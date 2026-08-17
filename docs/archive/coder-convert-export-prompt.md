# OpenCode bootstrap — Convert / Export (implement)

Paste this whole prompt into **OpenCode** (`opencode` TUI). You are the **Builder**. Read the spec, implement engine-first, verify, commit.

---

## Role

You implement working code. You are **not** rewriting the product design. Follow:

- Root `AGENTS.md` (Builder section, verification §D, system invariants)
- `mtapi-project/AGENTS.md` (API contracts, WebUI Playwright rules, no shell=True)

## Spec (source of truth)

**Read fully before coding:**

`docs/resolve-transcode-spec.md`

Especially:

- §1.1 Architectural problem (shared engine, not a transmute island)
- §2.2 Engine decisions (non-negotiable)
- §3 Targets (all preset ids + frames_* + GIF)
- §4.1 Primary: extend `video_pipeline` + presets + convert op
- §9–10 Verification + implementation order

Registry blurb: `docs/spec_registry.json` → `resolve-transcode-spec.md`.

## Goal

Ship **Convert / Export**:

1. **Shared engine growth** (required first)
   - Extend `mtapi-project/app/video_pipeline.py`:
     - `dump`: GIF ok; `image_format` png|webp|jpg|tiff; optional durable `out_dir`; pattern `frame_%06d.<ext>` **start_number 0** (match existing pipeline)
     - `encode`: accept full encode **presets** (not only libx264/crf) — ProRes, DNxHR, H.264/AVC, H.265/HEVC, VP9, AV1, FFV1; silence inject when no audio; even-floor for yuv420p
   - New preset registry e.g. `app/convert_presets.py` — single source of truth for §3.1–3.3 (+ dump format ids)
   - Helper to load user image folder → encode (frames in)
2. **API**
   - New `POST /ops/convert` via `app/operations/convert_ops.py` (register + import in `operations/__init__.py`)
   - Params: `input_path`, `target`, optional `output_path`, `fps` (default 24), `dry_run`
   - Standard `OperationResult`; absolute paths; `unique_output_path`; directory-safe for `frames_*`
3. **WebUI**
   - New peer tab under Transmutations: **Convert / Export**
   - `index.html` nav + `app.js` wiring + `js/tabs/convert.js`
   - Wordy labels, optgroups (Intermediate / Delivery / Archive / Image sequences), help panel + glossary
   - Accept video, GIF, image-sequence directory
4. **Optional later in same PR if time:** `transmute -C` CLI — only if it reuses the same presets; **do not** make API shell to bash as the primary path
5. **Do not** stuff targets into Single-Clip `transmute.js`
6. **Do not** change Folder Watcher behavior
7. Bump `VERSION` far-right DD when feature works

## Non-goals (v1)

- Animated GIF export
- Geometry + convert combine
- AR letterbox (Watcher owns that)
- Hardware encoders
- Rewriting all neural ops (only ensure dump/encode changes don’t break them)

## Implementation order (mandatory)

1. Presets + extend `encode`
2. Extend `dump` + load frames dir
3. `convert_ops` + register
4. API smoke with `/tmp/teste.mp4`
5. Shared-engine regression: one filter op still works (e.g. RIFE or existing pipeline identity)
6. Convert UI tab
7. WebUI verify
8. VERSION + mark spec status Implemented if done
9. Commit (logical commits ok)

## Verification (claim DONE only after this)

Test asset (create if missing):

```bash
ffmpeg -y -f lavfi -i "testsrc=duration=2:size=320x240:rate=24" \
  -f lavfi -i "sine=frequency=440:duration=2" \
  -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 64k -shortest \
  /tmp/teste.mp4
```

**API at minimum:**

- `target=h264_avc`, `prores_hq`, `dnxhr_lb` on `/tmp/teste.mp4`
- `target=frames_png` → folder with `frame_000000.png`
- folder → `h264_avc` with `fps=24`
- GIF → h264 or frames (make tiny `/tmp/teste.gif` if needed)
- `ffprobe` codecs look right

**WebUI (Playwright MCP / browser — not curl-only for DONE):**

- Open `http://localhost:24590/` → Convert / Export
- Run H.264 + PNG dump + reassemble; zero JS console errors

**Regression:** one existing VideoPipeline op still succeeds after engine changes.

## Constraints

- Absolute paths only for media I/O
- Subprocess: `create_subprocess_exec` / `run_command` argv lists — never `shell=True`
- Vanilla JS/CSS — no npm/React
- Prefer extending shared engine over forked ffmpeg recipes in the op file
- Fast-path direct video→video re-encode is OK only if argv comes from the **same** preset builder as `encode()`

## When stuck

If the spec is ambiguous, open a short question — do not invent a second dump/encode stack.

## Done means

- Spec verification §9 satisfied
- Working tree committed for this feature
- Spec status line updated to Implemented (optional but preferred)
- Push only if the human asked (they may ask you separately)

Start by reading `docs/resolve-transcode-spec.md` and `app/video_pipeline.py` end-to-end, then implement P0 engine pieces before any UI.
