"""
Convert / Export operation — POST /ops/convert.

Orchestrates the shared dump/encode engine for:
  1. Video/GIF → frames_* (durable dump via video_pipeline.dump)
  2. Video/GIF → video preset (dump → encode via engine)
  3. Image folder → video preset (load_frames_dir → encode via engine)

Not a transmute wrapper. Uses shared video_pipeline + convert_presets.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..job_workspace import JobWorkspace
from ..pathutil import unique_output_path
from ..convert_presets import (
    ENCODE_PRESETS, DUMP_PRESETS,
    is_video_encode_target, is_dump_target, is_valid_target,
    get_auto_name,
    VIDEO_EXTS, IMAGE_EXTS, GIF_EXTS,
)
from ..frame_range import end_frame_field, start_frame_field

# ── Params ──────────────────────────────────────────────────────────────────


class ConvertParams(BaseModel):
    input_path: str = Field(
        ...,
        description="Source video, animated GIF, or image-sequence directory",
    )
    target: str = Field(
        ...,
        description="Target preset id (h264_avc, prores_hq, dnxhr_lb, frames_png, …)",
    )
    output_path: str | None = Field(
        None,
        description="Output path; auto-named if omitted. For frames_* targets, this "
                    "is the output directory.",
    )
    fps: float = Field(
        24.0,
        ge=1.0, le=120.0,
        description="Effective FPS for image-folder import; ignored for video sources",
    )
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = Field(False, description="Print command without executing")


# ── Helpers ─────────────────────────────────────────────────────────────────


def _input_kind(path: Path) -> str:
    """Classify input: 'video', 'gif', 'image_dir', 'unknown'."""
    if not path.exists():
        return "unknown"
    if path.is_dir():
        images = 0
        for f in path.iterdir():
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
                images += 1
                if images >= 1:
                    break
        if images > 0:
            return "image_dir"
        return "unknown"
    ext = path.suffix.lower()
    if ext in GIF_EXTS:
        return "gif"
    if ext in VIDEO_EXTS:
        return "video"
    return "unknown"


def _resolve_output(
    input_path: Path,
    output_path: str | None,
    target: str,
) -> Path:
    """Resolve output path based on target type.

    For frames_* targets: output is a directory (auto-named with suffix).
    For video encodes: output is a file.
    """
    if output_path:
        p = Path(output_path).expanduser()
        return p.resolve()

    stem = input_path.stem
    auto = get_auto_name(stem, target)

    if is_dump_target(target):
        parent = input_path.parent
        out = parent / auto
    else:
        parent = input_path.parent
        out = parent / auto

    return unique_output_path(out)


# ── Handler ─────────────────────────────────────────────────────────────────


async def convert(p: ConvertParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()

    if not p.target or not is_valid_target(p.target):
        return OperationResult(
            ok=False, operation="convert",
            error=f"Invalid target: '{p.target}'. Valid: "
                  f"{list(ENCODE_PRESETS.keys()) + list(DUMP_PRESETS.keys())}",
        )

    kind = _input_kind(input_path)

    # ── Validate input kind vs target ────────────────────────────────────
    if kind == "unknown":
        return OperationResult(
            ok=False, operation="convert",
            error=f"Input not found or unsupported: {input_path}",
        )

    if kind == "image_dir" and is_dump_target(p.target):
        return OperationResult(
            ok=False, operation="convert",
            error="Input is already a directory of frames. To dump frames, provide a video or GIF file.",
        )

    # ── Resolve output ───────────────────────────────────────────────────
    out = _resolve_output(input_path, p.output_path, p.target)

    # Summary for output
    summary = f"convert {input_path.name} → {p.target}"

    if p.dry_run:
        return OperationResult(
            ok=True, operation="convert",
            output_path=str(out), dry_run=True,
            command=summary,
            stdout=f"Target: {p.target}\nInput: {input_path}\nOutput: {out}\n(dry run — no files written)",
        )

    # ── Create workspace ─────────────────────────────────────────────────
    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="convert_")
    success = False
    logs: list[str] = [summary]

    try:
        from ..video_pipeline import dump, encode, load_frames_dir

        # ── Path A: video/GIF → frames_* (dump only) ──────────────────
        if is_dump_target(p.target) and kind in ("video", "gif"):
            dp = DUMP_PRESETS[p.target]
            ws.create()

            dump_info = await dump(
                ws, input_path,
                image_format=dp.extension,
                out_dir=out,
                start_frame=p.start_frame,
                end_frame=p.end_frame,
            )
            success = True
            logs.append(f"Dumped {dump_info['frame_count']} frames to {out}")
            logs.append(f"Pattern: {dump_info['pattern']}")

            return OperationResult(
                ok=True, operation="convert",
                output_path=str(out),
                command=summary, stdout="\n".join(logs),
            )

        # ── Path B: image_dir → video preset (load_frames_dir → encode) ─
        if kind == "image_dir" and is_video_encode_target(p.target):
            ep = ENCODE_PRESETS[p.target]

            frame_info = await load_frames_dir(ws, input_path, fps=p.fps)

            src_dir = ws.frames_out
            if not any(src_dir.iterdir()):
                src_dir = input_path

            result_path = await encode(
                ws, out, frame_info["fps"],
                encode_preset=ep,
                frame_pattern=frame_info["pattern"],
                frame_source_dir=src_dir,
                silence_on_no_audio=True,
                mux_audio=False,
            )
            success = True
            logs.append(f"Encoded {frame_info['frame_count']} frames → {result_path}")

            return OperationResult(
                ok=True, operation="convert",
                output_path=str(result_path),
                command=summary, stdout="\n".join(logs),
            )

        # ── Path C: video/GIF → video preset (dump → encode) ───────────
        if kind in ("video", "gif") and is_video_encode_target(p.target):
            ep = ENCODE_PRESETS[p.target]

            dump_info = await dump(
                ws, input_path,
                start_frame=p.start_frame,
                end_frame=p.end_frame,
            )
            src_dir = ws.frames_in

            result_path = await encode(
                ws, out, dump_info["fps"],
                encode_preset=ep,
                frame_source_dir=src_dir,
                silence_on_no_audio=True,
                mux_audio=True,
            )
            success = True
            logs.append(f"Encoded {dump_info['frame_count']} frames → {result_path}")

            return OperationResult(
                ok=True, operation="convert",
                output_path=str(result_path),
                command=summary, stdout="\n".join(logs),
            )

        return OperationResult(
            ok=False, operation="convert",
            error=f"Unsupported conversion: {kind} → {p.target}",
        )

    except Exception as e:
        return OperationResult(
            ok=False, operation="convert",
            error=str(e),
            command=summary, stdout="\n".join(logs), stderr=str(e),
        )

    finally:
        ws.cleanup(keep_on_failure=not success)


# ── Register ────────────────────────────────────────────────────────────────

register(OperationSpec(
    id="convert",
    summary="Convert / Export — codec transcode or frame dump/import",
    description=(
        "Convert video/GIF/image-sequences between formats. "
        "Supports intermediates (ProRes, DNxHR), delivery codecs (H.264, H.265, VP9, AV1), "
        "archival (FFV1), and frame dumps (PNG, WebP, JPG, TIFF). "
        "Also imports image folders at a fixed FPS to any video target."
    ),
    params_model=ConvertParams,
    handler=convert,
    tags=["convert", "export", "frames", "pipeline"],
))
