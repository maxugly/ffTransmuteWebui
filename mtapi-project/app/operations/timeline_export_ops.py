"""
Sequence Timeline Export Operation — POST /ops/sequence_timeline_export.

Exports the current Sequence clip order as a CMX 3600 EDL or FCPXML 1.10 file,
with an option to ensure all media referenced by the timeline is DaVinci Resolve
compatible (.mov DNxHR/ProRes + PCM audio), reusing existing variants or
generating missing ones file-to-file.

Spec: docs/sequence-timeline-export-spec.md §4–§5.
"""
from __future__ import annotations

import logging
from pathlib import Path
import re
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..convert_presets import ENCODE_PRESETS, DAVINCI_PRESETS, is_davinci_preset
from ..timeline_export import generate_edl, generate_fcpxml
from .. import job_control
from .. import media
from ..video_pipeline import probe, probe_copy_info, transcode_with_preset, conform_clip

log = logging.getLogger("mtapi.timeline_export")

DAVINCI_CODECS = frozenset({"dnxhd", "prores", "prores_ks", "prores_aw", "prores_videotoolbox"})


def is_davinci_compatible(path: Path, info: dict[str, Any]) -> bool:
    """Return True if media is natively decodeable by DaVinci Resolve Free on Linux."""
    if path.suffix.lower() != ".mov":
        return False
    vcodec = str(info.get("video_codec") or info.get("codec_name") or "").lower()
    if vcodec not in DAVINCI_CODECS:
        return False
    has_audio = bool(info.get("has_audio"))
    if has_audio:
        acodec = str(info.get("audio_codec") or info.get("audio_codec_name") or "").lower()
        if not acodec.startswith("pcm_"):
            return False
    return True


class TimelineClipInput(BaseModel):
    path: str = Field(..., description="Original pool clip absolute path")
    active_path: str | None = Field(
        None,
        description="Active variant/conformed/clean path selected for this sequence slot",
    )
    duration: float | None = Field(
        None,
        gt=0,
        description="Known native duration in seconds (optional; probed if omitted)",
    )
    target_duration: float | None = Field(
        None,
        gt=0,
        description="Per-clip sequence time-stretch target duration in seconds (null = native)",
    )


class TimelineExportParams(BaseModel):
    clips: list[TimelineClipInput] = Field(
        ..., min_length=1, description="Ordered clips in the active sequence window"
    )
    format: Literal["edl", "fcpxml"] = Field(
        "edl", description="Timeline export format: 'edl' (CMX 3600) or 'fcpxml' (FCPXML 1.10)"
    )
    fps: float = Field(
        30.0, gt=0, le=240.0, description="Project timeline frame rate (default 30)"
    )
    title: str = Field(
        "Untitled", description="Sequence / project title"
    )
    resolve_only: bool = Field(
        False,
        description="Tie timeline to DaVinci-compatible (.mov DNxHR/ProRes + PCM) files only, generating missing ones beside their sources",
    )
    resolve_preset: str = Field(
        "dnxhr_hq",
        description="Intermediate preset from DAVINCI_PRESETS when resolve_only=True",
    )
    output_path: str | None = Field(
        None,
        description="Optional explicit output file path (.edl or .xml/.fcpxml); auto-named beside first clip or project if omitted",
    )
    dry_run: bool = False


async def sequence_timeline_export(p: TimelineExportParams) -> OperationResult:
    summary = f"sequence_timeline_export {p.format} ({len(p.clips)} clips @ {p.fps}fps)"
    if p.resolve_only and not is_davinci_preset(p.resolve_preset):
        return OperationResult(
            ok=False,
            operation="sequence_timeline_export",
            error=f"Invalid DaVinci preset '{p.resolve_preset}'. Valid: {list(DAVINCI_PRESETS)}",
            command=summary,
        )

    clean_title = p.title.strip() or "Untitled"
    safe_title = re.sub(r'[/\\:*?"<>|]', "_", clean_title)

    # 1. Validate all clip paths
    resolved_clips_input: list[tuple[Path, Path, float, float | None]] = []
    # (orig_path, active_path, native_dur, target_dur)

    token = job_control.current_token()
    n_clips = len(p.clips)

    for i, c in enumerate(p.clips):
        orig_p = Path(c.path).expanduser().resolve()
        if not orig_p.is_file():
            return OperationResult(
                ok=False,
                operation="sequence_timeline_export",
                error=f"Source clip not found: {orig_p}",
                command=summary,
            )
        act_p = Path(c.active_path).expanduser().resolve() if c.active_path else orig_p
        if not act_p.is_file():
            act_p = orig_p

        native_dur = c.duration
        if native_dur is None or native_dur <= 0:
            rec = media.load_record(c.path)
            meta = rec.get("meta") if rec else None
            if meta and meta.get("duration"):
                native_dur = float(meta["duration"])
            else:
                try:
                    info = await probe(act_p)
                    native_dur = float(info.get("duration") or 0.0)
                except Exception as e:
                    return OperationResult(
                        ok=False,
                        operation="sequence_timeline_export",
                        error=f"Could not probe duration for {act_p}: {e}",
                        command=summary,
                    )

        target_dur = c.target_duration if (c.target_duration and c.target_duration > 0) else None
        resolved_clips_input.append((orig_p, act_p, native_dur, target_dur))

    # 2. Check / Reuse / Generate DaVinci intermediates if resolve_only is True
    final_clips: list[tuple[str, float]] = []
    source_paths_full: list[str] = []
    reused_count = 0
    generated_count = 0

    if p.dry_run:
        ext = ".edl" if p.format == "edl" else ".xml"
        out_dest = Path(p.output_path).expanduser().resolve() if p.output_path else resolved_clips_input[0][0].parent / f"{safe_title}{ext}"
        return OperationResult(
            ok=True,
            operation="sequence_timeline_export",
            output_path=str(out_dest),
            dry_run=True,
            command=summary,
            stdout=f"Command: {summary}\nOutput: {out_dest}\n(dry run — no files written)",
            meta={"format": p.format, "clip_count": len(resolved_clips_input)},
        )

    for i, (orig_p, act_p, native_dur, target_dur) in enumerate(resolved_clips_input):
        job_control.check_cancelled()
        effective_dur = target_dur if target_dur is not None else native_dur
        time_factor = (target_dur / native_dur) if (target_dur is not None and native_dur > 0.001) else 1.0
        if abs(time_factor - 1.0) < 1e-3:
            time_factor = 1.0

        if not p.resolve_only:
            final_clips.append((str(act_p), effective_dur))
            source_paths_full.append(str(act_p))
            continue

        # DaVinci media mode:
        if token:
            job_control.report_progress(
                f"davinci check {i+1}/{n_clips} {act_p.name}",
                phase="davinci",
                current=i,
                total=n_clips,
                unit="clips",
                token=token,
            )

        # Step 2.1: Is active file already DaVinci compatible?
        info = await probe_copy_info(act_p)
        if time_factor == 1.0 and is_davinci_compatible(act_p, info):
            reused_count += 1
            final_clips.append((str(act_p), effective_dur))
            source_paths_full.append(str(act_p))
            continue

        # Step 2.2: Search variant registry and sibling on disk
        found_reusable: Path | None = None
        for candidate_parent in (act_p, orig_p):
            try:
                variants = await media.get_variants(candidate_parent, include_missing=False)
            except Exception:
                variants = {}
            for kind in ("dnxhr", "conformed", "export"):
                for v in (variants or {}).get(kind) or []:
                    vpath_str = v.get("path")
                    if not vpath_str:
                        continue
                    vp = Path(vpath_str)
                    if not (vp.is_file() and vp.stat().st_size > 0 and vp.suffix.lower() == ".mov"):
                        continue
                    v_det = v.get("detail") or {}
                    v_preset = v_det.get("preset")
                    v_factor = float(v_det.get("time_factor") or 1.0)
                    if time_factor == 1.0:
                        if (v_preset == p.resolve_preset or is_davinci_preset(v_preset)) and abs(v_factor - 1.0) < 1e-3:
                            found_reusable = vp
                            break
                    else:
                        if v_preset == p.resolve_preset and abs(v_factor - time_factor) < 1e-3:
                            found_reusable = vp
                            break
                if found_reusable:
                    break
            if found_reusable:
                break

        # Also check deterministic sibling on disk:
        if not found_reusable and time_factor == 1.0:
            sibling = act_p.parent / f"{act_p.stem}_{p.resolve_preset}.mov"
            if sibling.is_file() and sibling.stat().st_size > 0:
                try:
                    s_info = await probe_copy_info(sibling)
                    if is_davinci_compatible(sibling, s_info):
                        found_reusable = sibling
                except Exception:
                    pass

        if found_reusable:
            reused_count += 1
            final_clips.append((str(found_reusable), effective_dur))
            source_paths_full.append(str(found_reusable))
            continue

        # Step 2.3: Generate missing DaVinci intermediate
        if token:
            job_control.report_progress(
                f"davinci transcode {i+1}/{n_clips} {act_p.name}",
                phase="davinci",
                current=i,
                total=n_clips,
                unit="clips",
                token=token,
            )

        ep = ENCODE_PRESETS[p.resolve_preset]
        if time_factor == 1.0:
            out_mov = act_p.parent / f"{act_p.stem}_{p.resolve_preset}.mov"
            await transcode_with_preset(act_p, out_mov, ep, copy_audio=True)
        else:
            out_mov = act_p.parent / f"{act_p.stem}_{p.resolve_preset}_t{int(round(target_dur * 1000))}ms.mov"
            w = int(info.get("width") or 1920)
            h = int(info.get("height") or 1080)
            await conform_clip(
                act_p,
                out_mov,
                mode="pad",
                width=w,
                height=h,
                target_fps=None,
                time_factor=time_factor,
                encode_preset=ep,
                duration=native_dur,
                has_audio=bool(info.get("has_audio")),
            )

        if not out_mov.is_file() or out_mov.stat().st_size == 0:
            return OperationResult(
                ok=False,
                operation="sequence_timeline_export",
                error=f"Failed to generate DaVinci intermediate: {out_mov}",
                command=summary,
            )

        # Register variant on original clip
        st = act_p.stat()
        await media.register_variant(
            str(orig_p),
            kind="dnxhr",
            variant_path=out_mov.resolve(),
            detail={
                "preset": p.resolve_preset,
                "source_path": str(act_p),
                "time_factor": float(time_factor),
                "source_size": int(st.st_size),
                "source_mtime": float(st.st_mtime),
            },
        )
        generated_count += 1
        final_clips.append((str(out_mov), effective_dur))
        source_paths_full.append(str(out_mov))

    # 3. Generate timeline text
    if p.format == "edl":
        content = generate_edl(final_clips, fps=p.fps, title=clean_title, source_paths=source_paths_full)
        ext = ".edl"
        filename = f"{safe_title}.edl"
    else:
        content = generate_fcpxml(final_clips, fps=p.fps, title=clean_title, source_paths=source_paths_full)
        ext = ".xml"
        filename = f"{safe_title}.xml"

    # 4. Write output file
    if p.output_path:
        out_file = Path(p.output_path).expanduser().resolve()
        if not out_file.suffix or out_file.suffix.lower() not in (".edl", ".xml", ".fcpxml"):
            out_file = out_file.with_suffix(ext)
    else:
        first_clip_path = resolved_clips_input[0][0]
        out_file = first_clip_path.parent / filename

    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(content, encoding="utf-8")

    if token:
        job_control.report_progress(
            f"export timeline done ({len(final_clips)} clips)",
            phase="done",
            current=n_clips,
            total=n_clips,
            unit="clips",
            token=token,
        )

    resolved_paths_list = [p_str for p_str, _ in final_clips]
    logs = [
        f"Exported {p.format.upper()} timeline with {len(final_clips)} clips @ {p.fps} fps",
        f"Output written to: {out_file}",
    ]
    if p.resolve_only:
        logs.append(f"DaVinci Resolve media ({p.resolve_preset}): {reused_count} reused, {generated_count} generated")

    return OperationResult(
        ok=True,
        operation="sequence_timeline_export",
        output_path=str(out_file),
        command=summary,
        stdout="\n".join(logs),
        meta={
            "format": p.format,
            "filename": filename,
            "content": content,
            "fps": p.fps,
            "clip_count": len(final_clips),
            "resolve_only": p.resolve_only,
            "resolve_preset": p.resolve_preset,
            "generated_count": generated_count,
            "reused_count": reused_count,
            "resolved_paths": resolved_paths_list,
        },
    )


register(
    OperationSpec(
        id="sequence_timeline_export",
        summary="Export sequence timeline (EDL or FCPXML) for DaVinci Resolve",
        description=(
            "Generates a CMX 3600 EDL or FCPXML document for the current sequence. "
            "Optional resolve_only mode checks, reuses, or transcodes DaVinci Resolve compatible "
            ".mov files (DNxHR / ProRes + PCM audio) before building the timeline."
        ),
        params_model=TimelineExportParams,
        handler=sequence_timeline_export,
        tags=["sequence", "export", "timeline", "edl", "fcpxml"],
    )
)
