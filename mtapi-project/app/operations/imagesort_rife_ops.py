from __future__ import annotations

import uuid
from pathlib import Path
from typing import Literal

from PIL import Image
from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path, parse_path_list, verify_paths_exist
from ..image_sort import rank_images, rank_images_chain, rank_images_full, conform_image, MODES, SortStrategy

FitMode = Literal["letterbox", "crop", "stretch"]
SortOrder = Literal["nearest_first", "farthest_first"]
RifeModel = Literal["rife-v4.6", "rife-v4", "rife-v2.4", "rife-v2.3"]

VIDEO_EXTS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"})
IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"})


# ── sort-only endpoint ──────────────────────────────────────────────────

class ImageSortRankParams(BaseModel):
    image_paths: list[str] = Field(..., min_length=2, description="Ordered list; [0] = base (sort anchor)")
    sort_mode: str = Field("phash", description=f"Sort mode: {', '.join(sorted(MODES.keys()))}")
    sort_order: SortOrder = Field("nearest_first")
    sort_strategy: SortStrategy = Field("radial", description="radial = score each vs base; chain = greedy nearest-next walk")


async def imagesort_rank(p: ImageSortRankParams) -> OperationResult:
    resolved = [str(Path(x).expanduser().resolve()) for x in p.image_paths]

    missing = verify_paths_exist(resolved)
    if missing:
        return OperationResult(
            ok=False, operation="imagesort_rank",
            error=f"Files not found: {', '.join(missing)}",
        )

    try:
        result = rank_images_full(resolved, mode=p.sort_mode, order=p.sort_order, strategy=p.sort_strategy)
    except (FileNotFoundError, ValueError) as e:
        return OperationResult(
            ok=False, operation="imagesort_rank", error=str(e),
        )

    lines = [
        f"rank {p.sort_mode} {p.sort_strategy} {p.sort_order}: base + {len(resolved) - 1} targets",
        "order:",
    ]
    for item in result.items:
        role = item["role"]
        name = Path(item["path"]).name
        if role == "base":
            lines.append(f"  00  {name:30s} (base)")
        else:
            lines.append(f"  {result.items.index(item):02d}  {name:30s} score={item['score']:.2f}")

    return OperationResult(
        ok=True, operation="imagesort_rank",
        ordered_paths=result.ordered_paths,
        items=result.items,
        stdout="\n".join(lines),
    )


register(OperationSpec(
    id="imagesort_rank",
    summary="Rank stills by metric + strategy — returns ordered list with scores",
    description=(
        "Takes an ordered list of image paths (list[0] = base anchor), "
        "scores items 1..N, and returns the re-ordered list with scores. "
        "Strategy: radial = score each vs base; chain = greedy nearest-next walk. "
        "No conform, RIFE, or encode. "
        f"Sort modes: {', '.join(sorted(MODES.keys()))}."
    ),
    params_model=ImageSortRankParams,
    handler=imagesort_rank,
    tags=["imagesort", "sort", "rank"],
))


# ── run endpoint ────────────────────────────────────────────────────────

class ImageSortRifeParams(BaseModel):
    image_paths: list[str] | None = Field(None, description="Final ordered list; [0] = base (first keyframe)")
    image_dir: str | None = Field(None, description="Directory of targets (non-recursive)")
    input_path: str | None = Field(None, description="Newline-separated targets")
    sort_mode: str = Field("phash", description=f"Sort mode: {', '.join(sorted(MODES.keys()))}")
    sort_order: SortOrder = Field("nearest_first")
    sort_strategy: SortStrategy = Field("radial", description="radial = score each vs base; chain = greedy nearest-next walk")
    auto_sort: bool = Field(False, description="Headless convenience: re-rank targets vs [0] before conform. WebUI always sends false.")
    use_rife: bool = Field(True)
    multiplier: int = Field(2, ge=2, le=128, description="RIFE frame density (out ≈ K×M). 2–128; high M on 2 stills = long morph")
    model: RifeModel = Field("rife-v4.6")
    tta: bool = Field(False, description="RIFE TTA mode")
    uhd: bool = Field(False, description="RIFE UHD mode")
    fps: float = Field(24.0, ge=1.0, le=120.0, description="Output framerate")
    fit: FitMode = Field("letterbox")
    output_path: str | None = Field(None, description="Auto via finalize_output_path")
    crf: int = Field(18, ge=0, le=51)
    keep_frames: bool = Field(False, description="Keep workspace files for debug")
    dry_run: bool = Field(False, description="Plan and print only")


def _collect_paths(p: ImageSortRifeParams) -> list[str]:
    from ..pathutil import scan_input_dir

    if p.image_paths:
        candidates = [str(Path(x).expanduser().resolve()) for x in p.image_paths]
        missing = verify_paths_exist(candidates)
        if missing:
            raise ValueError(f"Files not found: {', '.join(missing)}")
    elif p.input_path:
        raw = parse_path_list(p.input_path)
        missing = verify_paths_exist(raw)
        if missing:
            raise ValueError(f"Files not found: {', '.join(missing)}")
        candidates = [str(Path(x).expanduser().resolve()) for x in raw]
    elif p.image_dir:
        candidates = scan_input_dir(p.image_dir, IMAGE_EXTS)
        if not candidates:
            raise ValueError(f"No image files found in directory: {p.image_dir}")
    else:
        raise ValueError("Provide image_paths, image_dir, or input_path")

    deduped: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        if c not in seen:
            seen.add(c)
            deduped.append(c)
    return deduped


def _resolve_output_path(
    source: str, output_path: str | None, use_rife: bool, multiplier: int,
) -> Path:
    suffix = f"_imagesort_rife{multiplier}x" if use_rife else "_imagesort"
    return finalize_output_path(
        output_path,
        source=source,
        default_suffix=suffix,
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )


async def imagesort_rife(p: ImageSortRifeParams) -> OperationResult:
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import encode as vp_encode
    from .. import job_control

    try:
        paths = _collect_paths(p)
    except ValueError as e:
        return OperationResult(
            ok=False, operation="imagesort_rife", error=str(e), dry_run=p.dry_run,
        )

    if len(paths) < 2:
        return OperationResult(
            ok=False, operation="imagesort_rife",
            error="Need at least 2 images (K >= 2)",
            dry_run=p.dry_run,
        )

    base = paths[0]
    base_path = Path(base)

    if p.auto_sort:
        targets = paths[1:]
        try:
            if p.sort_strategy == "chain":
                ranked = rank_images_chain(paths, mode=p.sort_mode, order=p.sort_order)
            else:
                ranked = rank_images(base, targets, mode=p.sort_mode, order=p.sort_order)
        except (FileNotFoundError, ValueError) as e:
            return OperationResult(
                ok=False, operation="imagesort_rife", error=str(e), dry_run=p.dry_run,
            )
        final_paths = [base] + [str(item.path) for item in ranked[1:]] if p.sort_strategy == "chain" else [base] + [str(item.path) for item in ranked]
    else:
        final_paths = paths

    out = _resolve_output_path(base, p.output_path, p.use_rife, p.multiplier)

    K = len(final_paths)
    M = p.multiplier if p.use_rife else 1
    n_est = K * M
    dur_est = n_est / max(p.fps, 1e-9)

    order_lines = []
    for i, fp in enumerate(final_paths):
        name = Path(fp).name
        role = "base" if i == 0 else ("manual" if not p.auto_sort else f"auto-sort ({p.sort_strategy})")
        order_lines.append(f"  {i:02d}  {name:30s} role={role}")

    summary = (
        f"imagesort_rife  K={K}  use_rife={p.use_rife}"
        + (f"  M={p.multiplier}" if p.use_rife else "")
        + f"  fps={p.fps}  fit={p.fit}  auto_sort={p.auto_sort}"
        + (f"  strategy={p.sort_strategy}" if p.auto_sort else "")
    )

    if p.dry_run:
        dry_log = "\n".join([
            "order (final):",
            *order_lines,
            f"conform: {p.fit}",
            f"keyframes={K}  use_rife={p.use_rife}"
            + (f"  M={p.multiplier}" if p.use_rife else "")
            + f"  fps={p.fps}  ~N={n_est}  ~duration={dur_est:.2f}s",
            f"output: {out}",
        ])
        return OperationResult(
            ok=True, operation="imagesort_rife", output_path=str(out),
            dry_run=True, command=summary, stdout=dry_log,
        )

    if p.use_rife:
        from ..filters.rife import run_rife_directory, resolve_rife_bin
        try:
            resolve_rife_bin()
        except RuntimeError as e:
            return OperationResult(
                ok=False, operation="imagesort_rife", error=str(e),
            )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="imagesort_")
    success = False
    logs: list[str] = [
        summary,
        "order (final):",
        *order_lines,
    ]
    job_token = job_control.current_token()

    def progress_cb(msg: str, **kw):
        logs.append(msg)
        try:
            job_control.report_progress(msg, token=job_token, **kw)
        except Exception:
            pass
        job_control.check_cancelled()

    try:
        with Image.open(base) as im:
            bw, bh = im.width, im.height
        bw = bw if bw % 2 == 0 else bw - 1
        bh = bh if bh % 2 == 0 else bh - 1
        logs.append(f"conform: {bw}x{bh} even  {p.fit}")

        progress_cb(
            f"conforming {K} keyframes…",
            phase="conform", current=0, total=K, unit="frames",
        )

        ws.create()
        for i, sp in enumerate(final_paths):
            job_control.check_cancelled()
            dst = ws.frames_in / f"frame_{i:06d}.png"
            await conform_image(sp, dst, bw, bh, fit=p.fit)
            progress_cb(
                f"conformed {i + 1}/{K}",
                phase="conform", current=i + 1, total=K, unit="frames",
                latest_frame=str(dst),
            )

        if p.use_rife:
            progress_cb(
                f"RIFE {p.multiplier}x interpolate…",
                phase="rife", current=0, total=K * p.multiplier, unit="frames",
            )
            meta = await run_rife_directory(
                ws.frames_in, ws.frames_out,
                multiplier=p.multiplier, model=p.model,
                tta=p.tta, uhd=p.uhd,
            )
            logs.append(
                f"rife: {meta['frame_count_in']} → {meta['frame_count_out']} frames"
                + f"  model={p.model}"
            )
            encode_dir = ws.frames_out
            progress_cb(
                f"rife done: {meta['frame_count_out']} frames",
                phase="rife", current=K * p.multiplier, total=K * p.multiplier, unit="frames",
            )
        else:
            encode_dir = ws.frames_in

        progress_cb(
            f"encode @ {p.fps} fps…",
            phase="encode", current=0, total=1, unit="pass",
        )
        result_path = await vp_encode(
            ws, out, p.fps,
            crf=p.crf, mux_audio=False,
            frame_source_dir=encode_dir,
        )
        progress_cb(
            f"encoded",
            phase="encode", current=1, total=1, unit="pass",
        )
        logs.append(f"encode: {result_path}  ~duration={dur_est:.2f}s")
        success = True

        return OperationResult(
            ok=True, operation="imagesort_rife",
            output_path=str(result_path), dry_run=False,
            command=summary,
            stdout="\n".join(logs),
        )

    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation="imagesort_rife", dry_run=False,
            command=summary, stdout="\n".join(logs), error=str(e),
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            return OperationResult(
                ok=False, operation="imagesort_rife", dry_run=False,
                command=summary, stdout="\n".join(logs),
                error="Cancelled by user",
            )
        return OperationResult(
            ok=False, operation="imagesort_rife", dry_run=False,
            command=summary, stdout="\n".join(logs),
            stderr=str(e), error=str(e),
        )
    finally:
        if not p.keep_frames:
            ws.cleanup(keep_on_failure=not success)


register(OperationSpec(
    id="imagesort_rife",
    summary="Conform stills to list[0] size, optionally RIFE-interpolate, encode to video",
    description=(
        "Trusts final `image_paths` order (list[0] = base, first keyframe + conform size ref). "
        "Conforms every keyframe to base dimensions (letterbox/crop/stretch), optionally "
        "RIFE-interpolates between keyframes, then encodes at a chosen fps. "
        "`auto_sort=false` from the WebUI (user manually ordered). "
        f"Sort modes: {', '.join(sorted(MODES.keys()))}. "
        "Duration = keyframes × multiplier ÷ fps."
    ),
    params_model=ImageSortRifeParams,
    handler=imagesort_rife,
    tags=["imagesort", "rife", "interpolation", "video"],
))
