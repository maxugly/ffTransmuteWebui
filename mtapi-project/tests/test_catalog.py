"""Backend checks for the server-resident CatalogIndex (spec §11)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.media.catalog import (  # noqa: E402
    THUMB_RAM_BUDGET,
    CatalogIndex,
    CatalogLockHeld,
    reset_catalog,
    set_catalog,
)
from app.media.performance import thumbnail_cache  # noqa: E402


def _hash(i: int) -> str:
    return f"{i:032x}"


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _tiny_jpeg() -> bytes:
    # 1x1 JPEG. Warmer caches compressed bytes only.
    return (
        b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        b"\xff\xdb\x00C\x00" + (b"\x08" * 64)
        + b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
        b"\xff\xc4\x00\x14\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00"
        b"\x00\x00\x00\x00\x00\x00\x00\x00\xff\xda\x00\x08\x01\x01\x00\x00"
        b"?\x00\x7f\xff\xd9"
    )


class Fixture:
    def __init__(self, n: int = 1000, project_n: int = 40, thumbs: int = 0, thumb_bytes: bytes | None = None):
        self.n = n
        self.project_n = project_n
        self.thumbs = thumbs
        self.thumb_bytes = thumb_bytes or _tiny_jpeg()
        self.tmp = tempfile.TemporaryDirectory(prefix="mtapi-catalog-")
        self.root = Path(self.tmp.name)
        self.media = self.root / "media"
        self.by_hash = self.media / "by_hash"
        self.by_hash.mkdir(parents=True)
        self.index_paths: dict[str, dict] = {}
        self.project_items: list[dict] = []
        self.orphan_hashes: list[str] = []
        self._build()

    def _build(self) -> None:
        jpeg = self.thumb_bytes
        for i in range(self.n):
            h = _hash(i)
            path = f"/media/clip_{i:04d}.mp4"
            rec = {
                "hash": h,
                "algo": "blake2b",
                "size": 1000 + i,
                "paths": [path],
                "meta": {
                    "width": 320, "height": 240, "fps": 24,
                    "duration": 2.0, "frames": 48, "video_codec": "h264",
                },
                "thumbs": {"first": i < self.thumbs, "last": False},
                "history": [{"ts": 1.0, "event": "opened", "path": path}],
                "variants": (
                    {"rifed": [{"kind": "rifed", "hash": _hash(900000 + i),
                                "path": f"/media/clip_{i:04d}_4x.mp4",
                                "detail": {"multiplier": 4}}]}
                    if i % 11 == 0 else {}
                ),
                "phashes": {"first": f"{i:016x}", "last": None} if i % 5 == 0 else {},
                "created_at": 1.0,
                "updated_at": 10.0 + i,
                "open_count": 2,
            }
            d = self.by_hash / h
            d.mkdir()
            _write_json(d / "record.json", rec)
            if i < self.thumbs:
                (d / "first_M.jpg").write_bytes(jpeg)
                (d / "first_H.jpg").write_bytes(jpeg)
            if i < self.project_n:
                self.index_paths[path] = {
                    "hash": h, "size": rec["size"], "mtime_ns": 1, "updated_at": 10.0 + i,
                }
                self.project_items.append({
                    "path": path, "name": Path(path).name, "hash": h, "size": rec["size"],
                })
            else:
                self.orphan_hashes.append(h)
        # One extra orphan not in the active project or index.
        orphan_h = _hash(self.n + 7)
        _write_json(self.by_hash / orphan_h / "record.json", {
            "hash": orphan_h,
            "algo": "blake2b",
            "size": 42,
            "paths": ["/media/orphan_outside_project.mp4"],
            "meta": {"width": 16, "height": 16},
            "thumbs": {"first": False, "last": False},
            "history": [{"ts": 1, "event": "opened"}] * 8,
            "variants": {},
            "created_at": 1.0,
            "updated_at": 99.0,
            "open_count": 1,
        })
        self.orphan_hashes.append(orphan_h)
        self.n += 1
        _write_json(self.media / "index.json", {"version": 1, "paths": self.index_paths})
        _write_json(self.root / "settings.json", {
            "thumbnail_size": "M",
            "thumbnails_to_ram": False,
        })
        _write_json(self.root / "pool_state.json", {
            "version": 2,
            "items": self.project_items,
            "images": [],
            "sequence": [self.project_items[0]["path"]] if self.project_items else [],
        })

    def catalog(self, **kwargs) -> CatalogIndex:
        return CatalogIndex(media_root=self.media, acquire_lock=kwargs.pop("acquire_lock", True), **kwargs)

    def close(self) -> None:
        self.tmp.cleanup()


class IoWatch:
    """Count real Path.read_text / is_file / stat on catalog files and source media."""

    def __init__(self):
        self.index_reads = 0
        self.record_reads = 0
        self.source_stats = 0
        self._orig_read = Path.read_text
        self._orig_stat = Path.stat
        self._orig_is_file = Path.is_file

    def install(self) -> None:
        watch = self

        def read_text(self_path: Path, *a, **k):
            name = self_path.name
            if name == "index.json":
                watch.index_reads += 1
            elif name == "record.json":
                watch.record_reads += 1
            return watch._orig_read(self_path, *a, **k)

        def stat(self_path: Path, *a, **k):
            text = str(self_path)
            if text.startswith("/media/clip_") or text.startswith("/media/orphan"):
                watch.source_stats += 1
            return watch._orig_stat(self_path, *a, **k)

        def is_file(self_path: Path):
            text = str(self_path)
            if text.startswith("/media/clip_") or text.startswith("/media/orphan"):
                watch.source_stats += 1
            return watch._orig_is_file(self_path)

        Path.read_text = read_text  # type: ignore[method-assign]
        Path.stat = stat  # type: ignore[method-assign]
        Path.is_file = is_file  # type: ignore[method-assign]

    def restore(self) -> None:
        Path.read_text = self._orig_read  # type: ignore[method-assign]
        Path.stat = self._orig_stat  # type: ignore[method-assign]
        Path.is_file = self._orig_is_file  # type: ignore[method-assign]


def _run(coro):
    return asyncio.run(coro)


class CatalogHydrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = Fixture(n=1000, project_n=40, thumbs=12)
        self.watch = IoWatch()
        self.watch.install()

    def tearDown(self) -> None:
        self.watch.restore()
        self.fx.close()

    def test_hydrate_1000_including_orphans(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        self.assertTrue(cat.catalog_ready)
        self.assertGreaterEqual(cat.records_loaded, 1001)
        self.assertEqual(cat.records_loaded, cat.records_total)
        self.assertEqual(len(cat.hash_to_record), cat.records_loaded)
        # Active project is a small subset; orphans still resident.
        self.assertGreater(len(self.fx.orphan_hashes), 900)
        for h in self.fx.orphan_hashes[:20]:
            rec = cat.record_for_hash(h)
            self.assertIsNotNone(rec, h)
            self.assertEqual(rec.hash, h)
        orphan = cat.record_for_path("/media/orphan_outside_project.mp4")
        self.assertIsNotNone(orphan)
        self.assertGreater(orphan.history_count, 0)
        # Full history arrays are not RAM-resident.
        served = cat.serving_dict(orphan)
        self.assertEqual(served["history"], [])
        self.assertEqual(served["history_count"], orphan.history_count)
        # Membership is the project subset only.
        self.assertEqual(len(cat.membership["items"]), 40)
        self.assertFalse(cat.index_load_failed)

    def test_zero_post_hydration_json_reads_on_display(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        idx0, rec0 = self.watch.index_reads, self.watch.record_reads
        src0 = self.watch.source_stats
        for i in range(0, 200, 3):
            h = _hash(i)
            rec = cat.record_for_hash(h)
            self.assertIsNotNone(rec)
            self.assertIsNotNone(cat.record_for_path(f"/media/clip_{i:04d}.mp4"))
            cat.variants_for_path(f"/media/clip_{i:04d}.mp4")
            cat.public_payload(h)
            cat.overlay_item({"path": f"/media/clip_{i:04d}.mp4", "hash": h})
        cat.pool_state_payload()
        self.assertEqual(self.watch.index_reads, idx0)
        self.assertEqual(self.watch.record_reads, rec0)
        self.assertEqual(self.watch.source_stats, src0)
        self.assertEqual(cat.counters.index_json_reads, 0)
        self.assertEqual(cat.counters.record_json_reads, 0)
        self.assertEqual(cat.counters.source_stats, 0)

    def test_malformed_record_isolated(self) -> None:
        bad = self.fx.by_hash / "not-a-hash-dir"
        bad.mkdir()
        (bad / "record.json").write_text("{not json", encoding="utf-8")
        empty = self.fx.by_hash / _hash(424242)
        empty.mkdir()
        (empty / "record.json").write_text("[]", encoding="utf-8")
        cat = self.fx.catalog()
        cat.hydrate()
        self.assertGreaterEqual(cat.counters.malformed_record_count, 2)
        self.assertTrue(any("parse error" in i.reason for i in cat.isolated))
        self.assertNotIn(_hash(424242), cat.hash_to_record)
        self.assertTrue(cat.catalog_ready)

    def test_malformed_index_does_not_overwrite(self) -> None:
        index = self.fx.media / "index.json"
        original = index.read_text(encoding="utf-8")
        index.write_text("NOT JSON {", encoding="utf-8")
        cat = self.fx.catalog()
        cat.hydrate()
        self.assertTrue(cat.index_load_failed)
        self.assertTrue(cat.catalog_ready)
        # Path maps fall back to record paths.
        self.assertIsNotNone(cat.hash_for_path("/media/clip_0000.mp4"))
        cat.update_path_mapping("/media/new.mp4", _hash(0), persist=True)
        after = index.read_text(encoding="utf-8")
        self.assertEqual(after, "NOT JSON {")
        self.assertNotEqual(after, '{"version": 1, "paths": {}}')
        # Restore for hygiene.
        index.write_text(original, encoding="utf-8")


class CatalogMutationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = Fixture(n=80, project_n=10, thumbs=4)

    def tearDown(self) -> None:
        self.fx.close()

    def test_repair_updates_ram_and_persists_atomically(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        h = _hash(0)
        rec = cat.record_for_hash(h)
        self.assertIsNotNone(rec)
        payload = cat.serving_dict(rec)
        payload["meta"] = {**(rec.meta or {}), "width": 999}
        payload["history"] = [{"ts": 99, "event": "repair"}]
        cat.upsert_record(payload)
        self.assertEqual(cat.record_for_hash(h).meta["width"], 999)
        disk = json.loads((self.fx.by_hash / h / "record.json").read_text(encoding="utf-8"))
        self.assertEqual(disk["meta"]["width"], 999)
        tmp = self.fx.by_hash / h / "record.tmp"
        self.assertFalse(tmp.exists())

    def test_persist_failure_sets_flag_and_restart_keeps_old_disk(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        h = _hash(1)
        original = json.loads((self.fx.by_hash / h / "record.json").read_text())
        cat.inject_persist_error = True
        payload = cat.serving_dict(cat.record_for_hash(h))
        payload["meta"] = {**(payload.get("meta") or {}), "width": 12345}
        rec = cat.upsert_record(payload)
        self.assertTrue(rec.persist_failed)
        self.assertGreaterEqual(cat.counters.persist_failed_count, 1)
        self.assertEqual(cat.record_for_hash(h).meta["width"], 12345)
        disk = json.loads((self.fx.by_hash / h / "record.json").read_text())
        self.assertEqual(disk["meta"]["width"], original["meta"]["width"])
        cat.release_process_lock()
        cat2 = self.fx.catalog()
        cat2.hydrate()
        self.assertNotEqual(cat2.record_for_hash(h).meta["width"], 12345)
        self.assertEqual(cat2.record_for_hash(h).meta["width"], original["meta"]["width"])
        cat2.release_process_lock()

    def test_missing_thumbs_not_generated(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        h = _hash(50)
        rec = cat.record_for_hash(h)
        self.assertEqual(rec.thumbs["first"]["M"].state, "missing")
        before = list((self.fx.by_hash / h).iterdir())
        src, kind = _run(cat.serve_hash_thumbnail(h, "first", "M"))
        self.assertIsNone(src)
        self.assertEqual(kind, "missing")
        after = list((self.fx.by_hash / h).iterdir())
        self.assertEqual({p.name for p in before}, {p.name for p in after})
        self.assertFalse((self.fx.by_hash / h / "first_M.jpg").exists())

    def test_project_switch_preserves_global_catalog(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        n = len(cat.hash_to_record)
        epoch = cat.warmer_epoch
        variants0 = cat.variants_for_path("/media/clip_0000.mp4")
        phash0 = cat.record_for_hash(_hash(0)).phashes
        other = {
            "kind": "fftransmute-project",
            "name": "other",
            "pool": {
                "items": [{"path": "/offline/missing.mp4", "name": "missing.mp4"}],
                "images": [],
                "sequence": [{"path": "/offline/missing.mp4"}],
            },
        }
        payload = cat.apply_membership_snapshot(other)
        self.assertEqual(len(cat.hash_to_record), n)
        self.assertEqual(cat.warmer_epoch, epoch)
        self.assertEqual(cat.variants_for_path("/media/clip_0000.mp4"), variants0)
        self.assertEqual(cat.record_for_hash(_hash(0)).phashes, phash0)
        paths = [it["path"] for it in payload["items"]]
        self.assertIn("/offline/missing.mp4", paths)
        self.assertEqual(payload.get("missing"), [])

    def test_second_process_fails_closed(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        with self.assertRaises(CatalogLockHeld) as ctx:
            other = self.fx.catalog()
            other.hydrate()
        self.assertIn("pid=", str(ctx.exception))
        cat.release_process_lock()


class CatalogWarmerTests(unittest.TestCase):
    def setUp(self) -> None:
        # 20 available thumbs * ~200 bytes still tiny; we shrink the budget instead.
        self.fx = Fixture(n=40, project_n=5, thumbs=20)
        _run(thumbnail_cache.clear())
        thumbnail_cache.evicted = 0

    def tearDown(self) -> None:
        _run(thumbnail_cache.clear())
        thumbnail_cache.evicted = 0
        self.fx.close()

    def test_over_budget_considered_vs_resident(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        cat.thumbnails_to_ram = True
        cat.selected_size = "M"
        original_max = thumbnail_cache.max_bytes
        thumbnail_cache.max_bytes = 400
        try:
            _run(cat.run_warmer())
            self.assertTrue(cat.thumbnail_warm_complete)
            self.assertGreater(cat.counters.warm_considered, 0)
            stats = _run(thumbnail_cache.stats())
            self.assertLessEqual(stats["bytes"], 400)
            self.assertLess(stats["entries"], cat.counters.warm_considered)
            self.assertGreaterEqual(stats["evicted"], cat.counters.warm_considered - stats["entries"])
            # An evicted available thumb is a disk fallback, not a failure.
            served_disk = 0
            for i in range(20):
                payload, src = _run(cat.serve_hash_thumbnail(_hash(i), "first", "M"))
                self.assertIsNotNone(payload)
                if src == "disk":
                    served_disk += 1
            self.assertGreater(served_disk, 0)
            self.assertGreater(cat.counters.disk_fallbacks, 0)
        finally:
            thumbnail_cache.max_bytes = original_max

    def test_size_change_invalidates_stale_epoch(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        cat.thumbnails_to_ram = True
        cat.selected_size = "M"
        old_epoch = cat.warmer_epoch
        rec = cat.record_for_hash(_hash(0))
        slot = rec.thumbs["first"]["M"]
        key_m = cat.thumb_cache_key(rec.hash, "first", "M", slot.rev)
        _run(cat.warmer_put_for_test(old_epoch, key_m, b"old-m"))
        self.assertTrue(thumbnail_cache.has(key_m))
        _run(cat.set_thumbnail_size("H"))
        self.assertEqual(cat.warmer_epoch, old_epoch + 1)
        self.assertFalse(thumbnail_cache.has(key_m))
        self.assertTrue((self.fx.by_hash / _hash(0) / "first_M.jpg").exists())
        stale_ok = _run(cat.warmer_put_for_test(old_epoch, key_m, b"stale"))
        self.assertFalse(stale_ok)
        self.assertFalse(thumbnail_cache.has(key_m))

    def test_thumbnails_to_ram_false_cancels_and_clears(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        cat.thumbnails_to_ram = True
        _run(cat.run_warmer())
        _run(cat.set_thumbnails_to_ram(False))
        stats = _run(thumbnail_cache.stats())
        self.assertEqual(stats["entries"], 0)
        self.assertTrue(cat.thumbnail_warm_complete)
        status = _run(cat.status())
        self.assertEqual(status["budget_bytes"], THUMB_RAM_BUDGET)
        self.assertEqual(status["ram_hits"], 0)
        self.assertEqual(status["resident_entries"], 0)
        self.assertTrue((self.fx.by_hash / _hash(0) / "first_M.jpg").exists())

    def test_budget_bytes_reported(self) -> None:
        cat = self.fx.catalog()
        cat.hydrate()
        status = _run(cat.status())
        self.assertEqual(status["budget_bytes"], 64 * 1024 * 1024)
        self.assertTrue(status["catalog_ready"])


class WrappedDisplayPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = Fixture(n=30, project_n=8, thumbs=4)
        self.cat = self.fx.catalog()
        self.cat.hydrate()
        set_catalog(self.cat)
        self.watch = IoWatch()
        self.watch.install()

    def tearDown(self) -> None:
        self.watch.restore()
        reset_catalog()
        self.fx.close()

    def test_wrapped_helpers_do_not_reread_json_or_stat_source(self) -> None:
        from app.media.cache import _load_index, get_variants, load_record, lookup_cached_hash
        from app.media.pool import load_pool_state

        idx0, rec0, src0 = self.watch.index_reads, self.watch.record_reads, self.watch.source_stats
        rec = load_record(_hash(0))
        self.assertIsNotNone(rec)
        self.assertEqual(rec["history"], [])
        index = _load_index()
        self.assertIn("/media/clip_0000.mp4", index.get("paths") or self.cat.path_to_hash)
        self.assertEqual(lookup_cached_hash(Path("/media/clip_0000.mp4")), _hash(0))
        variants = _run(get_variants("/media/clip_0000.mp4", hash_if_missing=False))
        self.assertIsInstance(variants, dict)
        state = load_pool_state()
        self.assertTrue(state.get("ok"))
        self.assertEqual(self.watch.index_reads, idx0)
        self.assertEqual(self.watch.record_reads, rec0)
        self.assertEqual(self.watch.source_stats, src0)


class RunPyWorkersTests(unittest.TestCase):
    def test_run_py_pins_workers_one(self) -> None:
        text = (ROOT / "run.py").read_text(encoding="utf-8")
        self.assertIn("workers=1", text)
        self.assertIn("WEB_CONCURRENCY", text)
        self.assertIn("UVICORN_WORKERS", text)
        self.assertIn("_forced_workers", text)


if __name__ == "__main__":
    unittest.main()
