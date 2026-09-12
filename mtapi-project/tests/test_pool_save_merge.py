"""save_pool_state stale-basis merge: server appends survive stale autosaves."""
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


def _doc(items, seq=(), updated_at=None):
    d = {"version": 2, "items": [{"path": p, "name": Path(p).name} for p in items],
         "sequence": [{"path": p, "name": Path(p).name} for p in seq]}
    if updated_at is not None:
        d["updated_at"] = updated_at
    return d


class _FakeCatalog:
    def __init__(self, raw):
        import copy
        self.membership = {
            "items": [dict(i) for i in raw.get("items", [])],
            "images": [],
            "sequence": [dict(s) for s in raw.get("sequence", [])],
            "selected_path": None,
            "selected_image_path": None,
            "raw": copy.deepcopy(raw),
        }
        self._global_lock = threading.RLock()

    def apply_membership_snapshot(self, raw):
        import copy
        self.membership["items"] = [dict(i) for i in raw.get("items", [])]
        self.membership["sequence"] = [dict(s) for s in raw.get("sequence", [])]
        self.membership["raw"] = copy.deepcopy(raw)
        return self.membership


class SaveMergeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mtapi-savemerge-")
        self.root = Path(self.tmp.name)
        self._saved = {}
        for mod in (media_config,):
            for name in ("POOL_STATE_PATH",):
                self._saved[(mod, name)] = getattr(mod, name)
        media_config.POOL_STATE_PATH = self.root / "pool_state.json"
        # pool.py bound POOL_STATE_PATH at import: patch there too.
        self._saved[(pool_mod, "POOL_STATE_PATH")] = pool_mod.POOL_STATE_PATH
        pool_mod.POOL_STATE_PATH = self.root / "pool_state.json"
        self._orig_cif = catalog_mod.catalog_if_ready
        catalog_mod.catalog_if_ready = lambda: None

    def tearDown(self):
        catalog_mod.catalog_if_ready = self._orig_cif
        for (mod, name), val in self._saved.items():
            setattr(mod, name, val)
        self.tmp.cleanup()

    def _read(self):
        return json.loads((self.root / "pool_state.json").read_text())

    def test_stale_basis_unions(self):
        # Server state (e.g. watcher ingest) newer than the saver's basis.
        (self.root / "pool_state.json").write_text(json.dumps(
            _doc(["/srv/new.mp4"], ["/srv/new.mp4"], updated_at=200.0)))
        payload = _doc(["/cli/old.mp4"], updated_at=100.0)
        payload["_basis_updated_at"] = 100.0
        res = asyncio.run(pool_mod.save_pool_state(payload))
        self.assertTrue(res["ok"])
        saved = self._read()
        paths = [i["path"] for i in saved["items"]]
        self.assertIn("/cli/old.mp4", paths)
        self.assertIn("/srv/new.mp4", paths)  # not wiped
        seq = [s["path"] for s in saved["sequence"]]
        self.assertIn("/srv/new.mp4", seq)
        self.assertNotIn("_basis_updated_at", saved)

    def test_fresh_basis_replaces(self):
        (self.root / "pool_state.json").write_text(json.dumps(
            _doc(["/srv/new.mp4"], updated_at=200.0)))
        payload = _doc(["/cli/old.mp4"], updated_at=200.0)
        payload["_basis_updated_at"] = 200.0
        asyncio.run(pool_mod.save_pool_state(payload))
        saved = self._read()
        self.assertEqual([i["path"] for i in saved["items"]], ["/cli/old.mp4"])

    def test_no_basis_replaces(self):
        # Explicit intents (project load) carry no basis → replace as before.
        (self.root / "pool_state.json").write_text(json.dumps(
            _doc(["/srv/new.mp4"], updated_at=200.0)))
        asyncio.run(pool_mod.save_pool_state(_doc(["/cli/old.mp4"])))
        saved = self._read()
        self.assertEqual([i["path"] for i in saved["items"]], ["/cli/old.mp4"])

    def test_stale_basis_with_live_catalog(self):
        fake = _FakeCatalog(_doc(["/srv/new.mp4"], ["/srv/new.mp4"], updated_at=300.0))
        catalog_mod.catalog_if_ready = lambda: fake
        payload = _doc(["/cli/old.mp4"])
        payload["_basis_updated_at"] = 100.0
        res = asyncio.run(pool_mod.save_pool_state(payload))
        self.assertTrue(res["ok"])
        paths = [i["path"] for i in fake.membership["items"]]
        self.assertIn("/cli/old.mp4", paths)
        self.assertIn("/srv/new.mp4", paths)
        seq = [s["path"] for s in fake.membership["sequence"]]
        self.assertIn("/srv/new.mp4", seq)

    def test_explicit_delete_with_fresh_basis_sticks(self):
        (self.root / "pool_state.json").write_text(json.dumps(
            _doc(["/a.mp4", "/b.mp4"], updated_at=200.0)))
        payload = _doc(["/a.mp4"], updated_at=200.0)  # user removed /b.mp4
        payload["_basis_updated_at"] = 200.0
        asyncio.run(pool_mod.save_pool_state(payload))
        saved = self._read()
        self.assertEqual([i["path"] for i in saved["items"]], ["/a.mp4"])


if __name__ == "__main__":
    unittest.main()
