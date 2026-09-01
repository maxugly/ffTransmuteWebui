# Coder Prompt — FastSAM multimodel (`000.000.7.00x`)

> **Target:** ffTransmuteWebui / `wip`  
> **Role:** Builder  
> **Kind:** One-shot. Product is locked in `docs/fastsam-sam-multimodel-spec.md` **§0**.  
> **As-built:** FastSAM-s only. Hardcoded `ensure_openvino_model(device=…)`. Tab has Mode + Device (GPU/CPU/AUTO). No Model select.  
> **Verification:** `AGENTS.md` §D. Click the FastSAM tab. `/tmp/teste.png`.

---

## MISSION

Let the user pick a stronger segmenter on the existing FastSAM tab. **Phase 1 must ship.** Phase 2 only if ultralytics export is boring.

**Do not** add `device_preference`. **Do not** change FastSAM-s default. **Do not** change video everything→target fallback.

---

## LOCKED (copy of spec §0)

1. Reuse `device` (`GPU` / `CPU` / `AUTO`). Default stays **GPU**.  
2. `model_id`: `FastSAM-s` | `FastSAM-x` | `SAM ViT-L` | `SAM ViT-H`. Default `FastSAM-s`.  
3. Phase 1: FastSAM-s + FastSAM-x, same `ultralytics.FastSAM`.  
4. Phase 2: ViT-L then ViT-H via **ultralytics `SAM`**. Wrapper to `.masks.xy` so `get_target_mask` is unchanged.  
5. No `segment-anything` / `sam2` unless ultralytics fails → then **stop after Phase 1**.  
6. Weights: ultralytics cache or `~/.cache/mtapi/models/`. Never commit `*.pt`.  
7. `keep_model_warm` stays; key includes `model_id` + `device`.  
8. AUTO heuristic only when Device=AUTO. Explicit GPU → GPU unless OpenVINO unavailable (log + CPU).  
9. Log `[fastsam] using <model> on <device>`.  
10. Bump VERSION DD. STATUS + SESSION + spec_registry.  
11. Video everything stays per-frame target fallback.

---

## FILES

| File | Change |
|------|--------|
| `app/filters/fastsam.py` | `MODEL_REGISTRY`. `ensure_openvino_model(model_id, device)` translates label → `.pt`, exports OV if missing. `make_fastsam_directory(..., model_id=...)`. Runtime cache keyed by model+device. |
| `app/operations/fastsam_ops.py` | `FastSAMParams.model_id`. Image + video paths pass it. Dry-run prints model. |
| `app/static/js/tabs/fastsam.js` | `<select id="fastsamModel">` above Mode. `collectFastSAMBody()` sends `model_id`. |
| `docs/fastsam-openvino-spec.md` | Banner: model set + default still FastSAM-s. |
| `docs/fastsam-sam-multimodel-spec.md` | Status Implemented / Partial if only Phase 1. |
| VERSION, STATUS, SESSION, spec_registry | DD bump. |

Pipeline `/ops/pipeline` stage `fastsam` must accept the same `model_id` kwarg (factory already takes `**kwargs` — **use it**, don’t swallow it).

---

## PHASE 1 (required)

1. Registry + filename map.  
2. Thread `model_id` through params, image still path, directory stage, dry-run.  
3. FastSAM-x = `FastSAM("FastSAM-x.pt")` + same OpenVINO export as s (`half=True, dynamic=True`).  
4. UI dropdown. FastSAM-s selected.  
5. Smoke FastSAM-s on `/tmp/teste.png` (target + everything). Must match previous behavior.  
6. Smoke FastSAM-x on `/tmp/teste.png` (first run may download + export). Output PNG or `_assets/` exists. Console: using FastSAM-x.

## PHASE 2 (stop if messy)

1. Try `from ultralytics import SAM` + `sam_l.pt` / `sam_h.pt` (or the registry names). Export OpenVINO.  
2. Normalize result so `get_target_mask` still reads `.masks.xy`.  
3. Smoke ViT-L everything on `/tmp/teste.png`.  
4. If export/API is a research project: **do not merge a half SAM**. Revert Phase 2, ship Phase 1, STATUS = Partial (s+x only).

---

## DO NOT

- Touch dump/encode bookends except passing `model_id` into the stage.  
- Redesign target vs everything.  
- Commit model weights.  
- Change default Device to AUTO.  
- Add a second Device field.

---

## DONE

- [ ] Phase 1 in tree, FastSAM-s still works, FastSAM-x ran once  
- [ ] Phase 2 shipped **or** explicitly Partial with a one-paragraph why  
- [ ] VERSION DD + STATUS/SESSION/spec_registry  
- [ ] Clicked FastSAM tab, no new JS errors  
- [ ] Commit on `wip`. No main merge unless human asked.

Weights and first OV export may take minutes. That is expected, not a hang.
