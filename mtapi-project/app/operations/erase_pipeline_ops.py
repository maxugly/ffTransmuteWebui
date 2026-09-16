"""
Sequence Erase → RIFE → Conform batch orchestration.

Spec: docs/sequence-erase-pipeline-spec.md §4–§8.

Pure orchestration: this module never imports ``subprocess`` and never
calls ffmpeg/RIFE/ONNX directly. Each stage invokes the existing operation
handlers (``erase_remove`` → ``rife`` → ``conform``) with absolute paths and
passes their absolute-path results between stages. Stage internals keep
their own dump → ``app/filters/*`` → encode stacks; no second stack here.

The op itself runs inside the existing job queue (one queued op, lineages
processed sequentially, never parallel GPU work). Progress uses the
existing ``report_progress()`` at every stage boundary; per-frame/per-item
progress still comes from the stage ops. Cancellation is cooperative via
``job_control.check_cancelled()``; incomplete outputs are never adopted.

Batch failures are HTTP 200 with ``{"ok": true, summary, items[]}`` —
``ok`` covers batch acceptance; per-lineage failures live in ``items[]``.
"""

import base64
import time
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..media import lineage as lin


# ── params ─────────────────────────────────────────────────────────────────


class EraseStageParams(BaseModel):
    model_config = {"extra": "ignore"}

    mask_b64: str | None = Field(
        None, description="Inline mask PNG (fallback when the lineage store has none)"
    )
    hd_strategy: Literal["Original", "Crop", "Resize"] = Field("Crop")
    crop_trigger: int = Field(800, ge=256, le=4096)
    crop_margin: int = Field(128, ge=0, le=512)
    resize_limit: int = Field(1280, ge=512, le=4096)
    device: Literal["GPU", "CPU", "AUTO"] = Field("GPU")


class RifeStageParams(BaseModel):
    model_config = {"extra": "ignore"}

    enabled: bool = Field(False, description="True when Sequence density rules need RIFE")
    multiplier: int = Field(2, ge=2, le=128)
    model: str = Field("rife-v4.6")
    tta: bool = Field(False)
    uhd: bool = Field(False)
    target_fps: float | None = Field(None, gt=0)


class ConformStageParams(BaseModel):
    model_config = {"extra": "ignore"}

    enabled: bool = Field(False)
    mode: str = Field("pad")
    aspect: str = Field("16:9")
    width: int | None = Field(None, gt=0, description="Canvas W (null = derive via join canvas rule)")
    height: int | None = Field(None, gt=0, description="Canvas H (null = derive via join canvas rule)")
    target_fps: float | None = Field(None, gt=0)
    preset: str = Field("h264_avc_hq")
    audio_policy: str = Field("encoded")


class OccurrenceSpec(BaseModel):
    model_config = {"extra": "ignore"}

    occurrence_id: str = Field(..., description="sequence[].id — never rewritten")
    target_duration: float | None = Field(None, gt=0)
    conformed_path: str | None = Field(None, description="Current conformed cache, if any")
    conform_signature: dict[str, Any] | None = Field(None)


class ErasePipelineItem(BaseModel):
    model_config = {"extra": "ignore"}

    lineage_id: str = Field(...)
    original_path: str = Field(..., description="Immutable original source (absolute)")
    erase: EraseStageParams = Field(default_factory=EraseStageParams)
    rife: RifeStageParams = Field(default_factory=RifeStageParams)
    conform: ConformStageParams = Field(default_factory=ConformStageParams)
    occurrences: list[OccurrenceSpec] = Field(default_factory=list)


class ErasePipelineParams(BaseModel):
    model_config = {"extra": "ignore"}

    items: list[ErasePipelineItem] = Field(..., min_length=1)
    dry_run: bool = Field(False, description="Plan only: resolve/reuse, run nothing")


# ── stage invocation (module-level indirection for tests) ──────────────────
# These call the EXISTING operation handlers — the only path to media work.


async def _run_erase(params: Any) -> Any:
    from .erase_ops import EraseRemoveParams, erase_remove

    return await erase_remove(EraseRemoveParams(**params))


async def _run_rife(params: Any) -> Any:
    from .rife_ops import RifeParams, rife_interpolate

    return await rife_interpolate(RifeParams(**params))


async def _run_conform(params: Any) -> Any:
    from .conform_ops import ConformParams, conform

    return await conform(ConformParams(**params))


async def _register_clean_variant(
    original: str, output: str, detail: dict[str, Any]
) -> Any:
    from ..media import register_variant

    return await register_variant(original, kind=lin.CLEAN_KIND,
                                  variant_path=Path(output), detail=detail)


async def _get_variants(parent: str) -> dict[str, Any] | None:
    from ..media import get_variants

    try:
        return await get_variants(parent)
    except Exception:
        return None


async def _probe_stage_source(path: str) -> dict[str, Any]:
    from ..video_pipeline import probe

    return await probe(Path(path))


def _canvas_for_stage(
    info: dict[str, Any], aspect: str, override_w: int | None, override_h: int | None
) -> tuple[int, int]:
    if override_w and override_h:
        return int(override_w), int(override_h)
    from .transmute_ops import _conform_canvas_for_join

    w = int(info.get("width") or 0)
    h = int(info.get("height") or 0)
    if w <= 0 or h <= 0:
        raise ValueError("cannot derive conform canvas: source has no dimensions")
    return _conform_canvas_for_join(
        [{"width": w, "height": h}], aspect or "16:9",
    )


def _time_factor(target: float | None, native: float) -> float:
    if not target or not native or native <= 0:
        return 1.0
    f = float(target) / float(native)
    return 1.0 if abs(f - 1.0) < 1e-3 else f


# ── per-lineage pipeline ───────────────────────────────────────────────────


def _item_label(item: ErasePipelineItem) -> str:
    return Path(item.original_path).name


async def _resolve_mask_bytes(
    item: ErasePipelineItem, lid: str
) -> tuple[bytes | None, dict[str, Any] | None, str]:
    """Lineage-store mask wins; inline mask_b64 is the fallback. Never empty."""
    stored = lin.load_mask_record(lid)
    if stored is not None:
        raw = lin.load_mask_bytes(lid)
        if raw:
            return raw, stored, "stored"
    if item.erase.mask_b64:
        try:
            raw = lin.decode_mask_b64(item.erase.mask_b64)
            w, h = lin.png_dimensions(raw)
        except ValueError as e:
            return None, None, f"invalid inline mask: {e}"
        return raw, {
            "lineage_id": lid,
            "mask_id": lin.mask_signature(raw),
            "mask_path": None,
            "width": w,
            "height": h,
            "threshold": lin.MASK_THRESHOLD,
            "erase_settings": lin.normalize_erase_settings(item.erase.model_dump()),
        }, "inline"
    return None, None, "no mask"


async def _process_lineage(
    item: ErasePipelineItem,
    *,
    index: int,
    total: int,
    dry_run: bool,
) -> dict[str, Any]:
    """original → erase → clean → RIFE? → conform? — one lineage, in order."""
    lid = lin.normalize_lineage_id(item.lineage_id) or ""
    name = _item_label(item)
    token = job_control.current_token()

    def _report(stage: str, extra: str = "") -> None:
        msg = f"Erase pipeline {index + 1}/{total} · {name} · {stage}{extra}"
        try:
            job_control.report_progress(msg, phase="erase_pipeline",
                                        current=index, total=total,
                                        unit="lineages", token=token)
        except Exception:
            pass

    result: dict[str, Any] = {
        "lineage_id": item.lineage_id,
        "occurrence_ids": [o.occurrence_id for o in item.occurrences],
        "ok": False, "status": "failed", "stage": "queued", "error": None,
        "clean_path": None, "variant_path": None,
        "adoptions": [],
    }

    # 1. Resolve + verify the immutable original (never a variant).
    _report("queued")
    try:
        job_control.check_cancelled()
    except job_control.JobCancelled as e:
        result.update(status="cancelled", stage="queued", error=str(e))
        return result
    src = Path(item.original_path).expanduser()
    if not src.is_absolute():
        result.update(status="skipped", stage="source",
                      error=f"original path must be absolute: {item.original_path}")
        _report("skipped", " — original not absolute")
        return result
    if not src.is_file():
        result.update(status="skipped", stage="source",
                      error=f"original not found: {src}")
        _report("skipped", " — original missing")
        return result
    try:
        original = str(src.resolve())
    except OSError:
        original = str(src)
    stat = lin.source_stat(original) or {}
    src_size = int(stat.get("size") or 0)
    src_mtime = float(stat.get("mtime") or 0.0)

    # 2. Load the saved mask; eligibility requires one.
    mask_bytes, mask_rec, mask_how = await _resolve_mask_bytes(item, lid)
    if not mask_bytes or mask_rec is None:
        result.update(status="skipped", stage="mask",
                      error=f"no mask for lineage {lid or item.lineage_id}")
        _report("skipped", " — no mask")
        return result
    mask_id = str(mask_rec["mask_id"])
    mask_w, mask_h = int(mask_rec["width"]), int(mask_rec["height"])
    erase_settings = lin.normalize_erase_settings({
        **(mask_rec.get("erase_settings") or {}),
        **{k: v for k, v in item.erase.model_dump().items() if k != "mask_b64"},
    })
    erase_sig = lin.erase_signature(mask_id, mask_w, mask_h, erase_settings)

    # 3. Reuse a valid clean artifact by complete signature, else erase.
    _report("erase")
    variants = await _get_variants(original)
    expected_clean = {
        "lineage_id": lid or item.lineage_id,
        "original_path": original,
        "mask_id": mask_id, "width": mask_w, "height": mask_h,
        "settings": erase_settings,
        "source_size": src_size, "source_mtime": src_mtime,
    }
    clean_hit = lin.find_valid_clean(variants, **expected_clean)
    clean_path: str | None = None
    if clean_hit is not None:
        clean_path = str(clean_hit.get("path"))
        # Reuse must still report WHICH signature was reused: without it the
        # client cannot record the clean's mask id, and later mask changes
        # never read stale (spec §4.1/§5.3).
        hit_detail = clean_hit.get("detail")
        if isinstance(hit_detail, dict):
            result["clean_signature"] = {
                **hit_detail, "output_path": clean_path,
            }
        _report("erase", " — reusing valid clean artifact")
    else:
        if dry_run:
            out = lin.clean_output_name(src, mask_id, erase_sig)
            clean_path = str(out)
            _report("erase", " — dry run, would erase")
        else:
            out = lin.clean_output_name(src, mask_id, erase_sig)
            if out.resolve() == src.resolve():
                result.update(status="failed", stage="erase",
                              error="clean output would overwrite the original")
                _report("failed", " — output collision")
                return result
            try:
                erase_b64 = base64.b64encode(mask_bytes).decode("ascii")
            except Exception as e:
                result.update(status="failed", stage="erase", error=str(e))
                return result
            res = await _run_erase({
                "input_path": original, "output_path": str(out),
                "mask_b64": erase_b64,
                "hd_strategy": erase_settings["hd_strategy"],
                "crop_trigger": int(erase_settings["crop_trigger"]),
                "crop_margin": int(erase_settings["crop_margin"]),
                "resize_limit": int(erase_settings["resize_limit"]),
                "device": erase_settings["device"],
            })
            if not res.ok:
                result.update(status="failed", stage="erase",
                              error=res.error or "erase failed")
                _report("failed", f" — erase: {res.error or 'failed'}")
                return result
            clean_path = res.output_path or str(out)
            detail = lin.clean_detail(
                lineage_id=lid or item.lineage_id, original_path=original,
                mask_id=mask_id, width=mask_w, height=mask_h,
                settings=erase_settings, source_size=src_size,
                source_mtime=src_mtime, output_path=clean_path,
            )
            try:
                await _register_clean_variant(original, clean_path, detail)
            except Exception:
                pass
            result["clean_signature"] = detail
            _report("erase", " — complete")
    result["clean_path"] = clean_path
    if not dry_run and (not clean_path or not lin.output_usable(clean_path)):
        result.update(status="failed", stage="erase",
                      error="clean output missing after erase")
        _report("failed", " — clean output missing")
        return result

    try:
        job_control.check_cancelled()
    except job_control.JobCancelled as e:
        result.update(status="cancelled", stage="erase", error=str(e))
        _report("cancelled", " — after erase")
        return result

    # 4. Optional RIFE from the CLEAN artifact (never the original).
    rifed_path: str | None = None
    rife_multiplier: int | None = None
    assert clean_path is not None
    if item.rife.enabled:
        rife_multiplier = int(item.rife.multiplier)
        if rife_multiplier < 2 or rife_multiplier > 128:
            result.update(status="failed", stage="rife",
                          error=f"RIFE multiplier out of range: {rife_multiplier}")
            return result
        _report("RIFE", f" ×{rife_multiplier}")
        if dry_run:
            rifed_path = f"{clean_path} → RIFE ×{rife_multiplier} (dry run)"
        else:
            rres = await _run_rife({
                "input_path": clean_path,
                "multiplier": rife_multiplier,
                "model": item.rife.model,
                "tta": bool(item.rife.tta),
                "uhd": bool(item.rife.uhd),
                **({"target_fps": float(item.rife.target_fps)}
                   if item.rife.target_fps else {}),
                "register_as_variant": True,
                "source_kind": "clean",
                "parent_path": original,
            })
            if not rres.ok:
                # Clean stays available; report RIFE failed, keep clean.
                result.update(status="failed", stage="rife",
                              error=rres.error or "RIFE failed")
                _report("failed", f" — RIFE: {rres.error or 'failed'}")
                return result
            rifed_path = rres.output_path
            _report("RIFE", " — complete")
        result["variant_path"] = rifed_path if not dry_run else None
        try:
            job_control.check_cancelled()
        except job_control.JobCancelled as e:
            result.update(status="cancelled", stage="rife", error=str(e))
            _report("cancelled", " — after RIFE")
            return result
    stage_source = rifed_path if (rifed_path and not dry_run) else clean_path
    stage_variant = "rifed" if (rifed_path and not dry_run) else "clean"

    # 5. Optional conform per occurrence (independent timing/settings).
    adoptions: list[dict[str, Any]] = []
    if item.conform.enabled:
        try:
            info = await _probe_stage_source(stage_source) if not dry_run else {
                "width": 0, "height": 0, "duration": 0.0, "has_audio": False,
            }
        except Exception as e:
            result.update(status="failed", stage="conform",
                          error=f"conform source probe failed: {e}")
            return result
        try:
            canvas_w, canvas_h = _canvas_for_stage(
                info, item.conform.aspect,
                item.conform.width, item.conform.height,
            )
        except ValueError as e:
            result.update(status="failed", stage="conform", error=str(e))
            return result
        native_dur = float(info.get("duration") or 0.0)
        try:
            src_st = Path(stage_source).stat() if not dry_run else None
        except OSError:
            src_st = None
        occurrences = item.occurrences or [OccurrenceSpec(occurrence_id="")]
        for occ in occurrences:
            try:
                job_control.check_cancelled()
            except job_control.JobCancelled as e:
                result.update(status="cancelled", stage="conform", error=str(e))
                result["adoptions"] = adoptions
                _report("cancelled", " — during conform")
                return result
            factor = _time_factor(occ.target_duration, native_dur)
            _report("conform", f" {canvas_w}x{canvas_h}"
                    + (f" ×{native_dur:.2f}s→{occ.target_duration:.2f}s" if occ.target_duration else ""))
            if dry_run:
                adoptions.append({
                    "occurrence_id": occ.occurrence_id,
                    "clean_path": clean_path,
                    "variant_path": result.get("variant_path"),
                    "conformed_path": None,
                    "reused": {"erase": clean_hit is not None, "rife": False, "conform": False},
                    "note": "dry run",
                })
                continue
            from ..video_pipeline import conform_signature, is_conform_signature_valid

            current = {
                "mode": item.conform.mode, "aspect": item.conform.aspect,
                "width": int(canvas_w), "height": int(canvas_h),
                "target_fps": float(item.conform.target_fps) if item.conform.target_fps else None,
                "time_factor": float(factor), "preset": item.conform.preset,
                "audio_policy": item.conform.audio_policy,
                "rife_multiplier": rife_multiplier,
                "source_variant": stage_variant,
                "source_size": int(src_st.st_size) if src_st else 0,
                "source_mtime": float(src_st.st_mtime) if src_st else 0.0,
            }
            cpath = occ.conformed_path
            csig = occ.conform_signature if isinstance(occ.conform_signature, dict) else None
            exists = bool(cpath) and lin.output_usable(cpath)
            size = 0
            if exists:
                try:
                    size = int(Path(str(cpath)).stat().st_size)
                except OSError:
                    exists = False
            ok_sig, _why = is_conform_signature_valid(
                csig, current=current, output_exists=exists, output_size=size)
            if ok_sig and cpath:
                adoptions.append({
                    "occurrence_id": occ.occurrence_id,
                    "clean_path": clean_path,
                    "variant_path": result.get("variant_path"),
                    "conformed_path": str(cpath),
                    "conform_signature": csig,
                    "reused": {"erase": clean_hit is not None,
                               "rife": False, "conform": True},
                })
                continue
            cres = await _run_conform({
                "input_path": stage_source,
                "source_variant": stage_variant,
                "mode": item.conform.mode, "aspect": item.conform.aspect,
                "width": int(canvas_w), "height": int(canvas_h),
                **({"target_fps": float(item.conform.target_fps)}
                   if item.conform.target_fps else {"target_fps": None}),
                **({"target_duration": float(occ.target_duration)}
                   if occ.target_duration else {"target_duration": None}),
                "preset": item.conform.preset,
                "audio_policy": item.conform.audio_policy,
                **({"rife_multiplier": int(rife_multiplier)}
                   if rife_multiplier else {"rife_multiplier": None}),
            })
            if not cres.ok:
                adoptions.append({
                    "occurrence_id": occ.occurrence_id,
                    "clean_path": clean_path,
                    "variant_path": result.get("variant_path"),
                    "conformed_path": None,
                    "error": cres.error or "conform failed",
                })
                result["conform_failed"] = True
                continue
            meta = cres.meta or {}
            adoptions.append({
                "occurrence_id": occ.occurrence_id,
                "clean_path": clean_path,
                "variant_path": result.get("variant_path"),
                "conformed_path": cres.output_path,
                "conform_signature": meta.get("signature"),
                "reused": {"erase": clean_hit is not None,
                           "rife": False, "conform": False},
            })
        result["adoptions"] = adoptions
        if result.get("conform_failed") and not any(
            a.get("conformed_path") for a in adoptions
        ) and adoptions:
            result.update(status="failed", stage="conform",
                          error="conform failed for all occurrences")
            _report("failed", " — conform")
            return result
    else:
        # No conform: still adopt clean/RIFE per occurrence.
        result["adoptions"] = [
            {"occurrence_id": o.occurrence_id, "clean_path": clean_path,
             "variant_path": result.get("variant_path"),
             "reused": {"erase": clean_hit is not None,
                        "rife": False, "conform": False}}
            for o in (item.occurrences or [OccurrenceSpec(occurrence_id="")])
        ]

    result.update(ok=True, status="completed",
                 stage="conform" if item.conform.enabled
                 else ("rife" if item.rife.enabled else "erase"))
    _report("complete")
    return result


# ── batch handler ──────────────────────────────────────────────────────────


async def erase_pipeline(p: ErasePipelineParams) -> OperationResult:
    op = "erase_pipeline"
    started = time.time()
    # Deduplicate by lineage (same lineage twice = one processing pass).
    seen: dict[str, ErasePipelineItem] = {}
    order: list[str] = []
    for it in p.items:
        lid = lin.normalize_lineage_id(it.lineage_id) or it.lineage_id
        if lid in seen:
            prev = seen[lid]
            have = {o.occurrence_id for o in prev.occurrences}
            for o in it.occurrences:
                if o.occurrence_id not in have:
                    prev.occurrences.append(o)
                    have.add(o.occurrence_id)
            continue
        seen[lid] = it
        order.append(lid)
    total = len(order)
    items_out: list[dict[str, Any]] = []
    completed = skipped = failed = cancelled = 0
    token = job_control.current_token()
    try:
        job_control.report_progress(
            f"Erase pipeline 0/{total} · starting", phase="erase_pipeline",
            current=0, total=total, unit="lineages", token=token)
    except Exception:
        pass
    stop_requested = False
    for i, lid in enumerate(order):
        if stop_requested:
            items_out.append({
                "lineage_id": lid,
                "occurrence_ids": [o.occurrence_id for o in seen[lid].occurrences],
                "ok": False, "status": "cancelled", "stage": "queued",
                "error": "Cancelled by user",
            })
            cancelled += 1
            continue
        try:
            one = await _process_lineage(seen[lid], index=i, total=total,
                                         dry_run=bool(p.dry_run))
        except job_control.JobCancelled as e:
            one = {
                "lineage_id": seen[lid].lineage_id,
                "occurrence_ids": [o.occurrence_id for o in seen[lid].occurrences],
                "ok": False, "status": "cancelled", "stage": "batch",
                "error": str(e),
            }
            stop_requested = True
        except Exception as e:  # noqa: BLE001 — continue to next lineage
            one = {
                "lineage_id": seen[lid].lineage_id,
                "occurrence_ids": [o.occurrence_id for o in seen[lid].occurrences],
                "ok": False, "status": "failed", "stage": "batch",
                "error": str(e)[:300],
            }
        st = one.get("status")
        if st == "completed":
            completed += 1
        elif st == "skipped":
            skipped += 1
        elif st == "cancelled":
            cancelled += 1
            stop_requested = True
        else:
            failed += 1
        items_out.append(one)
    summary = {"total": total, "completed": completed, "skipped": skipped,
               "failed": failed, "cancelled": cancelled}
    try:
        job_control.report_progress(
            f"Erase pipeline {total}/{total} · done "
            f"({completed} ok, {skipped} skipped, {failed} failed, "
            f"{cancelled} cancelled)", phase="erase_pipeline",
            current=total, total=total, unit="lineages", token=token)
    except Exception:
        pass
    return OperationResult(
        ok=True, operation=op, dry_run=bool(p.dry_run),
        stdout=(f"erase_pipeline: {completed}/{total} completed in "
                f"{time.time() - started:.1f}s"),
        meta={"summary": summary, "items": items_out},
    )


register(OperationSpec(
    id="erase_pipeline",
    summary="Sequence Erase → RIFE → Conform batch (original → clean → RIFE → conform)",
    description=(
        "Orchestrates existing erase_remove / rife / conform operations per "
        "lineageId: erase always starts from the original source, RIFE runs "
        "on the clean artifact when needed, conform runs per occurrence. "
        "Reuses valid artifacts by complete signature, continues after "
        "individual failures, supports cooperative Stop. No subprocess here."
    ),
    params_model=ErasePipelineParams,
    handler=erase_pipeline,
    tags=["sequence", "erase", "rife", "conform", "batch"],
))
