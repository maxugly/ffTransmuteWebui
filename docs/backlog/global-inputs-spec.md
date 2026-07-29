# Spec: Universal Global Inputs + Multi-File Sequential Processing

> **Version**: 000.000.3.1 (next bump)
> **Status**: Draft — for review
> **Author**: tom.714
> **Scope**: WebUI global input bar rewrite, multi-file op handlers, stop integration
> **Supersedes**: `docs/global-media-ui-spec.md`

---

## 1. What It Does

Replaces the current single global media input with four universal inputs that
travel with the user across all operation tabs:

| input | type | accepts | example |
|-------|------|---------|---------|
| Video file(s) | path(s) | `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi` | `/tmp/clip.mp4` |
| Image file(s) | path(s) | `.png`, `.jpg`, `.webp` | `/tmp/frame.png, /tmp/frame2.png` |
| Path in | directory | any existing directory | `/home/m/raw_footage/` |
| Path out | directory | any writable directory | `/home/m/output/` |

Every operation tab reads from these shared inputs. No more re-typing the
same path on every tab. The existing `global-media-ui-spec.md` described a
single "active media" — this expands it to four typed inputs plus multi-file
handling.

---

## 2. UI Design

### 2.1 Placement

A fixed bar between the header ("RIFE · AI Frame Interpolation") and the
action panel. Four input rows, compact, always visible. Collapsed by default
if the user prefers — toggle with a small chevron.

```
┌─────────────────────────────────────────────────────┐
│ Video file(s): [/tmp/clip.mp4        ] [Browse]     │
│ Image file(s): [                      ] [Browse]     │
│ Path in:       [                      ] [Browse]     │
│ Path out:      [                      ] [Browse]     │
└─────────────────────────────────────────────────────┘
```

### 2.2 Multi-File Input

File inputs use newline-separated paths in a small textarea (3 rows):

```
/tmp/a.mp4
/tmp/b.mp4
/tmp/c.mp4
```

**Why newlines, not commas:** filenames can contain commas (`my video, final.mp4`).
Newlines don't appear in filenames on any filesystem. The Browse button opens a
multi-select file dialog — each selected file becomes one line. No parsing
ambiguity, no escaping.

**Hover tooltip:**

> "Type one absolute path per line. Use Browse to select multiple files at once.
> For image ops, files are processed one at a time."

### 2.3 Status Indicators

To the right of each input, a small icon shows its current state:

| icon | meaning |
|------|---------|
| ✅ green check | **Active** — this input is being used by the current tab |
| ❌ red X | **Inactive** — blank, incompatible with tab, or invalid path |
| ✔️ grey check | **Overruled** — could work, but another input takes priority |

Examples:
- On the rife tab (video-only): Video input shows ✅. Image input shows ❌ (incompatible).
- On the withoutbg tab (image-only): Image input shows ✅. Video input shows ❌.
- If Path in is set AND Video files are set: Video shows ✔️ (overruled), Path in shows ✅.

This replaces the "which wins?" ambiguity. The user sees what's active at a glance.

### 2.4 Per-Tab Compatibility

Each tab declares what it accepts via a data attribute on the tab container:

```html
data-accepts="video"        <!-- video ops: rife, transmute, datamosh, deepdream -->
data-accepts="image"        <!-- image ops: withoutbg, styletransfer -->
data-accepts="image,video"  <!-- both: facemorph (video mode pending) -->
data-accepts="none"         <!-- no file input: watcher, pool, quick, advanced -->
```

When the active tab doesn't accept the global input type:
- The incompatible inputs are greyed out (not hidden — the user can still see what's set)
- A small warning: "Video not used by this tool"
- The Run button remains active — if the user set a video but is on an image tab, they probably meant to switch tabs

### 2.5 State Management

Stored in a global JS object:

```javascript
window.globalInputs = {
  video:     "",     // newline-separated paths, or empty
  image:     "",     // newline-separated paths, or empty
  pathIn:    "",     // single directory path
  pathOut:   "",     // single directory path
};
```

When a value changes, status indicators update and open tabs re-read.

---

## 3. Backend: Multi-File Sequential Processing

### 3.1 Which Ops Get Multi-File

| op | currently accepts | becomes |
|----|------------------|---------|
| withoutbg | multiple images (file list widget) | reads from global image input |
| facemorph | multiple images | reads from global image input |
| styletransfer | multiple content images + style image | content from global, style stays per-op |
| rife | single video | stays single video |
| transmute | single video | stays single video |
| datamosh | single video | stays single video |
| deepdream | single image/video | stays single |
| speedramp | single video | stays single |

**Styletransfer exception:** Style transfer has a primary content image PLUS a
style reference image. The global image input provides content images (processed
sequentially). The style reference image stays as a local per-op input. A
banner at the top of the styletransfer form reads:

> "⚠️ I am weird — the global inputs above don't fully work for me.
> Choose your content images above, then pick a style image below."

This is honest and clear. Styletransfer is the only op with this exception.

**Rule: only ops that already accept multiple inputs get sequential processing.
Single-input ops stay single-input.** No breaking changes.

### 3.2 Sequential Processing Loop

When an op's input is a comma-separated list, the handler:

```python
async def handle_op(params):
    paths = _parse_path_list(params.input_path)  # ["/tmp/a.mp4", "/tmp/b.mp4"]
    
    # STEP 1: verify all files exist BEFORE processing any
    missing = [p for p in paths if not Path(p).is_file()]
    if missing:
        return OperationResult(ok=False, error=f"Files not found: {missing}")
    
    # STEP 2: process sequentially
    results = []
    for i, path in enumerate(paths):
        # Check for Stop between every file
        job_control.check_cancelled()
        
        result = await _process_one(path, index=i, total=len(paths))
        results.append(result)
        
        # If one file fails, continue to the next (don't abort the batch)
        # but record the failure
    
    # STEP 3: return aggregate result
    return _aggregate_results(results)
```

### 3.3 Output Naming for Multi-File

Each file gets a unique output. The existing `finalize_output_path` handles
collision avoidance. For 3 input files:

```
/tmp/a.mp4 → /tmp/a_moshed.mp4
/tmp/b.mp4 → /tmp/b_moshed_1.mp4   (collision avoidance kicks in)
/tmp/c.mp4 → /tmp/c_moshed_2.mp4
```

### 3.4 Stop Integration

The Stop button calls `job_control.cancel()`. The handler calls
`job_control.check_cancelled()` **between files** — not mid-file. This
means:

- File 1 is already running → finishes normally
- Before starting File 2 → `check_cancelled()` raises `JobCancelled`
- The handler catches it, returns aggregate results for completed files
- The Stop button UI updates to "Stopped"

**This is the minimum viable stop.** It doesn't kill ffmpeg mid-encode. It
stops the batch between iterations. For ops where a single file takes
minutes (deepdream), the existing per-frame cancel still works — this is an
additional layer between files.

---

## 4. File Existence Verification

**All paths are verified before any processing begins.** This is mandatory:

1. Parse the comma-separated input into individual paths
2. For each path: `Path(path).is_file()` (or `.is_dir()` for pathIn/pathOut)
3. If ANY path is missing → return `ok: False` with the list of missing paths
4. Do NOT start processing. Do NOT process the ones that exist and fail on
   the third. All-or-nothing verification upfront.

This check happens in the op handler, not in the UI. The UI just passes
paths through — the backend is authoritative.

---

## 5. Path In / Path Out

### 5.1 Path In

A directory containing files to process. When set, ops that support it
scan the directory and build a file list. Example: watcher tab already
does this — the global "Path in" makes it available to all tabs.

For a tab that accepts video and has Path in set to `/home/m/raw/`:
1. Scan the directory for video files
2. Build a comma-separated list internally
3. Display the count: "12 videos found"
4. Process sequentially as above

### 5.2 Path Out

A directory where all outputs land. When set, ops append their output
filename to this directory instead of placing output next to the input.

If Path out = `/home/m/output/` and the op would normally name the file
`clip_rife2x.mp4` next to the input, it now writes to
`/home/m/output/clip_rife2x.mp4`.

If Path out is empty, the existing behavior applies (output next to input).

---

## 6. Implementation Order

### Phase 1: Global Input Bar (frontend only, no backend changes)
- Build the four-input bar in `index.html` / `app.js`
- Wire `window.globalInputs` state
- Each tab reads from it instead of its own local input
- Per-tab compatibility data attributes
- Hover tooltip on textboxes
- **Verify:** every tab still works with global inputs. Zero console errors.

### Phase 2: Multi-File Parsing (backend)
- Add `_parse_comma_paths()` helper to `pathutil.py` or a new shared module
- Add file-existence verification to each multi-file op handler
- Wire sequential loop in withoutbg, facemorph, styletransfer
- Wire `check_cancelled()` between iterations
- **Verify:** run with 3 test images. Stop after 1. Confirm only 1 output.

### Phase 3: Path In / Path Out
- Directory scanning for Path in
- Output directory override for Path out
- **Verify:** set Path in to a directory with 5 images. Run withoutbg. 5 outputs.

### Phase 4: Polish
- Chevron toggle for collapsing the global bar
- Grey-out logic for incompatible inputs per tab
- File count display ("3 files selected")

---

## 7. Files to Touch

| file | change |
|------|--------|
| `app/static/index.html` | global input bar HTML, collapse toggle |
| `app/static/app.js` | `window.globalInputs` state, tab compatibility, grey-out logic |
| `app/static/style.css` | global bar styling, tooltip, grey-out |
| `app/pathutil.py` | `_parse_path_list()` helper (splits newline-separated paths) |
| `app/operations/withoutbg_ops.py` | sequential loop, cancel checks, existence verify |
| `app/operations/facemorph_ops.py` | sequential loop, cancel checks |
| `app/operations/styletransfer_ops.py` | sequential loop, cancel checks |
| `app/contract.py` | maybe: batch result model for aggregate responses |

Files NOT touched: rife_ops, transmute_ops, datamosh_ops, deepdream_ops,
speedramp_ops, watcher, pool, quick, advanced — these stay single-input.

---

## 8. Open Questions

1. **Path out: override or append?** If Path out is set to `/home/m/output/`
   AND the user types a specific output path in an op's local output field,
   which takes priority? Proposed: the per-op output field wins — it's more
   specific. The global Path out is a default, not an override.

2. **Path in scanning a huge directory.** If Path in points at a directory
   with 10,000 files, scanning should not block the UI. Proposed: cap at 500
   files, show a warning, or scan lazily on first run rather than on every
   tab switch.

3. **Video ops with multiple files?** Currently video ops stay single-input.
   If a user sets multiple video paths and clicks Run on the rife tab, what
   happens? Proposed: only the first line is used. The status indicator shows
   ✅ on the first file line, ⚠️ on subsequent lines ("only the first file
   will be processed"). This is visible and honest rather than silently
   ignoring input.<｜end▁of▁thinking｜>

---
## 9. Pitfalls

- **Global inputs carrying stale values between tabs.** If the user sets a
  video on the rife tab, switches to withoutbg (image-only), the video input
  shows ❌ (incompatible) but is still populated. When they switch back to
  rife, it's still there and shows ✅. This is intentional — the inputs
  persist. The status indicators make the state visible at all times.

- **Stop between files vs mid-file.** The current Stop button calls
  `job_control.cancel()`. Ops that already call `check_cancelled()` mid-work
  (deepdream between frames) will stop mid-file. Ops that don't (rife single
  invocation of rife-ncnn-vulkan) will finish the current file before
  stopping. This is documented behavior — the spec adds between-file stop,
  it doesn't replace existing per-frame stop where it already exists.

- **Newline-separated paths must strip whitespace.** Users may add spaces
  after paths. `_parse_path_list()` must strip leading/trailing whitespace
  from each line and skip blank lines. `"/tmp/a.mp4  \n\n/tmp/b.mp4"` →
  `["/tmp/a.mp4", "/tmp/b.mp4"]`.<｜end▁of▁thinking｜>

---
## 10. Done Definition

This feature is DONE when:

- [ ] Four global inputs render on every tab, with Browse buttons and hover tooltips
- [ ] Tab compatibility with status indicators (✅ green check / ❌ red X / ✔️ grey check)
- [ ] Newline-separated paths in file inputs are parsed correctly
- [ ] All input files are verified to exist BEFORE any processing starts
- [ ] Multi-file ops (withoutbg, facemorph, styletransfer) process sequentially
- [ ] Stop button halts the batch between files — finished files stay, pending files don't start
- [ ] Path in scans directory, Path out overrides output location
- [ ] Single-input ops (rife, transmute, datamosh, deepdream) are UNCHANGED
- [ ] WebUI verified with Playwright: all tabs render, global inputs persist across tab switches
- [ ] Backend verified with curl: multi-file run produces N outputs, stop after 1 produces 1 output
