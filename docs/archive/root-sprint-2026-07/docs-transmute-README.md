# transmute

change the substance of your video — no scaling, no pixel loss (unless you ask for it).

a single bash script that wraps ffmpeg for the dozen most common video operations. one tool, no dependencies beyond ffmpeg.

## install

```bash
cp transmute ~/.local/bin/
chmod +x ~/.local/bin/transmute
```

or symlink it. make sure `ffmpeg` and `ffprobe` are on your `PATH`.

## usage

```
transmute INPUT [OPTIONS] [OUTPUT]
```

**INPUT** can be a single file, a folder (batch mode), or a comma-separated list for `-j` / `-g`.

if **OUTPUT** is omitted, the script auto-names based on the operation.

## operations

| flag | what it does | example output |
|---|---|---|
| `-f` | extract first frame → PNG | `video_f:00001.png` |
| `-l [N]` | extract last frame → JPG. N = seconds from end (default 0.1) | `video_l:0.1s.jpg` |
| `-a` | extract audio only → M4A | `video_a.m4a` |
| `-c` | crop to 16:9 center | `video_16x9c.mp4` |
| `-b` | letterbox to 16:9 (black bars) | `video_16x9b.mp4` |
| `-s` | crop to 1:1 square center (min side, no scale) | `video_1x1s.mp4` |
| `-S` | letterbox to 1:1 square (max side, pad, no scale) | `video_1x1b.mp4` |
| `-z WxH` | crop to exact resolution (center, no scale) | `video_1080x1080z.mp4` |
| `-x WxH` | stretch to exact resolution (scale, may distort) | `video_640x480x.mp4` |
| `-j [MODE]` | join/stitch clips end-to-end. MODE = pad \| crop \| stretch (default: pad) | `join-pad_1920x1080.mp4` |
| `-g [MODE]` | grid 2×2 panel of 4 videos. MODE = pad \| crop \| stretch (default: pad) | `grid-pad_1440x1440.mp4` |
| `-r` | reverse video (video + audio) | `video_rev.mp4` |
| `-q N` | JPEG quality for `-f` / `-l`. 2–31, lower = better (default: 2) | — |
| `-d` | dry run — print the ffmpeg command, don't execute | — |
| `-h` | show help | — |

**rule:** never scale, never lose pixels — except `-x` and `-g`/`-j` with stretch/crop modes, which intentionally resize.

## examples

```bash
# single file — square crop
transmute input.mp4 -s

# first frame to high-quality PNG
transmute input.mp4 -f

# last 0.5 seconds to JPG
transmute input.mp4 -l 0.5

# exact 1080×1080 crop from center
transmute input.mp4 -z 1080x1080

# stretch to 640×480 (will distort)
transmute input.mp4 -x 640x480

# join three clips end-to-end, padded to max resolution
transmute a.mp4,b.mp4,c.mp4 -j pad

# 2×2 grid of four clips, cropped to uniform tiles
transmute tl.mp4,tr.mp4,bl.mp4,br.mp4 -g crop

# batch: process every video in a folder to 1:1 squares
transmute ./clips -s

# batch with custom output folder
transmute ./clips -s ./squares

# dry run — see what ffmpeg would do
transmute input.mp4 -s -d
```

## join / grid modes

both `-j` and `-g` normalize all inputs to the same tile size (max width × max height across inputs):

| mode | behavior |
|---|---|
| `pad` | pad smaller clips with black bars to match the max size |
| `crop` | scale up to fill, then center-crop to max size |
| `stretch` | scale to exactly match max size (may distort) |

grid layout is `0_0 | w0_0 | 0_h0 | w0_h0` (top-left, top-right, bottom-left, bottom-right).

## requirements

- `ffmpeg`
- `ffprobe`
- `bash` 4+

## notes

- input folders are processed in sorted order for determinism
- audio is preserved wherever possible (`-c:a copy` for single-file ops, aac re-encode for joins/grids)
- `-c`, `-b`, `-s`, `-S`, `-z`, `-x`, `-j`, `-g` are mutually exclusive — pick one geometry operation at a time
- the first-frame filename contains a colon (`video_f:00001.png`) which is intentional but some file managers may not love it
