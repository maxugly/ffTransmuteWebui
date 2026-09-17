"""
Neural style transfer — Magenta arbitrary stylization (TF-Hub).

Image mode: stylize_pair() per content (model preloaded once).
Video mode: dump → filters.styletransfer (per_frame) → encode
  (model + style loaded once in the factory).
Evolve: strength ramp strip → shared evolve_video bookend.

See docs/filter-platform-spec.md.
"""
from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from ..evolve_video import EvolveRifeParams
from ..frame_range import end_frame_field, start_frame_field
from ..pathutil import finalize_output_path
from . import styletransfer_engine as ste

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class StyleTransferParams(EvolveRifeParams):
    engine: Literal["cpu", "gpu"] = Field(
        "cpu",
        description="Style engine: 'cpu' = Magenta TF-Hub (existing), "
        "'gpu' = OpenVINO AdaIN, strict GPU (fails loudly, never falls back to CPU)",
    )
    keep_model_warm: bool = Field(False, description="Keep the style model resident between runs")
    content_path: str | None = Field(
        None,
        description="Single content image path, or a directory of images",
    )
    content_paths: list[str] | None = Field(
        None,
        description="Batch of content images and/or directories (same style applied to each file)",
    )
    style_path: str = Field(
        ...,
        description="Style reference image (painting, texture, stained glass photo, …)",
    )
    output_path: str | None = Field(
        None,
        description=(
            "Optional explicit output file (single content) or directory. "
            "Omitted → `{content_stem}_styled.png` next to each content, never overwriting."
        ),
    )
    output_dir: str | None = Field(
        None,
        description="Optional folder for all outputs (default: each content's own directory)",
    )
    strength: float = Field(
        1.0,
        ge=0.0,
        le=1.0,
        description="0 = original content, 1 = full style transfer",
    )
    max_side: int = Field(
        1280,
        ge=0,
        le=4096,
        description="Longest side of content for inference (0 = full resolution). "
        "Lower = less RAM / faster. 1280 is a good default.",
    )
    style_size: int = Field(
        256,
        ge=64,
        le=512,
        description="Style encoder resolution (model default 256)",
    )
    suffix: str = Field(
        "_styled",
        description="Filename suffix for auto-named outputs",
    )
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = False

    # ── Evolve: strength ramp still → video (shared RIFE bookend) ─────────
    # RIFE + fps + save_stills: inherited from EvolveRifeParams
    evolve_enabled: bool = Field(
        False,
        description="Ramp strength over N frames → optional RIFE → evolve mp4",
    )
    evolve_frames: int = Field(
        16, ge=2, le=256,
        description="Number of strength keyframes (linear start→end)",
    )
    evolve_strength_start: float = Field(
        0.0, ge=0.0, le=1.0, description="First-frame strength (0 = pure content)",
    )
    evolve_strength_end: float = Field(
        -1.0, ge=-1.0, le=1.0,
        description="Last-frame strength; <0 means use main strength knob",
    )
    evolve_dedupe: bool = Field(
        False,
        description="Optional near-dupe drop (off by default — each strength is intentional)",
    )
    evolve_metric: str = Field("phash")
    evolve_threshold: float = Field(4.0, ge=0.0)


def _list_images_in_dir(d: Path) -> list[str]:
    if not d.is_dir():
        return []
    out: list[str] = []
    try:
        for child in sorted(d.iterdir()):
            if child.is_file() and child.suffix.lower() in IMAGE_EXTS and not child.name.startswith("."):
                out.append(str(child.resolve()))
    except OSError:
        pass
    return out


def _collect_contents(p: StyleTransferParams) -> list[str]:
    """Expand files + directories into a de-duplicated list of image paths."""
    seen: set[str] = set()
    out: list[str] = []

    def add_path(raw: str) -> None:
        path = Path(raw).expanduser().resolve()
        if path.is_dir():
            for f in _list_images_in_dir(path):
                if f not in seen:
                    seen.add(f)
                    out.append(f)
            return
        if path.is_file() and path.suffix.lower() in IMAGE_EXTS:
            s = str(path)
            if s not in seen:
                seen.add(s)
                out.append(s)

    if p.content_paths:
        for x in p.content_paths:
            add_path(x)
    if p.content_path:
        # Prefer listing content_path first when it's the primary single input
        head: list[str] = []
        path = Path(p.content_path).expanduser().resolve()
        if path.is_dir():
            head = _list_images_in_dir(path)
        elif path.is_file():
            head = [str(path)]
        for s in reversed(head):
            if s in seen:
                out.remove(s)
            seen.add(s)
            out.insert(0, s)
    return out


def _dest_for(src: str, p: StyleTransferParams, *, multi: bool) -> Path:
    """Always unique; default next to source (or under output_dir)."""
    src_p = Path(src)
    # Explicit single-file Save As only when one content and output_path is a file target
    explicit = None
    if p.output_path and not multi:
        explicit = p.output_path
    elif p.output_path and multi:
        # For multi, output_path if set is treated as a directory preference
        op = Path(p.output_path).expanduser()
        if op.is_dir() or str(p.output_path).endswith(("/", "\\")):
            return finalize_output_path(
                None,
                source=src_p,
                default_suffix=p.suffix,
                default_ext=".png",
                output_dir=op,
                allowed_exts=IMAGE_EXTS,
            )
        # otherwise ignore per-file explicit for batch (use output_dir / next-to-source)
        explicit = None

    return finalize_output_path(
        explicit,
        source=src_p,
        default_suffix=p.suffix,
        default_ext=".png",
        output_dir=p.output_dir,
        allowed_exts=IMAGE_EXTS,
    )


def _resolve_single_video(p: StyleTransferParams) -> str | None:
    """Return absolute path if the request is exactly one video (not a batch of stills)."""
    candidates: list[str] = []
    if p.content_path and str(p.content_path).strip():
        candidates.append(str(p.content_path).strip())
    if p.content_paths:
        for x in p.content_paths:
            if x and str(x).strip():
                candidates.append(str(x).strip())
    # de-dupe preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        uniq.append(c)
    if len(uniq) != 1:
        return None
    path = Path(uniq[0]).expanduser().resolve()
    if path.is_file() and path.suffix.lower() in VIDEO_EXTS:
        return str(path)
    return None


async def _styletransfer_video(p: StyleTransferParams, video_path: str) -> OperationResult:
    """Video path: dump → shared filters.styletransfer (per_frame) → encode."""
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, process, encode, cleanup
    from ..filters.styletransfer import make_styletransfer_filter

    input_path = Path(video_path).expanduser().resolve()
    style_path = Path(p.style_path).expanduser().resolve()

    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="styletransfer",
            error=f"Video not found: {input_path}", dry_run=p.dry_run,
        )
    if not style_path.is_file() and not p.dry_run:
        return OperationResult(
            ok=False, operation="styletransfer",
            error=f"Style image not found: {style_path}", dry_run=p.dry_run,
        )

    out = finalize_output_path(
        p.output_path or None,
        source=input_path,
        default_suffix="_styled",
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
        output_dir=p.output_dir or None,
    )

    summary = (
        f"styletransfer video {input_path.name} ← {style_path.name} "
        f"engine={p.engine} strength={p.strength} max_side={p.max_side} "
        f"frames={p.start_frame}–{p.end_frame if p.end_frame < 999999 else 'end'}"
    )

    if p.dry_run:
        return OperationResult(
            ok=True, operation="styletransfer", output_path=str(out),
            dry_run=True, command=summary,
            stdout=(
                f"{summary}\n"
                f"dump → filters.styletransfer (per_frame) → encode → {out}\n"
            ),
        )

    info = await probe(input_path)
    if info.get("frame_count", 0) <= 0 or info.get("fps", 0) <= 0:
        return OperationResult(
            ok=False, operation="styletransfer",
            error=f"Could not probe video (fps={info.get('fps')}, frames={info.get('frame_count')})",
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="styletransfer_")
    success = False
    logs: list[str] = [summary]

    try:
        filter_fn = make_styletransfer_filter(
            style_path=str(style_path),
            strength=p.strength,
            max_side=p.max_side,
            style_size=p.style_size,
            engine=p.engine,
        )
        dump_info = await dump(
            ws, input_path, start_frame=p.start_frame, end_frame=p.end_frame,
        )
        n_frames = int(dump_info.get("frame_count") or 0)
        fps = float(dump_info.get("fps") or info["fps"] or 24.0)
        logs.append(
            f"dump: {n_frames} frames @ {fps:g} fps "
            f"(src {p.start_frame}–{p.end_frame if p.end_frame < 999999 else 'end'})"
        )

        job_control.report_progress(
            "styletransfer frames",
            phase="styletransfer",
            current=0,
            total=max(1, n_frames),
            unit="frames",
        )

        def progress_cb(cur: int, tot: int) -> None:
            job_control.report_progress(
                f"styletransfer {cur}/{tot}",
                phase="styletransfer",
                current=cur,
                total=tot,
                unit="frames",
                latest_frame=str(ws.frames_out / f"frame_{cur-1:06d}.png"),
            )

        processed = await process(ws, filter_fn, progress_cb=progress_cb)
        logs.append(f"process: {processed} frames via filters.styletransfer")

        result_path = await encode(ws, out, fps)
        logs.append(f"Output: {result_path}")
        success = True

        job_control.report_progress(
            "styletransfer done",
            phase="done",
            current=processed,
            total=processed,
            unit="frames",
        )

        return OperationResult(
            ok=True, operation="styletransfer", output_path=str(out),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )

    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation="styletransfer", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )

    except Exception as e:
        return OperationResult(
            ok=False, operation="styletransfer", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs), stderr=str(e),
        )

    finally:
        await cleanup(ws, keep_on_failure=not success)


async def styletransfer(p: StyleTransferParams) -> OperationResult:
    # ── video path (filter platform: dump → per_frame → encode) ──
    video = _resolve_single_video(p)
    if video:
        return await _styletransfer_video(p, video)

    contents = _collect_contents(p)
    if not contents:
        return OperationResult(
            ok=False,
            operation="styletransfer",
            error="Need at least one content image (file or folder of images).",
            dry_run=p.dry_run,
        )

    if not p.dry_run:
        from ..pathutil import verify_paths_exist
        missing = verify_paths_exist(contents)
        if missing:
            return OperationResult(
                ok=False,
                operation="styletransfer",
                error=f"Content files not found: {', '.join(missing)}",
                dry_run=p.dry_run,
            )

    style = Path(p.style_path).expanduser().resolve()
    if not style.is_file() and not p.dry_run:
        return OperationResult(
            ok=False,
            operation="styletransfer",
            error=f"Style image not found: {style}",
            dry_run=p.dry_run,
        )

    multi = len(contents) > 1
    s_end = float(p.strength) if p.evolve_strength_end < 0 else float(p.evolve_strength_end)
    summary = (
        f"styletransfer n={len(contents)} style={style.name} "
        f"engine={p.engine} strength={p.strength} max_side={p.max_side}"
    )
    if p.evolve_enabled:
        summary += (
            f" evolve={p.evolve_frames}f "
            f"str {p.evolve_strength_start:.2f}→{s_end:.2f} "
            f"fps={p.evolve_fps} rife={p.evolve_use_rife}"
        )

    planned = [(src, _dest_for(src, p, multi=multi)) for src in contents]

    if p.dry_run:
        lines = [summary, f"Style: {style}"]
        for src, dest in planned:
            lines.append(f"  {Path(src).name} → {dest}")
            if p.evolve_enabled:
                lines.append(
                    f"    evolve → {Path(str(dest)).stem}_evolve.mp4 "
                    f"({p.evolve_frames} strengths)"
                )
        return OperationResult(
            ok=True,
            operation="styletransfer",
            output_path=str(planned[-1][1]) if planned else None,
            dry_run=True,
            command=summary,
            stdout="\n".join(lines) + "\n",
        )

    logs: list[str] = []
    job_token = job_control.current_token()

    def progress_cb(msg: str, **kw):
        logs.append(msg)
        try:
            job_control.report_progress(msg, token=job_token, **kw)
        except Exception:
            pass
        job_control.check_cancelled()

    # ── Evolve path (single content still; strength ramp) ──
    if p.evolve_enabled:
        if multi:
            return OperationResult(
                ok=False,
                operation="styletransfer",
                error="Evolve v1 supports one content still (clear extra list items).",
                dry_run=False,
                command=summary,
            )
        src0 = contents[0]
        # Video content not supported for evolve strength strip
        if Path(src0).suffix.lower() in VIDEO_EXTS:
            return OperationResult(
                ok=False,
                operation="styletransfer",
                error="Evolve needs a still content image (not video).",
                dry_run=False,
                command=summary,
            )
        return await _styletransfer_evolve_still(
            p, src0, style, summary, logs, progress_cb, job_token,
        )

    def runner():
        job_control.bind(job_token)
        use_ov = p.engine == "gpu"
        if use_ov:
            from . import styletransfer_ov_engine as ove
        # Warm model once, then stylize each with a pre-allocated unique dest
        try:
            if use_ov:
                ove.preload()
            else:
                ste.preload()
        except Exception as e:
            return {"ok": False, "error": str(e), "results": [], "output_path": None}

        results = []
        ok_n = 0
        primary = None
        total = len(planned)
        progress_cb(
            f"style transfer: {total} image(s), style={style.name}",
            phase="styletransfer",
            current=0,
            total=total,
            unit="images",
        )
        for i, (src, dest) in enumerate(planned):
            job_control.check_cancelled()
            progress_cb(
                f"image {i + 1}/{total}: {Path(src).name} → {dest.name}",
                phase="styletransfer",
                current=i + 1,
                total=total,
                unit="images",
            )
            # Re-finalize right before write (another job may have taken the name)
            dest_final = finalize_output_path(
                dest,
                source=src,
                default_suffix=p.suffix,
                default_ext=".png",
                allowed_exts=IMAGE_EXTS,
            )
            r = (
                ove.stylize_pair(
                    src,
                    style,
                    dest_final,
                    strength=p.strength,
                    max_side=p.max_side,
                    progress_cb=None,
                )
                if use_ov
                else ste.stylize_pair(
                    src,
                    style,
                    dest_final,
                    strength=p.strength,
                    max_side=p.max_side,
                    style_size=p.style_size,
                    progress_cb=None,
                )
            )
            results.append(r)
            if r.get("ok"):
                ok_n += 1
                # Live: finished still
                try:
                    out_p = r.get("output_path") or str(dest_final)
                    progress_cb(
                        f"styled {Path(src).name}",
                        phase="styletransfer",
                        current=i + 1,
                        total=total,
                        unit="images",
                        latest_frame=str(out_p),
                    )
                except Exception:
                    pass
                if primary is None:
                    primary = r.get("output_path")
        progress_cb(
            f"style transfer done: {ok_n}/{total} ok",
            phase="done",
            current=total,
            total=total,
            unit="images",
        )
        return {
            "ok": ok_n > 0,
            "ok_count": ok_n,
            "total": total,
            "results": results,
            "output_path": primary,
            "error": None if ok_n > 0 else "All images failed",
        }

    try:
        result = await asyncio.to_thread(runner)
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False,
            operation="styletransfer",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            error=str(e),
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            return OperationResult(
                ok=False,
                operation="styletransfer",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                error="Cancelled by user",
            )
        return OperationResult(
            ok=False,
            operation="styletransfer",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
            error=str(e),
        )

    lines = list(logs)
    for r in result.get("results") or []:
        if r.get("ok"):
            tag = f" ({r.get('engine')}/{r.get('device_settled')})" if r.get("engine") == "openvino" else ""
            lines.append(f"  OK {r.get('output_path')}{tag}")
        else:
            lines.append(f"  FAIL {r.get('content') or r.get('error')}: {r.get('error')}")

    ok = bool(result.get("ok"))
    return OperationResult(
        ok=ok,
        operation="styletransfer",
        output_path=result.get("output_path"),
        dry_run=False,
        command=summary,
        stdout="\n".join(lines) + "\n",
        error=None if ok else (result.get("error") or "style transfer failed"),
    )


async def _styletransfer_evolve_still(
    p: StyleTransferParams,
    content: str,
    style: Path,
    summary: str,
    logs: list[str],
    progress_cb,
    job_token,
) -> OperationResult:
    """One still: strength ramp strip → shared evolve_video (optional RIFE)."""
    from ..evolve_video import build_evolve_video, rife_opts_from_evolve_params
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import cleanup as vp_cleanup

    n = max(2, int(p.evolve_frames))
    s0 = float(np.clip(p.evolve_strength_start, 0.0, 1.0))
    s1 = float(p.strength) if p.evolve_strength_end < 0 else float(p.evolve_strength_end)
    s1 = float(np.clip(s1, 0.0, 1.0))
    strengths = [s0 + (s1 - s0) * (i / (n - 1)) for i in range(n)]

    still_out = finalize_output_path(
        p.output_path,
        source=content,
        default_suffix=p.suffix,
        default_ext=".png",
        allowed_exts=IMAGE_EXTS,
        output_dir=p.output_dir or None,
    )
    evolve_out = Path(still_out).with_name(Path(still_out).stem + "_evolve.mp4")

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="style_evolve_")
    success = False
    try:
        ws.create()
        cand = ws.root / "candidates"
        cand.mkdir(parents=True, exist_ok=True)

        def runner():
            job_control.bind(job_token)
            if p.engine == "gpu":
                from . import styletransfer_ov_engine as _ove

                return _ove.stylize_strength_strip(
                    content,
                    style,
                    cand,
                    strengths=strengths,
                    max_side=p.max_side,
                    progress_cb=progress_cb,
                )
            return ste.stylize_strength_strip(
                content,
                style,
                cand,
                strengths=strengths,
                max_side=p.max_side,
                style_size=p.style_size,
                progress_cb=progress_cb,
            )

        strip = await asyncio.to_thread(runner)
        if not strip.get("ok"):
            return OperationResult(
                ok=False,
                operation="styletransfer",
                error=strip.get("error") or "evolve strip failed",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
            )

        # Final still = last strength frame (also copy to still_out)
        paths = strip.get("paths") or []
        if paths:
            Path(still_out).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(paths[-1], still_out)
            logs.append(f"styled still (strength={s1:.2f}): {still_out}")

        result = await build_evolve_video(
            cand,
            evolve_out,
            fps=float(p.evolve_fps),
            rife=rife_opts_from_evolve_params(p),
            dedupe_metric=(p.evolve_metric if p.evolve_dedupe else None),
            dedupe_threshold=float(p.evolve_threshold),
            target_size=strip.get("size"),
            save_stills=bool(p.evolve_save_stills),
            progress_cb=progress_cb,
            workspace_prefix="style_evolve_enc_",
        )
        if result is None:
            return OperationResult(
                ok=False,
                operation="styletransfer",
                error="evolve encode skipped (need ≥2 frames)",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                output_path=str(still_out) if Path(still_out).is_file() else None,
            )
        logs.extend(result.logs)
        success = True
        return OperationResult(
            ok=True,
            operation="styletransfer",
            output_path=str(still_out),
            dry_run=False,
            command=summary,
            stdout=(
                "\n".join(logs)
                + f"\nOutput: {still_out}\nEvolve: {result.output_path}\n"
            ),
        )
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation="styletransfer", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="styletransfer", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        await vp_cleanup(ws, keep_on_failure=not success)


register(OperationSpec(
    id="styletransfer",
    summary="Neural style transfer (CPU Magenta or GPU OpenVINO AdaIN; optional Evolve video)",
    description=(
        "Arbitrary artistic style transfer. Engine 'cpu' = Magenta TF-Hub model "
        "(existing default); engine 'gpu' = OpenVINO AdaIN, strict GPU "
        "(fails loudly, no CPU fallback; needs POST /ops/styletransfer_ov_setup once). "
        "Pass content photo(s) or a folder, plus any style reference image. "
        "Outputs default next to each content as *_styled.png and never overwrite "
        "(auto _0001, _0002, …). "
        "Evolve: ramp strength over N frames (one neural pass) → optional RIFE → "
        "*_styled_evolve.mp4 via shared evolve_video bookend."
    ),
    params_model=StyleTransferParams,
    handler=styletransfer,
    tags=["styletransfer", "image", "video", "neural", "filter", "evolve"],
))


# ── OpenVINO AdaIN installer / status (GPU engine) ──────────────────────────

OV_IR_FILES = (
    ["style_encoder_fp16.xml", "style_encoder_fp16.bin"]
    + [
        f"content_stylize_{tag}_fp16.{ext}"
        for tag in ("512x512", "768x768", "1024x1024", "1080x1920")
        for ext in ("xml", "bin")
    ]
)
OV_DEV_SOURCE = Path("/home/m/snc/cod/testLamaEraser/ovs_style/artifacts")


def _ov_model_dir() -> Path:
    import os as _os

    env = _os.environ.get("OVS_STYLE_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    return Path(__file__).resolve().parent.parent.parent / "junk" / "models" / "ovs_style"


def _ov_source_dir() -> Path | None:
    import os as _os

    env = _os.environ.get("OVS_STYLE_SRC", "").strip()
    if env and Path(env).expanduser().is_dir():
        return Path(env).expanduser()
    if OV_DEV_SOURCE.is_dir():
        return OV_DEV_SOURCE
    return None


def get_styletransfer_ov_status() -> dict:
    """Read-only status payload for GET /api/styletransfer_ov/status."""
    from . import styletransfer_ov_engine as ove

    d = _ov_model_dir()
    files = {}
    try:
        files = {name: (d / name).is_file() for name in OV_IR_FILES}
    except OSError:
        pass
    resolved = ove.resolve_artifacts_dir()
    return {
        "ok": True,
        "ir_present": ove.ir_present(),
        "artifacts_dir": str(resolved) if resolved else None,
        "model_dir": str(d),
        "files": files,
        "devices": ove.available_devices(),
    }


class StyleTransferOvSetupParams(StyleTransferParams):
    style_path: str = Field(
        "",
        description="Unused for setup (inherited field, defaults empty).",
    )
    action: Literal["install", "update"] = Field(
        "install", description="install = copy missing IRs; update = re-copy all"
    )
    dry_run: bool = False  # re-declared for registry clarity (inherited anyway)


async def styletransfer_ov_setup(p: StyleTransferOvSetupParams) -> OperationResult:
    """Copy OVS-Style FP16 IRs into junk/models/ovs_style + CPU smoke + GPU probe.

    Cancel-safe between phases. Ends with a fresh status payload in meta +
    recommend_restart=false. Dry-run prints phases and changes nothing.
    """
    from . import styletransfer_ov_engine as ove

    op = "styletransfer_ov_setup"
    d = _ov_model_dir()
    src = _ov_source_dir()
    phases = [
        f"copy {len(OV_IR_FILES)} IR files → {d}",
        "compile-smoke on CPU (synthetic 256px input, no media needed)",
        "probe GPU compile+infer (non-fatal — CPU path already proven above)",
    ]
    plan = "\n".join(f"phase {i + 1}: {ph}" for i, ph in enumerate(phases))
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, dry_run=True, command=plan,
            stdout=f"styletransfer_ov_setup {p.action} (dry run — nothing changed)\n{plan}\n",
            meta={"dry_run": True, "status": {"styletransfer_ov": get_styletransfer_ov_status()},
                  "recommend_restart": False},
        )
    logs = [f"styletransfer_ov_setup {p.action} (AdaIN OpenVINO, Apache-2.0 weights via naoto0804/pytorch-AdaIN)"]
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
                "No OVS-Style IR source found — set $OVS_STYLE_SRC to a dir holding "
                "style_encoder_fp16.xml + content_stylize_*_fp16.xml, or place them in "
                f"{d} manually."
            )
        missing = [n for n in OV_IR_FILES if not (src / n).is_file()]
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
            for name in OV_IR_FILES:
                dest = d / name
                if p.action == "install" and dest.is_file():
                    continue
                shutil.copy2(src / name, dest)
                n += 1
            return n

        copied = await asyncio.to_thread(_copy)
        logs.append(f"IR files ready in {d} ({copied} copied, {len(OV_IR_FILES) - copied} kept)")

        _phase(1, len(phases))

        def _smoke(device: str) -> dict:
            rng = np.random.default_rng(7)
            if token:
                job_control.bind(token)
            settled = ove.preload(device=device)
            content = (rng.random((256, 256, 3)) * 255).astype(np.uint8)
            mean = rng.standard_normal((1, 512, 1, 1)).astype(np.float32)
            std = np.abs(rng.standard_normal((1, 512, 1, 1)).astype(np.float32)) + 0.1
            out = ove.stylize_array(content, mean, std, alpha=1.0, device=settled)
            return {"settled": settled, "shape": [int(v) for v in out.shape],
                    "mean": float(np.mean(out))}

        smoke = await asyncio.to_thread(_smoke, "CPU")
        logs.append(f"cpu smoke ok: settled={smoke['settled']} shape={smoke['shape']} mean={smoke['mean']:.1f}")

        _phase(2, len(phases))
        gpu_probe: dict = {"ok": False}
        try:
            gpu_probe = await asyncio.to_thread(_smoke, "GPU")
            gpu_probe["ok"] = True
            logs.append(f"gpu smoke ok: settled={gpu_probe['settled']} "
                        f"shape={gpu_probe['shape']} mean={gpu_probe['mean']:.1f}")
        except Exception as e:  # noqa: BLE001 — non-fatal, CPU path stands
            gpu_probe = {"ok": False, "error": str(e)[:300]}
            logs.append(f"gpu smoke skipped: {gpu_probe['error']}")
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"styletransfer_ov": get_styletransfer_ov_status()},
                  "recommend_restart": False},
        )
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"styletransfer_ov": get_styletransfer_ov_status()},
                  "recommend_restart": False},
        )
    if token:
        job_control.report_progress(
            "setup done", phase="done",
            current=len(phases), total=len(phases), unit="phases", token=token,
        )
    return OperationResult(
        ok=True, operation=op, command=plan, stdout="\n".join(logs),
        meta={"status": {"styletransfer_ov": get_styletransfer_ov_status()},
              "gpu_probe": gpu_probe,
              "recommend_restart": False},
    )


register(OperationSpec(
    id="styletransfer_ov_setup",
    summary="Install OVS-Style IRs for the GPU style-transfer engine",
    description=(
        "Copies the 10 AdaIN OpenVINO FP16 IR files into "
        "junk/models/ovs_style/, compile-smokes on CPU plus a non-fatal GPU "
        "probe. Source: $OVS_STYLE_SRC or the dev-machine build."
    ),
    params_model=StyleTransferOvSetupParams,
    handler=styletransfer_ov_setup,
    tags=["styletransfer", "setup", "openvino", "gpu"],
))
