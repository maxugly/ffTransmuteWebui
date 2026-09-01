# Coder Prompt — QR Art Illusion mode

> **Branch:** `wip` (not `main`)  
> **Role:** Builder — assigned in this prompt.  
> **Kind:** One-shot. Product is locked in `docs/qr-illusion-art-spec.md` **§0**.  
> **As-built:** QR tab requires QR Data + prompt. Optional one IP-Adapter still. Worker already has ControlNet Monster + IP-Adapter (PyTorch).  
> **Verification:** `AGENTS.md` WebUI proof. Click the QR Art tab.

---

## MISSION

Add **Illusion** next to QR on the existing tab: two user stills, no barcode, no “QR Data is required.”

Pattern = structure (ControlNet). Appearance = look (IP-Adapter). Same worker. Same op `qr_art`.

**Do not** write `illusion_ops.py`. **Do not** add Vulkan SD. **Do not** reopen OpenVINO + IP-Adapter in this pass.

---

## LOCKED (copy of spec §0)

1. `mode`: `"qr"` (default) | `"illusion"`. Existing QR clients unchanged.  
2. Illusion requires `pattern_image` + `ip_adapter_image` (absolute paths). `qr_text` ignored. `use_ip_adapter` forced true.  
3. Prompt optional. Empty → worker fallback `"high quality, detailed"`.  
4. Reuse shipped IP-Adapter path: FastSD python, 512×512, VAE slicing, OOM GPU→CPU strings. Control image = pattern, not a generated QR. Skip `qrcode` and `pyzbar`.  
5. Device: `cuda` if available; else try Intel **XPU** (`torch.xpu.is_available()`); else CPU + one log line. Log `device=xpu|cuda|cpu`.  
6. No OpenVINO iGPU claim for this combo. Phase 2 (OV ControlNet, no IP-Adapter) is a **later commit** only if v1 is clean — do not start it unless the human says so.  
7. UI: same tab. QR | Illusion control. Illusion shows Pattern + Appearance, hides QR Data and scan badge. One hint line.  
8. `collectQrBody`: illusion must not alert on empty QR Data. If dedicated fields blank, first `#giImage` line = pattern, second = appearance.  
9. Weights → `mtapi-project/junk/models/` or HF cache. Never commit `.safetensors` / `.pt`.  
10. Ship: bump root `VERSION` DD, STATUS top box + §3/§4, spec banner Partial→Implemented (or keep Partial if Phase 2 mentioned). Do **not** paste the version digits into STATUS header.  
11. Do not touch FastSAM or dump/encode bookends.

---

## FILES

| File | Change |
|------|--------|
| `app/operations/qr_ops.py` | `mode`, `pattern_image`; `qr_text` / `prompt` not required when illusion; skip QR generate |
| `app/operations/qr_art_ov_worker.py` | Empty-prompt fallback; XPU try; control/init = pattern path |
| `app/static/js/tabs/qr.js` | Mode UI; collect body; field show/hide |
| `docs/qr-illusion-art-spec.md` | Banner: Illusion Implemented (v1) |
| `docs/STATUS.md`, `docs/spec_registry.json`, `VERSION` | Map + DD |

---

## BUILD

1. Params + validation split by mode.  
2. Worker: no QR file when illusion; resize pattern 512; appearance → IP-Adapter as today.  
3. Tab: mode switch; Playwright must not see “QR Data is required” in Illusion.  
4. QR mode smoke still requires Data + prompt and still badges scan.  
5. Illusion smoke: `/tmp/teste.png` + a second PNG (copy is fine), empty Data, empty prompt → `ok`, output PNG exists, log has no `qrcode` generate, log has `device=`.

First IP-Adapter / ControlNet download may take minutes. That is expected.

---

## DO NOT

- Vulkan / `stable-diffusion.cpp` / second worker.  
- Multi-image IP-Adapter (3+).  
- Empty prompt = strip CLIP text encoder.  
- Change QR defaults or force Illusion as default.  
- Merge to `main` unless the human asked.

---

## DONE

- [ ] Illusion Run with two stills, no QR Data, output PNG  
- [ ] QR mode still works (Data required, scan badge)  
- [ ] Clicked QR Art tab, mode switch, no new JS errors  
- [ ] Device logged  
- [ ] VERSION + STATUS top box + spec banner  
- [ ] Commit on `wip`
