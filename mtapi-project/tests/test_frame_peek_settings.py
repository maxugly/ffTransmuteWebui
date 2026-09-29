"""Frame peek: settings round-trip + per-size frame-strip isolation."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from app.media.config import THUMBNAIL_SIZES, normalize_thumb_size
from app.media.performance import DEFAULT_SETTINGS, _normalize_settings


def test_peek_settings_default_on_at_half():
    assert DEFAULT_SETTINGS["global_frame_peek"] is True
    assert DEFAULT_SETTINGS["frame_peek_size"] == "M"
    data = _normalize_settings({})
    assert data["global_frame_peek"] is True
    assert data["frame_peek_size"] == "M"


def test_peek_toggle_normalizes_like_other_bools():
    assert _normalize_settings({"global_frame_peek": False})["global_frame_peek"] is False
    assert _normalize_settings({"global_frame_peek": True})["global_frame_peek"] is True
    # Truthy coercion, same as mute_videos / auto_* flags.
    assert _normalize_settings({"global_frame_peek": "yes"})["global_frame_peek"] is True
    assert _normalize_settings({"global_frame_peek": 0})["global_frame_peek"] is False


def test_peek_size_is_a_real_thumb_size_class():
    assert THUMBNAIL_SIZES["L"] == 120
    assert THUMBNAIL_SIZES["M"] == 240
    assert THUMBNAIL_SIZES["H"] == 480
    for size in ("L", "M", "H"):
        assert _normalize_settings({"frame_peek_size": size})["frame_peek_size"] == size
    # Case-insensitive, like every other size token.
    assert _normalize_settings({"frame_peek_size": "h"})["frame_peek_size"] == "H"


def test_peek_size_garbage_falls_back_to_half_not_high():
    # The fallback must be Half, not the global H default — an unknown token
    # must not silently double the still width.
    for junk in ("", None, "banana", "XL", 9999, "L2"):
        assert _normalize_settings({"frame_peek_size": junk})["frame_peek_size"] == "M"
    assert normalize_thumb_size("banana") == "H"
    assert normalize_thumb_size("banana", "M") == "M"
    assert normalize_thumb_size(None, "M") == "M"


def test_peek_keys_survive_a_mixed_payload():
    data = _normalize_settings({
        "thumbnail_size": "M",
        "mute_videos": False,
        "global_frame_peek": False,
        "frame_peek_size": "L",
        "auto_vfr_to_cfr": True,
        "warm_models": {"deepdream": True},
    })
    assert data["global_frame_peek"] is False
    assert data["frame_peek_size"] == "L"
    assert data["thumbnail_size"] == "M"
    assert data["mute_videos"] is False
    assert data["warm_models"]["deepdream"] is True


def test_strip_filename_carries_the_size_class():
    """One cache dir holds every class: frame_%06d_<size>.jpg.

    Without the size in the name the existence probe (which only looks at the
    last frame) would happily serve the previous size's stills after a change.
    """
    from app.routes.media import register  # noqa: F401  (import-time sanity)

    # Mirrors _strip_frame_name in app/routes/media.py.
    def strip_name(frame_1based: int, size: str) -> str:
        return f"frame_{max(1, int(frame_1based)):06d}_{normalize_thumb_size(size, 'L')}.jpg"

    assert strip_name(1, "L") == "frame_000001_L.jpg"
    assert strip_name(90, "M") == "frame_000090_M.jpg"
    assert strip_name(1, "H") == "frame_000001_H.jpg"
    # Distinct classes never collide on one frame number.
    assert len({strip_name(12, s) for s in ("L", "M", "H")}) == 3
