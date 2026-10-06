"""Auto-add op outputs: settings defaults + normalize + roundtrip."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.media.performance import _normalize_settings, DEFAULT_SETTINGS  # noqa: E402


class DefaultsTest(unittest.TestCase):
    def test_defaults_off(self):
        self.assertFalse(DEFAULT_SETTINGS["auto_add_op_outputs"])
        self.assertFalse(DEFAULT_SETTINGS["auto_add_op_outputs_to_sequence"])
        self.assertFalse(DEFAULT_SETTINGS["auto_add_op_image_outputs"])

    def test_normalize_missing(self):
        d = _normalize_settings({})
        self.assertFalse(d["auto_add_op_outputs"])
        self.assertFalse(d["auto_add_op_outputs_to_sequence"])
        self.assertFalse(d["auto_add_op_image_outputs"])

    def test_normalize_truthy(self):
        d = _normalize_settings({
            "auto_add_op_outputs": True,
            "auto_add_op_outputs_to_sequence": 1,
            "auto_add_op_image_outputs": "yes",
        })
        self.assertTrue(d["auto_add_op_outputs"])
        self.assertTrue(d["auto_add_op_outputs_to_sequence"])
        self.assertTrue(d["auto_add_op_image_outputs"])

    def test_dependents_store_independently(self):
        # Gating happens at use-time in the browser; the server keeps values raw.
        d = _normalize_settings({
            "auto_add_op_outputs": False,
            "auto_add_op_outputs_to_sequence": True,
            "auto_add_op_image_outputs": True,
        })
        self.assertFalse(d["auto_add_op_outputs"])
        self.assertTrue(d["auto_add_op_outputs_to_sequence"])
        self.assertTrue(d["auto_add_op_image_outputs"])

    def test_survives_full_payload(self):
        d = _normalize_settings({
            "thumbnail_size": "H",
            "auto_add_to_sequence": True,
            "auto_first_last": True,
            "auto_first_last_mode": "sequence",
            "auto_add_op_outputs": True,
            "auto_add_op_outputs_to_sequence": True,
            "auto_add_op_image_outputs": True,
        })
        self.assertTrue(d["auto_add_op_outputs"])
        self.assertTrue(d["auto_add_op_outputs_to_sequence"])
        self.assertTrue(d["auto_add_op_image_outputs"])
        self.assertTrue(d["auto_add_to_sequence"])
        self.assertTrue(d["auto_first_last"])


if __name__ == "__main__":
    unittest.main()


def test_catalog_stamp_skips_non_media_paths():
    """A directory output_path must never be stamped as a generated file.

    The catalog scan op returns its target *directory* as output_path; stamping
    that would create a phantom 'generated' row for a folder.
    """
    import re
    src = Path(__file__).resolve().parents[1] / "app/static/js/pool/auto-add-outputs.js"
    text = src.read_text(encoding="utf-8")
    assert "isCatalogableMedia" in text
    # The guard must run before any fetch is issued.
    guard = text.index("if (!isCatalogableMedia(path)) return;")
    fetch = text.index("fetch('/api/media-catalog/generated'")
    assert guard < fetch, "media guard must precede the catalog POST"


def test_catalog_stamp_accepts_generated_audio_extensions():
    """Music/Stems outputs are .wav — audio must count as catalogable media even
    though audio never enters a pool."""
    import re
    src = Path(__file__).resolve().parents[1] / "app/static/js/pool/auto-add-outputs.js"
    text = src.read_text(encoding="utf-8")
    block = re.search(r"CATALOG_AUDIO_EXTS\s*=\s*\[([^\]]+)\]", text)
    assert block, "audio extension list missing"
    for ext in ("'.wav'", "'.mp3'", "'.flac'"):
        assert ext in block.group(1), f"{ext} should be catalogable"
