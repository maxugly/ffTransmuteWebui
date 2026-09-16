"""Sequence clip tag colors: normalize + catalog passthrough + save round-trip."""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.media import config as media_config  # noqa: E402
from app.media import pool as pool_mod  # noqa: E402
import app.media.catalog as catalog_mod  # noqa: E402


def _seq_entry(path, **kw):
    d = {"path": path, "name": Path(path).name}
    d.update(kw)
    return d


class TagNormalizeTest(unittest.TestCase):
    def test_valid_tag_kept_lowercased(self):
        out = pool_mod._normalize_sequence_entries(
            [_seq_entry("/v/a.mp4", tag_color="#EF4444")], require_exists=False)
        self.assertEqual(out[0].get("tag_color"), "#ef4444")

    def test_camel_case_tag_mapped(self):
        out = pool_mod._normalize_sequence_entries(
            [_seq_entry("/v/a.mp4", tagColor="#22c55e")], require_exists=False)
        self.assertEqual(out[0].get("tag_color"), "#22c55e")

    def test_invalid_tag_dropped(self):
        for bad in ("red", "#fff", "#gggggg", "", 123, None, "#1234567"):
            out = pool_mod._normalize_sequence_entries(
                [_seq_entry("/v/a.mp4", tag_color=bad)], require_exists=False)
            self.assertNotIn("tag_color", out[0], msg=f"bad={bad!r}")

    def test_untagged_entry_has_no_key(self):
        out = pool_mod._normalize_sequence_entries(
            [_seq_entry("/v/a.mp4")], require_exists=False)
        self.assertNotIn("tag_color", out[0])

    def test_per_entry_tags_survive_side_by_side(self):
        out = pool_mod._normalize_sequence_entries([
            _seq_entry("/v/a.mp4", tag_color="#ef4444"),
            _seq_entry("/v/a.mp4", tag_color="#3b82f6"),
            _seq_entry("/v/a.mp4"),
        ], require_exists=False)
        self.assertEqual(out[0].get("tag_color"), "#ef4444")
        self.assertEqual(out[1].get("tag_color"), "#3b82f6")
        self.assertNotIn("tag_color", out[2])


class TagCatalogTest(unittest.TestCase):
    def _membership(self, raw):
        return catalog_mod.CatalogIndex._membership_sequence(None, raw)

    def test_catalog_keeps_valid_tag(self):
        out = self._membership([_seq_entry("/v/a.mp4", tag_color="#d946ef")])
        self.assertEqual(out[0].get("tag_color"), "#d946ef")

    def test_catalog_drops_invalid_tag(self):
        out = self._membership([_seq_entry("/v/a.mp4", tag_color="not-a-color")])
        self.assertNotIn("tag_color", out[0])


class TagSaveRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mtapi-seqtags-")
        self.root = Path(self.tmp.name)
        self._saved = {
            (media_config, "POOL_STATE_PATH"): media_config.POOL_STATE_PATH,
            (pool_mod, "POOL_STATE_PATH"): pool_mod.POOL_STATE_PATH,
        }
        media_config.POOL_STATE_PATH = self.root / "pool_state.json"
        pool_mod.POOL_STATE_PATH = self.root / "pool_state.json"
        self._orig_cif = catalog_mod.catalog_if_ready
        catalog_mod.catalog_if_ready = lambda: None

    def tearDown(self):
        catalog_mod.catalog_if_ready = self._orig_cif
        for (mod, name), val in self._saved.items():
            setattr(mod, name, val)
        self.tmp.cleanup()

    def test_save_keeps_tag(self):
        payload = {
            "version": 2,
            "items": [],
            "sequence": [_seq_entry("/v/a.mp4", tag_color="#0ea5e9")],
        }
        res = asyncio.run(pool_mod.save_pool_state(payload))
        self.assertTrue(res.get("ok"))
        saved = json.loads((self.root / "pool_state.json").read_text())
        self.assertEqual(saved["sequence"][0].get("tag_color"), "#0ea5e9")


if __name__ == "__main__":
    unittest.main()
