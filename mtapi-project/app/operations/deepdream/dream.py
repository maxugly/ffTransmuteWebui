"""
Core DeepDream functions: dream_image, dream_video, dream_ouroboros,
and temporal helpers (optical flow, blend, transform).
"""
from __future__ import annotations

import shutil
import tempfile as _tf
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .models import (
    DEFAULT_MODEL,
    FRAME_TRANSFORMS,
    MIN_DREAM_SIDE,
    MODEL_MIN_SIDE,
    MODEL_PRESETS,
    VIDEO_EXTS,
    _build_feature_extractor,
    _deprocess,
    _even_min,
    _maybe_preview_resize,
    _normalize_model_name,
    _preprocess,
    _probe_video,
    _require_tf,
)


# ── dream_image ────────────────────────────────────────────────────────────

def dream_image(
    input_path: Path,
    output_path: Path,
    *,
    model_name: str = DEFAULT_MODEL,
    layer_preset: str = "classic",
    layer_weights: dict[str, float] | None = None,
    step: float = 0.01,
    iterations: int = 20,
    num_octave: int = 3,
    octave_scale: float = 1.4,
    max_loss: float | None = 15.0,
    jitter: bool = True,
    reinject_detail: bool = True,
    blend: float = 1.0,
    guide_path: str | Path | None = None,
    preview_width: int | None = None,
    progress_cb=None,
) -> Path:
    """Run DeepDream on a single image. Returns output_path.

    ``model_name``: inception_v3 | vgg16 | resnet50 (real different nets).
    ``guide_path`` enables guided dreaming (Google / DeepDreamAnim style).
    ``preview_width`` downscales wide inputs for faster iteration.
    """
    tf, keras = _require_tf()

    model_name = _normalize_model_name(model_name)
    min_side = MODEL_MIN_SIDE.get(model_name, MIN_DREAM_SIDE)

    input_path = Path(input_path)
    preview_tmp = None
    if preview_width and int(preview_width) > 0:
        from ...png_pipeline import PngFramePipeline, dump_sync, encode_sync  # noqa: F811
        pipeline = PngFramePipeline(prefix="mtapi_prev_")
        work = Path(_tf.mkdtemp(prefix="mtapi_prev_"))
        pipeline._tmpdir = str(work)
        preview_tmp = work
        input_path = _maybe_preview_resize(input_path, int(preview_width), work)
        if progress_cb and input_path.name.startswith("_preview_"):
            progress_cb(f"preview width={preview_width}px")

    if layer_weights:
        layer_settings = {k: float(v) for k, v in layer_weights.items() if float(v) > 0}
    else:
        presets = MODEL_PRESETS.get(model_name) or MODEL_PRESETS[DEFAULT_MODEL]
        layer_settings = dict(presets.get(layer_preset) or presets.get("classic") or next(iter(presets.values())))
    if not layer_settings:
        layer_settings = dict(MODEL_PRESETS[DEFAULT_MODEL]["classic"])

    if max_loss is not None and max_loss <= 0:
        max_loss = None

    if progress_cb:
        progress_cb(
            f"model={model_name} layers={list(layer_settings.keys())}",
            phase="model",
        )

    feature_extractor, _model = _build_feature_extractor(keras, model_name, layer_settings)

    guide_feats: dict[str, Any] | None = None
    if guide_path:
        gp = Path(guide_path).expanduser().resolve()
        if not gp.is_file():
            raise FileNotFoundError(f"Guide image not found: {gp}")
        if progress_cb:
            progress_cb(f"guided dream ← {gp.name}")
        g_img = _preprocess(tf, keras, gp, model_name)
        g_img = tf.image.resize(g_img, (224, 224))
        raw = feature_extractor(g_img)
        if isinstance(raw, dict):
            guide_feats = {k: tf.constant(v) for k, v in raw.items()}
        else:
            name = next(iter(layer_settings))
            guide_feats = {name: tf.constant(raw)}

    def compute_loss(input_image):
        features = feature_extractor(input_image)
        if not isinstance(features, dict):
            name = next(iter(layer_settings))
            features = {name: features}
        loss = tf.zeros(shape=())
        for name, activation in features.items():
            coeff = float(layer_settings.get(name, 1.0))
            if guide_feats is not None and name in guide_feats:
                y = guide_feats[name]
                y = tf.image.resize(y, tf.shape(activation)[1:3])
                ch = tf.shape(activation)[-1]
                x = tf.reshape(activation, [-1, ch])
                yf = tf.reshape(y, [-1, ch])
                x_n = tf.nn.l2_normalize(x, axis=-1)
                y_n = tf.nn.l2_normalize(yf, axis=-1)
                A = tf.matmul(x_n, y_n, transpose_b=True)
                idx = tf.argmax(A, axis=1)
                matched = tf.gather(yf, idx)
                loss = loss + coeff * tf.reduce_mean(x * matched)
            else:
                act_shape = tf.shape(activation)
                h, w = act_shape[1], act_shape[2]
                use_crop = tf.logical_and(h > 6, w > 6)
                crop = tf.cond(
                    use_crop,
                    lambda a=activation: a[:, 2:-2, 2:-2, :],
                    lambda a=activation: a,
                )
                scaling = tf.reduce_prod(tf.cast(tf.shape(crop), "float32"))
                scaling = tf.maximum(scaling, 1.0)
                loss = loss + coeff * tf.reduce_sum(tf.square(crop)) / scaling
        return loss

    def gradient_ascent_step(img, learning_rate):
        with tf.GradientTape() as tape:
            tape.watch(img)
            loss = compute_loss(img)
        grads = tape.gradient(loss, img)
        grads = grads / tf.maximum(tf.reduce_mean(tf.abs(grads)), 1e-6)
        img = img + learning_rate * grads
        return loss, img

    def gradient_ascent_loop(img, iterations, learning_rate, max_loss=None):
        from ... import job_control
        h = int(img.shape[1]) if img.shape[1] is not None else MIN_DREAM_SIDE
        w = int(img.shape[2]) if img.shape[2] is not None else MIN_DREAM_SIDE
        max_jit = max(1, min(16, min(h, w) // 8))
        for i in range(int(iterations)):
            job_control.check_cancelled()
            ox = oy = 0
            if jitter:
                ox = int(np.random.randint(-max_jit, max_jit + 1))
                oy = int(np.random.randint(-max_jit, max_jit + 1))
                img = tf.roll(tf.roll(img, ox, 2), oy, 1)
            loss, img = gradient_ascent_step(img, learning_rate)
            if jitter and (ox or oy):
                img = tf.roll(tf.roll(img, -ox, 2), -oy, 1)
            if max_loss is not None and float(loss) > float(max_loss):
                break
            if progress_cb and (i == 0 or (i + 1) % 5 == 0 or i + 1 == iterations):
                progress_cb(
                    f"ascent step {i + 1}/{iterations} loss={float(loss):.2f}",
                    phase="ascent",
                    current=i + 1,
                    total=int(iterations),
                    unit="steps",
                )
        return img

    try:
        original_img = _preprocess(tf, keras, input_path, model_name)
        original_shape = tuple(int(x) for x in original_img.shape[1:3])

        work_h = _even_min(original_shape[0], min_side)
        work_w = _even_min(original_shape[1], min_side)
        work_shape = (work_h, work_w)
        if work_shape != original_shape:
            if progress_cb:
                progress_cb(
                    f"upscaling {original_shape[1]}×{original_shape[0]} → "
                    f"{work_w}×{work_h} for {model_name} (min side {min_side}px)"
                )
            work_img = tf.image.resize(original_img, work_shape, method="bilinear")
        else:
            work_img = original_img

        successive_shapes: list[tuple[int, int]] = [work_shape]
        n_oct = max(1, int(num_octave))
        scale = max(1.05, float(octave_scale))
        for i in range(1, n_oct):
            h = _even_min(int(work_h / (scale ** i)), min_side)
            w = _even_min(int(work_w / (scale ** i)), min_side)
            shape = (h, w)
            if shape == successive_shapes[-1]:
                break
            if shape not in successive_shapes:
                successive_shapes.append(shape)
        successive_shapes = successive_shapes[::-1]

        n_shapes = len(successive_shapes)
        if progress_cb:
            progress_cb(
                f"octaves: {' → '.join(f'{w}×{h}' for h, w in successive_shapes)}",
                phase="octaves",
                current=0,
                total=n_shapes,
                unit="octaves",
            )

        shrunk_original_img = tf.image.resize(work_img, successive_shapes[0])
        img = tf.identity(work_img)

        from ... import job_control
        for i, shape in enumerate(successive_shapes):
            job_control.check_cancelled()
            if progress_cb:
                progress_cb(
                    f"octave {i + 1}/{n_shapes} shape={shape[1]}×{shape[0]}",
                    phase="octave",
                    current=i + 1,
                    total=n_shapes,
                    unit="octaves",
                )
            img = tf.image.resize(img, shape)
            img = gradient_ascent_loop(
                img,
                iterations=iterations,
                learning_rate=step,
                max_loss=max_loss,
            )
            if reinject_detail:
                upscaled_shrunk = tf.image.resize(shrunk_original_img, shape)
                same_size_original = tf.image.resize(work_img, shape)
                lost_detail = same_size_original - upscaled_shrunk
                img = img + lost_detail
                shrunk_original_img = tf.image.resize(work_img, shape)

        img = tf.image.resize(img, original_shape)
        out_arr = _deprocess(img.numpy(), model_name)

        blend = float(max(0.0, min(1.0, blend)))
        if blend < 1.0:
            base = Image.open(input_path).convert("RGB").resize(
                (out_arr.shape[1], out_arr.shape[0]), Image.Resampling.LANCZOS
            )
            base_np = np.asarray(base, dtype=np.float32)
            dream_np = out_arr.astype(np.float32)
            mixed = base_np * (1.0 - blend) + dream_np * blend
            out_arr = np.clip(mixed, 0, 255).astype(np.uint8)

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        keras.utils.save_img(str(output_path), out_arr)
        return output_path
    finally:
        if preview_tmp is not None:
            pipeline.cleanup()


# ── temporal helpers ───────────────────────────────────────────────────────

def linear_blend(img1, img2, alpha: float):
    """Blend two HxWx3 arrays: (1-alpha)*img1 + alpha*img2."""
    a = float(max(0.0, min(1.0, alpha)))
    a1 = np.asarray(img1, dtype=np.float32)
    a2 = np.asarray(img2, dtype=np.float32)
    if a1.shape != a2.shape:
        im1 = Image.fromarray(np.clip(a1, 0, 255).astype(np.uint8)).resize(
            (a2.shape[1], a2.shape[0]), Image.Resampling.BILINEAR
        )
        a1 = np.asarray(im1, dtype=np.float32)
    out = a1 + a * (a2 - a1)
    return np.clip(out, 0, 255).astype(np.uint8)


def _optical_flow_seed(
    prev_src: np.ndarray,
    prev_dream: np.ndarray,
    curr_src: np.ndarray,
) -> np.ndarray:
    """Warp dream residual from prev→curr with Farneback optical flow."""
    import cv2

    prev_src = np.asarray(prev_src, dtype=np.float32)
    prev_dream = np.asarray(prev_dream, dtype=np.float32)
    curr_src = np.asarray(curr_src, dtype=np.float32)
    if prev_src.shape[:2] != curr_src.shape[:2]:
        prev_src = cv2.resize(prev_src, (curr_src.shape[1], curr_src.shape[0]))
        prev_dream = cv2.resize(prev_dream, (curr_src.shape[1], curr_src.shape[0]))

    h, w = curr_src.shape[:2]
    prev_g = cv2.cvtColor(np.clip(prev_src, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    curr_g = cv2.cvtColor(np.clip(curr_src, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)

    flow = cv2.calcOpticalFlowFarneback(
        prev_g, curr_g,
        None,
        pyr_scale=0.5, levels=3, winsize=15,
        iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
    )
    flow = -flow
    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    map_x = flow[:, :, 0] + grid_x
    map_y = flow[:, :, 1] + grid_y

    halludiff = prev_dream - prev_src
    warped = cv2.remap(
        halludiff.astype(np.float32),
        map_x, map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT,
    )
    seed = curr_src + warped
    return np.clip(seed, 0, 255).astype(np.uint8)


def _cycle_layer_weights(base: dict[str, float], frame_idx: int, cycle: bool) -> dict[str, float]:
    if not cycle or not base:
        return base
    names = list(base.keys())
    if len(names) <= 1:
        return base
    pick = names[frame_idx % len(names)]
    return {pick: float(base[pick])}


def transform_frame(
    frame,
    *,
    mode: str = "zoom_rotate",
    zoom: float = 1.04,
    rotation_deg: float = 1.5,
    translate_x: float = 5.0,
    translate_y: float = 5.0,
    fps: float = 30.0,
):
    """Apply a geometric transform for Ouroboros feedback (PIL affine)."""
    import math

    mode = (mode or "none").lower().replace("-", "_")
    if mode not in FRAME_TRANSFORMS:
        mode = "none"
    if mode == "none":
        return frame

    arr = np.asarray(frame)
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError("transform_frame expects HxWx3 image")
    h, w = arr.shape[:2]
    ref_fps = 30.0
    fps = float(fps) if fps and fps > 0 else ref_fps
    rate = ref_fps / fps

    z = 1.0
    deg = 0.0
    tx = ty = 0.0
    if mode in ("zoom", "zoom_rotate"):
        z = 1.0 + (float(zoom) - 1.0) * rate
    if mode in ("rotate", "zoom_rotate"):
        deg = float(rotation_deg) * rate
    if mode == "translate":
        tx = float(translate_x) * rate
        ty = float(translate_y) * rate

    if arr.dtype != np.uint8:
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    else:
        im = Image.fromarray(arr)

    cx, cy = w / 2.0, h / 2.0
    ang = math.radians(deg)
    cos_a, sin_a = math.cos(ang), math.sin(ang)
    s = 1.0 / z if abs(z) > 1e-6 else 1.0
    a = cos_a * s
    b = sin_a * s
    d = -sin_a * s
    e = cos_a * s
    c = cx - a * cx - b * cy - tx
    f = cy - d * cx - e * cy - ty

    out = im.transform(
        (w, h),
        Image.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC,
        fillcolor=(0, 0, 0),
    )
    return np.asarray(out)


# ── dream_video ────────────────────────────────────────────────────────────

def dream_video(
    input_path: Path,
    output_path: Path,
    *,
    frame_step: int = 1,
    max_frames: int | None = None,
    keep_audio: bool = True,
    temporal_blend: float = 0.85,
    optical_flow: bool = False,
    layer_cycle: bool = False,
    image_kwargs: dict[str, Any] | None = None,
    progress_cb=None,
) -> Path:
    input_path = Path(input_path)
    output_path = Path(output_path)
    image_kwargs = dict(image_kwargs or {})
    frame_step = max(1, int(frame_step))
    temporal_blend = float(temporal_blend)
    use_temporal = (not optical_flow) and (0.0 <= temporal_blend < 1.0 - 1e-9)

    if optical_flow:
        try:
            import cv2  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                "Optical flow requires OpenCV. Install: pip install opencv-python-headless"
            ) from e

    model_name = _normalize_model_name(image_kwargs.get("model_name"))
    base_layers = image_kwargs.get("layer_weights")
    if not base_layers:
        preset = image_kwargs.get("layer_preset") or "classic"
        presets = MODEL_PRESETS.get(model_name) or MODEL_PRESETS[DEFAULT_MODEL]
        base_layers = dict(presets.get(preset) or presets.get("classic") or next(iter(presets.values())))

    meta = _probe_video(input_path)
    fps = meta.get("fps") or 25.0

    from ...png_pipeline import PngFramePipeline, dump_sync, encode_sync
    pipeline = PngFramePipeline(prefix="mtapi_dream_")
    work = Path(_tf.mkdtemp(prefix="mtapi_dream_"))
    pipeline._tmpdir = str(work)
    try:
        frames_dir = work / "frames"
        dream_dir = work / "dream"
        seed_dir = work / "seed"
        frames_dir.mkdir()
        dream_dir.mkdir()
        seed_dir.mkdir()

        if progress_cb:
            progress_cb("extracting frames…", phase="extract", current=0, total=0, unit="frames")
        dump_sync(str(input_path), str(frames_dir), frame_pattern="f_%06d.png")

        frames = sorted(frames_dir.glob("f_*.png"))
        if not frames:
            raise RuntimeError("No frames extracted from video")

        if max_frames and max_frames > 0:
            frames = frames[: int(max_frames)]

        from ... import job_control

        last_dream: Path | None = None
        last_dream_arr = None
        last_src_arr = None
        total = len(frames)
        to_process = (total + frame_step - 1) // frame_step if total else 0
        for idx, fr in enumerate(frames):
            job_control.check_cancelled()
            out_fr = dream_dir / fr.name
            if idx % frame_step != 0:
                src = last_dream if last_dream else fr
                shutil.copy2(src, out_fr)
                continue

            with Image.open(fr) as im:
                curr_src = np.asarray(im.convert("RGB"))

            mode_tag = ""
            dream_src = fr
            if optical_flow and last_dream_arr is not None and last_src_arr is not None:
                seed = _optical_flow_seed(last_src_arr, last_dream_arr, curr_src)
                seed_path = seed_dir / fr.name
                Image.fromarray(seed).save(seed_path)
                dream_src = seed_path
                mode_tag = " flow"
            elif use_temporal and last_dream_arr is not None:
                blended = linear_blend(last_dream_arr, curr_src, temporal_blend)
                seed_path = seed_dir / fr.name
                Image.fromarray(blended).save(seed_path)
                dream_src = seed_path
                mode_tag = f" blend={temporal_blend:.2f}"

            frame_kwargs = dict(image_kwargs)
            cycled = _cycle_layer_weights(base_layers, idx, layer_cycle)
            frame_kwargs["layer_weights"] = cycled
            if layer_cycle:
                mode_tag += f" layer={next(iter(cycled))}"

            done = (idx // frame_step) + 1
            if progress_cb:
                progress_cb(
                    f"dreaming frame {idx + 1}/{total}{mode_tag}  (work unit {done}/{to_process})",
                    phase="video-frames",
                    current=done,
                    total=to_process,
                    unit="frames",
                )

            def frame_inner_progress(msg, **kw):
                if progress_cb:
                    progress_cb(
                        f"[frame {idx + 1}/{total}] {msg}",
                        phase="video-frames",
                        current=done,
                        total=to_process,
                        unit="frames",
                    )

            dream_image(dream_src, out_fr, progress_cb=frame_inner_progress, **frame_kwargs)
            last_dream = out_fr
            with Image.open(out_fr) as im:
                last_dream_arr = np.asarray(im.convert("RGB"))
            last_src_arr = curr_src

        if progress_cb:
            progress_cb(
                "encoding video…",
                phase="encode",
                current=to_process if total else 0,
                total=to_process if total else 0,
                unit="frames",
            )
        encode_sync(str(dream_dir), str(output_path), fps,
                    frame_pattern="f_%06d.png", preset="medium",
                    audio_from=str(input_path) if keep_audio else None)
        if progress_cb:
            progress_cb(
                "video complete",
                phase="done",
                current=to_process if total else 0,
                total=to_process if total else 0,
                unit="frames",
            )
        return output_path
    finally:
        pipeline.cleanup()


# ── dream_ouroboros ────────────────────────────────────────────────────────

def dream_ouroboros(
    input_path: Path,
    output_path: Path,
    *,
    length: int = 30,
    fps: float = 30.0,
    frame_transform: str = "zoom_rotate",
    zoom: float = 1.04,
    rotation_deg: float = 1.5,
    translate_x: float = 5.0,
    translate_y: float = 5.0,
    image_kwargs: dict[str, Any] | None = None,
    progress_cb=None,
) -> Path:
    input_path = Path(input_path)
    output_path = Path(output_path)
    if output_path.suffix.lower() not in VIDEO_EXTS:
        output_path = output_path.with_suffix(".mp4")
    image_kwargs = dict(image_kwargs or {})
    length = max(1, int(length))
    fps = float(fps) if fps and fps > 0 else 30.0

    from ...png_pipeline import PngFramePipeline, dump_sync, encode_sync
    pipeline = PngFramePipeline(prefix="mtapi_ouro_")
    work = Path(_tf.mkdtemp(prefix="mtapi_ouro_"))
    pipeline._tmpdir = str(work)
    try:
        dream_dir = work / "dream"
        dream_dir.mkdir()
        seed = work / "seed.png"
        with Image.open(input_path) as im:
            im.convert("RGB").save(seed)

        from ... import job_control

        current = seed
        for i in range(length):
            job_control.check_cancelled()
            if progress_cb:
                progress_cb(
                    f"ouroboros {i + 1}/{length} "
                    f"transform={frame_transform} zoom={zoom} spin={rotation_deg}°",
                    phase="ouroboros",
                    current=i + 1,
                    total=length,
                    unit="frames",
                )

            def ouro_inner(msg, **kw):
                if progress_cb:
                    progress_cb(
                        f"[ouro {i + 1}/{length}] {msg}",
                        phase="ouroboros",
                        current=i + 1,
                        total=length,
                        unit="frames",
                    )

            out_fr = dream_dir / f"f_{i:06d}.png"
            dream_image(current, out_fr, progress_cb=ouro_inner, **image_kwargs)

            if i + 1 < length and frame_transform and frame_transform != "none":
                with Image.open(out_fr) as im:
                    arr = np.asarray(im.convert("RGB"))
                transformed = transform_frame(
                    arr,
                    mode=frame_transform,
                    zoom=zoom,
                    rotation_deg=rotation_deg,
                    translate_x=translate_x,
                    translate_y=translate_y,
                    fps=fps,
                )
                next_in = work / f"in_{i:06d}.png"
                Image.fromarray(transformed).save(next_in)
                current = next_in
            else:
                current = out_fr

        if progress_cb:
            progress_cb(
                "encoding ouroboros video…",
                phase="encode",
                current=length,
                total=length,
                unit="frames",
            )
        encode_sync(str(dream_dir), str(output_path), fps,
                    frame_pattern="f_%06d.png", preset="medium",
                    audio_from=None)
        if progress_cb:
            progress_cb(
                "ouroboros complete",
                phase="done",
                current=length,
                total=length,
                unit="frames",
            )
        return output_path
    finally:
        pipeline.cleanup()
