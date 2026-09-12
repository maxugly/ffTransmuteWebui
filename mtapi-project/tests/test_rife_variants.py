"""RIFE variant chaining: source_kind detail + parent co-registration."""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.media import cache as media_cache  # noqa: E402
from app.media import config as media_config  # noqa: E402
from app.operations.rife_ops import RifeParams, register_rifed_output  # noqa: E402


class RifeVariantParamsTest(unittest.TestCase):
    def test_new_fields_optional(self):
        p = RifeParams(input_path="/tmp/x.mp4")
        self.assertIsNone(p.source_kind)
        self.assertIsNone(p.parent_path)

    def test_new_fields_accepted(self):
        p = RifeParams(input_path="/tmp/x.mp4", source_kind="dnxhr",
                       parent_path="/tmp/y.mp4")
        self.assertEqual(p.source_kind, "dnxhr")
        self.assertEqual(p.parent_path, "/tmp/y.mp4")


class RifeVariantChainTest(unittest.TestCase):
    """register_rifed_output against an isolated media cache (no catalog)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mtapi-rifevar-")
        self.root = Path(self.tmp.name)
        self._saved = {}
        for mod in (media_config, media_cache):
            for name in ("BY_HASH_DIR", "INDEX_PATH", "POOL_STATE_PATH"):
                if hasattr(mod, name):
                    self._saved[(mod, name)] = getattr(mod, name)
        by_hash = self.root / "by_hash"
        media_config.BY_HASH_DIR = by_hash
        media_cache.BY_HASH_DIR = by_hash
        media_config.INDEX_PATH = self.root / "index.json"
        media_cache.INDEX_PATH = self.root / "index.json"
        media_config.POOL_STATE_PATH = self.root / "pool_state.json"
        media_cache.POOL_STATE_PATH = self.root / "pool_state.json"

    def tearDown(self):
        for (mod, name), val in self._saved.items():
            setattr(mod, name, val)
        self.tmp.cleanup()

    def _files(self):
        orig = self.root / "orig.mp4"
        prox = self.root / "orig_resolve.mov"
        out = self.root / "orig_resolve_rife.mp4"
        orig.write_bytes(b"original-bytes-1234")
        prox.write_bytes(b"proxy-bytes-56789")
        out.write_bytes(b"rifed-bytes-abcdef")
        return orig, prox, out

    def test_input_only_registration(self):
        orig, _, out = self._files()
        vh = asyncio.run(register_rifed_output(
            str(orig), str(out), multiplier=2, target_fps=None,
            has_audio=False))
        self.assertIsNotNone(vh)
        rec = media_cache.load_record(
            media_cache.lookup_cached_hash(orig, check_source=True))
        rifed = (rec.get("variants") or {}).get("rifed") or []
        self.assertEqual(len(rifed), 1)
        self.assertEqual(rifed[0]["path"], str(out.resolve()))
        self.assertEqual(rifed[0]["detail"]["multiplier"], 2)
        self.assertNotIn("source_kind", rifed[0]["detail"])

    def test_proxy_co_registers_on_parent(self):
        orig, prox, out = self._files()
        vh = asyncio.run(register_rifed_output(
            str(prox), str(out), multiplier=4, target_fps=60.0,
            has_audio=True, source_kind="dnxhr", parent_path=str(orig)))
        self.assertIsNotNone(vh)
        # Input (proxy) record.
        phash = media_cache.lookup_cached_hash(prox, check_source=True)
        prec = media_cache.load_record(phash)
        prifed = (prec.get("variants") or {}).get("rifed") or []
        self.assertEqual(len(prifed), 1)
        self.assertEqual(prifed[0]["detail"]["source_kind"], "dnxhr")
        self.assertEqual(prifed[0]["detail"]["multiplier"], 4)
        # Parent (original) record gains the same file as rifed-DNxHR.
        ohash = media_cache.lookup_cached_hash(orig, check_source=True)
        orec = media_cache.load_record(ohash)
        orifed = (orec.get("variants") or {}).get("rifed") or []
        self.assertEqual(len(orifed), 1)
        self.assertEqual(orifed[0]["path"], str(out.resolve()))
        self.assertEqual(orifed[0]["detail"]["source_kind"], "dnxhr")
        self.assertEqual(orifed[0]["detail"]["derived_from"], str(prox.resolve()))
        # Returned hash belongs to the parent record (frontend recovers by parent).
        self.assertEqual(vh, orifed[0]["hash"])

    def test_missing_parent_is_ignored(self):
        _, prox, out = self._files()
        vh = asyncio.run(register_rifed_output(
            str(prox), str(out), multiplier=2, target_fps=None,
            has_audio=False, source_kind="dnxhr",
            parent_path=str(self.root / "gone.mp4")))
        self.assertIsNotNone(vh)  # input registration still succeeds


if __name__ == "__main__":
    unittest.main()
