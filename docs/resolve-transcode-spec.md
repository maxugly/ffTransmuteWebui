# Convert / Export — Codecs, Frame Folders, GIF

> **Status:** Implemented (`convert_ops.py`, `convert_presets.py`, engine dump/encode extensions, Convert UI tab)  
> **Nav home:** new peer tab under **Transmutations** → **Convert / Export**  
> **Engine home:** `app/video_pipeline.py` + `JobWorkspace` (shared with filters / PipelineChain)  
> **Not** Single-Clip Ops (geometry / extract / reverse stay there)  
> **Not** Folder Watcher (batch ingest → DNxHR stays there)  
> **Not** a second dump/encode stack inside `transmute` alone

---

## 1. Problem

Three complementary user needs:

1. **Into the NLE (Resolve Free on Linux):** H.264 (AVC) and H.265 (HEVC) often will not decode. Users need **intermediates** — DNxHR and/or Apple ProRes — in a `.mov` with PCM audio before import.
2. **Out to the world:** Delivery formats — H.264/AVC MP4, H.265/HEVC MP4, WebM/VP9, AV1 — and sometimes **FFV1** archive.
3. **Frame folders in and out:** Dump video/GIF → stills (PNG/WebP/JPG/TIFF); import stills folder or **GIF** → any video target.

### 1.1 Architectural problem (more important than the UI)

The app is moving from **all-in-one ops** toward **filters** on a shared disk pipeline:

```text
dump (video/GIF → image sequence)
  → filter_fn* (DeepDream, RIFE, withoutBG, style, …)   # optional chain
  → encode (image sequence → video, chosen codec)
```

That bookend engine already lives in:

| Module | Role |
|--------|------|
| `app/video_pipeline.py` | `probe`, `dump`, `process`, `encode` |
| `app/job_workspace.py` | Per-job `frames_in` / `frames_out` / audio / metadata |
| `app/pipeline_chain.py` | Multi-filter cascade on stage dirs |
| Op handlers (deepdream, rife, …) | Increasingly: thin wrappers that supply a `filter_fn` |

**Convert / Export is not a parallel ffmpeg island.** It is the **user-facing control surface for the same dump/encode engine** filters already share:

- **Frames out** = durable `dump` to a path the user keeps (not only `/tmp/mtapi_jobs/…`).
- **Frames in** = skip dump; treat a user folder as the sequence and call **`encode` only**.
- **Codec targets** (ProRes, DNxHR, H.264, …) = **encode presets** on that engine (today `encode()` is mostly libx264+CRF; it must grow).
- **GIF in** = `dump`/`probe` accept GIF like any other ffmpeg input.

If Convert reinvented dump/encode only inside `transmute`, filters and Convert would drift (patterns, start numbers, audio mux, progress). **One engine; many faces** (Convert tab, pipeline chain, individual filter ops).

---

## 2. Product & architecture decisions (locked for v1)

### 2.1 Product

| Decision | Choice |
|----------|--------|
| UI placement | **New peer tab** under Transmutations: **Convert / Export** |
| Relation to Single-Clip | Separate. First/last frame stays on Single-Clip; **full sequence dump** lives here. |
| Relation to Watcher | Separate. Watcher remains auto-ingest → DNxHR-LB + AR fit. |
| Framing / scale | **No creative scale.** Even-floor only for 4:2:0 delivery encodes. |
| Missing audio | Encode path: mux workspace audio if present; else inject silence (or `-an` only if explicitly requested later). Dumps: no audio sidecar in v1 (engine may still extract audio into workspace for later mux when doing video→video via frames). |
| GIF | **Import only** in v1 (→ frames or → video). No GIF export preset yet. |
| TIFF | Supported; lowest priority — PNG is the workhorse for filters. |
| Naming style | Wordy labels, tooltips, glossary. |
| Quality | Named presets + light overrides (§5). |

### 2.2 Engine (non-negotiable)

| Decision | Choice |
|----------|--------|
| **Implementation home** | **Python:** extend `video_pipeline` (+ thin `convert` op). Not a greenfield bash reimplementation. |
| **Shared with filters** | Same `dump` / `encode` (and same frame naming) used by PipelineChain and filter-based ops. |
| **Frame pattern** | **`frame_%06d.png` with `-start_number 0`** — **match existing `video_pipeline.dump` / `encode`**. User-facing dumps use this so folders are drop-in compatible with filter stages. (UI copy: “starts at `frame_000000.png` — same as internal pipeline.”) |
| **PNG is canonical mid-chain** | Filters and PipelineChain remain **PNG-on-disk**. WebP/JPG/TIFF dumps are **export formats** for humans/external tools; importing non-PNG stills **normalizes to PNG** (or encode path accepts mixed stills via ffmpeg demux — see §4.2) before any filter chain. Round-trip for filter work: prefer **PNG out / PNG in**. |
| **Convert video→video** | Prefer **engine path**: dump (temp workspace) → identity (or no process) → encode with **target preset**. Optional fast-path: direct ffmpeg re-encode without materializing frames when no filter and user did not ask for frames (see §4.2.D). Fast-path must still call the **same encode-recipe table** so ProRes/DNxHR args never fork. |
| **CLI** | Optional convenience: `transmute -C` **may** wrap the same recipes for offline use, but **API + filters must not depend on transmute for convert**. Primary source of truth = Python encode/dump presets. |
| **Geometry combine** | No. Convert is dump/encode bookends, not geometry. |

### 2.3 Mental model (for builders and UI copy)

```text
                    ┌─────────────────────────────────────┐
  video / GIF  ──►  │  dump   (video_pipeline)            │  ──►  frame folder (user or temp)
                    └─────────────────────────────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
  frame folder ──►  │  filter_fn…  (optional; PipelineChain)│
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────▼───────────────────┐
                    │  encode  (video_pipeline + presets)  │  ──►  mov/mp4/webm/mkv
                    └─────────────────────────────────────┘
```

Convert tab exposes the **edges**. Filters plug into the **middle**. Dynamic mixing chains the middle and still uses the same edges.

---

## 3. Targets (v1 set)

Every target has: stable `id` (API + CLI), wordy UI label, short blurb (shown under the select + `title` tooltip), container, codecs, defaults, auto-name suffix.

### 3.1 Intermediate — for DaVinci Resolve / NLE

| id | UI label | When to use | Container | Video | Audio | Auto name |
|----|----------|-------------|-----------|-------|-------|-----------|
| `prores_hq` | **ProRes 422 HQ (Apple intermediate · Resolve / FCP)** | High-quality edit intermediate. 10-bit 4:2:2. Large files, very editable. Prefer if you work with ProRes elsewhere or want max quality intermediate. | `.mov` | `prores_ks` profile `hq` (3), `yuv422p10le` | `pcm_s16le` | `_prores_hq.mov` |
| `prores_proxy` | **ProRes Proxy (lightweight intermediate · offline edit)** | Small/fast ProRes for rough cuts; not delivery. | `.mov` | `prores_ks` profile `proxy` (0), `yuv422p10le` | `pcm_s16le` | `_prores_proxy.mov` |
| `dnxhr_lb` | **DNxHR LB (Avid / Resolve intermediate · low bandwidth)** | Same family as Folder Watcher default. Smallest DNxHR; good for proxies and Resolve Free on Linux. | `.mov` | `dnxhd` profile `dnxhr_lb`, `yuv422p` | `pcm_s16le` | `_dnxhr_lb.mov` |
| `dnxhr_sq` | **DNxHR SQ (Avid / Resolve intermediate · standard quality)** | Balanced size vs quality for general Resolve work. | `.mov` | `dnxhd` profile `dnxhr_sq`, `yuv422p` | `pcm_s16le` | `_dnxhr_sq.mov` |
| `dnxhr_hq` | **DNxHR HQ (Avid / Resolve intermediate · high quality)** | Heavier intermediate when LB/SQ look soft or you need more headroom. | `.mov` | `dnxhd` profile `dnxhr_hq`, `yuv422p` | `pcm_s16le` | `_dnxhr_hq.mov` |

**Tooltip / help text (shared intermediate note):**  
> Resolve Free on Linux often cannot decode H.264 (AVC) or H.265 (HEVC). Transcode to DNxHR or ProRes + PCM audio, import the `.mov`, edit, then use a delivery target below to export for web/devices. Folder Watcher uses **DNxHR LB** automatically for whole folders; this tab is one file at a time with more target choices.

### 3.2 Delivery — web, devices, sharing

| id | UI label | When to use | Container | Video | Audio | Auto name |
|----|----------|-------------|-----------|-------|-------|-----------|
| `h264_avc` | **H.264 / AVC · MP4 (universal playback)** | Default “it just plays everywhere” export. YouTube-ish, phones, most browsers, Discord, etc. **AVC** = Advanced Video Coding = H.264. | `.mp4` | `libx264` CRF 23 preset medium `yuv420p` | AAC 192k | `_h264_avc.mp4` |
| `h264_avc_hq` | **H.264 / AVC · MP4 high quality (near-master delivery)** | Same universal codec, visually cleaner (CRF 18). Bigger files. Good for archival-ish masters that must stay H.264. | `.mp4` | `libx264` CRF 18 preset slow `yuv420p` | AAC 256k | `_h264_avc_hq.mp4` |
| `h265_hevc` | **H.265 / HEVC · MP4 (efficient modern devices)** | Half the bitrate of H.264 for similar look. **HEVC** = High Efficiency Video Coding = H.265. Great for 4K phones / storage; slightly weaker browser support than AVC. Tag `hvc1` for Apple. | `.mp4` | `libx265` CRF 26 preset medium `yuv420p` `-tag:v hvc1` | AAC 192k | `_h265_hevc.mp4` |
| `h265_hevc_hq` | **H.265 / HEVC · MP4 high quality** | Cleaner HEVC (CRF 20). Still much smaller than ProRes/DNxHR. | `.mp4` | `libx265` CRF 20 preset medium `yuv420p` `-tag:v hvc1` | AAC 256k | `_h265_hevc_hq.mp4` |
| `webm_vp9` | **VP9 · WebM (web / open formats)** | Browser-friendly open stack. Good for web embeds; encode is slower than x264. Opus audio. | `.webm` | `libvpx-vp9` CRF 30 `-b:v 0` `-row-mt 1` | Opus 160k | `_vp9.webm` |
| `av1_mp4` | **AV1 · MP4 (next-gen efficient delivery)** | Newer than HEVC; excellent compression. Encode can be slow (SVT-AV1). Prefer when recipients can play AV1 (modern browsers/devices). | `.mp4` | `libsvtav1` CRF 30 preset 6 `yuv420p` | AAC 192k | `_av1.mp4` |

**Naming pedagogy (show in UI help block):**

| Shorthand | Full name | Typical container |
|-----------|-----------|-------------------|
| **AVC** | Advanced Video Coding = **H.264** | MP4 |
| **HEVC** | High Efficiency Video Coding = **H.265** | MP4 |
| **VP9** | Google’s open codec (successor era to VP8) | WebM |
| **AV1** | AOMedia Video 1 (royalty-free next-gen) | MP4 / WebM |
| **ProRes** | Apple intermediate codec | MOV |
| **DNxHR** | Avid DNxHR intermediate (successor to DNxHD for HD+) | MOV |
| **PCM** | Uncompressed audio (edit-friendly) | inside MOV |
| **AAC** | Lossy audio, MP4 standard | MP4 |
| **Opus** | Modern lossy audio, WebM standard | WebM |

### 3.3 Archive / mezzanine

| id | UI label | When to use | Container | Video | Audio | Auto name |
|----|----------|-------------|-----------|-------|-------|-----------|
| `ffv1_mkv` | **FFV1 · MKV (lossless archive / mezzanine)** | Bit-exact-ish lossless video archive. Huge. Good “don’t lose any more generation” store between pipelines; not for Resolve Free import as primary intermediate (use ProRes/DNxHR for that). | `.mkv` | `ffv1` level 3 | `pcm_s16le` | `_ffv1.mkv` |

### 3.4 Image sequences & GIF — dump out / assemble in

These are first-class Convert targets / input modes, not a side tool.

#### Dump: video (or GIF) → image folder

| id | UI label | When to use | Output | Image codec notes | Auto name |
|----|----------|-------------|--------|-------------------|-----------|
| `frames_png` | **PNG image sequence · folder (lossless frames out · pipeline-native)** | **Canonical dump.** Same format/pattern as `video_pipeline.dump` / filter stages. Use this when you will hand frames to other tools **or** re-import for encode / future filter chains. | directory of `frame_%06d.png` | engine dump | `<stem>_frames_png/` |
| `frames_webp` | **WebP image sequence · folder (efficient stills out)** | Smaller than PNG for human/export use. **Not** mid-chain for filters — re-import normalizes or encodes directly. | `frame_%06d.webp` | dump variant quality **90** | `<stem>_frames_webp/` |
| `frames_jpg` | **JPEG / JPG image sequence · folder (small stills out)** | Smallest common dump. Lossy. **JPG = JPEG.** Bad for multi-generation filter work. | `frame_%06d.jpg` | dump variant `-q:v 2` | `<stem>_frames_jpg/` |
| `frames_tiff` | **TIFF image sequence · folder (print / VFX style stills)** | Low priority. Prefer PNG for pipeline compatibility. | `frame_%06d.tif` | dump variant | `<stem>_frames_tiff/` |

**Dump behavior (via engine):**

- Input: video file **or** animated GIF (extend `probe`/`dump` to accept GIF).
- Implementation: call shared **`dump`**, then either leave frames in workspace and **copy/move** to user `output_path`, **or** teach dump an optional `out_dir=` that writes durable frames without double I/O.
- Frame pattern: **`frame_%06d.<ext>`, `-start_number 0`** (engine parity: `frame_000000.png`, …).
- Timing: `-fps_mode passthrough` (current dump behavior); optional later `fps=` resample.
- No audio sidecar next to user frame folder in v1; workspace may still extract audio for encode-only paths.
- Unique output dir if collision (`pathutil` / unique suffix).

#### Import: image folder or GIF → video target

There is **no separate “import” target id**. Import is an **input mode**:

| Input kind | How detected | What user picks as target | FPS |
|------------|--------------|---------------------------|-----|
| Directory of stills | Folder contains ≥1 of `.png` `.webp` `.jpg` `.jpeg` `.tif` `.tiff` and is **not** treated as video-batch (see rules below) | Any **video** target in §3.1–3.3 (`h264_avc`, `prores_hq`, `dnxhr_lb`, …) | Required effective fps: API/CLI `fps` / `-F`, default **24** |
| Animated `.gif` | Extension `.gif` | Any video target **or** any `frames_*` dump target | Prefer GIF native rate; else `-F` / default 24 |
| Normal video | `.mp4` etc. | Any target including `frames_*` | From file for dumps; N/A for re-encode |

**Directory classification rules (important):**

1. If path is a file → single-file mode.  
2. If path is a dir **and** target is `frames_*` → error (“already a folder; pick a video/GIF to dump”).  
3. If path is a dir **and** target is a video codec:
   - Count image files (ext above, non-recursive, top-level only).  
   - Count video files (existing `is_video_file` set).  
   - If `images >= 1` and `images >= videos` → **image sequence assemble** (sorted by filename).  
   - Else if `videos >= 1` → **batch convert** each video (existing transmute folder batch idea).  
   - Else → error: empty / unknown contents.

**Assemble ffmpeg shape (images → video):**

```bash
# Prefer ordered list or glob. Example pattern approach when names are frame_%06d.png:
ffmpeg -y -framerate "$FPS" -i /path/to/dir/frame_%06d.png \
  …video target codec args… out.mp4

# If files are not a strict %d pattern (mixed names), build concat demuxer list
# sorted by locale/C filename order, still -framerate "$FPS".
```

- Mixed extensions in one folder: convert only the **dominant** extension (most files); warn in stdout if others ignored. Or require a single extension — **prefer fail with clear error if more than one image ext present** (cleaner).
- Dimensions: use first frame; if later frames differ, ffmpeg may fail — surface error as-is.
- Alpha: PNG/WebP with alpha → for delivery targets, flatten on black (or let encoder drop alpha); for ProRes, v1 may drop alpha unless profile is 4444 (out of scope). Document “alpha flattened for most targets.”

#### GIF (import)

| Direction | Supported v1? | Notes |
|-----------|---------------|--------|
| GIF → any video target | **Yes** | Treat like video input; palette sources are fine. |
| GIF → `frames_*` | **Yes** | One still per GIF frame. |
| Video → animated GIF | **No** (later) | Palette + fps knobs deserve their own small preset later. |

**UI / glossary add-ons:**

| Term | Meaning |
|------|---------|
| **Image sequence** | Folder of numbered stills played in order at a fixed FPS to make video. |
| **PNG** | Portable Network Graphics — lossless stills; default dump. |
| **WebP** | Modern still format; smaller than PNG, often lossy/near-lossless. |
| **JPEG / JPG** | Lossy stills; small; generational damage if you dump→edit→encode often. |
| **TIFF / TIF** | High-end still container; optional here. |
| **GIF** | Graphics Interchange Format — animated or still; **import** as a clip or dump to frames. Limited colors (palette). |

### 3.5 Out of scope for v1 (do not implement yet; leave room in UI groups)

- Hardware encoders (NVENC / QSV / VAAPI).  
- ProRes 4444 / DNxHR 444 / HQX (alpha intermediates).  
- Two-pass encodes, target bitrate modes, multi-audio tracks, subtitles.  
- Remux-only (stream copy) without re-encode.  
- **Animated GIF export.**  
- Recursive image folders / multi-shot reel assembly.  
- Writing audio WAV beside frame dumps.

---

## 4. Approach

### 4.1 Primary: extend the shared engine (do this first)

#### 4.1.1 Encode presets registry

Add a single table (e.g. `app/convert_presets.py` or inside `video_pipeline.py`) keyed by target `id`:

```python
# Conceptual — builder picks structure
PRESETS = {
  "h264_avc": EncodePreset(container=".mp4", codec="libx264", crf=23, preset="medium",
                           pix_fmt="yuv420p", audio="aac", audio_bitrate="192k",
                           extra=["-movflags", "+faststart"], even_floor=True),
  "prores_hq": EncodePreset(container=".mov", codec="prores_ks", profile=3,
                            pix_fmt="yuv422p10le", audio="pcm_s16le", even_floor=False),
  "dnxhr_lb": EncodePreset(...),
  # ... all §3.1–3.3 ids
}
```

**`video_pipeline.encode` must accept a preset** (or expanded kwargs covering ProRes/DNxHR/VP9/AV1/FFV1 — not only `codec/crf/preset/pix_fmt`). Today’s signature is too narrow for Resolve intermediates; growing it is part of this work so **PipelineChain final encode** can later pick delivery codecs too.

Silence inject when no `workspace.audio_path` (align with Watcher / Resolve friendliness for intermediate targets).

#### 4.1.2 Dump extensions

Extend `video_pipeline.dump`:

| Capability | Detail |
|------------|--------|
| **GIF input** | Same as video; ffmpeg decodes animated GIF to frames. |
| **`image_format`** | `png` (default) \| `webp` \| `jpg` \| `tiff` — pattern `frame_%06d.<ext>`, **start_number 0**. |
| **`out_dir` optional** | If set, write frames there (durable Convert dump). If unset, keep current `workspace.frames_in` behavior for filters. |
| **Return metadata** | `{frame_count, fps, audio_path, pattern, start_number}` unchanged in spirit. |

Filters continue to call `dump(workspace, path)` → PNG in `frames_in`. Convert dump calls `dump(..., image_format=…, out_dir=user_path)`.

#### 4.1.3 Import: frames directory → encode

New helper, e.g. `load_frames_dir(workspace, dir_path) -> dict`:

1. Detect image ext family (single ext preferred).  
2. If already `frame_%06d.png` start 0: point encode at that dir **or** symlink/copy into `workspace.frames_out`.  
3. If other names / WebP/JPG/TIFF: either ffmpeg-assemble later, or normalize copy to `frames_out` as PNG sequence (PNG normalize preferred when a filter chain will run; for Convert encode-only, ffmpeg can read the folder pattern / concat demuxer directly).  
4. Set fps from caller (default 24).  
5. No audio unless sidecar later.

Then `encode(workspace, output, fps, preset=PRESETS[target])`.

#### 4.1.4 Convert op as thin orchestrator

```text
POST /ops/convert
```

```python
async def convert(p: ConvertParams) -> OperationResult:
    # 1. frames_* target  → dump only (durable out_dir)
    # 2. input is image dir → load_frames_dir + encode(preset)
    # 3. input is video/gif + video target →
    #       preferred: dump → (no filters) → encode(preset)
    #       optional fast-path: direct ffmpeg using SAME preset argv builder
    # 4. dry_run → return command strings from preset builder without running
```

Tags: `["convert", "export", "frames", "pipeline"]`.  
**Not** a transmute_ops geometry helper.

### 4.2 Path matrix (engine)

| Input | Target | Engine calls |
|-------|--------|--------------|
| Video / GIF | `frames_png` / webp / jpg / tiff | `dump(..., image_format, out_dir=)` |
| Video / GIF | video preset | `dump` → `encode(preset)` **or** fast-path `encode_direct(preset)` sharing argv |
| Image folder | video preset | `load_frames_dir` → `encode(preset)` |
| Image folder | `frames_*` | Error (already frames) |
| Video folder (batch) | video preset | Loop files; each through convert (CLI/API batch helper optional) |

#### D. Fast-path note

Direct ffmpeg video→video (no PNG materialization) is **allowed** for Convert when the user did not request frames and no filters run — **only if** argv comes from the **same preset builder** `encode()` uses. Goal: speed without forking ProRes/DNxHR recipes. Filters **never** use this fast-path mid-chain.

### 4.3 Optional CLI (`transmute -C`) — secondary

CLI is **nice for offline shell use**, not the system of record.

```text
transmute INPUT.mp4 -C h264_avc
transmute INPUT.mp4 -C frames_png OUT_DIR
transmute ./frames -C h264_avc -F 24
transmute anim.gif -C prores_hq
```

If implemented, it should either:

- shell out to a small Python entrypoint that uses `video_pipeline`, **or**  
- duplicate only the **preset argv table** imported from one source of truth (codegen or shared docs risk — prefer Python).

**WebUI and filter ops must call Python**, not `bin/transmute -C`.

### 4.4 Backend API (surface)

```text
POST /ops/convert
{
  "input_path": "/abs/path/in.mp4",   # video, .gif, or image-sequence directory
  "target": "h264_avc",               # any §3 id including frames_*
  "output_path": null,
  "fps": 24,
  "dry_run": false
}
```

- `ConvertParams` as above.  
- Handler uses engine (§4.1.4), returns standard `OperationResult` (`output_path`, `command`, stderr, …).  
- Directory-safe outputs for `frames_*` (do not force `.mp4`).

Optional later: `crf`, `preset`, `image_quality`.

### 4.5 WebUI — Convert / Export tab

#### Nav

In `index.html`, under **Transmutations** (after Single-Clip Ops is fine):

```html
<div class="nav-item" data-tab="convert">
  …icon (e.g. arrows / export)…
  Convert / Export
</div>
```

Wire `switchTab`, `TAB_ACCEPTS`: accept **video, gif, and directories** (`any` or a dedicated `'media+dir'`), title string, `renderTabForm` → `renderConvertForm`.

#### New module

`mtapi-project/app/static/js/tabs/convert.js`

Structure (wordy + educational):

1. **Panel title:** Convert / Export  
2. **Lead paragraph:** re-encode codecs **and** dump/import image sequences; GIF in; not geometry; not Watcher batch.  
3. **Target `<select>`** with `<optgroup>`:

   - Intermediate (Resolve / NLE)  
   - Delivery (web & devices)  
   - Archive  
   - **Image sequences (frames out)** ← `frames_png` / `webp` / `jpg` / `tiff`  

   Option text = **full UI labels** from §3 (long is good).

4. **Dynamic help panel** under the select (updates on change):
   - Full blurb from §3  
   - Codec / format line  
   - “Also known as …” aliases  
   - For `frames_*`: show pattern **`frame_000000.png`** (pipeline-native, start at 0) + “output is a folder”  
   - For `frames_png`: “Same sequence format internal filters use (DeepDream, RIFE, pipeline chain).”  
   - `title=` on each `<option>` for hover tooltips  

5. **Input path** + Browse  
   - Placeholders: `/path/to/clip.mp4` · `/path/to/frames/` · `/path/to/anim.gif`  
   - `field-desc`: video, animated GIF, or folder of stills (PNG preferred for filter-compatible round-trips).  

6. **FPS control** — used when assembling image folders; default 24; hint when ignored.

7. **Output path** — file vs folder hint by target.

8. Dry-run + Run → `POST /ops/convert`.

9. **Knowledge card:** codec glossary + “PNG sequences are the shared language between Convert and neural filters” + Watcher cross-link.

#### Pool integration (light)

Optional “Send to Convert / Export”.

### 4.6 Files to touch (engine-first)

| Priority | File | Change |
|----------|------|--------|
| **P0** | `mtapi-project/app/video_pipeline.py` | Extend `dump` (GIF, image_format, optional out_dir); extend `encode` (full presets / silence inject / even-floor) |
| **P0** | `mtapi-project/app/convert_presets.py` (new) **or** presets in video_pipeline | Single registry of §3 encode + dump targets |
| **P0** | `mtapi-project/app/operations/convert_ops.py` (new) | `ConvertParams` + orchestrator; register op; import in `operations/__init__.py` |
| **P0** | `mtapi-project/app/job_workspace.py` | Only if needed (e.g. list non-PNG stills, frames_out from external dir) |
| **P1** | `mtapi-project/app/pipeline_chain.py` | Optional: allow final encode preset id (so chains can emit ProRes/H.264 without a second Convert pass) — **nice**, not blocking Convert tab |
| **P1** | `mtapi-project/app/static/index.html`, `app.js`, `js/tabs/convert.js` | Convert / Export tab UI |
| **P2** | `transmute` + `bin/transmute` + `docs-transmute-README.md` | Optional `-C` CLI wrapping same presets |
| **P2** | Filter ops still on old PNG path | No change required if they already use `video_pipeline`; they automatically inherit dump/encode improvements |
| — | `VERSION` | Bump far-right DD |
| — | This spec | Status → Implemented when done |

**Do not** implement Convert only as transmute flags with API shelling to bash.  
**Do not** add targets to `js/tabs/transmute.js`.

---

## 5. Defaults, knobs, and capability level

| Control | v1 |
|---------|----|
| Video presets | All §3.1–3.3 ids via **shared encode registry** |
| Frame dumps | `frames_png` (pipeline-native), webp, jpg, tiff |
| GIF import | Yes |
| Image folder import | Yes + `fps` |
| Mid-chain format | **PNG** only (filters / PipelineChain) |
| Audio | Per preset; silence if missing on encode |
| AR fit | No (Watcher) |
| Dry run | Yes (show ffmpeg argv from preset builder) |

Future: free CRF, GIF export, pipeline final-encode preset UI, hardware encode.

---

## 6. Pattern to follow

- **Engine:** grow `video_pipeline` the way filter ops already depend on it (`deepdream` / `rife` v2 JobWorkspace path).  
- **Filters:** stay pure `filter_fn(input_png, output_png, index)` — they never pick containers.  
- **Convert:** only place users pick dump format + encode preset (bookends).  
- **PipelineChain:** dump once → filters → encode once; should call the **same** encode presets when we expose chain output codec.  
- **UI:** same Browse / dry-run patterns as other tabs; educational copy.  
- **Watcher:** leave alone (batch DNxHR + AR).

---

## 7. Pitfalls

1. **Two engines:** Implementing Convert only in `transmute` while filters use `video_pipeline` **will** diverge. Engine first.
2. **Encode API too narrow today:** `encode(..., codec, crf, preset, pix_fmt)` cannot express ProRes/DNxHR/PCM. Extend carefully; keep backward-compatible defaults for existing filter ops (libx264 CRF 18-ish).
3. **start_number 0 vs 1:** Pipeline uses **0**. User dumps must match or re-import/`%06d` demux breaks.
4. **Pixel formats:** ProRes `yuv422p10le`; DNxHR `yuv422p`; delivery `yuv420p` + even-floor.
5. **Missing audio:** Image folders / many GIFs; inject silence for intermediate/delivery encodes.
6. **Odd dimensions** on yuv420p encodes.
7. **HEVC:** `-tag:v hvc1`.
8. **AV1:** require `libsvtav1` or fail clearly.
9. **Folder ambiguity:** videos vs stills — §3.4 rules.
10. **ensure_video_output_path** must not force `.mp4` on frame directories.
11. **JPG generational loss** / TIFF flaky → document PNG as pipeline-native.
12. **GIF palette** limits.
13. **Fast-path vs filter path:** never skip dump when a filter will run; fast-path only Convert encode-only.
14. **Regression on filter ops:** After changing `encode`/`dump`, smoke DeepDream or RIFE on `/tmp/teste.mp4` once so shared engine did not break mid-chain tools.

---

## 8. Relationship map

```text
                    video_pipeline.dump / encode     ◄── shared engine (P0)
                           ▲           ▲
           ┌───────────────┤           ├────────────────┐
           │               │           │                │
   Convert / Export   PipelineChain   filter ops     (optional transmute -C)
   (UI bookends)      (filter stages) (deepdream…)   (CLI convenience)
           │
   Folder Watcher ── separate batch DNxHR path (may later call same encode preset)
   Single-Clip    ── geometry / first-last frame (not full sequences)
```

**Filters transition:** ops become `filter_fn` only; they assume PNG sequences already exist. Convert (and PipelineChain) own dump+encode. This spec is how dump/encode become **good enough for everyone**.

---

## 9. Verification (mandatory before DONE)

### Engine / API (primary)

```bash
# Convert op — video codecs
curl -s -X POST http://localhost:24590/ops/convert \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste.mp4","target":"h264_avc","output_path":"/tmp/teste_h264_avc.mp4"}'

curl -s -X POST http://localhost:24590/ops/convert \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste.mp4","target":"prores_hq"}'

curl -s -X POST http://localhost:24590/ops/convert \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste.mp4","target":"dnxhr_lb"}'

# Frames out (PNG pipeline-native)
curl -s -X POST http://localhost:24590/ops/convert \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste.mp4","target":"frames_png","output_path":"/tmp/teste_frames_png"}'
ls /tmp/teste_frames_png | head   # expect frame_000000.png …

# Frames in
curl -s -X POST http://localhost:24590/ops/convert \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste_frames_png","target":"h264_avc","fps":24,"output_path":"/tmp/teste_from_frames.mp4"}'

# GIF
ffmpeg -y -f lavfi -i "testsrc=duration=1:size=160x120:rate=10" -f gif /tmp/teste.gif
curl -s -X POST http://localhost:24590/ops/convert \
  -H 'Content-Type: application/json' \
  -d '{"input_path":"/tmp/teste.gif","target":"h264_avc"}'
```

`ffprobe` outputs for ProRes/DNxHR/H.264. Silence inject on video-only source once.

### Shared-engine regression

- Run one filter-based op (e.g. RIFE or DeepDream) on `/tmp/teste.mp4` after dump/encode changes — must still `ok: true`.

### WebUI

1. **Convert / Export** tab: optgroups, wordy labels, help text, pipeline-native PNG note.  
2. Video → H.264, ProRes HQ, DNxHR LB, HEVC, VP9.  
3. Video → PNG frames folder (`frame_000000.png`).  
4. That folder → H.264 with FPS 24.  
5. GIF → video or frames.  
6. Zero console errors; dry-run shows command.

### Optional CLI

Only if `-C` was implemented: same round-trips via `transmute`.

### Regression

- Single-Clip unchanged; Watcher unchanged; filter ops still dump/encode via engine.

Clean up test artifacts under `/tmp/teste_*`.

---

## 10. Implementation order (suggested)

1. **`convert_presets` + extend `encode`** (all video targets; silence; even-floor).  
2. **Extend `dump`** (GIF, image_format, durable `out_dir`).  
3. **`load_frames_dir` + `convert_ops`** orchestrator; register `/ops/convert`.  
4. API verify codecs + PNG round-trip + GIF.  
5. **Filter smoke** (shared engine).  
6. **Convert UI** tab + glossary.  
7. WebUI verify.  
8. Optional `transmute -C`.  
9. VERSION + mark spec Implemented.  
10. Later: PipelineChain final encode preset.

---

## 11. Open for later (not blocking)

- PipelineChain / UI: choose final encode preset after a filter chain (no second Convert pass).  
- CRF / still-quality knobs.  
- Animated GIF export.  
- Hardware encode.  
- Pool → Convert.  
- Watcher using shared `dnxhr_lb` preset.  
- Audio sidecar with frame dumps.  
- ProRes 4444 for alpha PNG sequences.  
- Migrating remaining all-in-one ops fully to filter_fn + this encode registry.
