"""
DeepDream engine — multi-model gradient ascent over octaves.

Supported networks (Keras Applications, ImageNet weights):
  - inception_v3  (classic Google DeepDream path)
  - vgg16         (gordicaleksa-style hierarchical look)
  - resnet50      (residual features; different textures)

Requires TensorFlow / Keras at runtime. Used by deepdream_ops — not imported
at server startup so missing TF only fails when DeepDream is invoked.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable


# ── Per-model layer presets (which activations to maximize) ────────────────
# These are real architecture layers — not cosmetic labels.

MODEL_PRESETS: dict[str, dict[str, dict[str, float]]] = {
    "inception_v3": {
        "shallow": {"mixed3": 1.0, "mixed4": 1.5},
        "mid": {"mixed4": 1.0, "mixed5": 1.5, "mixed6": 2.0},
        "deep": {"mixed5": 1.0, "mixed6": 1.5, "mixed7": 2.0},
        "classic": {"mixed4": 1.0, "mixed5": 1.5, "mixed6": 2.0, "mixed7": 2.5},
        "full": {
            "mixed3": 0.5, "mixed4": 1.0, "mixed5": 1.5, "mixed6": 2.0, "mixed7": 2.5,
        },
    },
    "vgg16": {
        # Roughly maps to classic deepdream "relu3_3 / relu4_3 / relu5_x" territory
        "shallow": {"block2_conv2": 1.0, "block3_conv3": 1.5},
        "mid": {"block3_conv3": 1.0, "block4_conv3": 1.5},
        "deep": {"block4_conv3": 1.0, "block5_conv2": 1.5, "block5_conv3": 2.0},
        "classic": {
            "block3_conv3": 0.5,
            "block4_conv3": 1.0,
            "block5_conv1": 1.5,
            "block5_conv3": 2.0,
        },
        "full": {
            "block2_conv2": 0.3,
            "block3_conv3": 0.7,
            "block4_conv3": 1.2,
            "block5_conv1": 1.5,
            "block5_conv3": 2.0,
        },
    },
    "resnet50": {
        "shallow": {"conv2_block3_out": 1.0, "conv3_block4_out": 1.5},
        "mid": {"conv3_block4_out": 1.0, "conv4_block6_out": 1.5},
        "deep": {"conv4_block6_out": 1.0, "conv5_block3_out": 2.0},
        "classic": {
            "conv3_block4_out": 0.8,
            "conv4_block1_out": 1.0,
            "conv4_block6_out": 1.5,
            "conv5_block3_out": 2.0,
        },
        "full": {
            "conv2_block3_out": 0.4,
            "conv3_block4_out": 0.8,
            "conv4_block6_out": 1.5,
            "conv5_block3_out": 2.0,
        },
    },
}

# Back-compat alias used by older callers
LAYER_PRESETS = MODEL_PRESETS["inception_v3"]

# Tunable layers for custom knobs (UI order)
MODEL_CUSTOM_LAYERS: dict[str, list[str]] = {
    "inception_v3": ["mixed3", "mixed4", "mixed5", "mixed6", "mixed7"],
    "vgg16": [
        "block2_conv2", "block3_conv3", "block4_conv3",
        "block5_conv1", "block5_conv2", "block5_conv3",
    ],
    "resnet50": [
        "conv2_block3_out", "conv3_block4_out",
        "conv4_block1_out", "conv4_block6_out", "conv5_block3_out",
    ],
}

MODEL_LABELS = {
    "inception_v3": "InceptionV3 (ImageNet) — classic Google DeepDream",
    "vgg16": "VGG16 (ImageNet) — hierarchical textures / classic NN dream look",
    "resnet50": "ResNet50 (ImageNet) — residual features, different “creatures”",
}

# Minimum spatial size so stems don't collapse (Inception is pickiest)
MODEL_MIN_SIDE = {
    "inception_v3": 160,
    "vgg16": 96,
    "resnet50": 128,
}

DEFAULT_MODEL = "inception_v3"
SUPPORTED_MODELS = tuple(MODEL_PRESETS.keys())

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".mpg", ".mpeg"}

MIN_DREAM_SIDE = 160  # default / Inception floor

# Ouroboros frame transforms (gordicaleksa/pytorch-deepdream style)
FRAME_TRANSFORMS = ("none", "zoom", "zoom_rotate", "rotate", "translate")

# Cache base nets so video frames don't re-download / rebuild every time
_base_model_cache: dict[str, Any] = {}


def _require_tf():
    try:
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        import tensorflow as tf  # noqa: F401
        import keras
        return tf, keras
    except ImportError as e:
        raise RuntimeError(
            "DeepDream requires TensorFlow. Install with: "
            "pip install 'tensorflow>=2.15'"
        ) from e


def _normalize_model_name(name: str | None) -> str:
    n = (name or DEFAULT_MODEL).strip().lower().replace("-", "_")
    aliases = {
        "inception": "inception_v3",
        "inceptionv3": "inception_v3",
        "googlenet": "inception_v3",
        "vgg": "vgg16",
        "resnet": "resnet50",
    }
    n = aliases.get(n, n)
    if n not in MODEL_PRESETS:
        n = DEFAULT_MODEL
    return n


def _get_preprocess_fn(keras, model_name: str) -> Callable:
    from keras.applications import inception_v3, vgg16, resnet50
    return {
        "inception_v3": inception_v3.preprocess_input,
        "vgg16": vgg16.preprocess_input,
        "resnet50": resnet50.preprocess_input,
    }[model_name]


def _load_base_model(keras, model_name: str):
    """Load (and cache) a Keras Application without top classifier."""
    if model_name in _base_model_cache:
        return _base_model_cache[model_name]
    from keras.applications import inception_v3, vgg16, resnet50
    if model_name == "inception_v3":
        model = inception_v3.InceptionV3(weights="imagenet", include_top=False)
    elif model_name == "vgg16":
        model = vgg16.VGG16(weights="imagenet", include_top=False)
    elif model_name == "resnet50":
        model = resnet50.ResNet50(weights="imagenet", include_top=False)
    else:
        raise ValueError(f"Unknown model: {model_name}")
    _base_model_cache[model_name] = model
    return model


def _probe_video(path: Path) -> dict[str, Any]:
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-show_entries", "format=duration",
        "-of", "json",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return {}
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {}
    streams = data.get("streams") or [{}]
    s0 = streams[0] if streams else {}
    fmt = data.get("format") or {}
    fps = 25.0
    r = s0.get("r_frame_rate") or "25/1"
    try:
        if "/" in r:
            a, b = r.split("/", 1)
            fps = float(a) / max(float(b), 1e-9)
        else:
            fps = float(r)
    except Exception:
        fps = 25.0
    return {
        "width": int(s0.get("width") or 0),
        "height": int(s0.get("height") or 0),
        "fps": fps,
        "duration": float(fmt.get("duration") or 0),
    }


def _preprocess(tf, keras, image_path: Path, model_name: str = DEFAULT_MODEL):
    model_name = _normalize_model_name(model_name)
    prep = _get_preprocess_fn(keras, model_name)
    img = keras.utils.load_img(str(image_path))
    img = keras.utils.img_to_array(img)
    img = tf.expand_dims(img, 0)
    img = prep(img)
    return img


def _deprocess(x, model_name: str = DEFAULT_MODEL):
    """Invert model-specific preprocess_input → uint8 RGB."""
    import numpy as np
    model_name = _normalize_model_name(model_name)
    x = np.array(x)
    if x.ndim == 4:
        x = x.reshape((x.shape[1], x.shape[2], 3))
    elif x.ndim != 3:
        raise ValueError(f"Unexpected tensor rank for deprocess: {x.shape}")

    if model_name == "inception_v3":
        # TF mode: x = (x / 127.5) - 1  →  reverse
        x = (x + 1.0) * 127.5
    else:
        # Caffe mode (VGG / ResNet): BGR + ImageNet mean subtract
        x = x.copy()
        x[..., 0] += 103.939
        x[..., 1] += 116.779
        x[..., 2] += 123.68
        x = x[..., ::-1]  # BGR → RGB
    return np.clip(x, 0, 255).astype("uint8")


def _build_feature_extractor(keras, model_name: str, layer_settings: dict[str, float]):
    model_name = _normalize_model_name(model_name)
    base = _load_base_model(keras, model_name)
    outputs = {}
    for name in layer_settings:
        try:
            outputs[name] = base.get_layer(name).output
        except ValueError as e:
            available = [l.name for l in base.layers if "conv" in l.name or "mixed" in l.name or "out" in l.name]
            raise ValueError(
                f"Unknown layer {name!r} on {model_name}. "
                f"Sample layers: {available[:20]}"
            ) from e
    return keras.Model(inputs=base.inputs, outputs=outputs), base


def _even_min(dim: int, floor: int = MIN_DREAM_SIDE) -> int:
    d = max(int(floor), int(dim))
    if d % 2:
        d += 1
    return d


def _maybe_preview_resize(path: Path, preview_width: int | None, work_dir: Path | None = None) -> Path:
    """If preview_width > 0 and image is wider, write a temp resized copy (DeepDreamAnim-style)."""
    if not preview_width or preview_width <= 0:
        return path
    from PIL import Image
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        if w <= preview_width:
            return path
        nh = max(1, int(h * (preview_width / float(w))))
        im = im.resize((int(preview_width), nh), Image.Resampling.LANCZOS)
        out = (work_dir or path.parent) / f"_preview_{preview_width}_{path.name}"
        if work_dir:
            work_dir.mkdir(parents=True, exist_ok=True)
        im.save(out)
        return out


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
    import numpy as np
    from PIL import Image

    model_name = _normalize_model_name(model_name)
    min_side = MODEL_MIN_SIDE.get(model_name, MIN_DREAM_SIDE)

    input_path = Path(input_path)
    # optional preview downscale
    preview_tmp = None
    if preview_width and int(preview_width) > 0:
        work = Path(tempfile.mkdtemp(prefix="mtapi_prev_"))
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

    # Optional guide features (DeepDreamAnim / google guided dream)
    guide_feats: dict[str, Any] | None = None
    if guide_path:
        gp = Path(guide_path).expanduser().resolve()
        if not gp.is_file():
            raise FileNotFoundError(f"Guide image not found: {gp}")
        if progress_cb:
            progress_cb(f"guided dream ← {gp.name}")
        g_img = _preprocess(tf, keras, gp, model_name)
        # run guide at a stable size for feature matching
        g_img = tf.image.resize(g_img, (224, 224))
        raw = feature_extractor(g_img)
        if isinstance(raw, dict):
            guide_feats = {k: tf.constant(v) for k, v in raw.items()}
        else:
            # single output
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
                # Match spatial locations to best guide descriptors (Google guide objective)
                y = guide_feats[name]
                y = tf.image.resize(y, tf.shape(activation)[1:3])
                ch = tf.shape(activation)[-1]
                x = tf.reshape(activation, [-1, ch])
                yf = tf.reshape(y, [-1, ch])
                # normalize for stable matching
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
        from .. import job_control
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
        original_shape = tuple(int(x) for x in original_img.shape[1:3])  # (H, W)

        # Work at least at model min side so stems never collapse to 1×1
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

        # Build octave ladder from work size; never go below MIN_DREAM_SIDE
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
        successive_shapes = successive_shapes[::-1]  # small → large

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

        from .. import job_control
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

        # back to original (possibly preview) size for output
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
            shutil.rmtree(preview_tmp, ignore_errors=True)


def linear_blend(img1, img2, alpha: float):
    """Blend two HxWx3 arrays: (1-alpha)*img1 + alpha*img2.

    Matches gordicaleksa/pytorch-deepdream: alpha=0.85 → mostly current frame,
    with 15% of the previous dreamed frame to reduce flicker.
    """
    import numpy as np
    a = float(max(0.0, min(1.0, alpha)))
    a1 = np.asarray(img1, dtype=np.float32)
    a2 = np.asarray(img2, dtype=np.float32)
    if a1.shape != a2.shape:
        # resize img1 to img2
        from PIL import Image
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
    """Warp dream residual from prev→curr with Farneback optical flow (DeepDreamAnim).

    halludiff = prev_dream - prev_src, warped by flow, added to curr_src.
    Features stick to motion instead of flickering independently each frame.
    """
    import cv2
    import numpy as np

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
    # DeepDreamAnim: flow = -flow; then map coords
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
    """DeepDreamAnim: cycle through layers frame-to-frame when cycle=True."""
    if not cycle or not base:
        return base
    names = list(base.keys())
    if len(names) <= 1:
        return base
    pick = names[frame_idx % len(names)]
    return {pick: float(base[pick])}


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
    """DeepDream each video frame with temporal coherence options.

    Temporal modes (DeepDreamAnim / gordicaleksa):

    * **temporal_blend** (default 0.85): alpha-mix last dream with current
      source before dreaming. Simple, no OpenCV required. 1.0 = off.
    * **optical_flow** (DeepDreamAnim): warp the *hallucination residual*
      (prev_dream − prev_src) by Farneback flow onto the current frame, then
      dream. Features follow motion instead of re-rolling every frame.
      Takes precedence over temporal_blend when both are set.
    * **layer_cycle**: rotate through active layers one-per-frame (DeepDreamAnim
      multi-layer loop).
    """
    from PIL import Image
    import numpy as np

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

    work = Path(tempfile.mkdtemp(prefix="mtapi_dream_"))
    try:
        frames_dir = work / "frames"
        dream_dir = work / "dream"
        seed_dir = work / "seed"
        frames_dir.mkdir()
        dream_dir.mkdir()
        seed_dir.mkdir()

        if progress_cb:
            progress_cb("extracting frames…", phase="extract", current=0, total=0, unit="frames")
        extract = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(input_path),
                "-vsync", "0",
                str(frames_dir / "f_%06d.png"),
            ],
            capture_output=True,
            text=True,
        )
        if extract.returncode != 0:
            raise RuntimeError(extract.stderr.strip() or "ffmpeg frame extract failed")

        frames = sorted(frames_dir.glob("f_*.png"))
        if not frames:
            raise RuntimeError("No frames extracted from video")

        if max_frames and max_frames > 0:
            frames = frames[: int(max_frames)]

        from .. import job_control

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

            # per-frame layer cycle
            frame_kwargs = dict(image_kwargs)
            cycled = _cycle_layer_weights(base_layers, idx, layer_cycle)
            frame_kwargs["layer_weights"] = cycled
            if layer_cycle:
                mode_tag += f" layer={next(iter(cycled))}"

            # Count only processed (non-skipped) frames for ETA, but show index/total
            done = (idx // frame_step) + 1
            if progress_cb:
                progress_cb(
                    f"dreaming frame {idx + 1}/{total}{mode_tag}  (work unit {done}/{to_process})",
                    phase="video-frames",
                    current=done,
                    total=to_process,
                    unit="frames",
                )

            # Nested progress for ascent inside this frame (doesn't reset video totals in UI
            # if report_progress only updates current when passed — we pass a quiet reporter)
            def frame_inner_progress(msg, **kw):
                if progress_cb:
                    # keep video-level totals; only update message for sub-steps
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
        _encode_png_sequence(
            dream_dir / "f_%06d.png",
            output_path,
            fps=fps,
            audio_from=input_path if keep_audio else None,
        )
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
        shutil.rmtree(work, ignore_errors=True)


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
    """Apply a geometric transform for Ouroboros feedback (PIL affine).

    Calibrated like gordicaleksa/pytorch-deepdream: defaults assume ~30 fps;
    zoom/spin amounts scale with ``ref_fps / fps`` so slower videos don't
    whip around faster.
    """
    import math
    import numpy as np
    from PIL import Image

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

    # Effective per-frame motion (params are calibrated @ 30 fps)
    z = 1.0
    deg = 0.0
    tx = ty = 0.0
    if mode in ("zoom", "zoom_rotate"):
        # zoom>1 zooms in (cv2 getRotationMatrix2D scale). Scale excess by rate.
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

    # PIL AFFINE maps output→input: x' = a*x + b*y + c
    # Match OpenCV getRotationMatrix2D(center, angle, scale) semantics.
    cx, cy = w / 2.0, h / 2.0
    ang = math.radians(deg)
    cos_a, sin_a = math.cos(ang), math.sin(ang)
    # scale z means "zoom in" → sample from smaller region → divide coords by z
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


def _encode_png_sequence(
    pattern: Path | str,
    output_path: Path,
    *,
    fps: float = 30.0,
    audio_from: Path | None = None,
) -> Path:
    """Encode f_%06d.png style sequence to video."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    has_audio = False
    if audio_from is not None and Path(audio_from).is_file():
        has_a = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "a",
                "-show_entries", "stream=index", "-of", "csv=p=0",
                str(audio_from),
            ],
            capture_output=True,
            text=True,
        )
        has_audio = bool(has_a.stdout.strip())

    if has_audio:
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", str(fps),
            "-i", str(pattern),
            "-i", str(audio_from),
            "-map", "0:v:0", "-map", "1:a:0?",
            "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-shortest",
            str(output_path),
        ]
    else:
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", str(fps),
            "-i", str(pattern),
            "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
            "-an",
            str(output_path),
        ]
    enc = subprocess.run(cmd, capture_output=True, text=True)
    if enc.returncode != 0 or not output_path.is_file():
        raise RuntimeError(enc.stderr.strip() or "ffmpeg encode failed")
    return output_path


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
    """Ouroboros: dream → geometric transform → feed back (zoom/spin/translate video).

    Inspired by gordicaleksa/pytorch-deepdream ``deep_dream_video_ouroboros``.
    Starts from a single image; writes an .mp4 of dreamed frames.
    Translate defaults to +5 px/frame on both axes (top-left → bottom-right).
    """
    from PIL import Image
    import numpy as np

    input_path = Path(input_path)
    output_path = Path(output_path)
    if output_path.suffix.lower() not in VIDEO_EXTS:
        output_path = output_path.with_suffix(".mp4")
    image_kwargs = dict(image_kwargs or {})
    # blend with original each ouroboros step usually fights the spiral — leave as caller set
    length = max(1, int(length))
    fps = float(fps) if fps and fps > 0 else 30.0

    work = Path(tempfile.mkdtemp(prefix="mtapi_ouro_"))
    try:
        dream_dir = work / "dream"
        dream_dir.mkdir()
        # seed frame (copy so we can overwrite chain)
        seed = work / "seed.png"
        # normalize to RGB png
        with Image.open(input_path) as im:
            im.convert("RGB").save(seed)

        from .. import job_control

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

            # Transform dreamed frame → next input (not what we encode; encode is pure dream)
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
        _encode_png_sequence(
            dream_dir / "f_%06d.png",
            output_path,
            fps=fps,
            audio_from=None,
        )
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
        shutil.rmtree(work, ignore_errors=True)


def resolve_layer_weights(
    layer_preset: str,
    *,
    model_name: str = DEFAULT_MODEL,
    custom_layer_weights: dict[str, float] | None = None,
    mixed3: float = 0,
    mixed4: float = 0,
    mixed5: float = 0,
    mixed6: float = 0,
    mixed7: float = 0,
    use_custom_weights: bool = False,
) -> dict[str, float]:
    """Resolve layer activation weights for the chosen model + preset."""
    model_name = _normalize_model_name(model_name)
    presets = MODEL_PRESETS.get(model_name) or MODEL_PRESETS[DEFAULT_MODEL]
    classic = dict(presets.get("classic") or next(iter(presets.values())))

    if custom_layer_weights:
        weights = {k: float(v) for k, v in custom_layer_weights.items() if float(v) > 0}
        if weights:
            return weights

    if use_custom_weights or layer_preset == "custom":
        # Legacy Inception knobs (mixed3–7) still accepted for back-compat
        if model_name == "inception_v3":
            weights = {
                "mixed3": mixed3,
                "mixed4": mixed4,
                "mixed5": mixed5,
                "mixed6": mixed6,
                "mixed7": mixed7,
            }
            weights = {k: float(v) for k, v in weights.items() if float(v) > 0}
            return weights or classic
        return classic

    return dict(presets.get(layer_preset) or classic)


def detect_media_kind(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    # fallback: try open as image
    try:
        from PIL import Image
        with Image.open(path) as im:
            im.verify()
        return "image"
    except Exception:
        return "video"


if __name__ == "__main__":
    # Minimal CLI for smoke tests
    import argparse
    p = argparse.ArgumentParser(description="DeepDream engine smoke CLI")
    p.add_argument("input")
    p.add_argument("-o", "--output", default=None)
    p.add_argument("--preset", default="classic")
    p.add_argument("--iterations", type=int, default=10)
    p.add_argument("--octaves", type=int, default=2)
    p.add_argument("--step", type=float, default=0.01)
    args = p.parse_args()
    inp = Path(args.input)
    out = Path(args.output) if args.output else inp.with_name(inp.stem + "_dream.png")
    kind = detect_media_kind(inp)
    print(f"kind={kind} out={out}", flush=True)

    def cb(msg):
        print(msg, flush=True)

    if kind == "video":
        dream_video(
            inp, out if out.suffix.lower() in VIDEO_EXTS else out.with_suffix(".mp4"),
            frame_step=max(1, 5),
            image_kwargs={
                "layer_preset": args.preset,
                "iterations": args.iterations,
                "num_octave": args.octaves,
                "step": args.step,
            },
            progress_cb=cb,
        )
    else:
        dream_image(
            inp, out if out.suffix else out.with_suffix(".png"),
            layer_preset=args.preset,
            iterations=args.iterations,
            num_octave=args.octaves,
            step=args.step,
            progress_cb=cb,
        )
    print(f"Output: {out}", flush=True)
