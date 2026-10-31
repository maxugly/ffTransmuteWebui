"""Sequence render range (clip N → M): pool payload persistence.

The range scopes the Sequence render only — it must survive the pool
autosave / project save round trip, and a malformed bound must fall back to
"whole sequence" instead of poisoning the saved document.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.media import config as media_config  # noqa: E402
from app.media import pool as pool_mod  # noqa: E402
import app.media.catalog as catalog_mod  # noqa: E402


class _NoCatalog:
    """catalog_if_ready() → None keeps the save path off the catalog."""

    @staticmethod
    def _global_lock():
        return threading.RLock()


def _doc(seq=(), **extra):
    d = {"version": 2, "items": [], "sequence": [{"path": p, "name": Path(p).name} for p in seq]}
    d.update(extra)
    return d


class RenderRangeNormalizeTest(unittest.TestCase):
    def test_absent_range_is_unset(self):
        out = pool_mod._normalize_render_range(None)
        self.assertEqual(out, {"from": None, "to": None})

    def test_non_dict_is_unset(self):
        self.assertEqual(pool_mod._normalize_render_range("34-56"),
                         {"from": None, "to": None})

    def test_string_bounds_become_ints(self):
        out = pool_mod._normalize_render_range({"from": "34", "to": "56"})
        self.assertEqual(out, {"from": 34, "to": 56})

    def test_int_bounds_are_kept(self):
        out = pool_mod._normalize_render_range({"from": 34, "to": 56})
        self.assertEqual(out, {"from": 34, "to": 56})

    def test_blank_bound_is_unset(self):
        out = pool_mod._normalize_render_range({"from": "", "to": None})
        self.assertEqual(out, {"from": None, "to": None})

    def test_non_positive_bound_is_dropped(self):
        out = pool_mod._normalize_render_range({"from": 0, "to": -3})
        self.assertEqual(out, {"from": None, "to": None})

    def test_garbage_bound_is_dropped(self):
        out = pool_mod._normalize_render_range({"from": "abc", "to": "5"})
        self.assertEqual(out, {"from": None, "to": 5})

    def test_payload_carries_the_range(self):
        out = pool_mod._normalize_pool_payload(_doc(["/a.mp4"], render_range={"from": 2, "to": 5}))
        self.assertEqual(out["render_range"], {"from": 2, "to": 5})

    def test_payload_without_range_is_unset(self):
        out = pool_mod._normalize_pool_payload(_doc(["/a.mp4"]))
        self.assertEqual(out["render_range"], {"from": None, "to": None})


class RenderRangeRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._old_root = media_config.MEDIA_ROOT
        self._old_state = pool_mod.POOL_STATE_PATH
        self._old_catalog = catalog_mod.catalog_if_ready
        media_config.MEDIA_ROOT = self.root / "media"
        pool_mod.POOL_STATE_PATH = self.root / "pool_state.json"
        catalog_mod.catalog_if_ready = lambda: None
        (self.root / "media").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        media_config.MEDIA_ROOT = self._old_root
        pool_mod.POOL_STATE_PATH = self._old_state
        catalog_mod.catalog_if_ready = self._old_catalog
        self.tmp.cleanup()

    def _read(self):
        return json.loads(pool_mod.POOL_STATE_PATH.read_text(encoding="utf-8"))

    def test_range_survives_the_save(self):
        payload = _doc(["/a.mp4"], render_range={"from": "34", "to": "56"})
        res = asyncio.run(pool_mod.save_pool_state(payload))
        self.assertTrue(res["ok"])
        saved = self._read()
        self.assertEqual(saved["render_range"], {"from": 34, "to": 56})

    def test_unset_range_survives_the_save(self):
        asyncio.run(pool_mod.save_pool_state(_doc(["/a.mp4"])))
        self.assertEqual(self._read()["render_range"], {"from": None, "to": None})


if __name__ == "__main__":
    unittest.main()
