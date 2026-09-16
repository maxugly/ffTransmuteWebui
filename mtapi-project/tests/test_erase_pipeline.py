"""Sequence Erase → RIFE → Conform pipeline (docs/sequence-erase-pipeline-spec.md).

Covers: lineage creation/migration, mask signatures, invalidation,
original-source selection, artifact reuse, duplicate occurrences, failure
recovery, cancellation, and batch response aggregation. Stage work is
faked at the operation-handler boundary (no media, no subprocess).
"""
from __future__ import annotations

import asyncio
import os
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import job_control  # noqa: E402
from app.contract import OperationResult  # noqa: E402
from app.media import lineage as lin  # noqa: E402
from app.media import pool as pool_mod  # noqa: E402
from app.operations import erase_pipeline_ops as ep  # noqa: E402
from app.video_pipeline import (  # noqa: E402
    conform_signature,
    is_conform_signature_valid,
)


def _mask_png(w: int, h: int, seed: int = 1) -> bytes:
    """Minimal valid PNG (IHDR + one solid IDAT row block)."""
    raw = bytes([(seed * 37 + y * w + x) % 256 for y in range(h) for x in range(w)])
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    idat = zlib.compress(b"\x00" * w * h + raw[:0] + b"\x00" + bytes([seed]) * w)
    out = bytearray(b"\x89PNG\r\n\x1a\n")
    for kind, data in ((b"IHDR", ihdr), (b"IDAT", idat)):
        out += struct.pack(">I", len(data)) + kind + data
        out += struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return bytes(out)


def _b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")


class _Iso(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mtapi-erasepipe-")
        self.root = Path(self.tmp.name)
        self._old = os.environ.get("MTAPI_LINEAGES")
        os.environ["MTAPI_LINEAGES"] = str(self.root / "lineages")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("MTAPI_LINEAGES", None)
        else:
            os.environ["MTAPI_LINEAGES"] = self._old
        self.tmp.cleanup()

    def _clip(self, name="clip.mp4") -> str:
        p = self.root / name
        p.write_bytes(b"fake-video-bytes-" + name.encode())
        return str(p)


class LineageIdentityTest(_Iso):
    def test_migrate_assigns_stable_id_per_path(self):
        items = [{"path": self._clip("a.mp4")}, {"path": self._clip("b.mp4")}]
        seq = [
            {"id": "occ-1", "path": items[0]["path"]},
            {"id": "occ-2", "path": items[0]["path"]},
            {"id": "occ-3", "path": items[1]["path"]},
        ]
        mapping = lin.migrate_entries(items, seq)
        self.assertEqual(len(mapping), 2)
        # Same source → same lineage; occurrence ids untouched.
        self.assertEqual(seq[0]["lineage_id"], seq[1]["lineage_id"])
        self.assertEqual(seq[0]["lineage_id"], items[0]["lineage_id"])
        self.assertNotEqual(seq[0]["lineage_id"], seq[2]["lineage_id"])
        self.assertEqual(seq[0]["id"], "occ-1")
        self.assertEqual(seq[1]["id"], "occ-2")

    def test_migrate_reuses_valid_and_replaces_invalid(self):
        good = lin.new_lineage_id()
        p = self._clip("c.mp4")
        seq = [
            {"id": "1", "path": p, "lineage_id": good},
            {"id": "2", "path": p, "lineageId": "not-a-uuid"},
        ]
        lin.migrate_entries(None, seq)
        self.assertEqual(seq[0]["lineage_id"], good)
        # Invalid persisted id is replaced, but both rows share the lineage.
        self.assertEqual(seq[1]["lineage_id"], good)

    def test_normalize_rejects_non_uuid(self):
        self.assertIsNone(lin.normalize_lineage_id("nope"))
        self.assertIsNone(lin.normalize_lineage_id(None))
        lid = lin.new_lineage_id()
        self.assertEqual(lin.normalize_lineage_id(lid), lid)


class MaskContractTest(_Iso):
    def test_save_load_roundtrip(self):
        lid = lin.new_lineage_id()
        raw = _mask_png(32, 16)
        rec = lin.save_mask(lid, raw, 32, 16, {"hd_strategy": "Crop"})
        self.assertEqual(rec["mask_id"], lin.mask_signature(raw))
        self.assertEqual((rec["width"], rec["height"]), (32, 16))
        self.assertEqual(rec["threshold"], 127)
        back = lin.load_mask_record(lid)
        assert back is not None
        self.assertEqual(back["mask_id"], rec["mask_id"])
        self.assertEqual(lin.load_mask_bytes(lid), raw)

    def test_dimension_mismatch_rejected(self):
        lid = lin.new_lineage_id()
        with self.assertRaises(ValueError):
            lin.save_mask(lid, _mask_png(32, 16), 64, 16)

    def test_non_png_rejected(self):
        lid = lin.new_lineage_id()
        with self.assertRaises(ValueError):
            lin.save_mask(lid, b"not a png", 4, 4)
        with self.assertRaises(ValueError):
            lin.decode_mask_b64("!!!not-base64!!!")

    def test_clear(self):
        lid = lin.new_lineage_id()
        lin.save_mask(lid, _mask_png(8, 8), 8, 8)
        self.assertTrue(lin.clear_mask(lid))
        self.assertIsNone(lin.load_mask_record(lid))
        self.assertFalse(lin.clear_mask(lid))

    def test_redraw_changes_mask_signature(self):
        a = lin.mask_signature(_mask_png(8, 8, seed=1))
        b = lin.mask_signature(_mask_png(8, 8, seed=2))
        self.assertNotEqual(a, b)


class InvalidationTest(_Iso):
    def _detail(self, **over):
        d = {
            "lineage_id": "lid-1", "derived_from": "/abs/a.mp4",
            "mask_id": "m1", "mask_width": 32, "mask_height": 16,
            "erase_signature": lin.erase_signature(
                "m1", 32, 16, {"hd_strategy": "Crop"}),
            "erase_settings": lin.normalize_erase_settings({"hd_strategy": "Crop"}),
            "source_size": 100, "source_mtime": 10.0,
            "output_path": str(self.root / "a_clean_x.mp4"),
        }
        d.update(over)
        return d

    def test_changed_mask_invalidates_clean(self):
        out = self.root / "a_clean_x.mp4"
        out.write_bytes(b"x")
        ok, _ = lin.is_clean_detail_valid(
            self._detail(), lineage_id="lid-1", original_path="/abs/a.mp4",
            mask_id="m1", width=32, height=16, settings={"hd_strategy": "Crop"},
            source_size=100, source_mtime=10.0)
        self.assertTrue(ok)
        ok, why = lin.is_clean_detail_valid(
            self._detail(), lineage_id="lid-1", original_path="/abs/a.mp4",
            mask_id="m2", width=32, height=16, settings={"hd_strategy": "Crop"},
            source_size=100, source_mtime=10.0)
        self.assertFalse(ok)
        self.assertIn("mask", why)

    def test_changed_settings_or_source_invalidate(self):
        out = self.root / "a_clean_x.mp4"
        out.write_bytes(b"x")
        base = dict(lineage_id="lid-1", original_path="/abs/a.mp4",
                    mask_id="m1", width=32, height=16,
                    source_size=100, source_mtime=10.0)
        ok, _ = lin.is_clean_detail_valid(
            self._detail(), settings={"hd_strategy": "Crop"}, **base)
        self.assertTrue(ok)
        for kw in ({"settings": {"hd_strategy": "Resize"}},
                   {"source_size": 101}, {"source_mtime": 11.0}):
            kw2 = {"settings": {"hd_strategy": "Crop"}, **base, **kw}
            ok, _ = lin.is_clean_detail_valid(self._detail(), **kw2)
            self.assertFalse(ok, kw)
        (self.root / "a_clean_x.mp4").unlink()
        ok, why = lin.is_clean_detail_valid(
            self._detail(), settings={"hd_strategy": "Crop"}, **base)
        self.assertFalse(ok)
        self.assertIn("missing", why)

    def test_timing_change_invalidates_only_conform(self):
        sig = conform_signature(
            parent_path="/abs/clean.mp4", variant_path="/abs/c.mp4",
            source_size=50, source_mtime=5.0, source_variant="clean",
            mode="pad", aspect="16:9", width=640, height=360,
            target_fps=None, time_factor=1.0, preset="h264_avc_hq",
            audio_policy="encoded", rife_multiplier=None)
        cur = {**sig, "time_factor": 2.0}
        ok, why = is_conform_signature_valid(
            sig, current=cur, output_exists=True, output_size=10)
        self.assertFalse(ok)
        self.assertIn("time_factor", why)
        # ...while the clean artifact underneath stays valid.
        out = self.root / "clean.mp4"
        out.write_bytes(b"x")
        ok, _ = lin.is_clean_detail_valid(
            self._detail(output_path=str(out)), lineage_id="lid-1",
            original_path="/abs/a.mp4", mask_id="m1", width=32, height=16,
            settings={"hd_strategy": "Crop"}, source_size=100, source_mtime=10.0)
        self.assertTrue(ok)

    def test_find_valid_clean_prefers_newest(self):
        good1 = self.root / "g1.mp4"
        good2 = self.root / "g2.mp4"
        good1.write_bytes(b"1")
        good2.write_bytes(b"2")
        base = dict(lineage_id="lid-1", original_path="/abs/a.mp4",
                    mask_id="m1", width=32, height=16,
                    settings={"hd_strategy": "Crop"},
                    source_size=100, source_mtime=10.0)
        variants = {"clean": [
            {"path": str(good1), "detail": lin.clean_detail(
                output_path=str(good1), source_size=100, source_mtime=10.0,
                lineage_id="lid-1", original_path="/abs/a.mp4",
                mask_id="m1", width=32, height=16,
                settings={"hd_strategy": "Crop"})},
            {"path": str(good2), "detail": lin.clean_detail(
                output_path=str(good2), source_size=100, source_mtime=10.0,
                lineage_id="lid-1", original_path="/abs/a.mp4",
                mask_id="m1", width=32, height=16,
                settings={"hd_strategy": "Crop"})},
            {"path": "/abs/stale.mp4", "detail": self._detail(mask_id="old")},
        ]}
        hit = lin.find_valid_clean(variants, **base)
        assert hit is not None
        self.assertEqual(hit["path"], str(good2))


class RifeTargetFpsPlumbingTest(unittest.TestCase):
    """Regression: RIFE with target_fps must not crash encode().

    Found live by the erase-pipeline proof: rife_ops passed "fps" inside
    encode_kwargs while run_staged_job also passes fps positionally to
    encode() → `TypeError: encode() got multiple values for argument 'fps'`.
    The target fps must travel via the dedicated encode_fps slot only.
    """

    def test_no_fps_inside_encode_kwargs(self):
        import re

        src = (ROOT / "app" / "operations" / "rife_ops.py").read_text()
        m = re.search(r"encode_kwargs=\{([^}]*)\}", src)
        self.assertIsNotNone(m, "rife encode_kwargs call site missing")
        self.assertNotIn('"fps"', m.group(1))
        self.assertNotIn("'fps'", m.group(1))

    def test_target_fps_uses_encode_fps_slot(self):
        src = (ROOT / "app" / "operations" / "rife_ops.py").read_text()
        self.assertIn("encode_fps=", src)

    def test_rife_dry_run_with_target_fps(self):
        import tempfile

        from app.operations.rife_ops import RifeParams, rife_interpolate

        with tempfile.TemporaryDirectory(prefix="mtapi-rifefps-") as tmp:
            clip = str(Path(tmp) / "tiny.mp4")
            Path(clip).write_bytes(b"tiny")
            res = asyncio.run(rife_interpolate(RifeParams(
                input_path=clip, multiplier=2, target_fps=10.0,
                dry_run=True,
            )))
            self.assertTrue(res.ok)
            self.assertTrue(res.dry_run)

    def test_staged_job_single_fps_forward(self):
        """run_staged_job must forward exactly one fps to encode()."""
        import inspect

        from app import staged_job

        src = inspect.getsource(staged_job.run_staged_job)
        # Positional fps + **kwargs: callers must not also smuggle "fps".
        self.assertIn("**_ek", src)


class NoSubprocessGuardTest(unittest.TestCase):
    def test_orchestrator_has_no_subprocess(self):
        import re

        for name in ("app/operations/erase_pipeline_ops.py",
                     "app/media/lineage.py"):
            src = (ROOT / name).read_text()
            code = "\n".join(
                line for line in src.splitlines()
                if not line.strip().startswith(('"', "'", "#"))
            )
            self.assertNotRegex(code, r"^\s*(import|from)\s+subprocess\b",
                                f"{name} imports subprocess")
            self.assertNotIn("shell=True", code)
            self.assertNotIn("run_command(", code)
            self.assertNotRegex(code, r"\b(Popen|check_output|os\.system)\b",
                                f"{name} spawns processes")


class PipelineHarness(_Iso):
    """Fake stage ops at the handler boundary; real lineage + batch logic."""

    def setUp(self):
        super().setUp()
        self.calls: list[tuple[str, dict]] = []
        self._saved = (ep._run_erase, ep._run_rife, ep._run_conform,
                       ep._get_variants, ep._register_clean_variant,
                       ep._probe_stage_source)
        self.variants_db: dict[str, dict] = {}
        self.fail_stage: str | None = None

        async def fake_erase(params):
            self.calls.append(("erase", dict(params)))
            if self.fail_stage == "erase":
                return OperationResult(ok=False, operation="erase_remove",
                                       error="boom-erase")
            out = Path(params["output_path"])
            out.write_bytes(b"clean-bytes")
            return OperationResult(ok=True, operation="erase_remove",
                                   output_path=str(out))

        async def fake_rife(params):
            self.calls.append(("rife", dict(params)))
            if self.fail_stage == "rife":
                return OperationResult(ok=False, operation="rife",
                                       error="boom-rife")
            out = Path(str(params["input_path"])).parent / "rife_out.mp4"
            out.write_bytes(b"rife-bytes")
            return OperationResult(ok=True, operation="rife",
                                   output_path=str(out))

        async def fake_conform(params):
            self.calls.append(("conform", dict(params)))
            if self.fail_stage == "conform":
                return OperationResult(ok=False, operation="conform",
                                       error="boom-conform")
            out = Path(str(params["input_path"])).parent / (
                f"conf_{len(self.calls)}.mp4")
            out.write_bytes(b"conform-bytes")
            return OperationResult(
                ok=True, operation="conform", output_path=str(out),
                meta={"signature": {"kind": "conformed", "preset": params.get("preset")}},
            )

        async def fake_variants(parent):
            return self.variants_db.get(parent)

        async def fake_register(parent, output, detail):
            return {"ok": True}

        async def fake_probe(path):
            return {"width": 640, "height": 360, "duration": 4.0,
                    "has_audio": False}

        ep._run_erase = fake_erase  # type: ignore[assignment]
        ep._run_rife = fake_rife  # type: ignore[assignment]
        ep._run_conform = fake_conform  # type: ignore[assignment]
        ep._get_variants = fake_variants  # type: ignore[assignment]
        ep._register_clean_variant = fake_register  # type: ignore[assignment]
        ep._probe_stage_source = fake_probe  # type: ignore[assignment]

    def tearDown(self):
        (ep._run_erase, ep._run_rife, ep._run_conform,
         ep._get_variants, ep._register_clean_variant,
         ep._probe_stage_source) = self._saved
        super().tearDown()

    def _item(self, orig, lid=None, **kw):
        lid = lid or lin.new_lineage_id()
        body = {
            "lineage_id": lid, "original_path": orig,
            "erase": {"mask_b64": _b64(_mask_png(16, 16))},
            "occurrences": [{"occurrence_id": "occ-1"}],
        }
        body.update(kw)
        return ep.ErasePipelineItem(**body)


class OriginalSourceTest(PipelineHarness):
    def test_erase_receives_original_despite_active_variants(self):
        orig = self._clip("orig.mp4")
        item = self._item(orig, occurrences=[
            {"occurrence_id": "occ-1",
             "conformed_path": "/abs/stale_conformed.mp4",
             "conform_signature": {"kind": "conformed"}},
            {"occurrence_id": "occ-2", "target_duration": 8.0},
        ])
        out = asyncio.run(ep._process_lineage(item, index=0, total=1, dry_run=False))
        self.assertTrue(out["ok"], out)
        erases = [c for c in self.calls if c[0] == "erase"]
        self.assertEqual(len(erases), 1)
        self.assertEqual(erases[0][1]["input_path"], orig)
        self.assertNotIn("stale_conformed", erases[0][1]["input_path"])
        self.assertNotIn("_rife", erases[0][1]["input_path"])
        # Clean is registered as derived from the original with lineage id.
        self.assertIn("clean", (out.get("clean_signature") or {}).get("kind", "clean"))
        detail = out.get("clean_signature") or {}
        self.assertEqual(detail.get("derived_from"), orig)

    def test_rife_consumes_clean_and_conform_consumes_rife(self):
        orig = self._clip("r.mp4")
        item = self._item(orig, rife={"enabled": True, "multiplier": 4},
                          conform={"enabled": True, "mode": "pad",
                                   "aspect": "16:9", "width": 640, "height": 360,
                                   "preset": "h264_avc_hq"})
        out = asyncio.run(ep._process_lineage(item, index=0, total=1, dry_run=False))
        self.assertTrue(out["ok"], out)
        kinds = [c[0] for c in self.calls]
        self.assertEqual(kinds, ["erase", "rife", "conform"])
        rife_in = self.calls[1][1]["input_path"]
        self.assertEqual(rife_in, out["clean_path"])
        self.assertNotEqual(rife_in, orig)
        conf_in = self.calls[2][1]["input_path"]
        self.assertEqual(conf_in, out["variant_path"])
        self.assertEqual(self.calls[2][1]["source_variant"], "rifed")
        self.assertEqual(self.calls[2][1]["rife_multiplier"], 4)

    def test_conform_without_rife_uses_clean(self):
        orig = self._clip("c.mp4")
        item = self._item(orig, conform={"enabled": True, "mode": "crop",
                                        "aspect": "16:9", "width": 640,
                                        "height": 360, "preset": "h264_avc_hq"})
        out = asyncio.run(ep._process_lineage(item, index=0, total=1, dry_run=False))
        self.assertTrue(out["ok"], out)
        self.assertEqual([c[0] for c in self.calls], ["erase", "conform"])
        self.assertEqual(self.calls[1][1]["input_path"], out["clean_path"])
        self.assertEqual(self.calls[1][1]["source_variant"], "clean")


class ReuseAndDedupTest(PipelineHarness):
    def test_rerun_reuses_valid_clean(self):
        orig = self._clip("re.mp4")
        lid = lin.new_lineage_id()
        raw = _mask_png(16, 16)
        lin.save_mask(lid, raw, 16, 16)
        clean = self.root / "re_clean_deadbeef_12345678.mp4"
        clean.write_bytes(b"clean")
        import stat as _st

        sst = Path(orig).stat()
        detail = lin.clean_detail(
            lineage_id=lid, original_path=orig, mask_id=lin.mask_signature(raw),
            width=16, height=16, settings={}, source_size=sst.st_size,
            source_mtime=sst.st_mtime, output_path=str(clean))
        self.variants_db[orig] = {"clean": [{"path": str(clean), "detail": detail}]}
        item = self._item(orig, lid=lid)
        out = asyncio.run(ep._process_lineage(item, index=0, total=1, dry_run=False))
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["clean_path"], str(clean))
        self.assertEqual([c for c in self.calls if c[0] == "erase"], [])
        # Reuse still reports the signature (stale detection needs the mask id).
        sig = out.get("clean_signature") or {}
        self.assertEqual(sig.get("mask_id"), lin.mask_signature(raw))
        self.assertEqual(sig.get("lineage_id"), lid)

    def test_duplicate_lineages_share_work(self):
        a = self._clip("dup.mp4")
        lid = lin.new_lineage_id()
        mk = lambda occ: self._item(a, lid=lid, occurrences=[{"occurrence_id": occ}])
        params = ep.ErasePipelineParams(items=[mk("occ-1"), mk("occ-2")])
        res = asyncio.run(ep.erase_pipeline(params))
        self.assertTrue(res.ok)
        summary = (res.meta or {})["summary"]
        self.assertEqual(summary["total"], 1)
        self.assertEqual(summary["completed"], 1)
        erases = [c for c in self.calls if c[0] == "erase"]
        self.assertEqual(len(erases), 1)
        items = (res.meta or {})["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(sorted(items[0]["occurrence_ids"]), ["occ-1", "occ-2"])

    def test_duplicate_occurrences_keep_independent_conform(self):
        a = self._clip("dup2.mp4")
        item = self._item(
            a, conform={"enabled": True, "mode": "pad", "aspect": "16:9",
                       "width": 640, "height": 360, "preset": "h264_avc_hq"},
            occurrences=[{"occurrence_id": "o1", "target_duration": 4.0},
                         {"occurrence_id": "o2", "target_duration": 8.0}])
        out = asyncio.run(ep._process_lineage(item, index=0, total=1, dry_run=False))
        self.assertTrue(out["ok"], out)
        conforms = [c for c in self.calls if c[0] == "conform"]
        self.assertEqual(len(conforms), 2)
        self.assertEqual([c[0] for c in self.calls].count("erase"), 1)
        durs = sorted(c[1].get("target_duration") or 0 for c in conforms)
        self.assertEqual(durs, [4.0, 8.0])
        self.assertEqual(len(out["adoptions"]), 2)


class FailureRecoveryTest(PipelineHarness):
    def test_rife_failure_keeps_clean_and_continues(self):
        self.fail_stage = "rife"
        good = self._clip("good.mp4")
        bad = self._clip("bad.mp4")
        mk = lambda p, occ: self._item(
            p, lid=lin.new_lineage_id(), rife={"enabled": True, "multiplier": 2},
            occurrences=[{"occurrence_id": occ}])
        # Fail only the first lineage: flip flag after its RIFE attempt.
        orig_calls = self.calls
        params = ep.ErasePipelineParams(items=[mk(bad, "b"), mk(good, "g")])
        real_rife = ep._run_rife

        async def flaky(params):
            if len([c for c in orig_calls if c[0] == "rife"]) >= 1:
                out = Path(str(params["input_path"])).parent / "rife_out.mp4"
                out.write_bytes(b"rife-bytes")
                orig_calls.append(("rife", dict(params)))
                return OperationResult(ok=True, operation="rife",
                                       output_path=str(out))
            return await real_rife(params)

        ep._run_rife = flaky  # type: ignore[assignment]
        res = asyncio.run(ep.erase_pipeline(params))
        summary = (res.meta or {})["summary"]
        items = (res.meta or {})["items"]
        self.assertTrue(res.ok)
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["completed"], 1)
        self.assertEqual(items[0]["status"], "failed")
        self.assertEqual(items[0]["stage"], "rife")
        # Failed erase leaves the original active: clean recorded, no variant.
        self.assertIsNotNone(items[0]["clean_path"])
        self.assertIsNone(items[0]["variant_path"])
        self.assertEqual(items[1]["status"], "completed")

    def test_failed_erase_reports_and_continues(self):
        a = self._clip("f1.mp4")
        b = self._clip("f2.mp4")
        params = ep.ErasePipelineParams(items=[
            self._item(a, occurrences=[{"occurrence_id": "a"}]),
            self._item(b, occurrences=[{"occurrence_id": "b"}]),
        ])
        # Only the first erase fails.
        real = ep._run_erase
        seen = {"n": 0}

        async def flaky(params):
            seen["n"] += 1
            if seen["n"] == 1:
                return OperationResult(ok=False, operation="erase_remove",
                                       error="boom")
            return await real(params)

        ep._run_erase = flaky  # type: ignore[assignment]
        res = asyncio.run(ep.erase_pipeline(params))
        summary = (res.meta or {})["summary"]
        self.assertEqual((summary["failed"], summary["completed"]), (1, 1))
        self.assertEqual((res.meta or {})["items"][0]["stage"], "erase")

    def test_cancel_marks_remaining_cancelled(self):
        a = self._clip("k1.mp4")
        b = self._clip("k2.mp4")
        params = ep.ErasePipelineParams(items=[
            self._item(a, occurrences=[{"occurrence_id": "a"}]),
            self._item(b, occurrences=[{"occurrence_id": "b"}]),
        ])
        real_check = job_control.check_cancelled
        state = {"n": 0}

        def flaky():
            state["n"] += 1
            if state["n"] > 2:
                raise job_control.JobCancelled("stop")
            return real_check()

        job_control.check_cancelled = flaky  # type: ignore[assignment]
        try:
            res = asyncio.run(ep.erase_pipeline(params))
        finally:
            job_control.check_cancelled = real_check  # type: ignore[assignment]
        summary = (res.meta or {})["summary"]
        self.assertTrue(res.ok)
        self.assertGreaterEqual(summary["cancelled"], 1)
        self.assertEqual(summary["completed"] + summary["cancelled"], 2)

    def test_batch_shape_mixed_success_failure(self):
        missing = str(self.root / "ghost.mp4")
        params = ep.ErasePipelineParams(items=[
            self._item(self._clip("ok.mp4"),
                       occurrences=[{"occurrence_id": "ok"}]),
            self._item(missing, occurrences=[{"occurrence_id": "ghost"}]),
        ])
        # No mask for the third lineage → skipped.
        nomask = self._item(self._clip("plain.mp4"),
                            occurrences=[{"occurrence_id": "plain"}])
        nomask.erase.mask_b64 = None
        params.items.append(nomask)
        res = asyncio.run(ep.erase_pipeline(params))
        self.assertTrue(res.ok)
        meta = res.meta or {}
        self.assertEqual(meta["summary"],
                         {"total": 3, "completed": 1, "skipped": 2,
                          "failed": 0, "cancelled": 0})
        by_occ = {i["occurrence_ids"][0]: i["status"] for i in meta["items"]}
        self.assertEqual(by_occ, {"ok": "completed", "ghost": "skipped",
                                 "plain": "skipped"})
        for it in meta["items"]:
            self.assertIn("stage", it)
            self.assertIn("lineage_id", it)


class PersistenceRoundTripTest(_Iso):
    def test_lineage_fields_survive_pool_payload(self):
        lid = lin.new_lineage_id()
        payload = {
            "items": [{"path": self._clip("p.mp4"), "lineage_id": lid,
                       "lineageId": "junk"}],
            "sequence": [{"path": self._clip("p.mp4"), "lineage_id": lid,
                          "clean_path": "/abs/p_clean_abcd.mp4",
                          "clean_signature": {"kind": "clean"},
                          "erase_mask_id": "m1",
                          "erase_settings": {"hd_strategy": "Crop", "bogus": 1},
                          "tag_color": "#ff0000"}],
            "lineages": {lid: {"original_path": self._clip("p.mp4"),
                               "mask_id": "m1", "width": 32, "height": 16,
                               "erase_settings": {"hd_strategy": "Crop"}},
                         "junk": {"original_path": "x"}},
        }
        norm = pool_mod._normalize_pool_payload(payload, require_exists=False)
        self.assertEqual(norm["items"][0]["lineage_id"], lid)
        seq = norm["sequence"][0]
        self.assertEqual(seq["lineage_id"], lid)
        self.assertEqual(seq["clean_path"], "/abs/p_clean_abcd.mp4")
        self.assertEqual(seq["clean_signature"], {"kind": "clean"})
        self.assertEqual(seq["erase_mask_id"], "m1")
        self.assertNotIn("bogus", seq["erase_settings"])
        self.assertIn(lid, norm["lineages"])
        self.assertNotIn("junk", norm["lineages"])

    def test_invalid_lineage_dropped(self):
        payload = {"sequence": [{"path": self._clip("q.mp4"),
                                 "lineage_id": "nope"}]}
        norm = pool_mod._normalize_pool_payload(payload, require_exists=False)
        self.assertNotIn("lineage_id", norm["sequence"][0])


if __name__ == "__main__":
    unittest.main()
