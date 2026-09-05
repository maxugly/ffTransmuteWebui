> **Archive — not law. STATUS.md is where we are now.**

### 000.000.8.016 — Skills tab (AI model skills)
- New top-level Workspace tab for SKILL.md skills (`docs/skills-tab-spec.md`, was Candidate). Upload single `.md`/`.txt` (file picker or paste box) or a `.zip` bundle (`SKILL.md` at root or one level down + support files); zips travel base64-inside-JSON so there is no multipart dependency and the full op/job/progress/cancel/single-flight machinery applies. `POST /ops/skills_install` (`app/operations/skills_ops.py`): model pass (Normalize default, Custom with user instruction — new `build_skill_install_messages` in `app/agents/skills.py`, text-only reuse of grok/agy/deepseek/openrouter/xai/openai/groq/stub) extracts `name`/`description` frontmatter (hand-parsed, no new deps); offline-tolerant fallback installs already-structured input as-is with a `meta.warning`; same-name collision returns `ok:false` + `meta.conflict` and the UI `confirm()`s before retrying with `overwrite:true`. Server store: `~/.cache/mtapi/skills.json` index (atomic tmp+replace, corrupt-index-tolerant reads) + `skills/{id}/` file bytes; zip traversal/absolute members reject the whole install; caps 200 skills / 200 KB per file / 5 MB + 50 files per zip. Thin `GET /api/skills`, `GET /api/skills/{id}`, `DELETE /api/skills/{id}` (`app/routes/skills.py`, registered in `main.py`). Frontend `js/tabs/skills.js` (`renderSkillsForm`, wired in `app.js` + `index.html` nav, Run/Queue + global inputs hidden like Agent/Notes): upload card, newest-first searchable list, reader with bundle file switcher, one-click Copy (clipboard + fallback), client-side Export `.md`/`.txt` (bundle `.txt` concatenates with `=== path ===` separators), per-row + reader Delete. New `tests/test_skills.py` (21 tests: frontmatter/slug/prompt-builder, store CRUD + corrupt recovery, zip root/nested/traversal/absolute rejects, op dry-run/empty/stub-fallback/garbage/conflict/zip-path). Full suite 100 green (was 79). Playwright-proven with real clicks on an isolated :24591 instance: paste install, zip-via-real-file-input install, conflict dialog → accept → overwrote, Copy status, byte-identical `.md` download, Delete, reload persistence — zero JS errors. Proof caught and fixed a real bug (Install button passed the click event object as `overwrite:true`, silently skipping the conflict guard). Follow-up: installed skills as Agent-tab context (v1.1 hook, spec §9).

---

### 000.000.8.013 — Single-Clip Zoom / Pan op
- New `zoom` entry on the Single-Clip Ops dropdown + `POST /ops/zoom` (`app/operations/zoom_ops.py`). Selecting it populates the full control set: engine toggle (Stable Pillow lerp default / Raw ffmpeg zoompan), 11 presets (zoom in/out, targeted, Ken Burns, ease in/out, punch, spiral, glitch, hue cycle, custom), timing (duration/fps/frame-d + live frame readout), output size, optics (rate/cap/direction/pre-scale), motion (pan/drift, target, oscillate), FX (rotate, easing, punch frame, glitch, hue cycle). Input auto-detects still (`-loop 1`) vs video; stable engine is stills-only in v1 (honest `ok:false` otherwise), rotate/glitch/hue are raw-only; raw expressions pass an injection guard. New `tests/test_zoom.py` (8 tests: preset map, guard, dry-run still, stable still real render, stable-video + FX-engine rejects, bad input). Full suite 79 green. Playwright-proven with real clicks (dropdown → all controls populate, readout `72 frames · @24fps · ~3.00s · stable · zoom_in`, zero new JS errors) + HTTP-proven backend (stable/raw still MP4s + raw clip MP4, ffprobe frame counts, HTTP 200 + `ok:false` failures). Spec: `docs/singleclip-zoom-spec.md`. Pan & Zoom tab untouched.

---

### 000.000.8.002 — Comma-safe join/grid
- Fixed a delimiter-collision bug where `/ops/join` and `/ops/grid` built multi-input as a single comma-joined string, and bash `transmute`/`bin/transmute` `collect_inputs()` split on `IFS=','`. A clip whose **own filename contained a comma** (`…yellow spots, camera slowly pulls b.mp4`) was silently truncated at its internal comma → `No such file or directory`. **1)** `/ops/join` target-less path now runs the pure-Python `concat_clips` (inputs as a real list, never comma-joined) and remuxes the already-H.264 intermediate to `.mp4` via stream copy (`_join_legacy`). **2)** New full pure-Python `grid_clips` helper (ffmpeg `xstack` 2×2, mirrors `transmute -g`) — `/ops/grid` routes through it, so grid is comma-safe too. **3)** Both bash `transmute` and `bin/transmute` `collect_inputs()` now detect a path truncated at an internal comma and exit loudly with a clear message instead of silently producing a bogus path. New `tests/test_join_comma.py` (6 tests: real join + grid with comma-filenames produce valid output, dry-run, bash hardening rejects comma-in-path, genuine multi-input still works). Full suite now 70 tests green.

---

### 000.000.8.001 — Final-encode fixes
- Hardened the shared final-render engine (`app/video_pipeline.py` `encode()` / `_build_encode_argv()`), fixing three "renders but makes nothing / fails depending on settings" failure modes. **1)** `encode()` now verifies ffmpeg actually wrote a non-empty output file via new `_ensure_output_file()` — a silent exit-0 that writes nothing (or a zero-byte file) is now a `RuntimeError` instead of a bogus `ok=True`. **2)** Legacy frame-op encodes (RIFE, speed, recohere, cut) auto-apply `pad=ceil(iw/2)*2:ceil(ih/2)*2` whenever the pix_fmt is chroma-subsampled (`yuv420p`/`yuv422*`), so odd native resolutions (e.g. 321×241) encode instead of crashing with "width not divisible by 2"; explicit `even_floor` still wins. **3)** `-shortest` no longer trims generated (RIFE'd / slow-mo) frames down to the source-audio length by default — that was silently discarding the whole point of interpolation; a new `clamp_to_audio` opt-in restores exact length-matched muxing for `cut` (`cut_ops.py` passes it). Full suite now 64 tests green (9 new in `tests/test_encode.py`: argv `-shortest`/pad/an behavior, `_ensure_output_file` missing/empty/non-empty, and a real-ffmpeg odd-dimension dump→encode integration test).

---

## Shipped History (from old §3)

## Shipped History (from old §3)

### 000.000.8.000 — Point release
- Everything since `7.000` merges to `main`: Flip / Rotate `7.017`, Clearable inputs `7.016`, Keep the Change `7.015`, Unified Speed & Time `7.014`, Visual Hijack + Mosh-ups `7.013`, Stable Fluids Phase 1–3 `7.011`, QR Art Illusion `7.009`, Settings chrome `7.008`, Live VERSION `7.007`, docs diet/slim `7.006`/`7.004`, FastSAM multimodel Partial `7.002`. Full suite 55 tests green.

---

### 000.000.7.017
- **Flip / Rotate** — lossless geometry in two places with one shared design. Single parameterized op `flip_rotate` (mode dropdown, 6 choices) on **Single-Clip Ops** and as a **Flip/Rotate** card in the **Image Edit** ops stack; both tabs are driven by `FLIP_ROTATE_MODES` + `flipRotateOptionsHtml` in `app/static/js/utils.js` so the vocabulary can never drift. Video path: new `-R MODE` flag on `transmute` and (parity) `bin/transmute` — `rotate_90`/`rotate_180`/`rotate_270` (`transpose` chain), `hflip`, `vflip`, diagonal `hflip+rotate_90`; composes with `-c/-b/-s/-S/-z/-x/-r`, audio stream-copy, auto-named `_r90/_r180/_r270/_hflip/_vflip/_hflip_r90` suffixes; registered as `/ops/flip_rotate`. Image path: `flip_rotate` stack op implemented on all three engines (ffmpeg `transpose`/`hflip`/`vflip`, ImageMagick `-rotate`/`-flop`/`-flip`, Pillow `Image.Transpose` with the CW/CCW correction) — a marker-image test proved pixel-identical corner orientation and dimension swap across all three. New `tests/test_fliprotate.py` (5 tests: CLI `-R` filter chain + suffix naming + real dim swap + bad-mode rejection, registry contract for `flip_rotate`, all three image engines × all six modes). Playwright-verified on the real UI for both tabs (Single-Clip: `-R hflip` → `src_hflip.mp4` 320×240; Image Edit: global image + vflip stack op → `ffmpeg -vf vflip`, ok=true, preview shown).

---

## Shipped History (from old §3)

### 000.000.7.016
- **Clearable inputs**: a red ✕ now ships with any populated text box, as a truly portable module. `js/ui/clearable.js` + `css/clearable.css`: add `data-clearable` to an `<input type="text">`/`<textarea>` → auto-wired as part of the page boot, plus a MutationObserver upgrades any dynamically rendered form (tabs re-render later and still get it with zero JS). The ✕ is red (`--error`), appears only when the field holds content, clears on click while firing `input` + `change` (so `updateGlobalInputs`, probing, and form-state capture all keep running), then restores focus. A 250 ms self-sync poller catches programmatic value writes that never dispatch events (desk-restore `applyDeskSnapshot`, file-browser picks, pool sends), so show/hide never desyncs. Wired on the four global inputs (Video file(s), Image file(s), Path in, Path out) in `index.html`; the old status ❌ “Not used by this tab” glyph (read as a dead clear button) was removed from `updateStatusIndicators`. `makeClearable`/`bindClearables` are exported from app.js for ad-hoc upgrades. Playwright-verified on the real UI: typed and picker-set values show the ✕, clicking clears the field and un-populates the panel / deactivates quick buttons; dynamic `data-clearable` injection auto-wraps. Systematic roll-out to all existing text boxes = the open follow-up.

---

## Shipped History (from old §3)

### 000.000.7.015
- **Keep the Change** (Unified Speed): RIFE **Free** overage is spendable, not just dropped. API `keep_extra`: `trim` (default; drop `G−R`, exact target), `fps` (encode all `G` inside target duration `T`, output rate rises to `G/T` — rejected by a Pydantic validator when `target_fps` is pinned), `length` (encode all `G` at the output rate, duration stretches to `G/F`, effective speed recomputed as `D/T`). Backend `resolve_speed_plan` returns `kept_mode`; the conforming encoder keeps all frames and encode-fuse re-times. Speed tab rebuilt to per-variable **Control/Auto**: Multiplier (Control) ⇄ Target Length (Control), the auto row shows the live derived value and is pointer-inert; **Keep the Change** segmented row (Trim / FPS-raise / Length-stretch) shown only with RIFE on, FPS-raise auto-disabled (and reverting to trim) while Output FPS is Auto·Match; live readout notes switch between `dropping N → target`, `encode all @ FPS`, and `encode all → duration`. Frontend `resolveUsPlan` is again a 1:1 mirror of the backend plan. New tests: 5 (keep trim / fps / length maths + validator rejection + rife-off ignore). Playwright verification on a real cut clip: 0.3× Free ⇒ 140 generated / 117 target / drop 23 → `encode all @ 28.8 FPS` (fps) → `encode all → 5.83s` (length); dry-run payload carries `keep_extra:"length"`, backend logs `0.25× → 5.83s`; clean console, no JS errors.

---

### 000.000.7.014
- **Unified Speed & Time**: one deterministic model for the Speed tab — per-frame FPS locked to source, `T = D/S`, `R = T×F`. Target Mode **Length** (exact duration) or **Multiplier** (exact factor). Optional RIFE **Snap** (speed locked to `1/M`, no extra frames) vs **Free** (next valid `M` with `G = N×M ≥ R`, extra dropped by a conforming encode). Fixes the wrong duration estimate (4s @ 0.5× reported 2.6s → now 8.00s). Backend `resolve_speed_plan` is mirrored 1:1 by the live UI readout (`app/static/js/tabs/speedchange.js`); API: `POST /ops/speedchange` with `target_mode` / `target_length` / `speed` / `rife_snap`. Fast path = pure ffmpeg; RIFE path = dump → ×M → thin G→R → encode @ F (audio atempo preserved). 13 new unit tests (`tests/test_speedchange.py`), Playwright-proofed on real `testsrc` assets (RIFE 0.5× snap → exactly 4.000s, 96 frames @ 24fps; super-simple fast 2× → 24 frames; 0.3× Free ⇒ 400/480/+80 readout).

---

## Shipped History (from old §3)

| Area | Notes | Spec / code |
|------|--------|-------------|
| **Stable Fluids Phase 2/3** | Pure WebGPU compute port (~3 passes: spray/advect, divergence+Jacobi×20, gradient-subtract) replacing the Unity iframe when native mode is on; **seed-image injection** (dedicated path → first Image Pool still → black) as the initial dye field; mode radio toggle; Record shared across both modes; tab teardown stops the sim/rAF on leave | `stablefluids-sim-spec.md` · `7.011` |
| Filter platform | dump / stages / encode | `filter-platform-spec.md` |
| Convert / Export | codecs, frames_*, GIF | `convert_ops.py`, `convert_presets.py` |
| Transmute geometry | CLI wrapper | `transmute_ops.py` |
| Datamosh | melt, classic, … | `operations/datamosh/` |
| DeepDream / withoutBG / style / facemorph | neural / multi-source | `*_ops` + filters |
| RIFE directory | RIFE tab + pipeline + Image Sort | `filters/rife.py` |
| Speed change + ramp | optional RIFE | `speedchange_ops`, `speedramp_ops` |
| Zoompan | still → video | `zoompan_ops.py` |
| Dual pools + Cut UI | encode still open | `video-image-pools-spec.md` |
| Image Sort → Video | rank, conform, RIFE, encode | `image-sort-rife-spec.md` |
| Image Sort chain | radial \| closest next | `image_sort/rank.py` |
| RIFE multiplier **2–128** | knobs + API | imagesort / rife / speed / ramp |
| Img2img OpenVINO | stage + op + tab + mark frames | `img2img-openvino-spec.md` |
| Txt2img OpenVINO | op + tab | `txt2img_ops.py` |
| Agent tab (Phase A+API) | CLI + HTTP via `~/.secrets` | `agent-vision-tab-spec.md` · `4.59` |
| **RIFE Recoherence** | 2 stills → RIFE M=2 → **img2img every mid** (keep all; no discard) → .mp4 | `rife-recoherence-spec.md` · `4.62` |
| **Upscale (NCNN)** | Real-ESRGAN / SRMD + tab + bins | `upscale_ops.py`, `filters/upscale.py` · `4.64` |
| **Cut encode** | Global range dump→encode | `cut_ops.py`, Cut tab · `4.64` |
| **Job queue (v1)** | FIFO in-memory + Jobs tab + Add to Queue | `job_queue.py`, `op_runner.py` · `4.64` |
| **QR & Illusion Art** | QR/Pattern + ControlNet + IP-Adapter | `qr_ops.py`, `qr_art_ov_worker.py`, `js/tabs/qr.js` · `5.05` |
| **Prompt Library** | Save/load ± pairs; img2img / txt2img / recohere | `prompt-library-spec.md` · `js/ui/prompt-library.js` · `4.61` |
| Job progress core | phase rate/ETA, cancel | `job_control.py` |
| RIFE dir watch | `frames_out` while binary runs | `filters/rife.py` |
| **Live preview (all ops)** | `latest_frame` on frame writers; **DeepDream mid-ascent** snapshots to `/tmp/mtapi_live/{token}.png` | `4.70`+`4.71` |
| Pre-run summary | Image Sort, RIFE, Speed, Face Morph | `ui/pre-run-summary.js` |
| Run-button elapsed | sticky `● m:ss` | `job-control.js` |
| list-keys (partial ship) | several list tabs | `ui/list-keys.js` |
| Bottom docs (partial ship) | Image Sort pilot + img2img / txt2img / agent / upscale / recohere / **deepdream** | `tool-bottom-docs-spec.md` |
| **DRY staged job** | `run_staged_job` shared bookend runner; rife / cut / upscale-video / speedramp migrated | `app/staged_job.py` · `4.65` |
| **Run/Queue collect unified** | Single `resolveActiveOpAndBody()` shared by Run + Add to Queue | `js/job-control.js` · `4.65` |
| **Bottom input preview** | Every op tab shows input thumb(s) at panel bottom (after docs); dual for style/recohere/guide | `js/ui/input-preview.js` · `4.66` |
| **DeepDream bottom docs** | Full noob-friendly story + every knob + recipes | `js/tabs/deepdream.js` · `4.67` |
| **DeepDream Evolve video** | Mid-ascent capture → Image Sort dedupe → optional RIFE → `*_evolve.mp4` (stills) | `deepdream-evolve-video-spec.md` · `4.73` |
| **Style Evolve + shared bookend** | Strength ramp (1 neural pass) → `app/evolve_video.py` RIFE/encode DRY | `styletransfer` · `4.74` |
| **Evolve DRY cleanup** | Shared `EvolveRifeParams` + `js/ui/evolve-rife.js` (DeepDream + Style tabs) | `evolve_video.py`, `evolve-rife.js` · `4.75` |
| **DeepDream dead-path scrub** | Removed unused sync `dream_video`/`dream_ouroboros`; shared RIFE model select across tabs | `dream.py`, `evolve-rife.js` · `4.76` |
| **Dead-code pass 3** | Dropped unused helpers/shims; wired `frame_range` fields across video ops | `shell`, engines, `*_ops` · `4.77` |
| **Image Compare tab** | Two stills · separate/overlay/A/B (shared module) · rate via `imagesort_rank` | `js/tabs/imgcompare.js` · `4.68` |
| **Nav category collapse** | Collapsible sidebar categories + localStorage persist + auto-expand active | `nav-collapse-spec.md` · `js/ui/nav-sections.js` · `4.69` |
| **Join codec export** | `target` preset id from `/api/presets`; Python `concat_clips` stitch → codec preset encode (DNxHR/ProRes/H.264/HEVC/AV1/FFV1) | `concat_clips` (`video_pipeline.py`), `JoinParams.target`, `/api/presets` · `4.81` |
| **RIFE in Join** | `use_rife` + `target_fps`; smallest 2^k overshoot + exact resample (no 72/96 leak); mux original audio; registers `rifed` variant | `transmute_ops._rife_preprocess`, `sequence_rife_interpolation_spec.md` · `4.81` |
| **Clip variant registry** | `register_variant` / `get_variants` + `/api/variants`; kinds original/rifed/export; association in central cache (no sidecar) | `cache.py`, `sequence_clip_variant_registry_spec.md` · `4.81` |
| **Unified Join Frontend** | Format dropdown (populated from `/api/presets`) + RIFE toggle/fps + variant nodes under pool cards | `js/pool/grid.js`, `js/pool/persistence.js`, `sequence_join_unified_frontend_spec.md` · `4.81` |
| **Simplify pass** | 3-agent review; collapsed per-clip triple-probe → single `probe()`; `asyncio.gather` on probe/hash; shared `RECENT_CAP`; dropped datamosh import | `simplify-code` skill · `4.81` |
| **/api/variants hardening** | Index-only lookup (`lookup_cached_hash`), never hashes caller input on GET (closes CPU/IO amplification) | `sequence_api_variants_security_spec.md` · `4.81` |
| **FastSAM fixes** | Accurate unpadded coordinate clicks (`cv2.pointPolygonTest` on `masks.xy`); 'Everything' mode outputs clean `_assets` directory; native system folder opener `/api/open-folder` | `fastsam_ops.py`, `fastsam.py` · `4.82` |
| **Seq Instant RIFE fix** | Correct slow-mo effective-fps (content density); Instant job progress | `sequence.js`, `transmute_ops._rife_preprocess` · `4.83` |
| **Instant RIFE queue + Stop** | FIFO client queue (no frame skip); main Run busy for whole batch; Stop cancels current + drops queue; Stitch via same path | `sequence.js`, `job-control.js`, `persistence.js` · `4.84` |
| **Instant RIFE badges/strip** | Token badges NEED/Q#/RUN/OK/FAIL + ORIG/RIFED file control; status strip above sequence | `sequence.js`, `pool.css` · `4.85` |
| **Job Stop pulse** | Main Stop pulses + shows elapsed whenever any job/Instant batch is busy | `job-control.js`, `forms.css` · `4.86` |
| **Instant RIFE auto-kick** | Meta-on-Sequence-tab, Time input debounce, post-render scan, Instant enables RIFE | `sequence.js`, `items.js`, `grid.js` · `4.87` |
| **Instant RIFE force probe** | Turning Instant ON probes all seq clips then queues densify; explicit empty-state strip | `ensureSequenceMetaAndInstantScan` · `4.88` |
| **Instant RIFE crash fix** | Fixed missing `_updateSeqVariantBadges` (broke all sequence render + Instant) | `sequence.js` · `4.89` |
| **Instant RIFE densest-wins** | Mid-flight Time/target raise soft-aborts and re-densifies; keep highest M (drop frames later) | `sequence.js`, `abortMainJob soft` · `4.90` |
| **Join preset = file→file transcode** | No dump→PNG for DNxHR/ProRes stitch; normal ffmpeg re-encode | `transcode_with_preset`, `_join_with_preset` · `5.00` |
| **Job workspace on disk** | Default `~/.cache/mtapi/jobs` (not /tmp tmpfs); override `MTAPI_JOBS_ROOT` | `job_workspace.py` · `4.99` |
| **Jobs tab live desk** | Read-only: live server ops + FIFO + Instant queue + done | `jobs.js`, `job_control.list_live_and_recent`, queue snapshot · `4.98` |
| **Sequence token size + layout** | Two-row chips; W/H ± size; min-width stops badge spill | `sequence.js`, `pool.css` · `4.97` |
| **Match click selects pool card** | Clear filter, uncollapse pool, re-render + scroll on match row/Select | `grid.js` · `4.96` |
| **Select RIFED sets multiplier** | Variant menu writes `_rifeMultiplier`; badge uses haveM so NEED does not stick after pick | `sequence.js` · `4.95` |
| **QR Art Generator** | Scannable QR + ControlNet QR Monster (OpenVINO img2img) + optional IP-Adapter (PyTorch ControlNet+IP-Adapter). Scannability badge via pyzbar. | `qr_ops.py`, `qr_art_ov_worker.py`, `js/tabs/qr.js` · **`5.04`** |
| **State tracking / popup spam** | Hydration-complete gate prevents Instant RIFE re-queue on project load; busy-block alerts replaced with logConsole | `sequence.js`, `job-control.js`, `pool/persistence.js` · **`5.02`** |
| **Sequence Audio Engines** | Rubberband DAW flags + 48kHz sample-rate fix + 10ms micro-fade; engine dropdown UI | `sequence-audio-engines-spec.md`, `video_pipeline.py`, `grid.js`, `persistence.js` · **`5.01`** |
| **Instant reuses existing densify** | Hydrate from /api/variants + persist rife_multiplier; NEED only if M insufficient | `sequence.js`, `persistence.js`, `cache.get_variants` · `4.94` |
| **Single-flight restore** | Soft-cancel must not abort fetch (orphaned server job); server rejects concurrent /ops/* | `job-control.js`, `job_queue.py`, `main.py` · `4.93` |
| **Instant re-render storm fix** | Queue no-op no longer re-renders; variants cache; failed no tight-retry; dual RIFE killed | `sequence.js`, `grid.js` · `4.92` |
| **Settings tab (blank)** | Workspace · bare chrome (no global/preview/Run); scaffold for perf prefs | `js/tabs/settings.js`, `css/settings.css` · `4.91` |
| **Universal persistence** | Full desk snapshot: metadata + signatures round-trip, `/api/media_signature`, shared lazy-loader (100px margin, max-5 fallback), settings precedence (project loads never overwrite globals), schema v2 migration, inactive-tab formState | `universal-persistence-spec.md` · **`5.06`** |
| **Settings layout polish** | Tight one-page cards hug content width; Neural FX blurb wraps after “Default is off” | `settings.js`, `settings.css` · **`5.12`** |
| **Settings card layout spec** | House style so new Settings cards ship tight (one-line head, packed controls, max-content width) | `settings-card-layout-spec.md` · **`5.13`** |
| **Catalog UX Phase 1** | Eager memory-restore of saved metadata (no network probe); `POST /api/media_signatures` + `POST /api/variants/batch` (max 100); `window.globalMediaIndex`; persisted-variant fast path (zero variant requests when dense enough); Instant RIFE COW + hash recovery + unreferenced lower-density GC | `performance-catalog-ux-spec.md` · **`5.14`** |
| **Hash-only thumbnail 500** | Hash URLs resolve a recorded source path, skip `thumb_failed` extracts, return 404 not 500; thumb `onerror` no longer POSTs `/api/media/recover` | `thumbnails.py`, `freshness.js` · **`5.15`** |
| **Thumbnail load speed** | Hash-only serve of an existing JPEG does not parse `record.json` or scan `index.json`; browser assigns at most 8 in-flight thumb `src`s | `media.py`, `lazy-loader.js` · **`5.16`** |
| **Viewport-lazy regression** | Default is strictly `viewportLazyThumbnails=true`. `preloadAllThumbnails` is a deprecated legacy alias (`preloadAllThumbnails=true` → `viewportLazyThumbnails=false`). | `lazy-loader.js` · **`5.17`** |
| **Thumb queue coverage** | Size/settings refresh and hash-upgrade src writes go through `assignThumbSrc` (max 8). | `freshness.js` · **`5.18`** |
| **Pay-once thumbs** | `GET ?hash=` is cache-only (404, no ffmpeg). `POST /api/thumbnails/ensure` fills misses in the background ONLY via idle-queue or explicit repair. | `media.py`, `lazy-loader.js` · **`5.19`** |
| **No redo** | Index lookup is path+size (not mtime). Cache-hit media open does not probe/extract/rewrite. Failed extracts stay failed until Retry. | `cache.py`, `open.py` · **`5.20`** |
| **Reload thumbs** | Hash `src` written on the card at render; 8-queue no longer withholds src; L/M serves H if needed | `grid.js`, `lazy-loader.js` · **`5.21`** |
| **Viewport-lazy default enforced** | Default is strictly viewport-lazy per `catalog-interaction-virtualization-spec.md`; settings from localStorage + `/api/settings` only | `lazy-loader.js`, `settings.js` · **`5.22`** |
| **No Instant scan on project load** | Opening a project does not re-probe / re-scan already-known clips | `sequence.js`, `persistence.js` · **`5.23`** |
| **Instant only needs density** | Instant encodes only clips that still need a higher M | `sequence.js` · **`5.24`** |
| **rifeNeed** | `rifed \| needsRife \| noRifeNeeded` on sequence entries | `sequence.js` · **`5.25`** |
| **Instant reads rifeNeed** | No sequence-wide variant scan; Instant uses in-memory rifeNeed | `sequence.js` · **`5.26`** |
| **Scroll keeps thumbs painted** | Hover/transform locked while the pool grid is scrolling; no full-grid restyle; `src` stays on the card | `layout.js`, `sequence.js`, `pool.css` · **`5.27`** |
| **Open does not re-scan thumbs** | Restore copies record meta + thumb flags; hover never calls `media_info`; failed extracts are not GET/ensured again | `pool.py`, `sequence.js`, `freshness.js` · **`5.28`** |
| **Scrollbar width setting** | Settings → UI tweaks. 6–30px. `5.30` actually changes the bar; `5.31` raises the cap to 30px | `settings.js`, `base.css` · **`5.29`–`5.31`** |
| **Preview collapse in header** | Media Output Preview toggles from ▲/▼ in the top bar after Stop. Side tab handle removed | `index.html`, `layout.css`, `app.js` · **`5.32`** |
| **Sidebar collapse is icon-wide** | Collapsed aside is 44px (icons only). Title + logo hide. Saved drag-width no longer keeps it fat | `layout.css`, `app.js` · **`5.33`** |
| **Header title gone** | No redundant tab title in the top bar. V-in/out buttons hug the left | `index.html`, `layout.css` · **`5.34`** |
| **Input preview not sidebar** | Nav `aside` is `.app-sidebar`; input preview is a `div` so collapse/resize no longer shrink it | `index.html`, `layout.css` · **`5.35`** |
| **Catalog virtualization** | Hover/scroll/select never `/api/media_info`. Path-keyed index + bounded queues. Video **and** Image Pool use `.pool-scroll-canvas`. JS scroll work p95 ~1ms. **Partial:** headless rAF p95 is not the spec’s vsync 16.6ms compositor target | `catalog-interaction-virtualization-spec.md` · **`5.37` Partial** |
| **Responsive virtualized pools** | Video and Image Pool use the bounded vanilla virtualizer: visible window + 1.5-screen overscan, recycled shells, hash-only thumbs, and explicit loading placeholders. Sequence.js and server catalog/thumbnail generation untouched. Broader catalog-virtualization performance spec remains Partial. | `grid.js`, `image-pool.js`, `virtual-grid.js`, `pool.css` · **`6.5`** |
| **Pool wall preview** | Default wall is one JPEG: first\|last side by side (120px each). Extra `wall.jpg` is first-only. Settings switch. Prepared on import from extracted first/last. Stable `<img>`; chrome-only recycle. | `pool-wall-preview-spec.md`, `wall-thumbs.js`, `thumbnails.py` · **`6.7`** |
| **Import probes metadata** | New Video/Image Pool adds queue hash+probe+thumbs immediately. Card Repair Metadata is clickable (`pointer-events`). | `items.js`, `image-pool.js`, `pool.css` · **`6.8`** |
| **Import wall not stuck** | New clips keep `path=` wall GET until first/last exist; hash URL is assigned after the combo JPEG is written. | `wall-thumbs.js`, `repair-queue.js` · **`6.9`** |
| **Pool dead-code cleanup** | Removed unused card helpers; `assignCardThumbs` skips wall tenants; viewport-lazy Settings switch gone; no FIRST/LAST labels on `.pool-wall`. | `pool-deadcode-cleanup-spec.md` · **`6.10`** |
| **7.000 release** | Wall that stays painted: one prepared JPEG (first\|last combo default), stable `<img>` tenants, chrome virtualizer, import probe + generate. | `pool-wall-preview-spec.md` · **`7.000`** |
| **Sequence total time** | Header shows sum of clip play lengths (Time override or native). | `sequence.js` · **`7.001`** |
| **Docs slim pass 1** | Archived competing TODO/ideas piles + July root STATUS/TODO/ROADMAP. Live truth is this file. | `docs-slim-plan.md` · **`7.002`** |
| **FastSAM multimodel** | Model selector on FastSAM tab: FastSAM-s (default) + FastSAM-x. Same OpenVINO export path. Phase 2 (SAM ViT-L/H) deferred: ultralytics SAM export crashes (`SAMModel` has no `args`). | `fastsam-sam-multimodel-spec.md` · **`7.002` Partial** |
| **Server-resident catalog** | CatalogIndex hydrates the full cache before serve; display paths read RAM; exclusive process lock; 64 MiB JPEG warmer; `/api/catalog/status`. §11–12 I/O, lock, warmer, restart, Video+Image+Sequence browser checks accepted | `server-memory-catalog-spec.md` · **`5.38`** |
| **Visual Hijack** | Motion-vector payload injection pipeline (`_execute_hijack_pipeline` in `common.py`). Source MVs extracted via `ffgac` → `ffedit -e` → applied to payload via `ffedit -a`. Image payload (file or extracted frame) injected at frame range, smeared by source MVs or frozen constant. Clean source bookends before/after. CLI `-H IMG:START:END[:STYLE]` in `transmute` + `bin/transmute`. `visualhijack` per_frame filter registered in `app/filters/`. 9 unit tests + 4 POC validation tests. Zero decoder errors, zero green pixels, frame count preserved, audio preserved. | `app/operations/datamosh/hijack.py`, `app/operations/datamosh/common.py`, `app/filters/visualhijack.py` · **`7.012`** |


## Recently Shipped (from old §5.2)

| Spec | Version |
|------|---------|
| [server-memory-catalog-spec.md](server-memory-catalog-spec.md) | **`000.000.5.38`** |
| [prompt-library-spec.md](prompt-library-spec.md) | **`000.000.4.61`** |
| [rife-recoherence-spec.md](rife-recoherence-spec.md) | **`000.000.4.60`** |
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | Phase A+API **`4.59`** |
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | **`4.55`** + UI tab |
| Txt2img OpenVINO | In tree (op + tab) |
| Image Sort chain, RIFE×128, progress core | ~`4.54` era |

## Fixed Bugs (from old §6)

1. **Autosave can overwrite named projects** → **fixed `4.63`** (session-only autosave; named file only on explicit Save). Full desk snapshot **`5.06`**.  
4. **Inactive tab knobs** not in project JSON → **fixed `5.06`** (formState + continuous desk bindings).  

## Other Implemented Specs (from old §5.4)

| Spec | Intent |
|------|--------|
| [image-compare-spec.md](image-compare-spec.md) | Shared module + **Compare tab `4.68`** |
| [nav-collapse-spec.md](nav-collapse-spec.md) | **Sidebar category collapse** (headers) — **Implemented `4.69`** |
| [deepdream-evolve-video-spec.md](deepdream-evolve-video-spec.md) | **DeepDream Evolve** — **Implemented `4.73`** (stills A+B); multi/video later |

### 000.000.7.013
- Datamosh: Implemented Mosh-ups (from Parker Higgins' automated datamoshing from multiple video sources technique). Added `video` and `shuffle` inject modes to Visual Hijack.
- `_resolve_payload_stills` and `_create_payload_yuv_from_stills` pipelines process multi-image/frame streams to stitch into MPEG-2 payload P-frames.
