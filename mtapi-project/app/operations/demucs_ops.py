"""
Demucs stem separation — OpenVINO Route C2 hybrid on the Intel iGPU.

File-to-file audio op, NOT filter-platform: no dump → app/filters/* →
encode involvement (invariant 1 untouched — there are no video frames here,
only audio chunks). Accepts a standalone audio file or a video (audio track
extracted via ffmpeg), emits one WAV per selected stem.

Two registered ops:
  demucs_separate   — the separator (model selector + stem toggles + knobs)
  demucs_ov_setup   — one-time IR installer + CPU smoke + GPU probe

Device is strict: GPU failures raise loudly, never a silent CPU fallback
(same contract as styletransfer/deepdream OV engines).
"""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..pathutil import unique_output_path
from . import demucs_ov_engine as ove

AUDIO_EXTS = frozenset(ove.AUDIO_EXTS)
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class DemucsSeparateParams(BaseModel):
    input_path: str = Field(..., description="Audio file, or a video (audio track is extracted)")
    output_dir: str | None = Field(None, description="Folder for stems (default: next to input)")
    model: Literal["htdemucs", "htdemucs_6s", "htdemucs_ft"] = Field(
        "htdemucs", description="Separator checkpoint (4 vs 6 stems vs 4-model bag)"
    )
    stems: list[str] | None = Field(
        None,
        description="Subset of source names to write (default: all for the model). "
        "htdemucs/ft: drums, bass, other, vocals. htdemucs_6s adds guitar, piano.",
    )
    device: Literal["GPU", "GPU.0", "CPU"] = Field(
        "GPU",
        description="OpenVINO device. GPU is strict (fails loudly, never falls back); "
        "CPU is the explicit opt-in fallback.",
    )
    overlap: float = Field(
        0.25, ge=0.0, lt=1.0,
        description="Chunk overlap ratio (0–0.5 typical). 0.25 matches the native reference.",
    )
    transition_power: float = Field(
        1.0, ge=0.1, le=4.0,
        description="Triangular OLA window sharpness (1.0 = Demucs reference)",
    )
    output_format: Literal["wav-f32", "wav-pcm24"] = Field(
        "wav-f32", description="Stem encoding (float32 default; pcm24 = integer with clipping report)"
    )
    overwrite: bool = Field(False, description="Overwrite existing stem files (default: never, _0001…)")
    no_async: bool = Field(False, description="Disable double-buffered async inference (diagnostics)")
    dry_run: bool = False


def _resolve_stems(model: str, stems: list[str] | None) -> list[str]:
    allowed = list(ove.MODEL_SPECS[model]["sources"])
    if not stems:
        return allowed
    unknown = [s for s in stems if s not in allowed]
    if unknown:
        raise RuntimeError(
            f"Model {model!r} has no stem(s) {unknown} "
            f"(available: {', '.join(allowed)})"
        )
    if len(set(stems)) != len(stems):
        raise RuntimeError(f"Duplicate stems requested: {stems}")
    return [s for s in allowed if s in stems]  # manifest order, never positional


def get_demucs_ov_status() -> dict:
    """Read-only status payload for GET /api/demucs_ov/status."""
    models: dict[str, dict] = {}
    for name, spec in ove.MODEL_SPECS.items():
        d = ove.resolve_artifacts_dir(name)
        files = {}
        if d is not None:
            try:
                files = {n: (d / n).is_file() for n in spec["irs"]}
            except OSError:
                pass
        models[name] = {
            "ir_present": d is not None,
            "artifacts_dir": str(d) if d else None,
            "stems": list(spec["sources"]),
            "members": len(spec["irs"]),
            "files": files,
        }
    return {
        "ok": True,
        "models": models,
        "model_dir": str(
            Path(__file__).resolve().parent.parent.parent / "junk" / "models" / "demucs_ov"
        ),
        "devices": ove.available_devices(),
    }


async def demucs_separate(p: DemucsSeparateParams) -> OperationResult:
    op = "demucs_separate"
    token = job_control.current_token()
    logs: list[str] = []

    def _progress(done: int, total: int) -> None:
        if token:
            job_control.report_progress(
                f"chunk {done}/{total}", phase="separate",
                current=done, total=total, unit="chunks", token=token,
            )

    try:
        src = Path(p.input_path).expanduser()
        if not src.is_file():
            raise RuntimeError(f"Input not found: {src}")
        suffix = src.suffix.lower()
        if suffix not in AUDIO_EXTS and suffix not in VIDEO_EXTS:
            raise RuntimeError(
                f"Unsupported input {src.suffix} (audio: {sorted(AUDIO_EXTS)}; "
                f"video: {sorted(VIDEO_EXTS)})"
            )
        wanted = _resolve_stems(p.model, p.stems)
        logs.append(
            f"demucs_separate model={p.model} stems={','.join(wanted)} "
            f"device={p.device} overlap={p.overlap}"
        )

        members = await asyncio.to_thread(ove.get_reference_members, p.model)
        pt_model = members[0]
        sample_rate = int(pt_model.samplerate)
        L = ove.chunk_samples_of(pt_model)

        tmp_extract: Path | None = None
        decode_path = str(src)
        if suffix in VIDEO_EXTS:
            logs.append("extracting audio track from video (ffmpeg 44.1k stereo)…")
            tmp_extract = await ove.extract_audio_from_video(src, sample_rate)
            decode_path = str(tmp_extract)

        try:
            wav = await asyncio.to_thread(ove.read_audio_file, decode_path, sample_rate)
        finally:
            if tmp_extract is not None:
                shutil.rmtree(tmp_extract.parent, ignore_errors=True)

        total = wav.shape[1]
        duration = total / sample_rate
        stride = int((1.0 - p.overlap) * L)
        n_chunks = (total + stride - 1) // stride if total else 0
        logs.append(
            f"input {total} samples ({duration:.2f}s @ {sample_rate}Hz) → "
            f"{n_chunks} chunk(s) of {L}"
        )
        if p.dry_run:
            plan = (
                f"demucs_separate (dry run — nothing changed)\n"
                f"model={p.model} device={p.device} overlap={p.overlap} "
                f"transition_power={p.transition_power} format={p.output_format}\n"
                f"input: {src} ({duration:.2f}s) → {n_chunks} chunks\n"
                f"stems: {', '.join(wanted)}"
            )
            return OperationResult(
                ok=True, operation=op, dry_run=True, command=plan,
                stdout="\n".join(logs) + "\n" + plan + "\n",
                meta={"dry_run": True, "stems": wanted, "chunks": n_chunks},
            )

        allow_fb = p.device.upper() == "CPU"
        compiled, settled, adir = await asyncio.to_thread(
            ove.load_ensemble, p.model, p.device, allow_fallback=allow_fb
        )
        # Loud device honesty: the tab's dropdown must mean what it says.
        if p.device.upper().startswith("GPU") and settled.upper() == "CPU":
            raise RuntimeError(
                f"OpenVINO GPU failed (no CPU fallback — device={p.device}); "
                "pick device=CPU explicitly or run GPU Setup."
            )
        logs.append(f"compiled {len(compiled)} IR(s) from {adir} → settled={settled}")
        job_control.check_cancelled()

        def _run() -> Any:
            if token:
                job_control.bind(token)
            import torch as _t  # noqa: F401 (ensures dep present in worker)

            return ove.separate_audio(
                wav, pt_model, compiled, list(ove.MODEL_SPECS[p.model]["sources"]),
                overlap=p.overlap,
                transition_power=p.transition_power,
                async_mode=not p.no_async,
                progress_cb=_progress,
                cancel_cb=job_control.check_cancelled,
            )

        import time as _time

        t0 = _time.perf_counter()
        stems_t = await asyncio.to_thread(_run)
        infer_s = _time.perf_counter() - t0
        logs.append(
            f"inference done in {infer_s:.1f}s "
            f"({duration / max(infer_s, 1e-6):.2f}x real-time, settled={settled})"
        )

        # Atomic per-stem WAV export (only requested stems hit disk).
        import torch

        out_dir = Path(p.output_dir).expanduser() if p.output_dir else src.parent
        out_dir.mkdir(parents=True, exist_ok=True)
        clip_report: dict[str, int] = {}
        written: dict[str, str] = {}
        _finite = bool(torch.isfinite(stems_t).all())
        if not _finite:
            raise RuntimeError("Separator produced non-finite samples.")
        all_sources = list(ove.MODEL_SPECS[p.model]["sources"])
        for name in wanted:
            idx = all_sources.index(name)
            stem = stems_t[idx]
            peak = float(stem.abs().max().item())
            if p.output_format == "wav-pcm24":
                over = int((stem.abs() > 1.0).sum().item())
                clip_report[name] = over
                if over:
                    logs.append(f"stem {name}: {over} samples outside [-1,1] clipped to PCM24")
                data = (stem.clamp(-1.0, 1.0) * 8388607.0).round().to(torch.int32)
                _write_pcm24_wav(data, out_dir / f"{src.stem}_{name}_{p.model}.wav",
                                 sample_rate, p.overwrite, written, name)
            else:
                dest = out_dir / f"{src.stem}_{name}_{p.model}.wav"
                if not p.overwrite:
                    dest = unique_output_path(dest)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(ove.write_stem_wav, stem.cpu(), dest, sample_rate)
                written[name] = str(dest)
            logs.append(f"✓ {name}: {written[name]} (peak {peak:.3f})")

        first = written[wanted[0]]
        stdout = "\n".join(logs) + f"\nOutput: {first}\n"
        if token:
            job_control.report_progress(
                "done", phase="done", current=n_chunks, total=n_chunks,
                unit="chunks", token=token,
            )
        return OperationResult(
            ok=True, operation=op, output_path=first, dry_run=False,
            command=f"demucs_separate model={p.model} device={settled} overlap={p.overlap}",
            stdout=stdout,
            meta={
                "model": p.model, "device_settled": settled,
                "stems": written, "clip_report": clip_report,
                "chunks": n_chunks, "duration_s": round(duration, 3),
                "infer_s": round(infer_s, 2),
            },
        )
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            stdout="\n".join(logs),
        )
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            stdout="\n".join(logs), stderr=str(e)[:2000],
        )


def _write_pcm24_wav(
    data: Any, dest: Path, sample_rate: int,
    overwrite: bool, written: dict[str, str], name: str,
) -> None:
    """Integer PCM24 WAV via stdlib wave (atomic temp + replace)."""
    import uuid as _uuid
    import wave

    if not overwrite:
        dest = unique_output_path(dest)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".tmp_{_uuid.uuid4().hex[:8]}_{dest.name}")
    try:
        import numpy as _np

        arr = _np.asarray(data.numpy(), dtype=_np.int32)
        # interleave [2, N] → bytes, 3 bytes LE per sample
        n_ch, n = arr.shape
        raw = bytearray()
        for i in range(n):
            for ch in range(n_ch):
                raw += int(arr[ch, i]).to_bytes(4, "little", signed=True)[:3]
        with wave.open(str(tmp), "wb") as w:
            w.setnchannels(n_ch)
            w.setsampwidth(3)
            w.setframerate(sample_rate)
            w.writeframes(bytes(raw))
        if not tmp.exists() or tmp.stat().st_size == 0:
            raise RuntimeError(f"Temporary stem file is empty: {tmp}")
        import os as _os

        _os.replace(tmp, dest)
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise
    written[name] = str(dest)


# ── Installer / status ────────────────────────────────────────────────────
def _ov_model_dir() -> Path:
    import os as _os

    env = _os.environ.get("DEMUCS_OV_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    return Path(__file__).resolve().parent.parent.parent / "junk" / "models" / "demucs_ov"


def _ov_source_dir() -> Path | None:
    import os as _os

    env = _os.environ.get("DEMUCS_OV_SRC", "").strip()
    if env and Path(env).expanduser().is_dir():
        return Path(env).expanduser()
    if ove._DEV_FALLBACK.is_dir():
        return ove._DEV_FALLBACK
    return None


class DemucsOvSetupParams(DemucsSeparateParams):
    input_path: str = Field(
        "", description="Unused for setup (inherited field, defaults empty)."
    )
    action: Literal["install", "update"] = Field(
        "install", description="install = copy missing IRs; update = re-copy all"
    )


async def demucs_ov_setup(p: DemucsOvSetupParams) -> OperationResult:
    """Copy the 6 Demucs Route-C2 IR pairs into junk/models/demucs_ov.

    Then CPU smoke (real single-chunk inference, no media needed) + a
    non-fatal GPU probe. Cancel-safe between phases. Dry-run changes nothing.
    """
    op = "demucs_ov_setup"
    d = _ov_model_dir()
    src = _ov_source_dir()
    phases = [
        f"copy {len(ove.IR_FILE_NAMES)} IR files → {d}",
        "compile-smoke on CPU (synthetic 1-chunk inference, no media needed)",
        "probe GPU compile+infer (non-fatal — CPU path already proven above)",
    ]
    plan = "\n".join(f"phase {i + 1}: {ph}" for i, ph in enumerate(phases))
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, dry_run=True, command=plan,
            stdout=f"demucs_ov_setup {p.action} (dry run — nothing changed)\n{plan}\n",
            meta={"dry_run": True, "status": {"demucs_ov": get_demucs_ov_status()},
                  "recommend_restart": False},
        )
    logs = [f"demucs_ov_setup {p.action} (HTDemucs Route C2, Meta weights via demucs 4.x)"]
    token = job_control.current_token()

    def _phase(i: int, total: int) -> None:
        job_control.check_cancelled()
        if token:
            job_control.report_progress(
                f"setup phase {i + 1}/{total}", phase="setup",
                current=i, total=total, unit="phases", token=token,
            )

    try:
        _phase(0, len(phases))
        if src is None:
            raise RuntimeError(
                "No Demucs IR source found — set $DEMUCS_OV_SRC to a dir holding "
                f"htdemucs_c2.xml (+_bin) etc., or place them in {d} manually."
            )
        missing = [n for n in ove.IR_FILE_NAMES if not (src / n).is_file()]
        if missing:
            raise RuntimeError(
                f"IR source {src} is missing {len(missing)} file(s): "
                + ", ".join(missing[:4])
                + ("…" if len(missing) > 4 else "")
            )

        def _copy() -> int:
            if token:
                job_control.bind(token)
            d.mkdir(parents=True, exist_ok=True)
            n = 0
            for name in ove.IR_FILE_NAMES:
                dest = d / name
                if p.action == "install" and dest.is_file():
                    continue
                shutil.copy2(src / name, dest)
                n += 1
            return n

        copied = await asyncio.to_thread(_copy)
        logs.append(f"IR files ready in {d} ({copied} copied, {len(ove.IR_FILE_NAMES) - copied} kept)")

        _phase(1, len(phases))

        def _smoke(device: str) -> dict:
            if token:
                job_control.bind(token)
            return ove.smoke_chunk("htdemucs", device, allow_fallback=True)

        smoke = await asyncio.to_thread(_smoke, "CPU")
        logs.append(
            f"cpu smoke ok: settled={smoke['settled']} "
            f"chunk={smoke['chunk_samples']} stems={','.join(smoke['sources'])} "
            f"({smoke['seconds']}s)"
        )

        _phase(2, len(phases))
        gpu_probe: dict = {"ok": False}
        try:
            gpu_probe = await asyncio.to_thread(_smoke, "GPU")
            gpu_probe["ok"] = True
            logs.append(
                f"gpu smoke ok: settled={gpu_probe['settled']} "
                f"chunk={gpu_probe['chunk_samples']} ({gpu_probe['seconds']}s)"
            )
        except Exception as e:  # noqa: BLE001 — non-fatal, CPU path stands
            gpu_probe = {"ok": False, "error": str(e)[:300]}
            logs.append(f"gpu smoke skipped: {gpu_probe['error']}")
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"demucs_ov": get_demucs_ov_status()},
                  "recommend_restart": False},
        )
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"demucs_ov": get_demucs_ov_status()},
                  "recommend_restart": False},
        )
    if token:
        job_control.report_progress(
            "setup done", phase="done",
            current=len(phases), total=len(phases), unit="phases", token=token,
        )
    return OperationResult(
        ok=True, operation=op, command=plan, stdout="\n".join(logs),
        meta={"status": {"demucs_ov": get_demucs_ov_status()},
              "gpu_probe": gpu_probe,
              "recommend_restart": False},
    )


register(OperationSpec(
    id="demucs_separate",
    summary="Demucs stem separation (OpenVINO Route C2 hybrid, strict GPU)",
    description=(
        "Separate audio into stems with Meta HTDemucs v4 on the Intel iGPU "
        "(host STFT/ISTFT via torch+demucs, neural core via OpenVINO). "
        "Model 'htdemucs' = 4 stems (drums/bass/other/vocals), 'htdemucs_6s' = 6 "
        "(+guitar/piano), 'htdemucs_ft' = 4 stems via a 4-model bag. "
        "Accepts an audio file or a video (track extracted). GPU is strict "
        "(fails loudly, no CPU fallback; needs POST /ops/demucs_ov_setup once). "
        "Outputs one WAV per selected stem next to the input, never overwriting."
    ),
    params_model=DemucsSeparateParams,
    handler=demucs_separate,
    tags=["demucs", "audio", "stems", "neural", "openvino", "gpu"],
))

register(OperationSpec(
    id="demucs_ov_setup",
    summary="Install Demucs Route-C2 IRs for the GPU stem separator",
    description=(
        "Copies the 6 Demucs OpenVINO IR pairs (htdemucs, htdemucs_6s, "
        "htdemucs_ft m0–m3) into junk/models/demucs_ov/, compile-smokes on CPU "
        "plus a non-fatal GPU probe. Source: $DEMUCS_OV_SRC or the dev-machine build."
    ),
    params_model=DemucsOvSetupParams,
    handler=demucs_ov_setup,
    tags=["demucs", "setup", "openvino", "gpu"],
))
