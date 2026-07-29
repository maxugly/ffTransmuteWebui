"""
Utility functions: layer weight resolution and media type detection.
"""
from __future__ import annotations

from pathlib import Path

from .models import DEFAULT_MODEL, IMAGE_EXTS, MODEL_PRESETS, VIDEO_EXTS, _normalize_model_name


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
    try:
        from PIL import Image
        with Image.open(path) as im:
            im.verify()
        return "image"
    except Exception:
        return "video"
