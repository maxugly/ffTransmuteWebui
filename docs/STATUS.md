# Project status — agent & human source of truth

> **Updated:** 2026-09-01  \
> **VERSION:** root `VERSION` file (do not copy the digits here)  \
> **Branch:** `wip`  
> **Purpose:** Where we are. **Shipped / partial / remaining roadmap.** Agents **must** read this before inventing features or re-speccing shipped work.

**Also read:** `AGENTS.md` (root) · [README.md](README.md)

---

## Shipped this stretch / Next assignment

| Area | Notes | Spec / code |
|------|--------|-------------|
| **Single-Clip PTS-aware RIFE (cfr Path D)** | Default RIFE path is now true-timestamp bracketing: `pts_map` sidecar + per-pair `rife-ncnn-vulkan -s t_q` (`t_step` default 0.25, 0 = exact), endpoint copy-through, cut detection (4× median gap), `_cfr_pts` suffix. CFR-first/direct stay as legacy compare. `-s` honored by v4.6 proven on-box + pinned by regression test. 9 new tests, 149 total green. Playwright-proven with real clicks: Row 2 PTS toggle + t-step → dry run (54 PTS → 8 inferred / 46 copied) → real VFR run in 23s wall (54f, r==avg, gaps uniform @ 1/F, duration 5.77→5.77s vs legacy CFR-first collapse to 1.8s) — zero new JS errors. | `pts-aware-rife-spec.md` · `singleclip-cfr-spec.md` · `rife_pts.py` · `cfr_ops.py` · `video_pipeline.py` (`pts_map`) · `tabs/transmute.js` · `job-control.js` · `tests/test_cfr.py` |
| **References: FLUX 3 Video row (full brief, zero trim)** | Big Chart gains the human-supplied FLUX 3 Video entry verbatim across all 13 cols (`MODELS_ROWS`, no renderer/sort changes): Unified-multimodal-frontier category (Self-Flow, FLUX-mimic offshoot), 2026-07 release (Jul 23 announce, gated EA, playground trial till Aug 17), unpublished-train-res native cell (720p evals, `flux_3_video` 5–20s 720p/1080p, only native 2:1), 720p-Draft cheap-coherence sweet spot (all three price figures, 5–10s single-subject rule), 20s/1080p max (no 4K), 5–8s test / 10s delivery duration cell, FL2V Yes + Audio Yes badges (endpoints + no-external-audio + blurry-cut-vs-Seedance caveats in tips/weaknesses), full strengths (faces, lip-sync winner, weird-believable, typography, agentic chaining) + weaknesses (Seedance 2.5 smoking, censorship, drift past 12–15s, preliminary-hype flag, gated) cells. Full uncut brief also saved as source doc `flux_mod_ref.md`. Playwright-proven with real clicks on :24590: Video Models nav → FLUX 3 Video row live, all 13 cells, Yes/Yes badges, zero console errors. 140 pytest green. | `js/tabs/references.js` · `docs/flux_mod_ref.md` |
| **Single-Clip VFR → CFR (+ optional RIFE)** | New Single-Clip Ops entry **`cfr`** + `POST /ops/cfr`: base = fast single-pass CFR normalize (`ffmpeg -vf fps -fps_mode cfr`, no dump, audio kept); RIFE toggle reveals Frame ×/model/TTA/UHD + **`→ CFR First`** (default ON) → dump→CFR-stage→RIFE→encode, off = legacy direct-RIFE. Auto FPS = probe `avg_frame_rate` (fallback `r_frame_rate`); `0 = Auto` on the wire as `null`. Probe keeps `fps` semantics, adds `fps_avg`/`fps_r`/`is_vfr_guess`. `cfr_first` without RIFE coerced to False. 12 new tests, 140 total green. Playwright-proven with real clicks: dropdown → Row 2 gating → dry runs → real VFR clip (r=30≠avg≈9.36) → CFR out (r==avg), RIFE CFR-first + direct both interpolated — zero new JS errors. | `coder-cfr-prompt.md` · `singleclip-cfr-spec.md` · `cfr_ops.py` · `filters/cfr.py` · `tabs/transmute.js` · `job-control.js` · `tests/test_cfr.py` |
| **Scripts tab + digicam_2000s (`8.036`)** | New top-level **Scripts** section (Script Runner tab): read-only `GET /api/scripts/catalog` (validate + cache, corrupt → `[]`), generic runner (`runOpWithCancel` dispatch, 8 accordion groups, preset autofills w/h, per-script frame-range toggle, dry-run knob, `tool-docs` block). First script **`digicam_2000s`** (image → `*_digicam.jpg`, video → dump→`filters.digicam`→encode `*_digicam.mp4`): VGA squish, soft lens, CCD color, luma/chroma grain (`luma_only` fixed), flash + vignette knobs, JPEG pass table `[60,50,42,34,28]`, per-frame `seed+i` RNG, hex timestamp color, numpy barrel remap. 16 new tests, 128 total green. Playwright-proven with real clicks: nav → 8 groups → preset 144p/vga fills → dry run (no file) → real image (74 KB JPG) → global-Run video (640×480 10f MP4) — zero page errors. Caught live: frontend `"0"` string vs `Literal[0,1,2]` → HTTP 422, relaxed to `int ge/le`. | `coder-digicam-prompt.md` · `scripts-tab-spec.md` · `digicam_core.py` · `filters/digicam.py` · `operations/digicam_ops.py` · `scripts/catalog.json` · `routes/scripts.py` · `js/tabs/scripts.js` · `tests/test_digicam.py` · **`8.036`** |
| **References: always-visible sort affordance + cache-bust (`8.035`)** | Every sortable header on all 5 tables now shows a dim ⇅ at all times (active column keeps live ▲/▼); repaint paths restore ⇅ on deactivate. Also bumped `references.js/css` cache-busters `?v=2`→`?v=3` (unchanged since `8.021` while the files shipped 4 releases — stale browsers were running old code). Verified on Video: all 13 headers show affordances, Released click sorts oldest-first with live ▲. | `index.html` · `app.js` · `js/tabs/references.js` · `css/references.css` · **`8.035`** |
| **References: sort arrows on YT tables + unclip fix (`8.034`)** | License (A) and Watermarks (D) tables are now sortable on every header via shared `sortRows` (new `data-ytable` + `paintYtTable` path, horizontal headers with ▲/▼, no toggles). Badge columns sort best→worst (Yes→Varies→No, Survives→Degraded→Stripped); defaults are name A→Z (slight reorder vs the old curated order). Caught live during proof: the License card was flex-squeezed to 175px, silently clipping 4 of 6 rows under `overflow:hidden` — YT workspace children now `flex-shrink:0` so the tab scrolls instead (wide model tables untouched). Playwright-proven with real clicks on both tables + screenshots, zero console errors. | `js/tabs/references.js` · `css/references.css` · **`8.034`** |
| **References: always-vertical headers, gap-free tables (`8.033`)** | All three model tables go full matrix-style: every header label is permanently vertical (90° CCW, bottom-to-top) with checkbox + sort arrow in a compact top row. Header text no longer forces column width, so columns size to body content (Provider 74px, Context 48px, Avail 32px on Coding). Also removed the `thead th:nth-child(3)` 220px min-width rule that was holding a gap open on 3rd columns. Header height is a uniform 147px on all tables and never moves on toggle/sort; collapsed columns still shrink to dimmed 26px strips with re-check restore. Clicking a vertical label sorts. Playwright-proven with screenshots on all 3 tabs, zero console errors. | `css/references.css` · `js/tabs/references.js` · **`8.033`** |
| **References: collapsed headers get bounded stubs (`8.032`)** | Follow-up to `8.031`: the uncapped vertical label let one long header (e.g. 43-char Sweet Spot, Key Strengths) blow the whole sticky header row to 244px+. Collapsed labels are now capped at an 88px stub (`max-height` + ellipsis overflow) so header height is constant 123px no matter which columns collapse (45px all-expanded), and the full name survives on a `title` tooltip on every header label. Verified worst case on Video (sweet+tips → 26px strips, 152 cells) with screenshots. | `css/references.css` · `js/tabs/references.js` · **`8.032`** |
| **References: collapsible columns never vanish (`8.031`)** | Fixed the roach-motel column toggle on all three model tables (Video/Image/Coding): unchecking a column no longer `display:none`s it (which orphaned its own checkbox). Unchecked columns now collapse to a 26px strip — checkbox stays on top, label rotates 90° CCW (bottom-to-top) so it stays readable without forcing width, body cells hold the strip with a faint tint. Re-check restores full width. Shared `sortHeaders`/`paintSortableTable` path so all tables + persisted `refs-col-vis` behave the same. Caught + fixed live: `thead th:nth-child(3)` 220px min-width was beating the strip (qualified selectors to `thead`/`tbody`). Playwright-proven with real clicks: code/provider 26px→91px, video/notes 26px→230px ×76 rows, image/buckets 26px→233px ×51 rows, reload persistence, zero console errors. | `css/references.css` · `js/tabs/references.js` · **`8.031`** |
| **References: Coding Models → verified LLM table + Benchmarks col (`8.030`)** | Coding Models sub-tab rebuilt from human `llm_mod_ref.md` gateway-list verification: 19 stale rows (BigPickle, Laguna, Dots3, LFM, StepFun) → 29 verified rows (Kimi K3, GLM-5.2/5.3, DeepSeek V4 Pro/Flash, Qwen3.8/3.6, Nemotron 3 Nano/Super/Ultra + 3.5 trio, Inkling + Small, Muse Spark 1.2/1.3, Llama 4 Maverick, Mistral Medium/Small, MiniMax M3/M2.7, Ling 3.0 Flash, Gemma 4, gpt-oss, North Mini Code, MiMo V2.5). LLM twist: new sortable `Reported Benchmarks` col quoting number + provenance (vendor vs AA/third-party); `—` unconfirmed cells sort last; highlights on GLM-5.2 (strongest open coding benchmarks) + Muse Spark 1.3 (top free pick); recommendations + callout rewritten (Avail. all `+`, free-tier unverified, dropped-name list). Playwright-proven with real clicks: 7 headers in order, 29 rows, sorts, zero console errors, zero page h-scroll. | `mtapi-project/app/static/js/tabs/references.js` · `docs/llm_mod_ref.md` · **`8.030`** |
| **References: Video Models Big Chart data enrichment (`8.029`)** | Enriched 25 sparse/placeholder video model rows in `js/tabs/references.js` `MODELS_ROWS` array with full taxonomy categories, release dates, native/sweet/max resolutions, accurate FL2V/Audio badges, key technical notes, strengths, weaknesses, and concrete practical prompt tips derived from research reference documents (`wan_hunyuan_mod_ref.md`, `vidu_mod_ref.md`, `minimax_ltx_mod_ref.md`, `seedance_mod_ref.md`, `kling_mod_ref.md`, `pixverse_vidu_mod_ref.md`). Verified JavaScript syntax (`node --check`) and 112 pytest unit tests green. | `mtapi-project/app/static/js/tabs/references.js` · **`8.029`** |
| **References: ShengShu Vidu AI Video Model cheat sheet (`_mod_ref`)** | Researched full 6-model ShengShu Vidu family (Vidu Q3 Pro / Q3 Flagship, Vidu Q3 Turbo, Vidu Q1 / Start-End Interpolation Endpoint, Vidu S1 Real-Time / Low Latency, Vidu Q2, Vidu 1.0 / 1.5 / 2.0) from primary API documentation, launch technical notes, and community benchmarks. Enforced zero marketing buzzwords, 7-value category taxonomy, concrete failure modes, 3 practical prompting tips per model, competitor comparisons, and verified specific technical objectives (start-end 0.8–1.25 aspect ratio tolerance guard & HTTP 400 rejection, R2V 1–7 multi-image slot rules for character vs background lock, single-pass joint audio-visual lip-sync mechanics via quotation marks or WAV/MP3 uploads, and I2V/R2V benchmark positioning over text-only prompting). | `docs/vidu_mod_ref.md` · **`8.028`** |
| **References: Alibaba Wan & Tencent Hunyuan AI Video Model cheat sheet (`_mod_ref`)** | Researched full 8-model Alibaba Wan family (Wan 3.0 Prime, Wan 3.0 Base/Self-Host, Wan 2.2 Fast/I2V rCM/I2V LoRA, Wan 2.1 14B & 1.3B, Wan 2.6 & 2.7) and open-source video models (Tencent Hunyuan Video v1.0 & v2.0 4K, Mochi 1 Genmo, Pyramid Flow & ToonCrafter) from primary documentation and community power-user data. Enforced zero marketing buzzwords, 7-value category taxonomy, concrete failure modes, 3 practical prompting tips per model, competitor comparisons, and specific research objective verifications (negative prompt field rules, document reference inputs, rCM 4-step execution, VRAM footprints, Mochi 1 480p resolution trade-off). | `docs/wan_hunyuan_mod_ref.md` · **`8.027`** |
| **References: MiniMax & Lightricks LTX AI Video Model cheat sheet (`_mod_ref`)** | Researched full 11-model MiniMax (H3, H3 Max, Hailuo 2.3/2.3 Fast, Hailuo 02, Video-01 Director/Live, Video-01 Base) and Lightricks LTX line (2.5/2.5 Fast, 2.3/2.3 Fast/F2LF, 2 19B/Pro/Fast, 0.9.8 13B Distilled, 2B Q8) from community power-user data and primary documentation. Enforced zero marketing buzzwords, 7-value category taxonomy, concrete use cases, known failure modes, personality, 3 practical prompting tips per model, and competitor comparisons. Formatted to exact reference spec. | `docs/minimax_ltx_mod_ref.md` · **`8.026`** |
| **References: PixVerse & Vidu AI Video Model cheat sheet (`_mod_ref`)** | Researched full 16-model PixVerse (V4, V4.5, V5, V5.5, V6), Real Motion physics line (2.6, 2.6 Remix, Turbo, 3.1/3.1 Turbo, 3.2, 3.2 Remix, 3.5, 3.5 Turbo), and Shengshu Vidu line (1.0/1.5/2.0, Q2, Q3, Q3 Turbo/Pro) from community power-user data (Reddit r/aivideo, forums, YouTube reviews). Enforced zero marketing buzzwords, 7-value category taxonomy, concrete use cases, known failure modes (subject warping in Remix, start/end aspect ratio 0.8-1.25 constraints, watermark realities), personality, 3 practical prompting tips per model, and competitor comparisons. Formatted to exact 13-col reference spec. | `docs/pixverse_vidu_mod_ref.md` · **`8.025`** |
| **References: Kling AI Video Model cheat sheet (`_mod_ref`)** | Researched full 11-model Kuaishou Kling family (Kling 3.0, 3.0 Pro, 3.0 Omni, 3.0 Turbo, 3.0 Motion Control, 2.6, 2.6 Pro, 2.5/2.5 Turbo, 2.1, 01, Avatar V2) from community power-user data (Reddit r/aivideo, forums, YouTube reviews, benchmarks). Enforced zero marketing buzzwords, 7-value category taxonomy, concrete use cases, known failure modes (limb morphing, teeth glitches, credit burn), personality, 3 practical prompting tips per model, and competitor comparisons. Formatted to exact 13-col reference spec. | `docs/kling_mod_ref.md` · **`8.024`** |
| **References: Video Models 13-col schema + batch #1 (love per line)** | Big Chart grows 10→13 cols (Notes stays last): new sortable `Category` (7-value taxonomy: Cinematic Realism, Precision / Control, Physics / Chaos, Avatar / Lip-Sync, Stylized, Edit / Extend, Open / Self-Host), `Released` (YYYY-MM), `Use / Prompt Tips` (how to drive it, not brochure copy). Schema is key-based so future column toggles plug straight in; no sort/renderer/legend changes; other 73 rows render `—` (sort last) until their turn. Batch #1 researched from primary sources: Wan 3.0 Prime (2026-08, Precision/Control, doc-input trick, no-negative-field tip), Kling 3.0 Omni (2026-02, director-not-photographer prompting, FL2V left ? as unconfirmed), Seedance 2.5 Lite (2026-07, beats+9-refs-beat-40 tips, 4K claim flagged unverified). Playwright-proven with real clicks: 13 headers in order, 76 rows, enriched cells live, Category/Released sorts (empties last), no h-scroll, zero console errors. | `js/tabs/references.js` · **`8.022`** |
| **References: Video/Image Models expansion (Research + scroll fix)** | OCR'd user screenshots of models + 3 research subagents: 41 new video models (35→76 rows, deduped, no dupes) + 27 new image models (24→51 rows). Real scroll fix: wide models cards are now flex columns with internally-scrolling bodies + sticky table headers (the earlier `overflow-y:auto`-on-workspace never engaged — the card shrank and clipped at 944px). Fixed 7 new image rows with `-` company (5 Flux → BLACK FOREST LABS, RealVisXL V3 + DreamShaper XL → SDXL COMMUNITY). Cache-busters (`?v=2`) on `references.css` + `references.js` imports. Playwright-proven with real clicks: 76 video rows / 51 image rows, ~4400px/~1400px in-card scroll travel, sorts, zero console errors (only pre-existing pool-thumb 404s + favicon). | `js/tabs/references.js` · `css/references.css` · `index.html` · `app.js` · **`8.021`** |
| **References: Video Models touch-up (Omni `-` + H3 highlight)** | Big Chart stays 35 rows: Omni Video Custom unknown cells (`native/sweet/max/dur/audio`) now render `-` (FL2V stays gray No, Audio falls back to amber ? badge); MiniMax H3 / Hailuo 03 gets the green highlight (`Top 2K/audio pick`, 4th highlighted row). No other rows/cols touched. Playwright-proven with real clicks: 35 rows, Omni `-` cells + No/? badges live, H3 `ref-highlight`, Max-Output re-sort, no h-scroll, zero console errors. | `js/tabs/references.js` · **`8.020`** |
| **Auto-add op outputs** | New Settings card `Op outputs` (Pools): master `Auto-add op outputs to Pool` (default off) + dependent sub-block visible only when on: `Also add to Sequence` (video-only, deduped) + `Auto-add image outputs to Image Pool`. Covers all Run results via one funnel (`displayOpResult` → `maybeAutoAddOpOutput`): Single-Clip Ops, Cut, Datamosh, Speed/RIFE, Convert, batch items. Dry runs/failures never add. Stitch + Quick keep their explicit always-add. 5 new tests, 112 total green. Playwright-proven with real clicks: master on→sub appears, reload persistence, real Cut Encode → pool 1296→1297 + sequence gains output — zero pageerrors (one transient pre-existing thumb 404). | `performance.py` · `app.js` · `tabs/settings.js` · `pool/auto-add-outputs.js` · `job-control.js` · `tests/test_auto_add_outputs.py` · **`8.019`** |
| **References: Video Models refresh (LTX 2.5 / Wan 2.2 / H3)** | Big Chart 30→35 rows: 6 stale LTX/Wan/Hailuo rows replaced with 11 cleaned rows from human data — LTX 2.5 Upsampler + 2.5 Distilled + 2.3 Distilled + 2.3 F2LF + 2 Turbo + 0.9.8 13B, Wan 2.2 Fast + I2V rCM + I2V LoRA, Omni Video Custom, MiniMax H3 / Hailuo 03. FL2V/audio badges mapped (leading Yes→yes, No→no, Unknown→?). Seedance/Vidu/Kling/Luma/Veo/Pixverse/Van Gogh/Real Motion rows untouched. Playwright-proven with real clicks: 35 rows render, Max-Output + Model sorts, F2LF double-green badges — zero pageerrors. | `js/tabs/references.js` · **`8.018`** |
| **Auto first/last** | New Settings toggle right after `Auto-add imports to Sequence` (default off): extracts `{stem}_first.png` / `{stem}_last.png` next to each video, skip-if-exists (never overwrites, no `_0001` siblings). Sub-controls appear only when on: exclusive `On pool import | On added to sequence` mode + `Batch process existing` button. Crash-safe backend (`export_frame_png(skip_if_exists)` stats first, ffmpeg → `.tmp.png` + atomic replace; stale tmp cleaned, failures return `ok:false` for retry). Delta-only triggers (new import paths / fresh sequence entries / explicit batch — no load/restore/render scan, session dedup, zero requests when off). Moved videos leave PNGs in place; re-import recreates at the new location. 7 new tests, 107 total green. Playwright-proven with real clicks: master on→sub appears, mode switch, batch fires, default-off reload hides sub — zero JS errors. HTTP-proven: create → `skipped:true` second call, settings roundtrip. | `performance.py` · `thumbnails.py` · `routes/media.py` · `app.js` · `tabs/settings.js` · `pool/auto-firstlast.js` · `pool/items.js` · `pool/sequence-composer.js` · `tests/test_auto_first_last.py` · **`8.017`** |
| **Skills tab (AI model skills)** | New top-level Workspace tab: upload single `.md`/`.txt`, paste text, or `.zip` bundle (`SKILL.md` + files, base64-in-JSON so no multipart dep). Model-assisted install via `POST /ops/skills_install` (Normalize default + Custom prompt, reuses `agents/` backends text-only; offline-tolerant fallback installs already-structured input as-is with `meta.warning`; same-name collision → `ok:false` + `meta.conflict` → UI `confirm()` → `overwrite:true`). Server store `~/.cache/mtapi/skills.json` + `skills/{id}/` (atomic writes, zip traversal/absolute members rejected, 200-skill / 200 KB / 5 MB caps), thin `GET/DELETE /api/skills*` reads. List (newest, search) + reader (file switcher) + one-click Copy + Export .md/.txt (bundle .txt concatenates). 21 new tests, 100 total green. Playwright-proven with real clicks: paste install, zip-via-file-input install, conflict-overwrite accept, Copy status, byte-identical .md download, separator-joined .txt download, Delete, reload persistence — zero JS errors. Fixed a real bug found by proof (Install button passed the click event as `overwrite:true`). | `skills-tab-spec.md` · `skills_store.py` · `skills_ops.py` · `routes/skills.py` · `tabs/skills.js` · `tests/test_skills.py` · **`8.016`** |
| **References: Video Models data (Van Gogh + Real Motion)** | Big Chart grows 18→30 rows: 3 Van Gogh Relax (Fast/Standard/HQ) + 9 Real Motion (3.5 Turbo highlighted top pick, 3.5, 3.1 Turbo, 3.1, 3.2, Turbo, 2.6, 3.2 Remix, 2.6 Remix). Audio badges from source data, True FL2V = ? (unconfirmed, needs human verify), Free-tier flag folded into Notes. Old conflated `Pixverse 6.0 / Real Motion 3.5 Turbo / Motion 2.0` row renamed to `Pixverse 6.0 / Motion 2.0` (Turbo now has its own row). Playwright-proven with real clicks, zero JS errors. | `js/tabs/references.js` · **`8.015`** |
| **Single-Clip Zoom / Pan op** | New `zoom` entry on the Single-Clip Ops dropdown + `POST /ops/zoom`: engine toggle (Stable Pillow lerp / Raw ffmpeg zoompan), 11 presets (in/out, targeted, Ken Burns, ease, punch, spiral, glitch, hue, custom), timing + live readout, auto still/video detect. 8 new tests, 79 total green. Playwright-proven (dropdown populates, zero new JS errors) + HTTP-proven (real MP4s, ffprobe counts, HTTP 200 + `ok:false` fails). | `zoom_ops.py` · `tabs/transmute.js` · `job-control.js` · `tests/test_zoom.py` · `singleclip-zoom-spec.md` |
| **References: Video Models sub-tab** | References now has two real sub-tabs, synced both ways: left nav (`YT Footage` / `Video Models`) + top segmented bar. The 5 dead decorative buttons are gone; YT cards unchanged under `refs`, new Big Chart (18 rows, one card/one table, no h-scroll at desktop width, amber LTX oversize warning, green `Your current model` / `wall crash debris` badges) under `refs-models`. Table defaults to Model A→Z, every column header click-sorts asc/desc (numeric-aware, empties last). Playwright-proven with real clicks, zero JS errors. | `index.html` · `app.js` · `js/tabs/references.js` · `css/references.css` · **`8.004`** |
| **References: Image Models sub-tab** | Third sub-tab under References (`refs-images`), exact same treatment as Video: one card/one table (24 rows: Company / Model / Native Training Res / Optimal Gen Res / Buckets / Notes), defaults to Company A→Z with Model tiebreak, all headers click-sortable via shared generic sort helpers. Playwright-proven (default/sort/desc/nav-sync), zero JS errors, no h-scroll. | `index.html` · `app.js` · `js/tabs/references.js` · **`8.005`** |
| **References: Coding Models sub-tab** | Fourth sub-tab under References (`refs-code`): one card/one table (7 rows: Model / Provider-Base / Context / Strengths / Weaknesses / Best For), defaults to Model A→Z with Provider tiebreak, all headers click-sortable via the same shared helpers. Muse Spark 1.3 row highlighted with green `Primary daily driver` badge. Playwright-proven, zero JS errors, no h-scroll. | `index.html` · `app.js` · `js/tabs/references.js` · **`8.006`** |
| **References: Coding Models data refresh** | Replaced with new 19-model dataset and new columns (Model / Provider / Context / Key Strengths / Avail. / Notes-Best For). Weaknesses column dropped per new data; Avail. markers (`*`/`+`/`*+`) rendered verbatim with a "as published" legend (no local definition yet). Muse Spark 1.3 keeps the highlighted `Top overall free pick` badge. Playwright-proven, zero JS errors, no h-scroll. | `js/tabs/references.js` · **`8.007`** |
| **References: Coding legend + recommendations** | Avail. legend now defined (`*` = free in OpenCode Zen, `+` = free via Kilo Gateway / OpenRouter free router, `*+` = both). New Quick Recommendations card under the table (overall / pure-coding / speed / multimodal / tiny-local) plus free-tier caveats callout. Playwright-proven, zero JS errors. | `js/tabs/references.js` · **`8.008`** |
| **References: True FL2V column (Video)** | New centered `True FL2V` column on the Video Models chart (between Duration and Notes), click-sortable (Yes → ? → No). Badges: green Yes (start+end), gray No (start-frame/T2V only), amber ? (unconfirmed) + legend. Best-effort values: Yes = Seedance Pro/2.x, Kling 2.x/3.0, Luma Ray2/3; No = LTX-Video, Wan 1.3B; ? = LTX 2.x, Wan 14B/2.2, Seedance Lite, Hailuo, Vidu, Veo 3, Pixverse — needs human verify. Playwright-proven, zero JS errors, no h-scroll. | `js/tabs/references.js` · **`8.009`** |
| **References: Video Audio/Strengths/Weaknesses** | Big Chart grows 7→10 cols, Notes stays last: new centered `Audio` badge column (Yes/?/No, same ordering as FL2V) + plain-text `Strengths` / `Weaknesses`, all click-sortable, additive only (existing rows/cols untouched). Legend covers both badge columns. Playwright-proven with real clicks (Video Models nav, Audio/Strengths/Weaknesses sorts), 18 rows, zero JS errors, no h-scroll at desktop width. | `js/tabs/references.js` · **`8.012`** |
| **Sequence split (god-file → 6 leaves + barrel)** | Former 2615-line `pool/sequence.js` is now a 10-line barrel re-exporting `sequence-model` (pool lookups/durations), `sequence-select` (hover/selection/focus frame), `sequence-variants` (TTL cache + static `fetchVariantsBatch` import + ORIG/RIFED menu), `sequence-rife` (density math + Instant queue/drain/hydrate + queue snapshot), `sequence-composer` (dropzone/CRUD/token render), `sequence-transport` (preview playback + clip time settings + list-keys). Deleted dead `_maybeAutoRifeForPath`; fixed mid-file + dynamic imports. All 6 existing importers (`app.js`, `grid.js`, `items.js`, `persistence.js`, `preview.js`, `jobs.js`) untouched. Playwright-proven with real clicks: Sequence nav, ▶ play (advanced 2/340), RIFED variant fetch, Jobs tab — zero new JS errors (only pre-existing thumb 404s). | `js/pool/sequence*.js` · **`8.011`** |
| **Tab scroll memory (session-only)** | Clicking away from any tab and back restores its scroll position — per-tab, in-memory. New vanilla module (`js/ui/tab-scroll.js`) saves outer `#actionPanel` + `#actionPanelForm` + pool grid wrap (`#poolGridWrap`/`#imgPoolGridWrap`) scrollTops on every scroll (capture-phase, rAF-throttled) and on `switchTab` leave, restores on return via double-rAF (falls back to desk `gridScrollTop` for pool tabs on first visit). Playwright-proven with real nav clicks: Sequence 600→away→600, Pool own 200, Speed outer 400→away→400; zero new JS errors. | `app.js` · `js/ui/tab-scroll.js` |
| **Tab scroll memory (cross-session)** | Same per-tab positions now survive reload / browser restart via browser-only `localStorage` key `mtapi_tab_scroll` (`{ v, tabs }`, never into named projects or server snapshot — same class as prompt library / nav collapse). Writes throttled 400 ms + flushed on `switchTab` leave, `pagehide`, and hidden-tab; map seeded before first `switchTab`. Restore hardened with retries (double-rAF, +200 ms, +600 ms) so late layout (virtual-grid sync, images) converges instead of clamping to 0. Playwright-proven with real clicks: Speed outer switch 214→214, reload 214→214, Pool grid switch + reload 200→200, Speed intact after visiting other tabs; zero pageerrors. | `js/ui/tab-scroll.js` · `app.js` · **`8.014`** |
| **Comma-safe join/grid** | Fixed a delimiter collision: `/ops/join` + `/ops/grid` comma-joined multi-input and bash `collect_inputs()` split on `IFS=','`, so a clip whose own filename contained a comma got truncated → `No such file or directory`. Join target-less path now uses pure-Python `concat_clips` + remux; new pure-Python `grid_clips` (xstack) handles grid; both bash `transmute`+`bin/transmute` now detect comma-in-path and exit loudly. 6 new tests (`tests/test_join_comma.py`), 70 total green. | `transmute_ops.py` · `video_pipeline.py` · `transmute` · `bin/transmute` · `tests/test_join_comma.py` · **`8.002`** |
| **Final-encode fixes** | Shared final-render engine hardened (`app/video_pipeline.py` `encode`/`_build_encode_argv`). **1)** `encode()` now verifies the output file exists & is non-empty (`_ensure_output_file`) — no more "runs but makes nothing" on silent ffmpeg exit 0. **2)** Legacy frame-op encodes (RIFE/speed/recohere/cut) auto-pad odd chroma-subsampled dims (`yuv420p`) instead of crashing on "width not divisible by 2". **3)** `-shortest` no longer trims generated RIFE'd frames to the source-audio length by default; new `clamp_to_audio` opt-in keeps exact length-matched mux for `cut`. 9 new tests (`tests/test_encode.py`), 64 total green. | `app/video_pipeline.py` · `app/operations/cut_ops.py` · `tests/test_encode.py` · **`8.001`** |
| **8.000 release** | Full point release — every 7.x ship since `7.000` lands on `main`: **Flip / Rotate** (7.017), **Clearable inputs** (7.016), **Keep the Change** (7.015), **Unified Speed & Time** (7.014), **Visual Hijack + Mosh-ups** (7.013, `datamosh_hijack`), **Stable Fluids** (7.011), **QR Art Illusion** (7.009), **Settings chrome** (7.008), **Live VERSION** (7.007), **docs diet/slim** (7.006/7.004), **FastSAM multimodel Partial** (7.002). 55 reployed tests green; Playwright-proven on both new tabs. | `docs/archive/changelog.md` · **`8.000`** |
| **Flip / Rotate** | Lossless geometry on both the **Single-Clip Ops** dropdown and the **Image Edit** ops stack. One parameterized op (`flip_rotate`) with a shared 6-mode vocabulary (90°-step rotation cw/ccw, hflip/vflip, diagonal `hflip+rotate_90`) driven by one shared builder after the `FLIP_ROTATE_MODES` pattern — same modes on both tabs. Video: new `-R MODE` flag on `transmute` + `bin/transmute` (composes with -c/-b/-s/-S/-z/-x/-r, audio copy), new `/ops/flip_rotate`. ImageEdit: `flip_rotate` stack op implemented on all three engines (ffmpeg `transpose`/`hflip`/`vflip`, ImageMagick `-rotate`/`-flop`/`-flip`, Pillow `Image.Transpose`) — verified pixel-identical across engines. Playwright-proven on both tabs (real clip rotated+flipped, real image vflip through the UI). New `tests/test_fliprotate.py` (5 tests: CLI filter/suffix + dim swap + bad-mode, registry contract, all 3 image engines × all 6 modes). | `transmute` · `bin/transmute` · `transmute_ops.py` · `imageedit_ops.py` · `tabs/transmute.js` · `tabs/imageedit.js` · `utils.js` · `job-control.js` · **`7.017`** |
| **Clearable inputs** | A red ✕ now comes with any populated text box. Portable module (`js/ui/clearable.js` + `css/clearable.css`): drop `data-clearable` on an `<input>`/`<textarea>` and it auto-wires — one attribute, zero JS. ✕ appears only when the field holds content, clears on click (fires `input` + `change` so global sync / probe / form-state keep working), restores focus; values set programmatically (e.g. desk restore, file browser) are picked up via a 250 ms self-sync poller, and a MutationObserver upgrades dynamically rendered forms. Wired on the four global inputs (Video/Image/**Path in**/**Path out**) where the ✕ actually clears the box now; the old misleading ❌ “not used by this tab” status glyph (read as a dead clear button) is gone. Playwright-proven: ✕ appears⇄clears on real typed/picked values, panel un-populates, quick buttons deactivate. **Roll-out to every existing text box is a systematic follow-up.** | `app/static/js/ui/clearable.js` · `app/static/css/clearable.css` · **`7.016`** |
| **Unified Speed: Keep the Change** | RIFE **Free** overage is now spendable: `keep_extra` **trim** (drop `G−R`, exact — default), **fps** (encode all `G` inside target duration, rate rises to `G/T`), **length** (encode all at the output rate, duration stretches to `G/F`, effective speed recomputed). `keep_extra='fps'` is rejected when `target_fps` is pinned (validator + UI: the FPS raise button is disabled while Output FPS is Auto·Match). Speed tab rebuilt to per-variable **Control/Auto** (Multiplier ⇄ Length; auto row shows the derived value live and is inert), Keep the Change segmented row, and live readout notes (`dropping N → target`, `encode all @ FPS`, `encode all → duration`). Frontend `resolveUsPlan` mirrors backend 1:1 again. 5 new tests (16 speed plan/execute/validator); Playwright-proven on real clip: 0.3× Free ⇒ 140 generated / 117 target / drop 23; fps ⇒ `encode all @ 28.8 FPS`; length ⇒ `encode all → 5.83s`; dry-run payload carries `keep_extra` and backend accepts it. | `app/operations/speedchange_ops.py` · `app/static/js/tabs/speedchange.js` · `app/static/css/forms.css` · `unified-speed-tab-spec.md` · **`7.015`** |
| **Unified Speed & Time** | Speed factor is now a single deterministic model: per-frame FPS is locked to source, `T = D/S`, `R = T×F`. Target Mode = **Length** (exact output duration, speed derived) or **Multiplier** (exact speed factor). Optional RIFE with **Snap** (speed locks to `1/M`, zero extra frames) or **Free** (next M with `G=N×M ≥ R`, extra frames dropped by a conforming encode). Replaces the old Speed + RIFE Slo-Mo split and fixes the wrong final-duration estimate (e.g. 4s @ 0.5× now reports 8.00s, not 2.6s). UI readout mirrors backend `resolve_speed_plan` 1:1, live in Multiplier/Length/RIFE-Snap/Free. Fast path pure ffmpeg `setpts`+`fps`+`atempo`; RIFE path dump→×M→conform→encode@F. 13 backend unit tests; Playwright proof on real testsrc (RIFE 0.5× snap → exactly 4.000s / 96 frames @ 24fps; fast 2× → 24 frames; readout 0.3× Free ⇒ 400 target / 480 generated / overshoot 80). | `app/operations/speedchange_ops.py` · `app/static/js/tabs/speedchange.js` · `unified-speed-tab-spec.md` · **`7.014`** |
| **Visual Hijack / Mosh-up** | Motion-vector payload injection. Full pipeline in `app/operations/datamosh/common.py` (`_execute_hijack_pipeline`) + handler (`hijack.py`). Register `datamosh_hijack` op with `inject_mode` (file/frame/video/shuffle), `start_frame`, `end_frame`, `transition_style` (smear/freeze), `mv_multiplier`. CLI `-H IMG:START:END[:STYLE]` in both `transmute` and `bin/transmute`. `visualhijack` per_frame filter registered in `app/filters/`. 9 unit tests + 4 POC validation tests passing. Zero decoder errors, zero green pixels, frame count preserved. Mosh-ups implemented from Parker Higgins' multiple video sources technique. | `app/operations/datamosh/hijack.py` · `app/operations/datamosh/common.py` · `app/filters/visualhijack.py` · **`7.013`** |
| **FastSAM multimodel** | Phase 1 (FastSAM-s/x) shipped in `ac25a60`. Phase 2 (SAM ViT-L/H) still deferred. | `fastsam-sam-multimodel-spec.md` · **`7.002` Partial** |
| **Stable Fluids sim** | Phase 1 (self-host + iframe + Record) **+ Phase 2 pure WebGPU port** (advect / pressure / project) **+ Phase 3 seed-image injection** (dedicated path or first Image Pool still). Mode toggle in the tab; Record shared across modes. | `stablefluids-sim-spec.md` · **`7.011`** |
| **QR Art Illusion** | Two stills, no QR Data. Same worker. Mode switch on QR tab. | `qr-illusion-art-spec.md` · **`7.009`** |
| **Settings chrome** | No page title / knob how-to. Cards start immediately. | **`7.008`** |
| **Live VERSION** | One file (`VERSION`). WebUI brand reads `/health`. STATUS does not restate the digits. | **`7.007`** |
| **Docs STATUS diet** | STATUS is now a map; diary moved to changelog. | **`7.006`** |
| **Docs slim pass 3** | Prompts, legacy renaming, and sequence spec cleanup. | **`7.004`** |

**Next:** human names the next job.

**Ready to build (spec written, not shipped):**
- **Python Environment card (uv)** — Settings card listing every dependency (required vs installed, Missing/Update/Extra/Protected), checkboxes + mass **Install/Upgrade/Remove** via `uv` through the existing op/job machinery. Spec: `docs/venv-deps-card-spec.md`.
- **Settings Media Import card + auto-reencode VFR** — first Settings card (moved import switches + `Auto-reencode VFR to CFR` master with FPS sub-block, pool batch); detect-gated, replace semantics, no new endpoint. Spec: `docs/settings-media-import-spec.md`.

---

## 1. Product in one paragraph

**ffTransmuteWebui** = bash `transmute` / datamosh + **mtapi** FastAPI (`:24590`) + vanilla SPA. Frame effects: **filter platform** (`dump → app/filters/* → encode`). Dual pools: **Video** (`items[]`) + **Image** (`images[]`). Jobs: `/tmp/mtapi_jobs/{id}/` + `job_control`. OpenVINO (FastSD GPU): img2img, txt2img, agent vision/prompts, RIFE recoherence. **Prompt Library** saves ± pairs in `localStorage` across SD tabs.

---

## 2. Agent roles (short)

Hats for a turn. The human names the owner in the prompt — not a permanent roster.

| Role | Edits | Deliverable |
|------|-------|-------------|
| Spec writer | `docs/**` only | Specs / STATUS — **no** app code |
| Builder | code + docs | Working feature; WebUI smoke |
| Reviewer | reports | Diff vs spec |

Prefer **STATUS + as-built specs** over backlog drafts. Filter platform only for frame effects. VERSION: far-right `DD` per feature.

---

## 3. Shipped (stable)

| Area | Now | Spec / code |
|------|-----|-------------|
| Filter platform | dump → `app/filters/*` → encode. No second dump/encode stack. | `filter-platform-spec.md` |
| Convert / Export | codecs, `frames_*`, GIF | `convert_ops.py`, `convert_presets.py` |
| Transmute / datamosh | geometry CLI + file-level glitch | `transmute_ops.py`, `operations/datamosh/` |
| Neural / frame ops | deepdream, withoutbg, style, facemorph, img2img, txt2img, upscale, qr_art (QR + Illusion), FastSAM-s/x (Phase 1) | `*_ops` + `filters/` |
| RIFE | directory stage; multiplier **2–128**; recohere (2 stills → M=2 → img2img every mid, keep all) | `filters/rife.py`, `rife-recoherence-spec.md` |
| Speed | uniform + PNG ramp; optional RIFE | `speedchange_ops.py`, `speedramp_ops.py` |
| Dual pools + Cut | Video `items[]` vs Image `images[]`. Cut = global Video + frame range + encode. | `video-image-pools-spec.md` |
| Pool wall | one prepared JPEG (first\|last combo default); stable `<img>`; never clear `src` | `pool-wall-preview-spec.md` |
| Sequence / Join | stitch; codec export (file→file for DNxHR/ProRes); Instant RIFE; variants; total time | `sequence_*.md` under `docs/` |
| Catalog | server-resident index + virtualizer (chrome recycle; wall tenants stay) | `server-memory-catalog-spec.md` |
| Jobs / progress | in-memory FIFO; live preview; dir watch on frame writers | `job_queue.py`, `workspace-progress-spec.md` |
| Persistence | desk snapshot; if a named project is open, pool saves write that file too. Session autosave never overwrites a named file on its own | `universal-persistence-spec.md` |
| Agent + Prompt Library | CLI/HTTP vision; ± pairs in `localStorage` | `agent-vision-tab-spec.md`, `prompt-library-spec.md` |

**Active ops (registry):** transmute, convert, pipeline, datamosh, deepdream, facemorph, withoutbg, fastsam, style, rife, **rife_recohere**, speedchange, speedramp, zoompan, imagesort, img2img, txt2img, agent, upscale, **qr_art** *(in tree — see §4)*.
---

## 4. Partial / in progress (do not mark done)

| Area | Status | Next |
|------|--------|------|
| **Catalog virtualization** | Hover/queues/Image+Video virt in `5.37` | Headed vsync 16.6ms compositor p95 — `catalog-interaction-virtualization-spec.md` |
| **Workspace progress** | RIFE + **dump dir watch** in tree | multi-phase remaining ETA polish — `workspace-progress-spec.md` |
| **Tool bottom docs** | Several tabs have blocks; not universal | Finish roll-out — `tool-bottom-docs-spec.md` |
| **UI list / sequence keys** | Sequence L/R + scroll-into-view **shipped `4.64`**; some pool edge cases may remain | `ui-list-nav-timer-spec.md` |
| **Agent polish** | Phase A+API shipped | Streaming, Image Pool send-to, Ollama, multi-tool loop |
| Image Sort true TSP | Out of scope | Chain is greedy only |


---

## 5. Roadmap — specs still to implement

Build **only when human prioritizes.** Suggested order in §8.

### 5.1 Priority queue (cleaned specs)

| # | Spec | Intent | Notes |
|---|------|--------|--------|
| 1 | Finish remaining §4 partials | Daily UX + headed 16.6ms compositor p95 + verify upscale | Catalog index shipped `5.38` |
| 4 | [tilagup-mtapi-mode-spec.md](tilagup-mtapi-mode-spec.md) | Multi-step agent tiled SD | Sibling `/home/m/snc/cod/tilagup` |
| 5 | [image-quality-rating-spec.md](image-quality-rating-spec.md) | Pool tech/aesthetic scores | **Fix pool normalize first** |
| 6 | [fastsam-sam-multimodel-spec.md](fastsam-sam-multimodel-spec.md) | **FastSAM + SAM multimodel selector** — stronger backends (FastSAM-x, SAM ViT-L/H) | Phase 1 shipped, Phase 2 deferred (not ready for builder). |
| 7 | [performance-settings-spec.md](performance-settings-spec.md) | Performance settings tab, thumbnail resolution, and RAM cache prefs | **Proposed** — budget setting later |


### 5.2 Recently shipped (orientation)

Version diary: [archive/changelog.md](archive/changelog.md).

### 5.3 Research (not a solo build ticket)

| Spec | Intent |
|------|--------|
| [fastsdcpu-upscalers-spec.md](fastsdcpu-upscalers-spec.md) | FastSD upscale catalog (Intel) |
| [amused-openvino-spec.md](amused-openvino-spec.md) | aMUSEd txt2img OpenVINO (proposed) |

### 5.4 Other open product specs (top-level)

| Spec | Intent |
|------|--------|
| [unified-speed-tab-spec.md](unified-speed-tab-spec.md) | **Unified Speed & Time Tab** — UI redesign for deterministic time manipulation, consolidating Speed and RIFE. |
| [audio-analysis-spec.md](audio-analysis-spec.md) | BPM / key / analysis |
| [automation-spec-legacy.md](automation-spec-legacy.md) / [parameter-automation-spec.md](parameter-automation-spec.md) | Parameter envelopes |
| [dynamic-mixing-spec.md](dynamic-mixing-spec.md) | Dynamic mix |
| [model-manager-spec.md](model-manager-spec.md) | Model manager UI |
| [frame-scrubber-spec.md](frame-scrubber-spec.md) / [frame-range-spec.md](frame-range-spec.md) | Scrubber / range (partial surface exists) |
| [sequencer-mvp-spec.md](sequencer-mvp-spec.md) / [seq-proportional-spec.md](seq-proportional-spec.md) | Sequencer |
| [pool-toggle-spec.md](pool-toggle-spec.md) | Pool toggles |
| [qr-illusion-art-spec.md](qr-illusion-art-spec.md) §0 | **Illusion mode** — pattern still + appearance still; no QR Data. Spec locked. Builder: [coder-qr-illusion-prompt.md](coder-qr-illusion-prompt.md). |


### 5.5 Backlog ops (`docs/backlog/*`) — not implemented

~28 draft ops. Prefer cleaned top-level specs when both exist. **Human priority only.**

| Spec | Intent |
|------|--------|
| [upscale-spec.md](backlog/upscale-spec.md) | NCNN Real-ESRGAN / SRMD — **code may be partial in tree** |
| [swinir-spec.md](backlog/swinir-spec.md) | Denoise/deblur |
| [sd-tiled-upscale-spec-legacy.md](backlog/sd-tiled-upscale-spec-legacy.md) | **Legacy** → tilagup-mtapi |
| [depthmap-spec.md](backlog/depthmap-spec.md) | MiDaS depth |
| [opticalflow-spec.md](backlog/opticalflow-spec.md) | Flow maps |
| [facerestore-spec.md](backlog/facerestore-spec.md) | CodeFormer |
| [colorize-spec.md](backlog/colorize-spec.md) | DDColor |
| [inpaint-spec.md](backlog/inpaint-spec.md) | Generative inpaint |
| [latentmorph-spec.md](backlog/latentmorph-spec.md) | Latent interp |
| [lineart-spec.md](backlog/lineart-spec.md) | Line art |
| [slitscan-spec.md](backlog/slitscan-spec.md) | Slit-scan |
| [videoecho-spec.md](backlog/videoecho-spec.md) | Video echo |
| [glitch-spec.md](backlog/glitch-spec.md) / [ffglitch-spec.md](backlog/ffglitch-spec.md) | Databend / broader glitch |
| [codecview-spec.md](backlog/codecview-spec.md) | Codec MV overlay |
| [lut-spec.md](backlog/lut-spec.md) | LUT grade |
| [ascii-spec.md](backlog/ascii-spec.md) | ASCII render |
| [vqgan-spec.md](backlog/vqgan-spec.md) | VQGAN |
| [timelapse-spec.md](backlog/timelapse-spec.md) | Timelapse |
| [audioproc-spec.md](backlog/audioproc-spec.md) / [audiowave-spec.md](backlog/audiowave-spec.md) / [audio-reactive-spec.md](backlog/audio-reactive-spec.md) | Audio suite |
| [analyzetag-spec.md](backlog/analyzetag-spec.md) | Analyze tag songs |
| [mediaexport-spec.md](backlog/mediaexport-spec.md) | Palette / export |
| [civitai-spec.md](backlog/civitai-spec.md) | CivitAI cloud |
| [telemetry-spec.md](backlog/telemetry-spec.md) | Telemetry / WS |
| [global-inputs-spec-legacy.md](backlog/global-inputs-spec-legacy.md) / [global-media-ui-spec-legacy.md](backlog/global-media-ui-spec-legacy.md) | Mostly superseded by dual pools |

`coder-*-prompt.md` files = kickoff text only.

---

## 6. Known bugs / product debt

2. **List reorder** jumps scroll to top.  
3. **Arrows** scroll page outside wired list tabs.  
5. **High RIFE M** × large K = huge jobs; no soft warn.  
6. Pool **normalize strips unknown fields** — blocks quality rating.  
7. Large **uncommitted** tree risk — `git status` before ship/push.  
8. **Speed tab RIFE ≈10× slower than Sequence Instant RIFE** (unresolved). Same clip/workflow — 4–6 s, 720×720–1080×1080, TTA on, interpolate to 60 fps — normally ~2–3 min, Speed tab ~17 min. Both paths call the identical `run_rife_directory` (`rife_ops.py` vs `speedchange_ops.py`) with identical flags and matching multiplier math, so no code path found yet; candidates: real M/length mismatch between tabs, TTA path, or Sequence reusing cached variant, none confirmed. Troubleshooting deferred.


---

## 7. VERSION & runtime

- **Current:** root `VERSION` (FastAPI `/health` and the WebUI brand read it). Diary: `docs/archive/changelog.md`.
- Secrets: `~/.secrets` at startup.
- Server: `cd mtapi-project && .venv/bin/python run.py` → `http://localhost:24590/`
- Jobs: `~/.cache/mtapi/jobs` (override `MTAPI_JOBS_ROOT`)
- FastSD: `MTAPI_FASTSD_ROOT` (img2img / txt2img / recohere)
- RIFE: `rife-ncnn-vulkan` on PATH
- Prompt library: browser `localStorage` key `mtapi_prompt_library`
- NCNN bins: may live under `mtapi-project/bin/`

---

## 8. Suggested build order (roadmap)

1. Close remaining §4 partials (list/sequence keys, progress polish, tool-docs, headed 16.6ms compositor).  
3. **Product choice:** quality rating *or* tilagup mode.  
4. Agent polish (streaming / Ollama) when vision UX needs it.  
5. Explicit backlog picks only (depth, flow, facerestore, …).


---

## 9. Doc maintenance

On ship: bump root `VERSION` → update **this file** (top box + §3/§4 if the map changed) → update spec banner. Do not paste the version digits into this file.

**STATUS wins** when it disagrees with a stale backlog draft.
