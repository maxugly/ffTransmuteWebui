# Coder Prompt — Stable Fluids sim tab (`000.000.7.010`)

> **Target:** ffTransmuteWebui / `wip`  
> **Role:** Builder  
> **Kind:** One-shot. Product is locked in `docs/stablefluids-sim-spec.md`.  
> **Decision (human):** self-host only (**Path B**). No external iframe fallback.  
> **Verification:** `AGENTS.md` §D. Open the Stable Fluids tab. Record a 3s WebM. No console errors.
> **agy reviewed** — 4 issues patched in §4.2, §4.4, §5.3, §9, §10.

---

## MISSION

Add a new **Stable Fluids** tab (sidebar: Neural FX section) that embeds keijiro's WebGL fluid sim **self-hosted** and can record its canvas. **No Unity needed** — self-host the pre-built static site with `wget --mirror`. **No server op** — pure client-side iframe + capture.

Phase 1 (required): self-host the build + iframe embed + Record button.  
Phase 2 (follow-up): pure WebGPU native port.  
Phase 3 (follow-up): seed-image injection from Image Pool.

---

## LOCKED (copy of spec §1–4, §9)

1. **Self-host only.** Drop keijiro's static build into `mtapi-project/app/static/stablefluids/`:
   ```bash
   wget --mirror --convert-links --adjust-extension \
        https://keijiro.github.io/StableFluids/
   # copy the resulting folder into app/static/stablefluids/
   ```
2. iframe `src` is **always** `/stablefluids/` (same-origin) — required for `captureStream()` recording. **No external URL fallback.**
3. Presence check is **client-side only** (no server-side flag — `static.py` serves plain files): `fetch('/stablefluids/index.html', { method: 'HEAD' })`. `r.ok` → show iframe + Record. 404 → show placeholder with the `wget` command, no iframe, Record hidden.
4. `TAB_ACCEPTS['stablefluids'] = 'none'` — does not consume global Video/Image inputs.
5. `'stablefluids'` in the `hideRun` set — hide Run / Queue / Stop.
6. `switchTab` title: `'Stable Fluids · WebGL Sim'`.
7. Canvas discovery uses try/catch on `iframe.contentDocument` (defensive; not expected to throw since same-origin).
8. **Never** clear `iframe.src` (AGENTS.md §6).
9. Recording: `canvas.captureStream(60)` + `MediaRecorder` (VP9 @ 25Mbps). Download `fluid_<ts>.webm`. Fallback codec if `isTypeSupported` rejects VP9.
10. CCapture.js PNG-sequence → download local `.zip` (no server workspace upload).
11. Add `Stable Fluids` nav-item in `index.html` under Neural FX.
12. Create `js/tabs/stablefluids.js`. Add `renderStableFluidsForm` to the **bottom export block** of `app.js` (app.js:1253).
13. `static.py`: `StaticFiles` mount at `/stablefluids` guarded by `is_dir()`, `html=True`.

---

## FILES

| File | Change |
|------|--------|
| `app/routes/static.py` | Import `StaticFiles`. Mount at `/stablefluids` if `STATIC_DIR / "stablefluids"` is a dir. `html=True`. |
| `app/static/index.html` | Nav-item `data-tab="stablefluids"` under Neural FX section. |
| `app/static/app.js` | (a) `TAB_ACCEPTS: 'stablefluids': 'none'` · (b) `hideRun` includes `'stablefluids'` · (c) `switchTab` title · (d) `renderTabForm` dispatch `else if` · (e) `state.stableFluids` slice · (f) top: `import { renderStableFluidsForm }` · (g) bottom export block: add `renderStableFluidsForm` |
| `app/static/js/tabs/stablefluids.js` | **NEW.** `renderStableFluidsForm()`, iframe src selection, `checkStableFluidsBuild()` (HEAD fetch), `waitForCanvas()` (try/catch), record/stop, `.tool-docs` block. |
| `app/static/stablefluids/` | **NEW dir.** Drop keijiro's `wget --mirror` output here. If absent, tab shows placeholder with the command. |
| `docs/STATUS.md` | Add row to §4 Partial or §3 Shipped. |
| `VERSION` | Bump far-right DD → `010`. |

---

## PHASE 1 (required — self-host + iframe + record)

1. `static.py`: add the `StaticFiles` mount.
2. `index.html`: add nav-item (use a fluid/swirl SVG).
3. `app.js`: all 7 integration points (§9 table).
4. Create `js/tabs/stablefluids.js`:
   - `renderStableFluidsForm()` renders into `elements.actionPanel.innerHTML`:
     - `.panel-title-desc` with h3 + `.dream-hint` one-liner.
     - **Record** button (enabled when build is present).
     - `<iframe src="/stablefluids/">` when build detected; else placeholder card with the `wget --mirror` command.
     - `.tool-docs` section with About copy (no Unity needed; self-hosted; recording is lossless 60fps; VP9 WebM).
   - `checkStableFluidsBuild()`: HEAD fetch to `/stablefluids/index.html`. Returns boolean. Decides iframe vs placeholder.
   - `waitForCanvas(iframe, onFound)`: try/catch `iframe.contentDocument`. Poll for `<canvas>`. On catch, disable Record (defensive).
   - Record button: toggle `recording` state, flip label `Record` ↔ `Stop`, call `startRecording(canvas)` / `stopRecording()`.
   - `startRecording`: `canvas.captureStream(60)` → `MediaRecorder` with VP9, 25 Mbps. `onstop` → Blob → anchor download.
   - `stopRecording`: `mediaRecorder.stop()`.
5. Verify:
   - Tab opens, no Run/Queue/Stop, global inputs collapsed.
   - With build: iframe same-origin, canvas found, Record works → WebM downloads.
   - Without build: placeholder shows `wget` command, no iframe, **no console errors**.

---

## PHASE 2 (follow-up — WebGPU native port)

1. Create `js/stablefluids_webgpu.js`: port keijiro's 3 WebGL passes to WebGPU compute shaders (~200 lines). Single `<canvas id="stablefluids-canvas">`, 512×512, pointer-event velocity injection.
2. Mode toggle in `.tool-docs`: "WebGL (iframe)" vs "WebGPU (native)". Default → iframe for v1.
3. In WebGPU mode: `navigator.gpu` canvas + `captureStream` works directly (no iframe boundary). CCapture.js PNG-seq available.

---

## PHASE 3 (follow-up — image injection)

1. Add `#sfSeedImage` path + Browse row (always visible; disabled in iframe mode).
2. If field blank, pull `resolveGlobalImages()[0]` from Image Pool bar (QR Illusion pattern).
3. WebGPU native only: `initialTextureUrl` → `copyBufferToTexture` before first frame.
4. WebGL iframe: **cannot** inject (stock keijiro build doesn't listen). Out of scope unless user forks Unity build.

---

## DO NOT

- Add a `/ops/stablefluids` server endpoint (non-job tab).
- Load the sim from an external URL (self-host only).
- Touch dump/encode bookends or `app/filters/*` for the sim.
- Commit the Unity/WebGL build artifacts if they are large (decide `.gitignore` with human).
- Reintroduce global Video/Image / Run chrome on this tab.
- Claim image injection works in iframe mode.

---

## DONE

- [ ] `wget --mirror` ran; `app/static/stablefluids/` holds the build.
- [ ] Phase 1 in tree: tab renders, iframe loads `/stablefluids/`, Record produces WebM.
- [ ] Missing-build case: placeholder with `wget` command, no iframe, **zero console errors**.
- [ ] `app.js` export block has `renderStableFluidsForm`.
- [ ] `static.py` mount guarded by `is_dir()`.
- [ ] `.tool-docs` About section present and accurate.
- [ ] VERSION → `010`, STATUS updated.
- [ ] Clicked the tab, no new JS errors (Playwright + manual).
- [ ] Commit on `wip`. No main merge unless human asked.

**Note:** Phase 2 / Phase 3 can ship as separate commits. STATUS = Partial on Phase 1-only ship.
