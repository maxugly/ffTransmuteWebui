"""
DeepDream operation — thin bookends + engine.

Video path: dump → app.filters.deepdream (per_frame) → encode.
Image path: eng.dream_image once.
Ouroboros: special feedback loop (not a pipeline stage of source video).

See docs/filter-platform-spec.md.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image as PILImage
from pydantic import Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from ..evolve_video import EvolveRifeParams
from ..frame_range import end_frame_field, start_frame_field
from . import deepdream as eng

MediaKind = Literal["auto", "image", "video"]
LayerPreset = Literal["shallow", "mid", "deep", "classic", "full", "custom"]
FrameTransform = Literal["none", "zoom", "zoom_rotate", "rotate", "translate"]
DreamModel = Literal["inception_v3", "vgg16", "resnet50"]


class DeepDreamParams(EvolveRifeParams):
    input_path: str = Field(..., description="Source image or video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    media_kind: MediaKind = Field(
        "auto",
        description="auto detects from extension; force image or video processing path",
    )
    keep_model_warm: bool = Field(False, description="Keep the neural model resident between runs")

    # Real network architecture (not just layer labels)
    model_name: DreamModel = Field(
        "inception_v3",
        description=(
            "Neural net to dream with: inception_v3 (classic Google), "
            "vgg16 (hierarchical), resnet50 (residual). ImageNet weights."
        ),
    )

    # Ascent / octave knobs
    step: float = Field(0.01, ge=0.0001, le=0.5, description="Gradient ascent step size")
    iterations: int = Field(20, ge=1, le=200, description="Ascent steps per octave")
    num_octave: int = Field(3, ge=1, le=10, description="Number of octave scales")
    octave_scale: float = Field(1.4, ge=1.05, le=2.5, description="Scale ratio between octaves")
    max_loss: float = Field(
        0.0, ge=0, le=1e9,
        description=(
            "Stop ascent early when objective exceeds this absolute value. "
            "0 = disabled (recommended). Inception losses are often O(1–20); "
            "VGG/ResNet can be O(1e5+) — a low ceiling early-stops after 1 step "
            "and yields a near-copy of the input. Engine also auto-ignores "
            "max_loss when baseline loss already exceeds the threshold."
        ),
    )
    blend: float = Field(
        1.0, ge=0.0, le=1.0,
        description="Mix dreamed result with original (1 = full dream)",
    )

    # ── Dynamic ramp (per-frame lerp on the video dream path) ──
    # Each `*_to` is the end value the corresponding base knob ramps toward over
    # the dumped clip. None = not ramping (constant, identical to today).
    step_to: float | None = Field(
        None, description="End step for per-frame linear ramp (video path only)")
    iterations_to: float | None = Field(
        None, description="End iterations for per-frame linear ramp (video path only)")
    num_octave_to: float | None = Field(
        None, description="End num_octave for per-frame linear ramp (video path only)")
    octave_scale_to: float | None = Field(
        None, description="End octave_scale for per-frame linear ramp (video path only)")
    max_loss_to: float | None = Field(
        None, description="End max_loss for per-frame linear ramp (video path only)")
    blend_to: float | None = Field(
        None, description="End blend for per-frame linear ramp (video path only)")
    custom_layer_weights_to: dict[str, float] | None = Field(
        None,
        description="End custom layer weights (lerped per key, absent key = 0.0)",
    )

    # Binary-style options
    jitter: bool = Field(True, description="Random roll jitter during ascent (stabilizes)")
    reinject_detail: bool = Field(True, description="Reinject lost detail between octaves")
    keep_audio: bool = Field(True, description="For video: keep original audio track")

    # Layers (within the chosen model)
    layer_preset: LayerPreset = Field(
        "classic",
        description="Depth preset mapped to real layers of the selected model",
    )
    custom_layer_weights: dict[str, float] | None = Field(
        None,
        description="Optional explicit {layer_name: weight} map (overrides preset when custom)",
    )
    # Legacy Inception knobs (still accepted)
    mixed0: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed0 (Inception only)")
    mixed1: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed1 (Inception only)")
    mixed2: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed2 (Inception only)")
    mixed3: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed3 (Inception only)")
    mixed4: float = Field(1.0, ge=0, le=5, description="Custom weight for mixed4 (Inception only)")
    mixed5: float = Field(1.5, ge=0, le=5, description="Custom weight for mixed5 (Inception only)")
    mixed6: float = Field(2.0, ge=0, le=5, description="Custom weight for mixed6 (Inception only)")
    mixed7: float = Field(2.5, ge=0, le=5, description="Custom weight for mixed7 (Inception only)")
    mixed8: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed8 (Inception only)")
    mixed9: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed9 (Inception only)")
    mixed10: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed10 (Inception only)")

    # Video-only (source video dream)
    frame_step: int = Field(
        1, ge=1, le=60,
        description="Process every Nth frame (others copy last dream for speed)",
    )
    max_frames: int | None = Field(
        None, ge=1,
        description="Optional cap on frames processed (video smoke tests)",
    )
    temporal_blend: float = Field(
        0.85, ge=0.0, le=1.0,
        description=(
            "DeepDream video flicker control (simple alpha mix): "
            "mix last dreamed frame with current source before dreaming. "
            "1.0 = pure current frame (no temporal mix); 0.85 is the classic default. "
            "Ignored when optical_flow is on."
        ),
    )
    optical_flow: bool = Field(
        False,
        description=(
            "DeepDreamAnim-style optical flow: warp the hallucination residual "
            "(prev_dream − prev_src) onto the current frame with Farneback flow, "
            "so features stick to motion. Requires OpenCV."
        ),
    )
    layer_cycle: bool = Field(
        False,
        description=(
            "DeepDreamAnim multi-layer loop: cycle one active layer per frame "
            "instead of optimizing all weighted layers every frame"
        ),
    )
    guide_path: str | None = Field(
        None,
        description="Optional guide image for guided DeepDream (match guide features)",
    )
    preview_width: int = Field(
        0, ge=0, le=4096,
        description="If >0, downscale input width for faster previews (DeepDreamAnim)",
    )

    # Ouroboros (gordicaleksa/pytorch-deepdream zoom / spin / translate feedback)
    ouroboros: bool = Field(
        False,
        description=(
            "If true, treat input as image and generate a feedback video: "
            "dream → zoom/spin/translate transform → feed back (Ouroboros)"
        ),
    )
    ouroboros_length: int = Field(
        30, ge=1, le=600,
        description="Number of Ouroboros frames (video length = length / fps)",
    )
    ouroboros_fps: float = Field(
        30.0, ge=1.0, le=120.0,
        description="Frames per second of the Ouroboros output video",
    )
    frame_transform: FrameTransform = Field(
        "zoom_rotate",
        description="Geometric feedback: none|zoom|zoom_rotate|rotate|translate",
    )
    zoom: float = Field(
        1.04, ge=0.85, le=1.25,
        description="Per-frame zoom at 30fps (>1 zooms in). Used by zoom / zoom_rotate",
    )
    rotation_deg: float = Field(
        1.5, ge=-30.0, le=30.0,
        description="Degrees of spin per frame at 30fps. Used by rotate / zoom_rotate",
    )
    translate_x: float = Field(
        5.0, ge=-50.0, le=50.0,
        description="Horizontal pixels per frame at 30fps (translate: + = right)",
    )
    translate_y: float = Field(
        5.0, ge=-50.0, le=50.0,
        description="Vertical pixels per frame at 30fps (translate: + = down; +x+y = top-left→bottom-right)",
    )

    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = False

    # ── Evolve video (mid-ascent strip → dedupe → optional RIFE → encode) ──
    # RIFE + fps + save_stills: inherited from EvolveRifeParams
    evolve_enabled: bool = Field(
        False,
        description="Capture mid-ascent frames, drop near-dups, encode evolve video",
    )
    evolve_metric: str = Field(
        "phash",
        description="Image Sort distance metric: phash|ahash|colorhash|mse|ssim",
    )
    evolve_threshold: float = Field(
        4.0, ge=0.0,
        description="Min distance to keep (0 = keep all). pHash default 4 Hamming",
    )
    evolve_capture_every: int = Field(
        0, ge=0, le=50,
        description="0 = live cadence; else every N ascent publishes",
    )
    evolve_max_candidates: int = Field(500, ge=10, le=2000)


async def _build_evolve_video(
    *,
    candidates_dir: Path,
    still_output: Path,
    p: DeepDreamParams,
    logs: list[str],
    progress_cb,
) -> Path | None:
    """Thin wrapper → shared app.evolve_video.build_evolve_video."""
    from ..evolve_video import build_evolve_video, rife_opts_from_evolve_params

    evolve_out = still_output.with_name(still_output.stem + "_evolve.mp4")
    with PILImage.open(still_output) as im:
        tw, th = im.width, im.height

    result = await build_evolve_video(
        candidates_dir,
        evolve_out,
        fps=float(p.evolve_fps),
        rife=rife_opts_from_evolve_params(p),
        dedupe_metric=(p.evolve_metric or "phash"),
        dedupe_threshold=float(p.evolve_threshold),
        target_size=(tw, th),
        save_stills=bool(p.evolve_save_stills),
        progress_cb=progress_cb,
        workspace_prefix="dream_evolve_",
    )
    if result is None:
        logs.append("evolve: skip (not enough candidates)")
        return None
    logs.extend(result.logs)
    return result.output_path


async def _dream_video(
    p: DeepDreamParams, input_path: Path, out: Path,
    image_kwargs: dict, job_token, logs, progress_cb,
) -> OperationResult:
    """Video dream: dump → shared deepdream per_frame stage → encode."""
    import uuid

    from ..filters.deepdream import make_deepdream_filter
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import cleanup, dump, encode as vp_encode, process

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="dream_video_")
    success = False
    try:
        dump_info = await dump(
            ws, input_path, start_frame=p.start_frame, end_frame=p.end_frame,
        )
        frames = sorted(ws.frames_in.glob("frame_*.png"))
        if not frames:
            raise RuntimeError("No frames extracted from video")
        logs.append(
            f"dump: {len(frames)} frames "
            f"(src {p.start_frame}–{p.end_frame if p.end_frame < 999999 else 'end'})"
        )

        # Optional smoke-test cap: drop trailing frames so process sees only N
        if p.max_frames and p.max_frames > 0 and len(frames) > int(p.max_frames):
            for fr in frames[int(p.max_frames):]:
                fr.unlink(missing_ok=True)
            frames = frames[: int(p.max_frames)]
            logs.append(f"max_frames={p.max_frames} (kept {len(frames)} frames)")

        fps = dump_info["fps"]
        total = len(frames)
        to_process = (total + p.frame_step - 1) // p.frame_step if total else 0

        filter_fn = make_deepdream_filter(
            **image_kwargs,
            temporal_blend=p.temporal_blend,
            optical_flow=p.optical_flow,
            layer_cycle=p.layer_cycle,
            frame_step=p.frame_step,
            total_frames=len(frames),
            step_to=p.step_to,
            iterations_to=p.iterations_to,
            num_octave_to=p.num_octave_to,
            octave_scale_to=p.octave_scale_to,
            max_loss_to=p.max_loss_to,
            blend_to=p.blend_to,
            custom_layer_weights_to=p.custom_layer_weights_to,
        )

        def _progress(current: int, total_n: int) -> None:
            if progress_cb:
                progress_cb(
                    f"[frame {current}/{total_n}] dream",
                    phase="video-frames",
                    current=current,
                    total=to_process or total_n,
                    unit="frames",
                    latest_frame=str(ws.frames_out / f"frame_{current-1:06d}.png"),
                )

        processed = await process(ws, filter_fn, progress_cb=_progress)
        logs.append(f"process: {processed} frames via filters.deepdream")

        result_path = await vp_encode(ws, out, fps, mux_audio=p.keep_audio)
        success = True
        return OperationResult(
            ok=True, operation="deepdream", output_path=str(result_path),
            command=f"dream_video filter {input_path.name}",
            stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="deepdream", error=str(e),
            stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        await cleanup(ws, keep_on_failure=not success)


async def _dream_ouroboros(
    p: DeepDreamParams, input_path: Path, out: Path,
    image_kwargs: dict, job_token, logs, progress_cb,
) -> OperationResult:
    """Ouroboros via JobWorkspace + VideoPipeline encode."""
    import uuid

    from ..job_workspace import JobWorkspace
    from ..video_pipeline import cleanup as vp_cleanup
    from ..video_pipeline import encode as vp_encode
    from .deepdream.dream import dream_image, transform_frame

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="dream_ouro_")
    ws.create()
    success = False
    try:
        seed = ws.root / "seed.png"
        PILImage.open(input_path).convert("RGB").save(seed)

        from .. import job_control as jc

        def _run_thread():
            current = seed
            n_ouro = int(p.ouroboros_length)
            for i in range(n_ouro):
                jc.check_cancelled()
                out_fr = ws.frames_out / f"frame_{i:06d}.png"
                if progress_cb:
                    progress_cb(
                        f"ouro {i + 1}/{n_ouro} dreaming…",
                        phase="ouroboros",
                        current=i,
                        total=n_ouro,
                        unit="frames",
                    )
                
                def _ouro_prog(msg, **kw):
                    if progress_cb:
                        if "current" in kw and "total" in kw:
                            # Translate inner ascent steps (which now span all octaves)
                            # into a global step count spanning all Ouroboros frames.
                            step_total = kw["total"]
                            step_curr = kw["current"]
                            kw["total"] = step_total * n_ouro
                            kw["current"] = (i * step_total) + step_curr
                            kw["phase"] = "ouroboros"
                            kw["unit"] = "overall steps"
                            msg = f"[frame {i + 1}/{n_ouro}] {msg}"
                        progress_cb(msg, **kw)

                # Mid-ascent live via dream_image → /tmp/mtapi_live/{token}.png
                dream_image(current, out_fr, progress_cb=_ouro_prog, **image_kwargs)
                # After write: point Live at the finished ouro frame
                if progress_cb:
                    progress_cb(
                        f"ouro {i + 1}/{n_ouro} saved",
                        phase="ouroboros",
                        current=i + 1,
                        total=n_ouro,
                        unit="frames",
                        latest_frame=str(out_fr),
                    )

                if i + 1 < n_ouro and p.frame_transform and p.frame_transform != "none":
                    arr = np.asarray(PILImage.open(out_fr).convert("RGB"))
                    transformed = transform_frame(
                        arr, mode=p.frame_transform, zoom=p.zoom,
                        rotation_deg=p.rotation_deg, translate_x=p.translate_x,
                        translate_y=p.translate_y, fps=float(p.ouroboros_fps),
                    )
                    next_in = ws.root / f"in_{i:06d}.png"
                    PILImage.fromarray(transformed).save(next_in)
                    current = next_in
                else:
                    current = out_fr

        await asyncio.to_thread(_run_thread)

        result_path = await vp_encode(ws, out, float(p.ouroboros_fps), mux_audio=False)
        success = True
        return OperationResult(
            ok=True, operation="deepdream", output_path=str(result_path),
            command=f"dream_ouroboros {input_path.name}", stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="deepdream", error=str(e),
            stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        await vp_cleanup(ws, keep_on_failure=not success)


async def deepdream(p: DeepDreamParams) -> OperationResult:
    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False,
            operation="deepdream",
            error=f"Input not found: {input_path}",
            dry_run=p.dry_run,
        )

    kind = p.media_kind
    if kind == "auto":
        kind = eng.detect_media_kind(input_path)

    # Ouroboros always produces video from an image seed
    if p.ouroboros:
        kind = "video"

    from ..pathutil import finalize_output_path

    if p.ouroboros:
        default_suffix, default_ext = "_ouroboros", ".mp4"
        allowed = set(eng.VIDEO_EXTS)
    elif kind == "video":
        default_suffix, default_ext = "_dream", ".mp4"
        allowed = set(eng.VIDEO_EXTS)
    else:
        default_suffix, default_ext = "_dream", ".png"
        allowed = set(eng.IMAGE_EXTS)

    out = finalize_output_path(
        p.output_path,
        source=input_path,
        default_suffix=default_suffix,
        default_ext=default_ext,
        allowed_exts=allowed,
    )

    layer_weights = eng.resolve_layer_weights(
        p.layer_preset,
        model_name=p.model_name,
        custom_layer_weights=p.custom_layer_weights,
        mixed0=p.mixed0,
        mixed1=p.mixed1,
        mixed2=p.mixed2,
        mixed3=p.mixed3,
        mixed4=p.mixed4,
        mixed5=p.mixed5,
        mixed6=p.mixed6,
        mixed7=p.mixed7,
        mixed8=p.mixed8,
        mixed9=p.mixed9,
        mixed10=p.mixed10,
        use_custom_weights=(p.layer_preset == "custom"),
    )

    image_kwargs = {
        "model_name": p.model_name,
        "layer_preset": p.layer_preset,
        "layer_weights": layer_weights,
        "step": p.step,
        "iterations": p.iterations,
        "num_octave": p.num_octave,
        "octave_scale": p.octave_scale,
        "max_loss": p.max_loss,
        "jitter": p.jitter,
        "reinject_detail": p.reinject_detail,
        "blend": p.blend,
        "guide_path": p.guide_path,
        "preview_width": p.preview_width or None,
    }

    summary = (
        f"deepdream {kind} model={p.model_name} step={p.step} iter={p.iterations} "
        f"octaves={p.num_octave} scale={p.octave_scale} "
        f"preset={p.layer_preset} layers={layer_weights}"
    )
    if p.guide_path:
        summary += f" guide={p.guide_path}"
    if p.preview_width:
        summary += f" preview_w={p.preview_width}"
    if p.evolve_enabled:
        summary += (
            f" evolve=on fps={p.evolve_fps} metric={p.evolve_metric}"
            f" thr={p.evolve_threshold} rife={p.evolve_use_rife}"
            f"×{p.evolve_rife_multiplier if p.evolve_use_rife else 1}"
        )
    if p.ouroboros:
        summary += (
            f" ouroboros length={p.ouroboros_length} fps={p.ouroboros_fps} "
            f"transform={p.frame_transform} zoom={p.zoom} spin={p.rotation_deg} "
            f"tx={p.translate_x} ty={p.translate_y}"
        )
    elif kind == "video":
        summary += (
            f" frame_step={p.frame_step} keep_audio={p.keep_audio} "
            f"temporal_blend={p.temporal_blend} optical_flow={p.optical_flow} "
            f"layer_cycle={p.layer_cycle}"
        )

    if p.dry_run:
        return OperationResult(
            ok=True,
            operation="deepdream",
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=f"Command: {summary}\nOutput: {out}\n",
        )

    logs: list[str] = []
    job_token = job_control.current_token()

    def progress_cb(msg: str, **kw) -> None:
        """String + optional structured progress (current/total/phase) for the UI poller."""
        logs.append(msg)
        try:
            job_control.report_progress(msg, token=job_token, **kw)
        except Exception:
            pass
        job_control.check_cancelled()

    def _in_job(fn, *args, **kwargs):
        """Run engine work in a worker thread with cancel token bound."""
        def runner():
            job_control.bind(job_token)
            try:
                return fn(*args, **kwargs)
            finally:
                # don't unregister — request still owns the token
                pass
        return runner

    try:
        if p.ouroboros:
            return await _dream_ouroboros(
                p, input_path, out, image_kwargs, job_token, logs, progress_cb,
            )
        elif kind == "video":
            return await _dream_video(
                p, input_path, out, image_kwargs, job_token, logs, progress_cb,
            )
        else:
            evolve_dir = None
            evolve_ws = None
            if p.evolve_enabled:
                import uuid as _uuid
                from ..job_workspace import JobWorkspace
                evolve_ws = JobWorkspace(_uuid.uuid4().hex[:12], prefix="dream_still_")
                evolve_ws.create()
                evolve_dir = evolve_ws.root / "evolve_candidates"
                evolve_dir.mkdir(parents=True, exist_ok=True)
                image_kwargs = {
                    **image_kwargs,
                    "evolve_dir": str(evolve_dir),
                    "evolve_max_candidates": int(p.evolve_max_candidates),
                    "evolve_capture_every": int(p.evolve_capture_every),
                }
            result_path = await asyncio.to_thread(
                _in_job(
                    eng.dream_image,
                    input_path,
                    out,
                    progress_cb=progress_cb,
                    **image_kwargs,
                ),
            )
            evolve_path = None
            if p.evolve_enabled and evolve_dir is not None:
                try:
                    evolve_path = await _build_evolve_video(
                        candidates_dir=Path(evolve_dir),
                        still_output=Path(result_path),
                        p=p,
                        logs=logs,
                        progress_cb=progress_cb,
                    )
                except Exception as ev_err:
                    logs.append(f"evolve failed: {ev_err}")
                finally:
                    if evolve_ws is not None:
                        from ..video_pipeline import cleanup as vp_cleanup
                        await vp_cleanup(evolve_ws, keep_on_failure=True)
            if evolve_path is not None:
                logs.append(f"Evolve: {evolve_path}")
                # Still is primary for compat; mention evolve in stdout
                return OperationResult(
                    ok=True,
                    operation="deepdream",
                    output_path=str(result_path),
                    dry_run=False,
                    command=summary,
                    stdout=(
                        "\n".join(logs)
                        + f"\nOutput: {result_path}\nEvolve: {evolve_path}\n"
                    ),
                )
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False,
            operation="deepdream",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            error=str(e),
        )
    except Exception as e:
        if "Cancelled by user" in str(e):
            return OperationResult(
                ok=False,
                operation="deepdream",
                dry_run=False,
                command=summary,
                stdout="\n".join(logs),
                error="Cancelled by user",
            )
        return OperationResult(
            ok=False,
            operation="deepdream",
            dry_run=False,
            command=summary,
            stdout="\n".join(logs),
            stderr=str(e),
            error=str(e),
        )

    return OperationResult(
        ok=True,
        operation="deepdream",
        output_path=str(result_path),
        dry_run=False,
        command=summary,
        stdout="\n".join(logs) + f"\nOutput: {result_path}\n",
    )


register(OperationSpec(
    id="deepdream",
    summary="Google DeepDream (+ optional Evolve video)",
    description=(
        "DeepDream with selectable nets (InceptionV3 / VGG16 / ResNet50, ImageNet). "
        "Images, videos with temporal blend or DeepDreamAnim optical-flow residual warping, "
        "guided dreaming, layer cycling, and Ouroboros zoom/spin/translate. "
        "Optional Evolve: mid-ascent strip → Image Sort dedupe → optional RIFE → .mp4. "
        "Requires TensorFlow; optical flow needs OpenCV."
    ),
    params_model=DeepDreamParams,
    handler=deepdream,
    tags=["deepdream", "generative", "image", "video", "ouroboros", "filter"],
))
