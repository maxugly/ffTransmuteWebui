# Watermark tab (Clean section) — Spec

> **Status**: Spec only. Builder follows this when implementing.
> **Hat**: Spec writer. This document + STATUS queue entry only — no app code.
> **Upstream**: `GargantuaX/gemini-watermark-remover` (`@pilio/gemini-watermark-remover`), MIT. First engine of many: the tab is the home for all watermark / metadata / fingerprint work.
> **Drives**: `VERSION` bump on ship (far-right DD) + STATUS top box + changelog entry.

---

## 1. Problem & intent

AI-generated stills and clips arrive carrying visible watermarks (Gemini bottom-right logo incl. Nano Banana variants today, other vendors tomorrow), plus EXIF/XMP metadata and invisible fingerprint/synthetic-media signals (e.g. SynthID). There is no place in the WebUI to clean or inspect any of that.

**Goal**: a new top-level nav section **`Clean`** with a first tab **`Watermark`** that:

1. Removes Gemini visible watermarks via a vendored copy of `gemini-watermark-remover` (reverse alpha blending — mathematically exact, not inpainting).
2. Reports detection (found / tier / box) without writing files.
3. Inspects and strips container metadata (EXIF/XMP-ish, container tags) with tools already on box.
4. Is an **extensible engine shell**: engine #2+ (general-AI remover, fingerprint scrub, …) plugs into the same dropdown + op params without new nav.

**Explicitly not in V1**: removing invisible/steganographic watermarks (SynthID — detect/report only, never claim removal), the hosted `pilio.ai` server-side pipeline (different product that uploads; we use the open-source local path only), browser-side canvas processing (backend shells the vendored CLI; the SPA stays vanilla with no npm).

---

## 2. Upstream facts (pin at build time)

Source: `https://github.com/GargantuaX/gemini-watermark-remover` (README + `package.json` + CLI docs). Builder re-verifies the tag before vendoring.

- License **MIT** (port of Allen Kuo `allenk/GeminiWatermarkTool` ©2024 MIT reverse-alpha method + calibrated masks).
- Package `@pilio/gemini-watermark-remover`, ESM-only (`type: module`), `bin: { gwr: ./bin/gwr.mjs }`. Runtime **Node 18+**, `pnpm`, Windows/macOS/Linux, no GPU, no external service on the local path.
- Deps: `mediabunny` (video mux/encode path); `sharp ^0.34.5 || ^0.35.0` as **optional peer** — required only for the CLI file decode/encode path, **not** for browser/`ImageData` SDK use.
- CLI has **one command**: `gwr remove <input> [--output <file> | --out-dir <dir>] [--overwrite] [--json]` plus video `--video-bitrate-mbps <n>` (default **calibrated 12 Mbps AVC profile**; quality-sensitive sources override, e.g. `20`) and `--video-timeout-ms <ms>` (**inactivity** timeout — an export may run longer while frames keep advancing; frame progress goes to **stderr**).
- Output format inferred from extension (`.png/.jpg/.jpeg/.webp` for images; video auto-detects `.mp4/.webm/.mov` and requires an explicit video output path).
- SDK (advanced/internal, **not** the V1 entry): `createWatermarkEngine` (reuse one engine so alpha maps stay cached across a batch), `removeWatermarkFromImageData{,Sync}`, `removeWatermarkFromImage`, node `removeWatermarkFromBuffer` with caller-injected decoder/encoder.
- Math: `watermarked = α·logo + (1−α)·original` → `original = (watermarked − α·logo) / (1−α)`, alpha map captured from a known solid background.
- Detection pipeline: size-catalog lookup → local anchor search → restoration validation. Catalog defaults: large outputs `96×96, margins 64px`; small outputs `48×48, margins 32px`.
- Limits (must appear verbatim-ish in the tab disclaimer): **visible bottom-right logo only**; **does not remove invisible/steganographic watermarks (no SynthID)**; fails/skips on cropped/repainted/heavily recompressed or unknown Gemini formats; validated against the Gemini pattern "through April 2026"; disable canvas-fingerprint-defender extensions (upstream issue #3).

---

## 3. Scope

**In (V1)**:

- `Clean` nav section + `Watermark` tab wired like every other tab (global inputs, Run/Queue, pool auto-add).
- Engine dropdown with `gemini-reverse-alpha` enabled and named disabled placeholders (`general-ai`, `synthid-detect`) so engine #2 needs no nav or contract change.
- `POST /ops/watermark_remove` (image + video, file-to-file via vendored `gwr` CLI).
- `POST /ops/watermark_detect` (read-only decision-tier readout, no file written).
- `POST /ops/metadata_inspect` (read-only EXIF/container tag readout) + `POST /ops/metadata_strip` (tag-stripped copy).
- `GET /api/watermark/status` + `POST /ops/watermark_setup` driving a **tab-local installer card** (vendored clone present/version, node, sharp/pnpm state, Install/Update + Refresh).
- Legal/limits disclaimer block on the tab.

**Out (follow-ups, named in UI as disabled, not built)**:

- Engine #2 (general-AI remover, e.g. hosted or local inpainting) — dropdown placeholder only.
- SynthID / invisible-fingerprint removal — `synthid-detect` placeholder is **report-only by design**; the spec forbids claiming removal.
- Browser-side canvas removal inside the SPA (no npm, no bundler — invariant 7).
- `uv pip sync`-style destructive resync of the vendored dir; ad-hoc version picker beyond the pinned tag.

---

## 4. Install model — vendored clone (human decision)

- Vendor path: `mtapi-project/tools/gemini-watermark-remover/` — a `git clone --depth 1 --branch <pinned-tag>` of upstream. The spec records the tag; the builder records the resolved commit hash in the status payload and the ship notes. `node_modules` stays inside the vendored dir. Never under `mtapi-project/junk/` (invariant 8: junk is throwaways/weights/screenshots).
- JS deps inside the vendored dir install with the manager that is present (`pnpm install --prod` preferred, `npm install --production` fallback) — needed for `mediabunny` and the optional-peer `sharp` on the CLI file path.
- Backend resolves the entrypoint as an **absolute path**: `<repo>/mtapi-project/tools/gemini-watermark-remover/bin/gwr.mjs`, invoked as `["node", <gwr>, "remove", …]` via `app.shell.run_command` (argv list, never `shell=True`; nothing in `main.py` — invariant 2). Node itself resolves via `shutil.which("node")`.
- Missing pieces fail **at use**, not at boot (same posture as ffmpeg): `check_tools()` in `app/shell.py` gains warn-only `node` (+ optional `pnpm/npm`) rows; every op handler re-checks and returns HTTP 200 + `{"ok": false, "error": "node not found on PATH — …"}` (invariant 10).

---

## 5. Backend contract

New module `app/operations/watermark_ops.py`, one import line in `app/operations/__init__.py` (registry populates by side effect; `main.py` builds `POST /ops/{id}` from `REGISTRY` with the existing `X-Job-Token` / single-flight path — no `main.py` logic changes). Status route lives in new `app/routes/watermark.py` (tag `meta`), included from `main.py` next to the other `*.register(app)` lines.

### 5.1 `POST /ops/watermark_remove`

Params (`pydantic.BaseModel`):

```json
{
  "input_path": "/abs/in.png",
  "output_path": "/abs/out.png | null",
  "out_dir": "/abs/dir | null",
  "overwrite": false,
  "engine": "gemini-reverse-alpha",
  "video_bitrate_mbps": 12,
  "video_timeout_ms": null,
  "dry_run": false
}
```

Validation (fail = `OperationResult(ok=False, error=…)`, never HTTP 4xx):

- `input_path` absolute + exists; `engine` must be the V1 literal (`general-ai` / `synthid-detect` → `ok:false, error="engine '…' not installed yet"`).
- `output_path` and `out_dir` mutually exclusive; defaults: image → sibling `<stem>_clean.<same ext>`; video (by extension, reuse `shell.ensure_video_output_path`) → sibling `<stem>_clean.mp4`.
- `video_bitrate_mbps` in `4–40`; `video_timeout_ms` null or positive int; `overwrite=false` + existing target → `ok:false` naming the file (no silent clobber).

Execution:

- Pre-checks: node on PATH, `bin/gwr.mjs` present + executable, else `ok:false` with the tab-installer hint.
- argv: `["node", GWR, "remove", in, "--output", out, "--json"]` + `["--overwrite"]` iff true + `["--video-bitrate-mbps", str(n)]` for video inputs + `["--video-timeout-ms", str(ms)]` iff set. (Directory input: loop one argv per file with `report_progress` per item — invariant 9.)
- Dry-run: return `ok:true, output_path:null, command:<argv str>, meta.dry_run=true` without spawning.
- Result: parse `--json` stdout for `applied / decisionTier` into `meta`; `command` echoes the argv; `output_path` absolute; verify the file exists + non-empty before `ok:true` (same `_ensure_output_file` posture as the shared encode engine). Video stderr progress already streams to the `mtapi` logger via `run_command`. `job_control.check_cancelled()` between files in batch mode.
- This op is **file-to-file, not filter-platform**: no dump → `app/filters/*` → encode involvement (invariant 1 untouched). Pixel-integrity flags (`-c/-b/-x`) do not apply.

### 5.2 `POST /ops/watermark_detect`

```json
{ "input_path": "/abs/in.png", "engine": "gemini-reverse-alpha" }
```

Read-only. Same pre-checks; runs the probe path (`--json` decision tier, no `--output`) and returns `meta: { watermark_found: bool, tier, box }`. Writes nothing. Powers the tab's Detect readout row.

### 5.3 `POST /ops/metadata_inspect` / `POST /ops/metadata_strip`

Inspect is read-only: `{ input_path }` → `meta.tags` readout assembled from **already-on-box** sources only — `ffprobe` show_format/streams + Pillow `Image.info/exif` (+ `exiftool` only if already on PATH; builder confirms at build time and documents which source answered). No new Python dep in V1.

Strip writes a tag-cleaned copy: `{ input_path, output_path?, overwrite=false, dry_run=false }`. Video: remux with `-map_metadata -1` (stream copy, no re-encode); image: Pillow re-save without EXIF (format from extension, quality preserved where applicable). Same default-naming (`*_clean`), overwrite, dry-run, and exists+non-empty-verify rules as §5.1. Failures are `ok:false` (invariant 10).

### 5.4 `GET /api/watermark/status` + `POST /ops/watermark_setup`

Status (read-only, no subprocess beyond `node --version` best-effort):

```json
{
  "ok": true,
  "node": { "found": true, "version": "v22.x" },
  "gwr": { "present": true, "tag": "v1.0.43", "commit": "abc1234" },
  "sharp": { "present": true },
  "pm": { "pnpm": true, "npm": true }
}
```

Setup (`{ action: "install" | "update", dry_run }`): clone at the pinned tag if absent, else `git fetch --tags` + checkout pinned tag; then prod-install JS deps with the available manager; one `report_progress` per phase; cancel-safe between phases; always ends with a fresh status payload in `meta` plus `recommend_restart: false` (Node sidecar needs no server restart). `dry_run` prints the would-be argv list and changes nothing.

---

## 6. Frontend — `js/tabs/watermark.js` + nav wiring

Vanilla HTML/CSS/ES modules only (invariant 7). Reuse `knobUnitHtml`/`setupBinaryKnob`/`setupContinuousKnob`, `bestInput()`, `openFileBrowser`, `runOpWithCancel`/`displayOpResult`, `maybeAutoAddOpOutput`, `data-clearable`, and the `tool-docs` bottom block — zero new infra.

1. **Nav** (`index.html`): new `<div class="nav-section" data-section="clean">` (header `Clean`, e.g. sparkle/brush SVG) with first `<div class="nav-item" data-tab="watermark">Watermark</div>`, placed after `transmute`, before `scripts` (keeps destructive/pipeline ops grouped, cleanup ops adjacent to runners).
2. **`app.js`**: import `renderWatermarkForm`; `TAB_ACCEPTS.watermark = 'any'`; **not** added to `FRAME_RANGE_TABS` (no frame range on this tab); `switchTab` title/body-class branch + `renderTabForm` branch; `job-control.js resolveActiveOpAndBody` maps active tab → `watermark_remove` + `collectWatermarkBody()`.
3. **Form** (`renderWatermarkForm`):
   - Title/desc + upstream link + legal/limits paragraph (§2 last bullet, short).
   - Installer card (status wiring §5.4): one-line version readout + Install/Update + Refresh; busy disables the card; note when `sharp` is missing (CLI file path needs it; detect still fine).
   - Engine `<select>`: `gemini-reverse-alpha` + disabled `general-ai (planned)`, `synthid-detect (report-only, planned)`.
   - Global-input reminder (read-only current `bestInput()`), output-dir row + Browse, knobs: Overwrite (binary), Dry run (binary), bitrate (continuous 4–40 step 0.5 default 12, video only — disabled hint on images), timeout (text, blank = default).
   - Buttons: **Remove** (primary → `watermark_remove`), **Detect** (secondary → `watermark_detect`, inline readout, no preview/pool), **Inspect** / **Strip metadata** (secondary row → §5.3).
   - `tool-docs` block: what reverse-alpha is, what it can't do (SynthID), bitrate/timeout semantics, where vendored code lives + pinned tag.
4. **Run flow**: standard `setRunUiBusy(true)` → `runOpWithCancel` → `displayOpResult` (console `[RESULT/COMMAND/STDOUT/STDERR]`, preview on file outputs) → `maybeAutoAddOpOutput` for file outputs only (Detect/Inspect never touch pools — invariant 5 Dual-pools behavior unchanged). Cancel via `abortMainJob` → `POST /api/cancel`.

---

## 7. Test plan

**Unit (`tests/test_watermark.py`)**: argv builder (image vs video flags, `--overwrite/--json/--video-bitrate-mbps/--video-timeout-ms`, exactly-one of output/out-dir); validation matrix (missing input, unknown engine → planned-engine refusal, bitrate out of range, rel-path reject, no-clobber without overwrite); dry-run returns command + writes nothing; `--json` stdout → `meta.applied/decisionTier` parse; node/gwr-missing → `ok:false` with installer hint; metadata strip drops tags on image + video fixtures (ffprobe/Pillow re-read); no `shell=True` anywhere (grep guard).

**API**: monkeypatched `run_command` canned `(0, json, "")`; assert `ok:true` + absolute `output_path` + meta; cancel mid-batch → `Cancelled by user`; HTTP status always 200 on operation failure.

**Playwright (WebUI proof — click the real control, invariant 12)**: Clean → Watermark renders with installer card; Detect on a Gemini fixture → readout row; dry-run → command echoed, no file; real image Remove → cleaned file + preview + pool auto-add (when enabled); real short video → bitrate flag honored, output non-empty; missing-tool path shows inline `ok:false`; zero new console errors.

---

## 8. Files touched (build hint)

- `mtapi-project/tools/gemini-watermark-remover/` — **new** vendored clone at pinned tag (with `node_modules` inside; excluded from junk rules).
- `app/operations/watermark_ops.py` — **new** (4 ops + argv/validate/parse helpers).
- `app/operations/__init__.py` — one import line.
- `app/routes/watermark.py` — **new** `GET /api/watermark/status`; `app/main.py` — include line only.
- `app/shell.py` — `check_tools()` node/pnpm warn rows.
- `app/static/index.html` — `Clean` section + Watermark nav item.
- `app/static/app.js` + `app/static/js/job-control.js` — tab registration + op dispatch.
- `app/static/js/tabs/watermark.js` — **new** tab module.
- `tests/test_watermark.py` — **new**.
- Ship: root `VERSION` far-right DD bump + STATUS top box + `docs/archive/changelog.md` (not this spec).

## 9. Invariants honored

1. Filter platform untouched (file-to-file op). 2. `shell.run_command` argv only, none in `main.py`. 3. Absolute I/O. 5. Pools via existing auto-add funnel. 7. Vanilla, no npm in SPA. 8. Vendored tool outside `junk/`. 9. `report_progress` per item/phase. 10. Failures HTTP 200 + `ok:false`. 12. Playwright clicks, not curl.
