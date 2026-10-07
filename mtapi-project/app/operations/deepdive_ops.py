"""Deep Dive per-track analysis workbench (spec ruling 2026-10-07).

Runs every available analysis model on one track in a single job:
  - Demucs stem separation (OpenVINO, strict device)
  - Essentia key/tempo/beats/onsets + competing legacy opinions
  - Basic Pitch note transcription + mido tempo-map MIDI
  - optional CDP pipeline (browser-executed; the pipeline JSON is echoed back
    in meta so the tab can run it via the existing CDP worker right after)

Semantics: one model failing does NOT fail the dive — every result lands in
meta with its own ok/failure, and generated artifacts are stamped in the
Media Catalog (origin=generated, AI-involved) as they complete.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..database import audio_db
from . import demucs_ops


class DeepDiveParams(BaseModel):
    input_path: str = Field(..., description="Absolute path to the track")
    output_dir: str | None = Field(None, description="Folder for stems (default: next to input)")
    overwrite: bool = Field(False, description="Overwrite existing outputs (default: never)")

    demucs_model: Literal["htdemucs", "htdemucs_6s", "htdemucs_ft"] = Field(
        "htdemucs", description="Demucs checkpoint (4 vs 6 stems vs 4-model bag)")
    demucs_stems: list[str] | None = Field(
        None, description="Stem subset (default: all for the model)")
    demucs_device: Literal["GPU", "GPU.0", "CPU"] = Field(
        "GPU", description="OpenVINO device — GPU is strict, never silently falls back")

    analyze_key: bool = Field(True)
    analyze_tempo: bool = Field(True)
    analyze_beats: bool = Field(True)
    basic_pitch: bool = Field(True, description="Basic Pitch note transcription + tempo-map MIDI")
    include_legacy: bool = Field(True, description="Legacy engines (madmom/librosa) for competing opinions")

    cdp_pipeline_json: str | None = Field(
        None, description="mtapi-cdp-pipeline/1 JSON — echoed to the tab, which runs it in the browser CDP worker")

    output_format: Literal["wav-f32", "wav-pcm24"] = Field("wav-f32")
    dry_run: bool = Field(False)


async def deep_dive(p: DeepDiveParams) -> OperationResult:
    op = "deep_dive"
    token = job_control.current_token()
    logs: list[str] = []

    def _progress(done: int, total: int, phase: str, msg: str) -> None:
        logs.append(msg)
        if token:
            job_control.report_progress(msg, phase=phase, current=done, total=total,
                                        unit="models", token=token)

    src = Path(p.input_path).expanduser()
    if not src.is_file():
        return OperationResult(ok=False, operation=op, error=f"Input not found: {src}")

    results: dict[str, dict[str, Any]] = {}
    failures: dict[str, str] = {}

    # ── 1. Demucs stems (independent failure, never aborts the dive) ──────
    _progress(1, 4, "demucs", "demucs: separating stems…")
    stems_written: dict[str, str] = {}
    try:
        dr = await demucs_ops.demucs_separate(demucs_ops.DemucsSeparateParams(
            input_path=str(src),
            output_dir=p.output_dir,
            model=p.demucs_model,
            stems=p.demucs_stems,
            device=p.demucs_device,
            output_format=p.output_format,
            overwrite=p.overwrite,
            dry_run=p.dry_run,
        ))
        if dr.ok and dr.meta and isinstance(dr.meta.get("stems"), dict):
            stems_written = {k: v for k, v in dr.meta["stems"].items() if v}
            results["demucs"] = {
                "ok": True, "model": p.demucs_model,
                "device_settled": dr.meta.get("device_settled"),
                "stems": stems_written,
                "infer_s": dr.meta.get("infer_s"),
            }
            for path in stems_written.values():
                _catalog_stamp(path, str(src))
                logs.append(f"✓ demucs stem: {path}")
        else:
            failures["demucs"] = dr.error or "separation failed"
    except Exception as exc:  # noqa: BLE001 — one model failing never fails the dive
        failures["demucs"] = str(exc)
    if "demucs" not in results:
        results["demucs"] = {"ok": False, "error": failures.get("demucs")}

    # ── 2. Essentia analysis + beats + onsets (both venvs) ────────────────
    _progress(2, 4, "essentia", "essentia: key/tempo/beats/onsets…")
    from ..audio_pipeline import scanner as sc

    analysis: dict[str, Any] = {}
    scanner = sc.AudioScanner(target_dir=str(src.parent), is_video_fn=None, is_image_fn=None)
    ok, feats = await scanner.analyze_file(
        path=src,
        want_key=p.analyze_key,
        want_tempo=p.analyze_tempo,
        want_beats=p.analyze_beats,
        want_midi=p.basic_pitch,
        guard_sec=None,
        include_legacy=p.include_legacy,
    )
    if ok:
        from ..audio_pipeline.scanner import _trim_opinions
        analysis = {k: v for k, v in feats.items() if k != "opinions"}
        # The dive panel shows the extended info, competing engines included —
        # trimmed (the sidecar keeps the full arrays).
        if feats.get("opinions"):
            analysis["engine_opinions"] = _trim_opinions(feats["opinions"], limit=64)
        results["essentia"] = {"ok": True, **analysis}
        logs.append(f"✓ essentia: key={feats.get('key')} tempo={feats.get('tempo')} "
                    f"beats={feats.get('beats_count')} onsets={feats.get('onset_rate')}")
    else:
        failures["essentia"] = feats.get("skipped", "analysis failed")
        results["essentia"] = {"ok": False, "error": failures["essentia"]}

    # ── 3. Basic Pitch note transcription + tempo-map MIDI ────────────────
    _progress(3, 4, "basic_pitch", "basic-pitch: note transcription…")
    midi_out: dict[str, Any] = {"ok": False}
    if ok and feats.get("midi_path"):
        midi_out = {"ok": True, "tempo_map": feats.get("midi_path")}
        _catalog_stamp(feats["midi_path"], str(src))
        logs.append(f"✓ tempo-map midi: {feats['midi_path']}")
    if ok and feats.get("notes_midi_path"):
        midi_out["ok"] = True
        midi_out["notes"] = feats["notes_midi_path"]
        midi_out["note_count"] = feats.get("notes_midi_count")
        _catalog_stamp(feats["notes_midi_path"], str(src))
        logs.append(f"✓ basic-pitch notes: {feats['notes_midi_path']} "
                    f"({feats.get('notes_midi_count', 0)} notes)")
    if not midi_out["ok"]:
        failures["basic_pitch"] = "no MIDI produced"
    results["basic_pitch"] = midi_out

    # ── 4. CDP pipeline (browser-executed — echo for the tab) ─────────────
    cdp: dict[str, Any] = {"ok": False, "reason": "no pipeline requested"}
    if p.cdp_pipeline_json:
        try:
            pipe = json.loads(p.cdp_pipeline_json)
            cdp = {"ok": True, "pipeline": pipe, "note":
                   "pipeline echoed — run it in the CDP tab against this track"}
            logs.append("cdp pipeline echoed for browser execution")
        except json.JSONDecodeError as exc:
            failures["cdp"] = f"bad pipeline JSON: {exc}"
            cdp = {"ok": False, "error": failures["cdp"]}
    results["cdp"] = cdp

    # ── sidecar: the dive report beside the track ─────────────────────────
    report_path = src.parent / f"{src.name}.deepdive.json"
    report = {
        "path": str(src),
        "deep_dive": True,
        "results": results,
        "failures": failures,
        "generated": [*stems_written.values(),
                      *[v for k, v in midi_out.items() if k in ("tempo_map", "notes") and v]],
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    logs.append(f"✓ dive report: {report_path}")

    _progress(4, 4, "done", "deep dive complete")
    return OperationResult(
        ok=True,
        operation=op,
        stdout="\n".join(logs),
        meta={
            "results": results,
            "failures": failures,
            "report": str(report_path),
            "stems": stems_written,
        },
    )


def _catalog_stamp(path: str, parent: str) -> None:
    """Generated-artifact stamp, best-effort — never fails the dive. The
    parent link keeps stems/MIDI out of the catalog's main list (8.135)."""
    try:
        audio_db.catalog_upsert(
            path, origin="generated", generated_flag=True, status="pending",
            derived_from=parent,
        )
    except Exception:  # noqa: BLE001
        pass


spec = OperationSpec(
    id="deep_dive",
    summary="Deep Dive — run every analysis model on one track",
    description=(
        "Per-track analysis workbench: Demucs stem separation, Essentia "
        "key/tempo/beats/onsets with competing engine opinions, Basic Pitch "
        "note transcription + tempo-map MIDI, and an optional CDP pipeline "
        "echo for browser execution. One model failing never fails the dive."
    ),
    params_model=DeepDiveParams,
    handler=deep_dive,
)

register(spec)
