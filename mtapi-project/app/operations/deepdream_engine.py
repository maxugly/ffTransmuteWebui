"""
Backward-compatible shim. All implementation has moved to deepdream/ sub-modules.

Import from .deepdream instead of .deepdream_engine.
"""
from .deepdream import *  # noqa: F401, F403, E402
from .deepdream import (  # noqa: F401
    DEFAULT_MODEL,
    FRAME_TRANSFORMS,
    IMAGE_EXTS,
    LAYER_PRESETS,
    MIN_DREAM_SIDE,
    MODEL_CUSTOM_LAYERS,
    MODEL_LABELS,
    MODEL_MIN_SIDE,
    MODEL_PRESETS,
    SUPPORTED_MODELS,
    VIDEO_EXTS,
    _build_feature_extractor,
    _deprocess,
    _even_min,
    _get_preprocess_fn,
    _load_base_model,
    _maybe_preview_resize,
    _normalize_model_name,
    _preprocess,
    _probe_video,
    _require_tf,
    detect_media_kind,
    dream_image,
    linear_blend,
    resolve_layer_weights,
    transform_frame,
)
