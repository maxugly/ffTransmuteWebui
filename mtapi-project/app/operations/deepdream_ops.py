"""
DeepDream operation — wraps deepdream_engine for the typed ops registry.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control
from . import deepdream_engine as eng

MediaKind = Literal["auto", "image", "video"]
LayerPreset = Literal["shallow", "mid", "deep", "classic", "full", "custom"]
FrameTransform = Literal["none", "zoom", "zoom_rotate", "rotate", "translate"]
DreamModel = Literal["inception_v3", "vgg16", "resnet50"]


class DeepDreamParams(BaseModel):
    input_path: str = Field(..., description="Source image or video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    media_kind: MediaKind = Field(
        "auto",
        description="auto detects from extension; force image or video processing path",
    )

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
        15.0, ge=0, le=100,
        description="Stop ascent early when loss exceeds this; 0 = disabled",
    )
    blend: float = Field(
        1.0, ge=0.0, le=1.0,
        description="Mix dreamed result with original (1 = full dream)",
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
    mixed3: float = Field(0.0, ge=0, le=5, description="Custom weight for mixed3 (Inception only)")
    mixed4: float = Field(1.0, ge=0, le=5, description="Custom weight for mixed4 (Inception only)")
    mixed5: float = Field(1.5, ge=0, le=5, description="Custom weight for mixed5 (Inception only)")
    mixed6: float = Field(2.0, ge=0, le=5, description="Custom weight for mixed6 (Inception only)")
    mixed7: float = Field(2.5, ge=0, le=5, description="Custom weight for mixed7 (Inception only)")

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

    dry_run: bool = False


def _default_output(input_path: Path, kind: str, ouroboros: bool = False) -> Path:
    stem = input_path.stem
    parent = input_path.parent
    if ouroboros:
        return parent / f"{stem}_ouroboros.mp4"
    if kind == "video":
        return parent / f"{stem}_dream.mp4"
    return parent / f"{stem}_dream.png"


def _ensure_ext(path: Path, kind: str) -> Path:
    if kind == "video":
        if path.suffix.lower() not in eng.VIDEO_EXTS:
            return path.with_suffix(".mp4")
        return path
    if path.suffix.lower() not in eng.IMAGE_EXTS:
        return path.with_suffix(".png")
    return path


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

    from ..pathutil import unique_output_path

    out = (
        Path(p.output_path).expanduser().resolve()
        if p.output_path
        else _default_output(input_path, kind, ouroboros=p.ouroboros)
    )
    out = _ensure_ext(out, kind)
    out = unique_output_path(out)

    layer_weights = eng.resolve_layer_weights(
        p.layer_preset,
        model_name=p.model_name,
        custom_layer_weights=p.custom_layer_weights,
        mixed3=p.mixed3,
        mixed4=p.mixed4,
        mixed5=p.mixed5,
        mixed6=p.mixed6,
        mixed7=p.mixed7,
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
            result_path = await asyncio.to_thread(
                _in_job(
                    eng.dream_ouroboros,
                    input_path,
                    out,
                    length=p.ouroboros_length,
                    fps=p.ouroboros_fps,
                    frame_transform=p.frame_transform,
                    zoom=p.zoom,
                    rotation_deg=p.rotation_deg,
                    translate_x=p.translate_x,
                    translate_y=p.translate_y,
                    image_kwargs=image_kwargs,
                    progress_cb=progress_cb,
                ),
            )
        elif kind == "video":
            result_path = await asyncio.to_thread(
                _in_job(
                    eng.dream_video,
                    input_path,
                    out,
                    frame_step=p.frame_step,
                    max_frames=p.max_frames,
                    keep_audio=p.keep_audio,
                    temporal_blend=p.temporal_blend,
                    optical_flow=p.optical_flow,
                    layer_cycle=p.layer_cycle,
                    image_kwargs=image_kwargs,
                    progress_cb=progress_cb,
                ),
            )
        else:
            result_path = await asyncio.to_thread(
                _in_job(
                    eng.dream_image,
                    input_path,
                    out,
                    progress_cb=progress_cb,
                    **image_kwargs,
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
    summary="Google DeepDream (InceptionV3 gradient ascent)",
    description=(
        "DeepDream with selectable nets (InceptionV3 / VGG16 / ResNet50, ImageNet). "
        "Images, videos with temporal blend or DeepDreamAnim optical-flow residual warping, "
        "guided dreaming, layer cycling, and Ouroboros zoom/spin/translate. "
        "Requires TensorFlow; optical flow needs OpenCV."
    ),
    params_model=DeepDreamParams,
    handler=deepdream,
    tags=["deepdream", "generative", "image", "video", "ouroboros"],
))
