"""Watcher hot-folder → pool: independent toggles, dun-move, pool file, variants."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import watcher  # noqa: E402
from app.media import config as media_config  # noqa: E402


def _reset_watcher_state():
    with watcher._lock:
        watcher._state.enabled = False
        watcher._state.pool_ingest = False
        watcher._state.pool_add_sequence = False
        watcher._state.in_dir = ""
        watcher._state.out_dir = ""
        watcher._state.last_error = None
        watcher._state.processing = None
    watcher._processed_names.clear()
    watcher._seen_sizes.clear()


class WatcherPoolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.in_dir = self.root / "in"
        self.out_dir = self.root / "out"
        self.in_dir.mkdir()
        self.out_dir.mkdir()
        # Isolate watcher config + media file fallback paths.
        self._orig_config = watcher._CONFIG_PATH
        watcher._CONFIG_PATH = self.root / "watcher.json"
        self._orig_pool = media_config.POOL_STATE_PATH
        self._orig_by_hash = media_config.BY_HASH_DIR
        self._orig_index = media_config.INDEX_PATH
        media_config.POOL_STATE_PATH = self.root / "pool_state.json"
        media_config.BY_HASH_DIR = self.root / "by_hash"
        media_config.INDEX_PATH = self.root / "index.json"
        _reset_watcher_state()

    def tearDown(self):
        try:
            watcher.apply_config(enabled=False, pool_ingest=False)
        finally:
            watcher._stop.set()
            th = watcher._thread
            if th is not None and th.is_alive():
                th.join(timeout=5)
            watcher._CONFIG_PATH = self._orig_config
            media_config.POOL_STATE_PATH = self._orig_pool
            media_config.BY_HASH_DIR = self._orig_by_hash
            media_config.INDEX_PATH = self._orig_index
            _reset_watcher_state()
            self.tmp.cleanup()

    def test_defaults_both_off(self):
        st = watcher.get_status()
        self.assertFalse(st["enabled"])
        self.assertFalse(st["pool_ingest"])
        self.assertFalse(st["pool_add_sequence"])
        self.assertFalse(st["running"])
        self.assertEqual(st["pool_ingested_count"], 0)

    def test_pool_ingest_needs_no_out_dir(self):
        st = watcher.apply_config(pool_ingest=True, in_dir=str(self.in_dir))
        try:
            self.assertTrue(st["pool_ingest"])
            self.assertIsNone(st["last_error"])
            self.assertTrue(st["running"] or st["pool_ingest"])
        finally:
            watcher.apply_config(pool_ingest=False)

    def test_dnxhr_still_requires_out_dir(self):
        st = watcher.apply_config(enabled=True, in_dir=str(self.in_dir),
                                  out_dir="")
        self.assertFalse(st["enabled"])
        self.assertIsNotNone(st["last_error"])

    def test_independent_toggles(self):
        watcher.apply_config(pool_ingest=True, in_dir=str(self.in_dir))
        try:
            # Turning DNxHR on must not disturb pool ingest, and a failed
            # DNxHR enable must not kill the running ingest job.
            bad = watcher.apply_config(enabled=True, out_dir="")
            self.assertFalse(bad["enabled"])
            self.assertTrue(watcher.get_status()["pool_ingest"])
            good = watcher.apply_config(enabled=True, out_dir=str(self.out_dir))
            self.assertTrue(good["enabled"])
            self.assertTrue(good["pool_ingest"])
            # Stopping DNxHR leaves ingest running.
            watcher.apply_config(enabled=False)
            st = watcher.get_status()
            self.assertFalse(st["enabled"])
            self.assertTrue(st["pool_ingest"])
        finally:
            watcher.apply_config(enabled=False, pool_ingest=False)

    def test_config_persists_ingest_flags_not_enables(self):
        watcher.apply_config(pool_ingest=False, pool_add_sequence=True,
                             in_dir=str(self.in_dir), out_dir=str(self.out_dir))
        saved = json.loads((self.root / "watcher.json").read_text())
        self.assertTrue(saved["pool_add_sequence"])
        self.assertFalse(saved["enabled"])
        self.assertFalse(saved["pool_ingest"])

    def test_ingest_moves_to_dun_and_writes_pool(self):
        clip = self.in_dir / "arrival.mp4"
        clip.write_bytes(b"\x00" * 4096)
        # Simulate a running ingest job without starting the poll thread.
        with watcher._lock:
            watcher._state.pool_ingest = True
            watcher._state.pool_add_sequence = True
            watcher._state.in_dir = str(self.in_dir)
        watcher.STABLE_S_SAVE = getattr(watcher, "STABLE_S", None)
        watcher.STABLE_S = 0
        try:
            watcher._scan_once(str(self.in_dir), str(self.out_dir), 1920, 1080,
                               "letterbox", dnxhr_on=False, ingest_on=True,
                               add_seq=True)
            # First pass only records size; second pass is stable → ingested.
            watcher._scan_once(str(self.in_dir), str(self.in_dir), 1920, 1080,
                               "letterbox", dnxhr_on=False, ingest_on=True,
                               add_seq=True)
        finally:
            if watcher.STABLE_S_SAVE is not None:
                watcher.STABLE_S = watcher.STABLE_S_SAVE
        dun_clip = self.in_dir / "dun" / "arrival.mp4"
        self.assertTrue(dun_clip.is_file(), "original must move to dun/")
        self.assertFalse(clip.exists(), "in_dir must be drained")
        pool = json.loads((self.root / "pool_state.json").read_text())
        paths = [it.get("path") for it in pool.get("items", [])]
        self.assertIn(str(dun_clip.resolve()), paths)
        seq_paths = [e.get("path") for e in pool.get("sequence", [])]
        self.assertIn(str(dun_clip.resolve()), seq_paths)
        # Re-ingest of the same (moved) file dedupes.
        res = watcher._pool_ingest_sync([str(dun_clip)], add_sequence=True)
        self.assertEqual(res["added_items"], 0)
        self.assertEqual(res["added_seq"], 0)

    def test_dnxhr_failure_does_not_block_ingest(self):
        clip = self.in_dir / "doomed.mp4"
        clip.write_bytes(b"\x00" * 2048)
        with watcher._lock:
            watcher._state.enabled = True
            watcher._state.pool_ingest = True
            watcher._state.in_dir = str(self.in_dir)
            watcher._state.out_dir = str(self.out_dir)
        orig_process = watcher._process_one
        watcher._process_one = lambda *a, **k: (False, None)  # transcode fails
        watcher.STABLE_S = 0
        try:
            watcher._scan_once(str(self.in_dir), str(self.out_dir), 1920, 1080,
                               "letterbox", dnxhr_on=True, ingest_on=True,
                               add_seq=False)
            watcher._scan_once(str(self.in_dir), str(self.out_dir), 1920, 1080,
                               "letterbox", dnxhr_on=True, ingest_on=True,
                               add_seq=False)
        finally:
            watcher._process_one = orig_process
            watcher.STABLE_S = 1.5
        self.assertEqual(watcher.get_status()["failed_count"], 1)
        dun_clip = self.in_dir / "dun" / "doomed.mp4"
        self.assertTrue(dun_clip.is_file(), "pool job still moves the file")
        res = watcher._pool_ingest_sync([str(dun_clip)], add_sequence=False)
        self.assertEqual(res["added_items"], 0)  # scan already ingested it
        pool = json.loads((self.root / "pool_state.json").read_text())
        paths = [it.get("path") for it in pool.get("items", [])]
        self.assertIn(str(dun_clip.resolve()), paths)

    def test_move_collision_suffix(self):
        (self.in_dir / "dun").mkdir()
        ((self.in_dir / "dun") / "clip.mp4").write_bytes(b"old")
        src = self.in_dir / "clip.mp4"
        src.write_bytes(b"new")
        moved = watcher._move_to_dun(src)
        self.assertIsNotNone(moved)
        self.assertEqual(moved.name, "clip_1.mp4")
        self.assertTrue(moved.is_file())

    def test_register_dnxhr_variant_fallback(self):
        parent = self.root / "orig.mp4"
        variant = self.root / "orig_resolve.mov"
        parent.write_bytes(b"parent-bytes")
        variant.write_bytes(b"variant-bytes")
        ok = watcher._register_variant_sync(parent, kind="dnxhr",
                                            variant_path=variant,
                                            detail={"codec": "dnxhr_lb"})
        self.assertTrue(ok)
        import hashlib
        ph = hashlib.blake2b(parent.read_bytes(), digest_size=16).hexdigest()
        rec = json.loads((self.root / "by_hash" / ph / "record.json").read_text())
        kinds = rec.get("variants", {})
        self.assertIn("dnxhr", kinds)
        self.assertEqual(kinds["dnxhr"][0]["path"], str(variant.resolve()))
        index = json.loads((self.root / "index.json").read_text())
        self.assertIn(str(parent.resolve()), index.get("paths", {}))


class _FakeRec:
    def __init__(self, h):
        self.hash = h
        self.paths = []
        self.variants = {}
        self.variants_status = "missing"


class _FakeCatalog:
    """Minimal live-server catalog double (thread-safe paths only)."""

    def __init__(self):
        import threading
        self._global_lock = threading.RLock()
        self.membership = {"items": [], "images": [], "sequence": [],
                           "selected_path": None, "selected_image_path": None,
                           "raw": {"version": 2}}
        self.hash_to_record = {}
        self.hash_to_paths = {}
        self.mappings = {}

    def update_path_mapping(self, path, h, size, mtime_ns, persist=True):
        self.mappings[str(path)] = h

    def _persist_record(self, rec, incoming):
        pass


class WatcherCatalogBranchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._orig_pool = media_config.POOL_STATE_PATH
        media_config.POOL_STATE_PATH = self.root / "pool_state.json"
        self._orig_cif = watcher.__dict__.get("catalog_if_ready", None)
        import app.media.catalog as catalog_mod
        self._orig_mod_cif = catalog_mod.catalog_if_ready
        self.fake = _FakeCatalog()
        catalog_mod.catalog_if_ready = lambda: self.fake
        _reset_watcher_state()

    def tearDown(self):
        import app.media.catalog as catalog_mod
        catalog_mod.catalog_if_ready = self._orig_mod_cif
        media_config.POOL_STATE_PATH = self._orig_pool
        _reset_watcher_state()
        self.tmp.cleanup()

    def test_pool_ingest_uses_live_membership(self):
        a = self.root / "a.mp4"
        b = self.root / "b.mp4"
        a.write_bytes(b"a")
        b.write_bytes(b"b")
        res = watcher._pool_ingest_sync([str(a), str(b)], add_sequence=True)
        self.assertEqual(res, {"added_items": 2, "added_seq": 2})
        self.assertEqual(len(self.fake.membership["items"]), 2)
        self.assertEqual(len(self.fake.membership["sequence"]), 2)
        pool = json.loads((self.root / "pool_state.json").read_text())
        self.assertEqual(len(pool["items"]), 2)
        # Browser-style save roundtrip keeps watcher additions.
        res2 = watcher._pool_ingest_sync([str(a)], add_sequence=True)
        self.assertEqual(res2, {"added_items": 0, "added_seq": 0})

    def test_register_variant_uses_live_records(self):
        from app.media.catalog import CatalogRecord
        parent = self.root / "p.mp4"
        variant = self.root / "p_resolve.mov"
        parent.write_bytes(b"parent")
        variant.write_bytes(b"variant!")
        ok = watcher._register_variant_sync(parent, kind="dnxhr",
                                            variant_path=variant,
                                            detail={"codec": "dnxhr_lb"})
        self.assertTrue(ok)
        recs = [r for r in self.fake.hash_to_record.values()
                if isinstance(r, CatalogRecord)]
        self.assertTrue(recs)
        dnxhr = [v for r in recs for v in r.variants.get("dnxhr", [])]
        self.assertEqual(len(dnxhr), 1)
        self.assertEqual(dnxhr[0]["path"], str(variant.resolve()))
        # Duplicate registration does not duplicate the row.
        watcher._register_variant_sync(parent, kind="dnxhr",
                                       variant_path=variant,
                                       detail={"codec": "dnxhr_lb"})
        dnxhr2 = [v for r in self.fake.hash_to_record.values()
                  if isinstance(r, CatalogRecord)
                  for v in r.variants.get("dnxhr", [])]
        self.assertEqual(len(dnxhr2), 1)


if __name__ == "__main__":
    unittest.main()
