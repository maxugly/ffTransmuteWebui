"""Backend checks for the unified Media Catalog DB (spec §4, §6, §6.6)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.database import audio_db  # noqa: E402
from app.media.performance import _normalize_settings  # noqa: E402

VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".webm", ".avi"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _is_video(p: Path) -> bool:
    return p.suffix.lower() in VIDEO_EXTS


def _is_image(p: Path) -> bool:
    return p.suffix.lower() in IMAGE_EXTS


class MediaCatalogDbTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self._prev_env = os.environ.pop("MTAPI_MEDIA_CATALOG_DB", None)
        self._prev_path = audio_db.DB_PATH
        audio_db.set_db_path(str(self.root / "catalog.db"))
        audio_db.init_db()
        self.lib = self.root / "lib"
        self.lib.mkdir()
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        audio_db.set_db_path(self._prev_path)
        if self._prev_env is not None:
            os.environ["MTAPI_MEDIA_CATALOG_DB"] = self._prev_env

    def _make(self, name: str, data: bytes = b"x" * 2048) -> str:
        p = self.lib / name
        p.write_bytes(data)
        return str(p)

    def _upsert(self, path: str, **kw):
        kw.setdefault("origin", "import")
        kw.setdefault("owned_dirs", [])
        kw.setdefault("generated_flag", False)
        kw.setdefault("status", "pending")
        kw.setdefault("is_video_fn", _is_video)
        kw.setdefault("is_image_fn", _is_image)
        return audio_db.catalog_upsert(path, **kw)

    def _row(self, path: str) -> dict:
        row = audio_db.get_row(path)
        self.assertIsNotNone(row, f"no row for {path}")
        return row

    # ── 1. schema ──────────────────────────────────────────────────────────
    def test_init_db_idempotent_with_tables_and_indexes(self) -> None:
        audio_db.init_db()  # second run must not raise
        with audio_db.get_db() as db:
            tables = {r[0] for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("media", tables)
            self.assertIn("provenance_log", tables)
            indexes = {r[0] for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'")}
            for name in (
                "idx_media_type", "idx_media_mine", "idx_media_hand", "idx_media_ai",
                "idx_media_origin", "idx_media_site", "idx_media_tempo",
                "idx_media_key", "idx_media_hash", "idx_provlog_path",
                "idx_provlog_batch",
            ):
                self.assertIn(name, indexes)

    def test_classify_type_audio_video_image(self) -> None:
        self.assertEqual(audio_db.classify_type("a.wav", _is_video, _is_image), "audio")
        self.assertEqual(audio_db.classify_type("a.mp3", _is_video, _is_image), "audio")
        self.assertEqual(audio_db.classify_type("a.mp4", _is_video, _is_image), "video")
        self.assertEqual(audio_db.classify_type("a.png", _is_video, _is_image), "image")
        self.assertEqual(audio_db.classify_type("a.txt", _is_video, _is_image), "unknown")
        self.assertEqual(audio_db.classify_type("a.mp4"), "unknown")

    # ── 2. upsert idempotency ──────────────────────────────────────────────
    def test_upsert_idempotent_and_hash_refresh(self) -> None:
        path = self._make("a.wav")
        first = self._upsert(path)
        second = self._upsert(path)
        self.assertEqual(first["row_id"], second["row_id"])
        with audio_db.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM media").fetchone()[0], 1)
        old_hash = self._row(path)["file_hash"]
        self._make("a.wav", b"y" * 4096)  # same path, different bytes
        self._upsert(path)
        self.assertNotEqual(self._row(path)["file_hash"], old_hash)

    # ── 3. owned-dir rule ──────────────────────────────────────────────────
    def test_owned_dir_rule_sets_mine_without_craft_bits(self) -> None:
        path = self._make("b.wav")
        self._upsert(path, owned_dirs=[str(self.lib)])
        row = self._row(path)
        self.assertEqual(row["is_mine"], 1)
        self.assertEqual(row["mine_source"], "dir_rule")
        self.assertEqual(row["made_by_me"], 0)
        self.assertEqual(row["ai_involved"], 0)

    def test_owned_dir_rule_applies_to_existing_row(self) -> None:
        path = self._make("c.wav")
        self._upsert(path)  # first ingest with no rules
        self.assertEqual(self._row(path)["is_mine"], 0)
        self._upsert(path, owned_dirs=[str(self.lib)])  # user adds the rule later
        row = self._row(path)
        self.assertEqual(row["is_mine"], 1)
        self.assertEqual(row["mine_source"], "dir_rule")

    def test_path_containment_is_not_string_prefix(self) -> None:
        # /lib/music2 is NOT inside /lib/music (regression: startswith matched).
        sibling = self.root / "music2"
        sibling.mkdir()
        target = sibling / "d.wav"
        target.write_bytes(b"z" * 512)
        self._upsert(str(target), owned_dirs=[str(self.root / "music")])
        self.assertEqual(self._row(str(target))["is_mine"], 0)
        self.assertTrue(audio_db.path_is_owned(str(self.lib / "x.wav"), [str(self.lib)]))
        self.assertFalse(audio_db.path_is_owned(str(target), [str(self.root / "music")]))
        self.assertFalse(audio_db.path_is_owned(str(target), []))

    # ── 4. generated claim ─────────────────────────────────────────────────
    def test_generated_claim_sets_mine_and_ai_not_hand(self) -> None:
        path = self._make("e.wav")
        self._upsert(path, generated_flag=True, origin="generated")
        row = self._row(path)
        self.assertEqual(row["is_mine"], 1)
        self.assertEqual(row["ai_involved"], 1)
        self.assertEqual(row["mine_source"], "generated")
        self.assertEqual(row["made_by_me"], 0)
        self.assertEqual(row["origin"], "generated")

    # ── 5. web fields persist, never wiped ─────────────────────────────────
    def test_web_fields_survive_reupsert(self) -> None:
        path = self._make("f.mp4")
        self._upsert(path, origin="web", web_fields={
            "site": "youtube", "is_youtube": True, "author": "A",
            "source_url": "https://x", "video_id": "abc", "publish_date": "2024-01-01",
        })
        row = self._row(path)
        self.assertEqual(row["origin"], "web")
        self.assertEqual(row["site"], "youtube")
        self.assertEqual(row["is_youtube"], 1)
        self.assertEqual(row["type"], "video")
        self.assertEqual(row["is_mine"], 0)
        self.assertEqual(row["made_by_me"], 0)
        self.assertEqual(row["ai_involved"], 0)  # downloaded AI slop stays 0/0

        self._upsert(path, status="scanned")  # rescan without web fields
        after = self._row(path)
        self.assertEqual(after["site"], "youtube")
        self.assertEqual(after["author"], "A")
        self.assertEqual(after["video_id"], "abc")
        self.assertEqual(after["publish_date"], "2024-01-01")
        self.assertEqual(after["status"], "scanned")

    # ── 6. manual precedence ───────────────────────────────────────────────
    def test_manual_row_never_reasserted_by_heuristics(self) -> None:
        path = self._make("g.wav")
        self._upsert(path, generated_flag=True)
        audio_db.mark(path, False, False, False)  # explicit disclaimer
        self.assertEqual(self._row(path)["is_mine"], 0)
        self._upsert(path, owned_dirs=[str(self.lib)], generated_flag=True,
                     origin="generated")
        row = self._row(path)
        self.assertEqual(row["is_mine"], 0)
        self.assertEqual(row["made_by_me"], 0)
        self.assertEqual(row["ai_involved"], 0)
        self.assertEqual(row["mine_source"], "manual")

    def test_generated_beats_dir_rule_strength(self) -> None:
        path = self._make("h.wav")
        self._upsert(path, owned_dirs=[str(self.lib)])
        self.assertEqual(self._row(path)["mine_source"], "dir_rule")
        self._upsert(path, owned_dirs=[str(self.lib)], generated_flag=True)
        row = self._row(path)
        self.assertEqual(row["mine_source"], "generated")
        self.assertEqual(row["ai_involved"], 1)

    # ── 7. write-time invariant ────────────────────────────────────────────
    def test_write_time_invariant_pulls_is_mine_up(self) -> None:
        path = self._make("i.wav")
        audio_db.mark(path, False, True, False)
        self.assertEqual(self._row(path)["is_mine"], 1)  # hand ⇒ mine
        audio_db.mark(path, False, False, True)
        self.assertEqual(self._row(path)["is_mine"], 1)  # ai ⇒ mine

    # ── 8/9. mark semantics ────────────────────────────────────────────────
    def test_mark_unmark_zeroes_triple_but_keeps_manual_source(self) -> None:
        path = self._make("j.wav")
        audio_db.mark(path, True, True, True)
        res = audio_db.mark(path, False, False, False)
        self.assertTrue(res["changed"])
        row = self._row(path)
        self.assertEqual(
            (row["is_mine"], row["made_by_me"], row["ai_involved"]), (0, 0, 0)
        )
        self.assertEqual(row["mine_source"], "manual")

    def test_mark_on_never_ingested_path_creates_row(self) -> None:
        path = self._make("k.png")
        res = audio_db.mark(path, True, True, False,
                            is_video_fn=_is_video, is_image_fn=_is_image)
        row = self._row(path)
        self.assertEqual(res["row_id"], row["id"])
        self.assertEqual(row["type"], "image")
        self.assertEqual(row["is_mine"], 1)
        self.assertEqual(row["made_by_me"], 1)
        self.assertEqual(row["mine_source"], "manual")

    # ── 10. audit log ──────────────────────────────────────────────────────
    def test_provenance_log_appends_on_change_only(self) -> None:
        path = self._make("l.wav")
        first = self._upsert(path, owned_dirs=[str(self.lib)])
        self.assertTrue(first["changed"])
        again = self._upsert(path, owned_dirs=[str(self.lib)])
        self.assertFalse(again["changed"])  # no triple change → no new log row
        history = audio_db.provenance_history(path)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["mechanism"], "dir_rule")
        self.assertEqual(history[0]["old_is_mine"], 0)
        self.assertEqual(history[0]["new_is_mine"], 1)

    def test_provenance_log_shares_supplied_batch_id(self) -> None:
        a = self._make("m1.wav")
        b = self._make("m2.wav")
        bid = "batch-xyz"
        audio_db.mark(a, True, True, False, batch_id=bid)
        audio_db.mark(b, True, False, True, batch_id=bid)
        with audio_db.get_db() as db:
            rows = db.execute(
                "SELECT DISTINCT batch_id FROM provenance_log WHERE batch_id = ?",
                (bid,),
            ).fetchall()
        self.assertEqual(len(rows), 1)
        with audio_db.get_db() as db:
            n = db.execute(
                "SELECT COUNT(*) FROM provenance_log WHERE batch_id = ?", (bid,)
            ).fetchone()[0]
        self.assertEqual(n, 2)

    # ── 11. undo ───────────────────────────────────────────────────────────
    def test_undo_batch_restores_triple_and_keeps_analysis(self) -> None:
        a = self._make("n1.wav")
        b = self._make("n2.wav")
        self._upsert(a, owned_dirs=[str(self.lib)])
        self._upsert(b, owned_dirs=[str(self.lib)])
        batch = audio_db.mark(a, False, False, False)["batch_id"]
        audio_db.mark(b, False, False, False, batch_id=batch)

        # A scan later fills an analysis column on row A.
        with audio_db.get_db() as db:
            db.execute("UPDATE media SET tempo = 128.32, key_name = 'C major' WHERE path = ?", (a,))

        res = audio_db.undo_batch(batch)
        self.assertEqual(res["restored"], 2)
        self.assertIsNotNone(res["batch_id"])
        row_a = self._row(a)
        self.assertEqual(row_a["is_mine"], 1)
        self.assertEqual(row_a["mine_source"], "dir_rule")
        self.assertEqual(row_a["tempo"], 128.32)          # analysis untouched
        self.assertEqual(row_a["key_name"], "C major")
        self.assertEqual(self._row(b)["is_mine"], 1)

        # Undo is itself logged under a fresh batch id.
        undo_history = audio_db.provenance_history(a)
        self.assertEqual(undo_history[0]["mechanism"], "undo")
        self.assertEqual(undo_history[0]["batch_id"], res["batch_id"])
        self.assertEqual(undo_history[0]["new_is_mine"], 1)

    def test_undo_unknown_batch_is_noop(self) -> None:
        res = audio_db.undo_batch("nope")
        self.assertEqual(res["restored"], 0)

    # ── 12. settings normalize ─────────────────────────────────────────────
    def test_normalize_settings_owned_dirs(self) -> None:
        self.assertEqual(_normalize_settings(None)["owned_dirs"], [])
        self.assertEqual(_normalize_settings({})["owned_dirs"], [])
        # non-list → []
        self.assertEqual(_normalize_settings({"owned_dirs": "x"})["owned_dirs"], [])
        out = _normalize_settings({
            "owned_dirs": [
                str(self.lib),
                str(self.lib),                       # dedupe
                "relative/path",                     # dropped (not absolute)
                "",                                  # dropped
                123,                                 # dropped (not a string)
                None,                                # dropped
                "~/",                                 # expanded to home
            ]
        })["owned_dirs"]
        self.assertIn(str(self.lib), out)
        self.assertNotIn("relative/path", out)
        self.assertNotIn("", out)
        self.assertIn(os.path.expanduser("~/"), out)
        self.assertEqual(len(out), len(set(out)))

    def test_normalize_settings_owned_dirs_cap(self) -> None:
        many = [f"/abs/dir-{i}" for i in range(400)]
        self.assertEqual(len(_normalize_settings({"owned_dirs": many})["owned_dirs"]), 256)


if __name__ == "__main__":
    unittest.main()