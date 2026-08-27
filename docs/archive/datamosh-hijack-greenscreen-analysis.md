# Visual Hijack "Green Screen" Bug — Deep Analysis

> **Status:** Unsolved. Reproduced. Root cause confirmed.
> **Filed:** 2026-08-26
> **Scope:** `mtapi-project/app/operations/datamosh/common.py` → `_execute_mosh_pipeline` (hijack path)
> **Symptom:** Injected image shows for exactly 1 frame, then output turns solid green `rgb(0, 135, 0)` for the glitch duration.

---

## 1. What "Visual Hijack" is supposed to do

Visual Hijack injects a static image at a chosen frame, then uses the video's own motion to **smear** that image across subsequent frames — as if the image were "painted into" the scene and then dragged around by the motion that follows. At an optional `end_frame`, the video recovers.

Example use: drop a logo or a face into a clip at frame 50, and have it streak and bleed downward as the camera pans, until the clip "recovers" at frame 120.

The two transition styles:
- **smear** — clear residuals (zero DCT), keep motion vectors → image smears with the video's motion.
- **freeze** — clear residuals AND zero motion vectors → image stays frozen in place.

---

## 2. The pipeline (current, broken)

The hijack path lives in `_execute_mosh_pipeline` (`common.py:26`), branched on `inject_mode in ("file", "frame")`. It runs **four** stages:

### Stage 0 — Splice the image into the video (`common.py:108-255`)

```
image_file ──► ffmpeg loop ──► img_vid.mp4 (1 frame of the image as video)
                                       │
input.mp4 ──┬─► Part 1 (frames 1..start_frame)  [untouched bookend]
            └─► Part 2 (frames start_frame..end)
                    │
                    └─► skip 1st frame ──► concat with img_vid.mp4
                                              │
                                              ▼
                                        concat.mp4  (image replaces frame at cut)
```

The image is turned into a 1-frame video, then **concatenated** with the source video (minus its first frame at the cut point). This creates a **hard cut** — two completely different images adjacent in the stream.

### Stage 1 — ffgac transcode to raw MPEG-2 (`common.py:257-278`)

```bash
ffgac -i concat.mp4 -an -vcodec mpeg2video \
      -mpv_flags +nopimb+forcemv -qscale:v 1 \
      -intra_penalty 1000000000 \
      -g max -sc_threshold max \
      -pict_type_script no_keyframe.js \    # ← forces every frame to P-type
      -f rawvideo -y prepped.m2v
```

Key flags:
- `+nopimb+forcemv` — force motion-vector computation per macroblock.
- `-intra_penalty 1000000000` — strongly discourage intra blocks (prefer inter prediction).
- `-pict_type_script no_keyframe.js` — suppress **all** keyframes; every frame is a P-frame.
- Output is raw MPEG-2 (`.m2v`).

### Stage 2 — ffedit glitch (`common.py:280-347`)

For **smear** (`glitch_mode == 2`):
```bash
ffedit -i prepped.m2v -s custom_glitch.js -sp "[2, 1, REL_END, 100, 0, 0]" -o glitched.m2v -y
```

`custom_glitch.js` mode 2 = **Residual Destruct**: zeros out every `q_dct` coefficient in every macroblock in range. The intent: with residuals zeroed, the decoder reconstructs each frame purely from motion-vector prediction, so the image "bleeds" across frames.

For **freeze** (`glitch_mode == 4`): two passes — first mode 2 (clear residuals), then mode 3 (zero motion vectors).

### Stage 3 — ffmpeg re-encode to MP4 (`common.py:351-364`)

```bash
ffmpeg -i glitched.m2v -i concat.mp4 \
       -map 0:v -map 1:a? \
       -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy -y output.mp4
```

The glitched raw stream is muxed with the original audio and re-encoded to H.264.

### Stage 4 — Reassemble with bookends (`common.py:366-396`)

If `start_frame > 1`, the clean Part 1 is concatenated with the glitched output so the final video has untouched footage up to the cut, the glitched section, then recovery.

---

## 3. The bug — exact mechanism

### 3.1 The hard cut breaks motion estimation

When `concat.mp4` is made (Stage 0), frame N is the injected image and frame N+1 is the original video content. These are **completely unrelated** — a red square next to a testsrc pattern, for example.

When ffgac transcodes this to MPEG-2 (Stage 1), it runs motion estimation across that cut. The encoder tries to express "frame N+1's macroblocks are predicted from frame N's macroblocks, plus a residual." But there is **no valid motion** between a red square and a testsrc — the search fails.

The encoder has two fallback modes for unmatchable blocks:
1. **Inter with huge residual** — encode the difference as a massive DCT residual.
2. **Intra block** — encode the block from scratch (no prediction), with its own DCT.

Because `-intra_penalty` is set to `1000000000`, the encoder *prefers* inter with huge residuals. But at a hard cut, even that fails, and you get a mix of enormous residuals and forced intra blocks.

### 3.2 Residual Destruct zeros everything — including the fallback blocks

`custom_glitch.js` mode 2 walks **every** macroblock in **every** frame in range and sets **all** `q_dct` coefficients to 0:

```js
// custom_glitch.js:46-62
for ( let p = 0; p < planes.length; p++ ) {
  const plane = planes[p];
  for ( let r = 0; r < plane.length; r++ ) {
    const row = plane[r];
    for ( let c = 0; c < row.length; c++ ) {
      const block = row[c];
      if ( block ) {
        for ( let i = 0; i < block.length; i++ ) {
          block[i] = 0;            // ← zeroes DC + all AC coefficients
        }
      }
    }
  }
}
```

This is **blind** — it does not distinguish:
- A normal inter block (where zeroing residuals = nice smear).
- An intra block at the cut (where the DCT coefficients **are** the block — zeroing them erases the block entirely).
- A block whose coded_block_pattern (CBP) indicates "no coefficients present" (where zeroing creates an invalid CBP of -1).

### 3.3 Invalid CBP → corrupt bitstream → error concealment → green

When all coefficients of an intra block are zeroed, the decoder reads a CBP of 0 (or -1 after the encoder's bookkeeping breaks). MPEG-2 **requires** intra blocks to have at least a DC coefficient. A CBP that says "this intra block has no data" is **illegal** in the bitstream.

ffmpeg's mpeg2 decoder hits this and logs:
```
[mpeg2video @ ...] invalid cbp -1 at 4 8
[mpeg2video @ ...] Invalid mb type in P-frame at 18 11
[mpeg2video @ ...] concealing 284 DC, 284 AC, 284 MV errors in P frame
[mpeg2video @ ...] corrupt decoded frame
```

**Error concealment** kicks in: ffmpeg replaces the undecodable frame with a "blank" YUV placeholder — `Y=0, U=0, V=0`. In YUV→RGB conversion, `Y=0, U=0, V=0` maps to **`rgb(0, 135, 0)`** — a pure, saturated green. This is the classic "green screen of death" in corrupted MPEG-2.

### 3.4 Why only frame 1 is correct

Frame 0 (the injected image) is encoded as a **P-frame** referencing... nothing useful (or as the first frame after the I-frame at the very start of the stream). Because it's the first content frame and the image video was a clean single frame, it decodes correctly — you see the red square for exactly one frame.

Frame 1 onward references frame 0 via motion vectors, but the residuals have been zeroed AND the blocks at the cut are invalid. The decoder fails, conceals, and outputs green. Every subsequent P-frame references the green frame before it, so the error propagates — green for the entire glitch duration.

### 3.5 Reproduction proof

Reproduced with testsrc (3s, 30fps, 320x240) + red image, start_frame=1:

```
frame_001.png  ( 252.0,    0.0,    0.0)  → RED (correct, injected image)
frame_002.png  (   0.0,  135.0,    0.0)  → GREEN (error concealment)
frame_003.png  (   0.2,  134.8,    0.0)  → GREEN
frame_004.png  (   0.2,  134.8,    0.0)  → GREEN
...
frame_010.png  (   0.4,  134.6,    0.1)  → GREEN
```

ffmpeg stderr:
```
[mpeg2video @ ...] invalid cbp -1 at 4 8
[mpeg2video @ ...] concealing 284 DC, 284 AC, 284 MV errors in P frame
[mpeg2video @ ...] corrupt decoded frame
```

---

## 4. Why this is hard — what makes the obvious fixes fail

### 4.1 "Don't zero the residuals at the cut"

If you simply skip zeroing for the first few frames (the cut region), the smear never starts — the image just appears for one frame and then the video snaps back to normal. The whole point of the glitch is that the image **bleeds**; without residual destruction there's no bleed.

### 4.2 "Use an I-frame at the cut"

If you encode the cut frame as an I-frame, it decodes cleanly (no prediction, no invalid CBP). But then the P-frames after it reference the I-frame correctly, and you get a clean image that **doesn't smear** — the motion vectors predict from the clean image, residuals correct it, and the image just sits there. You've removed the glitch.

### 4.3 "Lower intra_penalty so the encoder uses intra blocks"

This makes the problem **worse**. More intra blocks = more blocks whose DCT coefficients ARE the pixel data. Zeroing them erases more content → more invalid CBPs → more green.

### 4.4 "Don't suppress keyframes (drop no_keyframe.js)"

Without keyframe suppression, ffgac inserts an I-frame at the hard cut (scene-change detection). That I-frame decodes cleanly, but it also **resets the prediction chain** — the P-frames after it reference the new I-frame, the old motion is discarded, and the smear effect is lost. You get a clean cut to the image, then clean video. No glitch.

### 4.5 "Zero residuals only on inter blocks, skip intra blocks"

This is closer but still fails. At the cut, the encoder produces a **mix** of inter blocks (with huge residuals) and intra blocks. If you zero only inter residuals:
- The inter blocks become "predict from previous frame with no correction" — they copy motion-warped content from frame 0 (the image). Good.
- The intra blocks retain their DCT data — they show the **original video content** at the cut. Bad.

The result is a torn, partially-green, partially-correct mess. The intra blocks at the cut still reference invalid CBP states because the encoder's intra/inter decision and the CBP are coupled in ways that are hard to disentangle after the fact.

### 4.6 "Re-encode the image as a video first, then splice"

This is what the code already does (`img_vid.mp4`). The problem isn't the image encoding — it's the **concatenation** that creates the hard cut. Any time you place two unrelated frames adjacent and force P-frame prediction across them, motion estimation fails.

### 4.7 "Use a longer crossfade / blend at the cut"

A blend avoids the hard cut but destroys the datamosh aesthetic — the image would fade in, not smear. The whole point is the hard, glitchy, digital-artifact look. A blend is a different effect entirely.

---

## 5. The fundamental tension

The bug is a **fundamental tension** between two requirements:

1. **To smear**, you need the decoder to reconstruct frames from motion-vector prediction with zeroed residuals. This requires valid inter blocks with valid CBPs.
2. **To inject an image at a cut**, you need the encoder to encode a hard cut as P-frames. This produces invalid intra blocks and invalid CBPs at the cut.

You cannot have both: the hard cut **always** produces blocks that break when their residuals are zeroed. The current pipeline tries, and produces green.

---

## 6. The way forward (per the task hint)

The hint in the task points to the only viable redesign:

> *"you will likely need to redesign how the injection handles motion vectors (e.g., extracting mv from the video, generating a static video of the image, and applying the video's mv to the image's stream using ffedit -a)"*

### 6.1 The insight

The smear effect comes from **motion vectors dragging the image across frames**. The current pipeline tries to get those motion vectors from the encoder at the cut — but the encoder can't produce valid vectors there.

The workaround: **get the motion vectors from the video itself** (where they're valid), and **apply them to a separate stream of the image**. Then splice the image-with-vectors into the video. The image stream carries the video's motion, so when decoded, the image smears — but because the image stream was encoded cleanly (no hard cut), its blocks are valid and don't turn green.

### 6.2 Proposed pipeline

```
video.mp4 ──► ffgac ──► prepped.m2v ──► ffedit -e mv.json    (export MVs from video)
                                     │
                                     ▼
                              ffedit -a mv.json ◄── img_vid.m2v  (apply MVs to image stream)
                                     │
                                     ▼
                              img_with_mv.m2v  (image encoded with video's motion vectors)
                                     │
                                     ▼
                         splice into video at cut point
                                     │
                                     ▼
                              ffmpeg → output.mp4
```

Key difference: the image is encoded **separately** as a clean video (all frames = the image), then the video's motion vectors are **imported** into it via `ffedit -a`. The image stream now "thinks" it has the video's motion, so the decoder drags the image around — but every block is valid because there was never a hard cut in the image stream.

### 6.3 Why this avoids the green

- The image stream is encoded from a **uniform video** (all identical frames). Motion estimation produces zero vectors and zero residuals — all valid.
- Importing the video's MVs replaces those zero vectors with real motion. The residuals stay zero (or near-zero).
- When decoded, each frame predicts from the previous frame using the imported MVs, with zero residual correction → the image smears.
- No invalid CBPs are created because the block structure was valid before MV import, and MV import doesn't touch CBPs or coefficients.

### 6.4 Complications

- **Frame count matching**: the image video must have the same number of frames as the glitch duration, and the MV export must cover exactly that range.
- **MV coordinate systems**: the exported MVs are relative to the video's resolution and macroblock grid. The image video must match those exactly.
- **Splice points**: splicing the image-with-MVs stream into the video still creates cuts, but now the cuts are at the **bookends** of the glitch region, where the content is similar enough that the decoder doesn't produce invalid blocks. Or: the entire glitch region is replaced by the image-with-MVs stream, and the bookends are clean because the image stream's first/last frames are valid I-frames.
- **Audio**: the image stream has no audio; audio must be spliced from the original.
- **The `-a` flag**: `ffedit -i input -a data.json -o output` applies exported data. The JSON must be in the exact format that `-e` produces. This has been verified to work for MVs.

---

## 7. Files involved

| File | Role |
|------|------|
| `mtapi-project/app/operations/datamosh/common.py` | Pipeline orchestrator — `_execute_mosh_pipeline` runs all 4 stages |
| `mtapi-project/app/operations/datamosh/hijack.py` | Params + handler — calls `_execute_mosh_pipeline` with `glitch_mode=2` (smear) or `4` (freeze) |
| `mtapi-project/bin/custom_glitch.js` | Mode 2 = zero q_dct (Residual Destruct); Mode 3 = modify MVs |
| `no_keyframe.js` | Forces all-P-frame encoding |
| `mtapi-project/app/shell.py` | `run_command()` — async subprocess with argv lists, never shell=True |
| `mtapi-project/app/probe.py` | `probe_duration`, `probe_fps`, etc. |
| `mtapi-project/app/pathutil.py` | `unique_output_path`, `finalize_output_path` |
| `mtapi-project/app/contract.py` | `OperationResult`, `OperationSpec`, `register` |
| `mtapi-project/app/output_dir_ctx.py` | Request-scoped output directory |

---

## 8. Validation test (required before declaring fixed)

The task requires an automated, non-visual test:

1. Generate 3s 30fps testsrc video + static red image.
2. Run through `datamosh_hijack` natively.
3. Extract frames 1–10 as PNGs.
4. Analyze pixel colors (Python PIL).
5. **FAIL** if any frame is `rgb(0, 135, 0)` (±tolerance) — error-concealment green.
6. **FAIL** if ffgac/ffedit/ffmpeg log `invalid cbp`, `corrupt`, `conceal`, `out of range`, or `numerical result`.
7. **PASS** only if no green frames AND no bitstream errors.

This test must be created and must PASS before the task is complete.

---

## 9. Glossary

| Term | Meaning |
|------|---------|
| **MV** | Motion vector — the (dx, dy) offset a macroblock is predicted from |
| **q_dct** | Quantized DCT coefficients — the residual correction after prediction |
| **CBP** | Coded Block Pattern — bitmask saying which coefficient blocks are present |
| **P-frame** | Predicted frame — reconstructed from previous frame via MVs + residual |
| **I-frame** | Intra frame — self-contained, no prediction |
| **Intra block** | A macroblock encoded without prediction (its DCT IS the pixels) |
| **Inter block** | A macroblock encoded with prediction (DCT is the residual) |
| **Residual** | The difference between predicted and actual — stored as DCT coefficients |
| **Error concealment** | ffmpeg's fallback for undecodable frames — fills with Y=0,U=0,V=0 → green |
| **ffgac** | ffglitch's MPEG encoder — outputs editable raw streams |
| **ffedit** | ffglitch's frame editor — runs JS scripts, exports/applies MV/DCT data |
| **-e flag** | Export stream data (MVs, DCT) to JSON |
| **-a flag** | Apply exported data back into a stream |

---

## 10. Summary

The green-screen bug is **not** a coding error — it's a **fundamental incompatibility** between (a) forcing P-frame prediction across a hard content cut and (b) zeroing the residuals of the resulting broken blocks. The encoder produces invalid intra blocks and invalid CBPs at the cut; zeroing their coefficients destroys the only data they had; the decoder conceals the undecodable frames as solid green.

Every "simple" fix either removes the glitch or keeps the green. The only viable path is to **stop relying on the encoder to produce motion vectors at the cut** and instead **export the video's valid MVs and apply them to a separately-encoded image stream** — decoupling the motion (which comes from the video) from the content (which is the image) so that no hard cut ever enters the encoder.
