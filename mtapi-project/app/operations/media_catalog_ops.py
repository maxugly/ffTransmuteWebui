"""Media Catalog scan op: directory → rows + key/tempo analysis (spec §7).

``POST /ops/media_catalog_scan`` walks an owned directory, indexes every media
file, and — when the analysis toggles are on — extracts musical key and tempo
per file. Non-destructive: originals are never touched; analysis lands in the
catalog row and a sibling ``.json`` sidecar.

Invariant 2: ffmpeg is invoked through ``shell.run_command`` with an argv list,
never ``shell=True``. Invariant 9: progress per item. Invariant 10: failures are
HTTP 200 + ``ok:false`` (per-file failures mark the row and continue).
"""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field

import logging

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..database import audio_db
from ..job_control import report_progress
from ..media.performance import load_settings
from ..routes.media_catalog import _is_image_file, _is_video_file
from ..audio_pipeline.metadata import compare_with_tags
from ..audio_pipeline.scanner import (
    DEFAULT_LONG_FILE_GUARD_SEC,
    AudioScanner,
    engine_status,
    essentia_available,
)


def scanner_midi_available() -> bool:
    """mido powers the tempo-map MIDI sidecar (see scanner.write_tempo_map_midi)."""
    import importlib.util
    try:
        return importlib.util.find_spec("mido") is not None
    except Exception:
        return False


log = logging.getLogger("mtapi.catalog_scan")


class MediaCatalogScanParams(BaseModel):
    target_directory: str = Field(..., description="Absolute path to the directory to scan")
    recursive: bool = Field(True, description="Walk subdirectories")
    audio_types: list[str] = Field(
        default_factory=lambda: sorted(audio_db.AUDIO_EXTENSIONS),
        description="Audio extensions to treat as audio (video/image reuse the app's own predicates)",
    )
    analyze_key: bool = Field(True, description="Extract musical key (Essentia KeyExtractor)")
    analyze_tempo: bool = Field(True, description="Extract tempo in BPM (Essentia RhythmExtractor2013)")
    analyze_beats: bool = Field(False, description="Beat/downbeat grid (Slice 4 — madmom/aubio)")
    analyze_midi: bool = Field(False, description="Audio→MIDI sidecar (Slice 4 — Basic Pitch)")
    long_file_guard_sec: int = Field(
        DEFAULT_LONG_FILE_GUARD_SEC, ge=0, le=3600,
        description="Analyze only the first N seconds (0 = whole file). Guards long DJ mixes.",
    )
    reanalyze: bool = Field(False, description="Ignore the hash-dedup fast path and re-analyze everything")
    include_extra_opinions: bool = Field(
        True, description="Also run the secondary engines (librosa + the legacy madmom "
                           "venv) so several engines give competing tempo/beat opinions. "
                           "Off = Essentia only, roughly 3x faster per file.")
    dry_run: bool = Field(False, description="List what would be indexed/analyzed; write nothing")


async def media_catalog_scan(p: MediaCatalogScanParams) -> OperationResult:
    op = "media_catalog_scan"
    token = job_control.current_token()

    target = Path(p.target_directory).expanduser()
    if not target.is_dir():
        return OperationResult(ok=False, operation=op,
                               error=f"target_directory is not a directory: {target}")

    want_any = p.analyze_key or p.analyze_tempo or p.analyze_beats or p.analyze_midi
    if want_any and not essentia_available():
        return OperationResult(
            ok=False, operation=op,
            error="Essentia is not installed — key/tempo analysis unavailable. "
                  "Install with: uv pip install --python .venv/bin/python essentia "
                  "(or run with all analysis toggles off to index only).",
        )
    if p.analyze_beats or p.analyze_midi:
        # Slice 4: beats/onsets are Essentia (already required above) and MIDI
        # is a mido tempo map. Both are real — but neither is note transcription.
        if p.analyze_midi and not scanner_midi_available():
            return OperationResult(
                ok=False, operation=op,
                error="MIDI export needs `mido` — install with: "
                      "uv pip install --python .venv/bin/python mido",
            )

    settings = load_settings()
    owned_dirs = list(settings.get("owned_dirs") or [])

    scanner = AudioScanner(
        str(target),
        owned_dirs=owned_dirs,
        audio_types={e.lower() if e.startswith(".") else f".{e.lower()}" for e in p.audio_types},
        is_video_fn=_is_video_file,
        is_image_fn=_is_image_file,
    )

    files = list(scanner.iter_media_files(recursive=p.recursive))
    if p.dry_run:
        lines = [f"dry run — {len(files)} media file(s) under {target}"]
        lines.append(f"recursive={p.recursive} audio_types={sorted(scanner.audio_types)}")
        lines.append(f"analyze: key={p.analyze_key} tempo={p.analyze_tempo} "
                     f"guard={p.long_file_guard_sec}s")
        lines.append(f"engines: {engine_status()}")
        lines.append(f"owned_dirs: {owned_dirs}")
        lines.append("would analyze (first 25):")
        for f in files[:25]:
            analysed = "" if (p.analyze_key or p.analyze_tempo) else "  [index only]"
            lines.append(f"  {f}{analysed}")
        if len(files) > 25:
            lines.append(f"  … and {len(files) - 25} more")
        return OperationResult(ok=True, operation=op, dry_run=True,
                               output_path=None,
                               meta={"scanned_directory": str(target)},
                               command="\n".join(lines),
                               stdout="\n".join(lines))

    report_progress("Scan started", phase="scan", current=0, total=len(files),
                    unit="files", token=token)

    indexed = 0
    analyzed = 0
    deduped = 0
    skipped_no_audio = 0
    tagged = 0
    tag_errors: list[str] = []
    missing = 0
    errors: list[str] = []
    total = len(files) or 1

    for n, path in enumerate(files, start=1):
        if job_control.is_cancelled(token):
            return OperationResult(ok=False, operation=op, error="cancelled",
                                   meta={"indexed": indexed, "analyzed": analyzed})

        # Decide BEFORE indexing: indexing stamps status='scanned', which would
        # make the freshly-written row look already-analysed and skip itself.
        needs_analysis = p.reanalyze or scanner.needs_analysis(path)

        # Tags/headers are cheap and worth reading on every index pass, whether
        # or not analysis runs — this is where the owner's own key/BPM live.
        tags: dict = {}
        try:
            tags = await scanner.extract_tags(path)
            tagged += 1
            # Compare against whatever detection already exists, so a deduped
            # re-scan still refreshes detected-vs-tagged rather than going stale.
            existing = scanner.audio_db.get_row(str(path)) or {}
            # Compare the DETECTION against the tag — comparing the effective
            # value would always yield 0 once the tag is in charge.
            detected_tempo = existing.get("tempo_detected") if existing.get("tempo_detected") \
                is not None else existing.get("tempo")
            detected_key = existing.get("key_detected") if existing.get("key_detected") \
                is not None else existing.get("key_name")
            if detected_tempo or detected_key:
                comparison = compare_with_tags(tags, {
                    "tempo": detected_tempo, "key": detected_key,
                })
                if comparison:
                    scanner.record_tag_comparison(path, comparison)
        except Exception as exc:
            tag_errors.append(f"{path.name}: tags — {exc}")

        try:
            scanner.index_file(path, status="scanned")
            indexed += 1
        except Exception as exc:
            errors.append(f"{path.name}: index — {exc}")
            report_progress(f"index failed: {path.name}", phase="scan", current=n,
                            total=total, unit="files", token=token)
            continue

        if not (p.analyze_key or p.analyze_tempo):
            report_progress(f"indexed {path.name}", phase="scan", current=n,
                            total=total, unit="files", token=token)
            continue

        if not needs_analysis:
            deduped += 1
            report_progress(f"unchanged (skipped) {path.name}", phase="scan", current=n,
                            total=total, unit="files", token=token)
            continue

        guard = p.long_file_guard_sec or None
        try:
            ok, result = await scanner.analyze_file(
                path,
                want_key=p.analyze_key,
                want_tempo=p.analyze_tempo,
                want_beats=p.analyze_beats,
                want_midi=p.analyze_midi,
                guard_sec=guard,
                include_legacy=p.include_extra_opinions,
            )
        except Exception as exc:
            scanner.mark_error(path, str(exc))
            errors.append(f"{path.name}: analyze — {exc}")
            report_progress(f"analyze failed: {path.name}", phase="scan", current=n,
                            total=total, unit="files", token=token)
            continue

        if not ok:
            skipped_no_audio += 1
            report_progress(f"no audio track: {path.name}", phase="scan", current=n,
                            total=total, unit="files", token=token)
            continue

        if tags:
            comparison = compare_with_tags(tags, result)
            if comparison:
                scanner.record_tag_comparison(path, comparison)

        analyzed += 1
        detail = " · ".join(
            f"{k}={result[k]}" for k in ("key", "tempo") if result.get(k) is not None
        )
        report_progress(f"{path.name} — {detail or 'analyzed'}", phase="scan",
                        current=n, total=total, unit="files", token=token)

    # Default source of truth: a tagged value wins, else the detection. Manual
    # choices are untouched, and both numbers stay stored either way (§19).
    try:
        chosen = audio_db.backfill_source_of_truth()
        if chosen:
            log.info("[media-catalog] applied default source of truth to %d row(s)", chosen)
    except Exception as exc:
        log.warning("[media-catalog] source-of-truth backfill failed: %s", exc)

    # Files that vanished since the last scan: mark, never delete (spec §13 —
    # the mount may come back). Scoped to rows under this directory so a scan
    # of one folder never rewrites the whole catalog.
    missing = _mark_missing_under(target)

    summary = [
        f"Scanned {target}",
        f"indexed={indexed} analyzed={analyzed} unchanged={deduped} "
        f"tagged={tagged} no_audio={skipped_no_audio} missing={missing} "
        f"errors={len(errors)} tag_errors={len(tag_errors)}",
    ]
    if errors:
        summary.append("problems (row kept, scan continued):")
        summary.extend(f"  - {e}" for e in errors[:20])
        if len(errors) > 20:
            summary.append(f"  … and {len(errors) - 20} more")

    return OperationResult(
        ok=True,
        operation=op,
        # A scan produces no output file — the indexed directory is the result.
        # Returning it as output_path would make the preview panel offer a
        # "generated file" card for a folder.
        output_path=None,
        stdout="\n".join(summary),
        meta={
            "scanned_directory": str(target),
            "indexed": indexed,
            "analyzed": analyzed,
            "unchanged": deduped,
            "no_audio": skipped_no_audio,
            "tagged": tagged,
            "tag_errors": tag_errors,
            "missing": missing,
            "errors": errors,
            "engines": engine_status(),
        },
    )


def _mark_missing_under(root: Path) -> int:
    """Flag rows under `root` whose file no longer exists. Returns the count."""
    from datetime import datetime

    prefix = os.path.abspath(str(root))
    with audio_db.get_db() as db:
        rows = db.execute(
            "SELECT path FROM media WHERE status != 'missing' AND path LIKE ?",
            (prefix + "%",),
        ).fetchall()
        gone = [r["path"] for r in rows if not os.path.exists(r["path"])]
        if gone:
            now = datetime.now().isoformat()
            db.executemany(
                "UPDATE media SET status = 'missing', updated_at = ? WHERE path = ?",
                [(now, p) for p in gone],
            )
    return len(gone)


register(OperationSpec(
    id="media_catalog_scan",
    summary="Scan a directory into the Media Catalog (key + tempo)",
    description=(
        "Walks a directory, indexes every audio/video/image file into the catalog DB, "
        "and extracts musical key + tempo per file (Essentia). Non-destructive: writes "
        "a sibling .json sidecar, never touches originals. Owned-directory rules set "
        "the mine flag. Per-file failures mark the row and the scan continues."
    ),
    params_model=MediaCatalogScanParams,
    handler=media_catalog_scan,
    tags=["audio", "catalog", "analysis", "library"],
))