"""Load keeps missing media offline (never dropped); probe rejects insane fps.

Spec §8.4: a load must not delete media. The file fallbacks (catalog not
ready) keep absent entries and report them in ``missing``.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.media import config as media_config  # noqa: E402
from app.media import pool as pool_mod  # noqa: E402
import app.media.catalog as catalog_mod  # noqa: E402
import app.media.projects as projects_mod  # noqa: E402
import app.probe as probe_mod  # noqa: E402


def _doc(items, seq=()):
    return {
        "version": 2,
        "items": [
            {"path": p, "name": Path(p).name,
             "meta": {"fps": 24.0, "duration": 5.0}}
            for p in items
        ],
        "sequence": [
            {"path": p, "name": Path(p).name,
             "variant_path": p.replace(".mp4", "_rife.mp4"),
             "rife_multiplier": 2, "rife_need": "rifed"}
            for p in seq
        ],
    }


class OfflineKeepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mtapi-offline-")
        self.root = Path(self.tmp.name)
        self._saved = {}
        for mod, name in ((media_config, "POOL_STATE_PATH"),
                          (pool_mod, "POOL_STATE_PATH")):
            self._saved[(mod, name)] = getattr(mod, name)
        media_config.POOL_STATE_PATH = self.root / "pool_state.json"
        pool_mod.POOL_STATE_PATH = self.root / "pool_state.json"
        self._orig_cif = catalog_mod.catalog_if_ready
        catalog_mod.catalog_if_ready = lambda: None
        # One file that really exists; the rest are offline.
        self.real = self.root / "here.mp4"
        self.real.write_bytes(b"\x00" * 16)

    def tearDown(self):
        catalog_mod.catalog_if_ready = self._orig_cif
        for (mod, name), val in self._saved.items():
            setattr(mod, name, val)
        self.tmp.cleanup()

    def test_pool_state_load_keeps_missing(self):
        gone = "/srv/gone.mp4"
        doc = _doc([str(self.real), gone], [str(self.real), gone])
        (self.root / "pool_state.json").write_text(json.dumps(doc))
        data = pool_mod.load_pool_state()
        self.assertTrue(data["ok"])
        paths = [i["path"] for i in data["items"]]
        self.assertIn(str(self.real), paths)
        self.assertIn(gone, paths, "missing pool item must be kept offline")
        seq_paths = [e["path"] for e in data["sequence"]]
        self.assertIn(gone, seq_paths, "missing sequence entry must be kept")
        self.assertIn(gone, data["missing"])
        # Cached records survive the round-trip untouched.
        kept = next(i for i in data["items"] if i["path"] == gone)
        self.assertEqual((kept["meta"] or {}).get("fps"), 24.0)
        kept_seq = next(e for e in data["sequence"] if e["path"] == gone)
        self.assertEqual(kept_seq.get("variant_path"),
                         gone.replace(".mp4", "_rife.mp4"))
        self.assertEqual(kept_seq.get("rife_multiplier"), 2)

    def test_project_file_load_keeps_missing(self):
        gone = "/srv/gone.mp4"
        proj = self.root / "p.ffproject.json"
        proj.write_text(json.dumps({
            "kind": "fftransmute-project",
            "project_version": 2,
            "name": "p",
            "pool": _doc([str(self.real), gone], [gone]),
        }))
        data = projects_mod.load_project_file(proj)
        self.assertTrue(data["ok"])
        paths = [i["path"] for i in data["items"]]
        self.assertIn(gone, paths, "missing project item must be kept offline")
        self.assertEqual([e["path"] for e in data["sequence"]], [gone])
        self.assertIn(gone, data["missing"])


class StaleMergeKeepsFreshRowsTest(unittest.TestCase):
    """A stale autosave must not revert fresher rows (e.g. Time committed
    from another session while RIFE encodes). Spec §8.4: loads never delete;
    symmetrically, stale saves never clobber — only brand-new paths merge."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mtapi-stalemerge-")
        self.root = Path(self.tmp.name)
        self._saved = {}
        for mod, name in ((media_config, "POOL_STATE_PATH"),
                          (pool_mod, "POOL_STATE_PATH")):
            self._saved[(mod, name)] = getattr(mod, name)
        media_config.POOL_STATE_PATH = self.root / "pool_state.json"
        pool_mod.POOL_STATE_PATH = self.root / "pool_state.json"
        self._orig_cif = catalog_mod.catalog_if_ready
        catalog_mod.catalog_if_ready = lambda: None

    def tearDown(self):
        catalog_mod.catalog_if_ready = self._orig_cif
        for (mod, name), val in self._saved.items():
            setattr(mod, name, val)
        self.tmp.cleanup()

    def _doc(self, seq, updated_at=None):
        d = {"version": 2,
             "items": [{"path": s["path"]} for s in seq],
             "sequence": [dict(s) for s in seq]}
        if updated_at is not None:
            d["updated_at"] = updated_at
        return d

    def test_stale_save_keeps_fresh_time(self):
        fresh = {"path": "/srv/a.mp4", "name": "a.mp4",
                 "target_duration": 33.33}
        res = asyncio.run(pool_mod.save_pool_state(self._doc([fresh])))
        stale = self._doc([{"path": "/srv/a.mp4", "name": "a.mp4"}])
        stale["_basis_updated_at"] = float(res["updated_at"]) - 100.0
        asyncio.run(pool_mod.save_pool_state(stale))
        data = pool_mod.load_pool_state()
        row = next(e for e in data["sequence"]
                   if e["path"] == "/srv/a.mp4")
        self.assertEqual(row.get("target_duration"), 33.33,
                         "stale autosave must not revert committed Time")

    def test_stale_save_still_adopts_new_paths(self):
        old = {"path": "/srv/a.mp4", "name": "a.mp4",
               "target_duration": 33.33}
        res = asyncio.run(pool_mod.save_pool_state(self._doc([old])))
        inc = [{"path": "/srv/a.mp4", "name": "a.mp4"},
               {"path": "/srv/new.mp4", "name": "new.mp4"}]
        stale = self._doc(inc)
        stale["_basis_updated_at"] = float(res["updated_at"]) - 100.0
        asyncio.run(pool_mod.save_pool_state(stale))
        data = pool_mod.load_pool_state()
        paths = [e["path"] for e in data["sequence"]]
        self.assertIn("/srv/new.mp4", paths,
                      "watcher-style appends must still survive stale saves")
        row = next(e for e in data["sequence"]
                   if e["path"] == "/srv/a.mp4")
        self.assertEqual(row.get("target_duration"), 33.33)


class ProbeClampTest(unittest.TestCase):
    def test_async_rejects_insane_fps(self):
        async def fake_run(cmd):
            return 0, "16000/1\n", ""
        with mock.patch("app.shell.run_command", fake_run):
            self.assertEqual(asyncio.run(probe_mod.probe_fps("/x.mp4")), 0.0)
            self.assertEqual(
                asyncio.run(probe_mod.probe_fps("/x.mp4", default=25.0)), 25.0)

    def test_async_keeps_sane_fps(self):
        async def fake_run(cmd):
            return 0, "24000/1001\n", ""
        with mock.patch("app.shell.run_command", fake_run):
            fps = asyncio.run(probe_mod.probe_fps("/x.mp4"))
            self.assertAlmostEqual(fps, 23.976, places=2)

    def test_sync_rejects_insane_fps(self):
        with mock.patch.object(probe_mod, "_ffprobe_sync",
                               return_value="16000/1"):
            self.assertEqual(probe_mod.probe_fps_sync("/x.mp4"), 0.0)
        with mock.patch.object(probe_mod, "_ffprobe_sync",
                               return_value="25/1"):
            self.assertEqual(probe_mod.probe_fps_sync("/x.mp4"), 25.0)


if __name__ == "__main__":
    unittest.main()
