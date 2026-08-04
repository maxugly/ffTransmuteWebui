"""
Model registry, TensorFlow helpers, and preprocess/deprocess utilities.

Supported networks (Keras Applications, ImageNet weights):
  - inception_v3  (classic Google DeepDream path)
  - vgg16         (gordicaleksa-style hierarchical look)
  - resnet50      (residual features; different textures)
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Callable

import numpy as np


# ── Per-model layer presets ────────────────────────────────────────────────

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

LAYER_PRESETS = MODEL_PRESETS["inception_v3"]

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

MODEL_MIN_SIDE = {
    "inception_v3": 160,
    "vgg16": 96,
    "resnet50": 128,
}

# Gradient-ascent step multiplier after mean-|grad| normalize.
# Inception preprocess ≈ [-1, 1]; VGG/ResNet Caffe-style ≈ O(100).
# Without this, the same UI "step" barely moves VGG/ResNet pixels
# (looks like a copy of the input even after many iterations).
MODEL_STEP_SCALE = {
    "inception_v3": 1.0,
    "vgg16": 40.0,
    # ResNet residual features yield weaker mean-|grad| signal than VGG at the
    # same UI step — needs a higher post-normalize multiplier to match strength.
    "resnet50": 120.0,
}

DEFAULT_MODEL = "inception_v3"
SUPPORTED_MODELS = tuple(MODEL_PRESETS.keys())

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".mpg", ".mpeg"}

MIN_DREAM_SIDE = 160
FRAME_TRANSFORMS = ("none", "zoom", "zoom_rotate", "rotate", "translate")

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
    model_name = _normalize_model_name(model_name)
    x = np.array(x)
    if x.ndim == 4:
        x = x.reshape((x.shape[1], x.shape[2], 3))
    elif x.ndim != 3:
        raise ValueError(f"Unexpected tensor rank for deprocess: {x.shape}")

    if model_name == "inception_v3":
        x = (x + 1.0) * 127.5
    else:
        x = x.copy()
        x[..., 0] += 103.939
        x[..., 1] += 116.779
        x[..., 2] += 123.68
        x = x[..., ::-1]
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
