# datamosh.sh

corrupt your video at the motion-estimation level — smear pixels across time, or suppress keyframes so the codec's own motion vectors bleed into chaos. two passes through ffglitch's MPEG-2 toolchain, then re-encoded to a clean shareable mp4.

## install

```bash
cp datamosh.sh melt.js no_keyframe.js ~/.local/bin/
chmod +x ~/.local/bin/datamosh.sh
```

or symlink them. the JS files must live next to the script (it finds them relative to its own location). you need `ffgac`, `ffedit`, `ffmpeg`, and `ffprobe` on your `PATH` — `ffgac` and `ffedit` come from [ffglitch](https://ffglitch.org/), `ffmpeg` and `ffprobe` are standard.

## usage

```
datamosh.sh INPUT OUTPUT [OPTIONS]
```

**INPUT** is a single video file. **OUTPUT** is the path for the final mp4.

## modes

| flag | what it does |
|---|---|
| `--mode melt` (default) | continuous motion-vector smear — image content streaks and drips throughout the whole clip. old motion vectors are averaged over N frames and re-applied, so the past bleeds into the present. works on any footage, no cuts required. |
| `--mode classic` | keyframe-suppression mosh — every frame is forced to P-type so the decoder chains motion vectors from the very first frame. glitches only materialize at hard cuts in your source; a single unbroken shot looks basically untouched. the Avidemux-era technique. |

## melt tuning knobs

these only apply to `--mode melt`:

| flag | default | range | what it does |
|---|---|---|---|
| `--tail N` | 18 | 4–60 | frames of "memory" in the smear. higher = longer, gooier drips. lower = tighter, faster-fading trails. |
| `--hdamp N` | 15 | 0–100 | horizontal damping percent. lower = flatter, more vertical streaking (horizontal motion gets squashed). 100 = no dampening at all. whole numbers only — ffedit's `-sp` parser rejects decimals. |
| `--vdrift N` | 1 | -20 to 20 | constant per-frame vertical push added to the running smear. positive = pixels drift downward. negative = they climb upward. |

the script passes these as a JSON array `[tail, hdamp, vdrift]` to ffedit's `-sp` flag. you can also run melt.js directly if you need more control:

```bash
ffgac -i input.mp4 -an -vcodec mpeg4 -mpv_flags +nopimb+forcemv \
      -qscale:v 1 -fcode 6 -g max -sc_threshold max \
      -f rawvideo -y prepped.m4v

ffedit -i prepped.m4v -s melt.js -sp "[24, 10, 2]" -o glitched.m4v -y

ffmpeg -i glitched.m4v -i input.mp4 -map 0:v -map 1:a? \
       -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy -shortest \
       -y output.mp4
```

## examples

```bash
# default melt with sensible defaults
datamosh.sh input.mp4 output.mp4

# classic keyframe-suppression bleed
datamosh.sh input.mp4 output.mp4 --mode classic

# aggressive vertical drip — long memory, almost no horizontal motion kept
datamosh.sh input.mp4 output.mp4 --tail 40 --hdamp 3 --vdrift 2

# tight, fast smear — short memory, natural horizontal motion
datamosh.sh input.mp4 output.mp4 --tail 8 --hdamp 70 --vdrift 0

# upward drift (negative vdrift)
datamosh.sh input.mp4 output.mp4 --tail 20 --hdamp 10 --vdrift -3
```

## how it works (both modes)

**pass 1 — ffgac**: transcodes your video to a raw MPEG-4 part 2 stream with `-g max` (no automatic keyframes) and `-sc_threshold max` (no scene-change detection). every frame becomes a P-frame chained to the one before it.

**pass 2 — the glitch**:
- **melt**: ffedit runs `melt.js`, which reads every frame's forward motion vectors, dampens horizontal components, adds a vertical drift, then replaces the current frame's vectors with a rolling average of the last N frames. because old motion keeps feeding into new frames instead of resetting, image content trails and drips.
- **classic**: ffgac runs `no_keyframe.js` as a `--pict_type_script`, which returns `"P"` for every frame. no ffedit pass needed — the suppression happens during encoding. the decoder chains motion vectors from frame 0 onward, and any cut to a new scene drags the old scene's pixels across it.

**pass 3 — ffmpeg**: re-encodes the glitched raw stream to a normal H.264 mp4 with the original audio stream copied in.

## what it does NOT do

the standalone `datamosh.sh` only handles melt and classic. the WebUI (`mtapi-project`) exposes additional modes — **hijack** (graft one clip's motion vectors onto another's frames), **residual destruct** (zero out DCT coefficients for pure pixel bleeding), and **motion-vector hack** (arbitrary multiply + drift on vectors). those are Python-driven pipelines in `datamosh_ops.py` that shell out to ffglitch directly and aren't part of this standalone script.

## requirements

- `ffgac` — ffglitch's MPEG encoder (encodes to editable raw stream)
- `ffedit` — ffglitch's frame-level editor (runs JS glitch scripts on P-frames)
- `ffmpeg` — standard, for the final re-encode
- `ffprobe` — standard, bundled with ffmpeg
- `bash` 4+
- `melt.js` and `no_keyframe.js` — must be in the same directory as the script

## notes

- the temp directory is auto-cleaned on exit (even on failure)
- audio is preserved from the original — copied without re-encode (`-c:a copy`)
- `--mode classic` on a single continuous shot produces almost no visible glitch — that's correct behavior, not a bug. the effect needs a cut to manifest
- melt.js overrides work via ffedit's `-sp` flag, which only accepts JSON arrays of integers. `--hdamp` takes a whole-number percent for this reason; the JS divides by 100 internally
- this script is identical to `mtapi-project/bin/datamosh.sh` — the API wraps the same tool. changes to one should be mirrored to the other
