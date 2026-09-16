import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from app.media.performance import DEFAULT_SETTINGS, _normalize_settings


def test_vfr_settings_default_off_and_auto_fps():
    assert DEFAULT_SETTINGS["auto_vfr_to_cfr"] is False
    assert DEFAULT_SETTINGS["vfr_cfr_fps"] == 0
    data = _normalize_settings({})
    assert data["auto_vfr_to_cfr"] is False
    assert data["vfr_cfr_fps"] == 0


def test_vfr_settings_normalize_fps():
    assert _normalize_settings({"auto_vfr_to_cfr": True, "vfr_cfr_fps": 30})["vfr_cfr_fps"] == 30
    assert _normalize_settings({"vfr_cfr_fps": 500})["vfr_cfr_fps"] == 240
    assert _normalize_settings({"vfr_cfr_fps": -2})["vfr_cfr_fps"] == 0
    assert _normalize_settings({"vfr_cfr_fps": "garbage"})["vfr_cfr_fps"] == 0
