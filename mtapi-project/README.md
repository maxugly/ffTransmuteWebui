# mtapi

Bash tools (`transmute`, `datamosh.sh`) wrapped as a typed HTTP API. This is
the foundation piece from the tabs-vs-nodes conversation: every tool is a
typed operation with declared inputs/outputs, callable over HTTP, with
zero opinion about what eventually calls it — a form, a tab, a future
node graph, or another AI coding tool.

Built and tested end to end while writing this (real ffmpeg calls against
real test clips, not just "should work") — see **Bugs found by testing**
below for what that caught.

## Setup

```bash
pip install -r requirements.txt
```

Needs `ffmpeg`, `ffprobe`, `ffgac`, and `ffedit` on `PATH` — the last two
are ffglitch's, for the datamosh operations (see the earlier writeup for
how to get them). `transmute` and `datamosh.sh` (+ `melt.js` and
`no_keyframe.js`) live in `bin/` already.

## Run

```bash
python run.py
# or, for reload-on-save while you're actively editing:
uvicorn app.main:app --reload
```

Then open `http://localhost:24590/docs` — every operation below shows up
there as a live, typed form you can try directly in the browser. That
page, plus `http://localhost:24590/openapi.json`, is the machine-readable
spec: point another coding tool at the JSON and it has the exact shape of
every input and output with no guessing.

## Calling it

Every operation is one POST with a JSON body:

```bash
curl -X POST http://localhost:24590/ops/square_crop \
  -H "Content-Type: application/json" \
  -d '{"input_path": "/home/you/clips/input.mp4"}'
```

```bash
curl -X POST http://localhost:24590/ops/datamosh_melt \
  -H "Content-Type: application/json" \
  -d '{"input_path": "/home/you/clips/input.mp4", "output_path": "/home/you/clips/melted.mp4", "tail": 30, "hdamp": 5}'
```

**Use absolute paths.** There's no meaningful "current directory" from an
HTTP caller's point of view, so relative paths are ambiguous — see the
cwd bug below for exactly how that bites you if you don't.

`GET /ops` lists everything with its JSON schema. `GET /health` reports
which of the required binaries it could actually find on `PATH`.

## Operations

**transmute** — one op per flag: `first_frame`, `last_frame`,
`extract_audio`, `crop_16x9`, `letterbox_16x9`, `square_crop`,
`square_letterbox`, `crop_exact`, `stretch_exact`, `join`, `grid`,
`fit` (single-clip pad/crop/stretch — Quick Transmute), `reverse`.
Plus `transmute_raw` for arbitrary flag combinations.

**datamosh** — `datamosh_melt`, `datamosh_classic`, plus hijack / residual /
motion-vector variants (Python + ffglitch JS in `bin/`).

**deepdream** — multi-model (InceptionV3 / VGG16 / ResNet50), layer presets,
video optical flow, guided dream, ouroboros feedback video. Cancel + progress.

**facemorph** — dlib landmark morph chain from a folder/list of faces;
optional DeepDream before or after. Needs `~/snc/cod/facemorph` (or
`FACEMORPH_ROOT`) and the 68-point shape predictor.

**withoutbg** — background removal (local open weights or Cloud API).
Knobs: save cutout (RGBA), mask, leftover background.

**styletransfer** — Magenta arbitrary neural style transfer (content + any
style image). Strength and max_side knobs.

**Outputs** never overwrite: `app/pathutil.py` appends `_0001`, `_0002`, …
when the target path already exists (related withoutBG files share one number).

**Jobs** — send `X-Job-Token` on long `POST /ops/*`; poll
`GET /api/job/{token}`; stop with `POST /api/cancel`.

### Folder Watcher (ingest → DNxHR)

Background polling service that watches an input directory for new video
files, stabilizes (waits for file size to stop changing), then transcodes
each to DNxHR-LB `.mov` — Resolve-friendly intermediate format. Processed
originals are moved to a `dun/` subfolder so they don't get picked up
again.

Controlled at `GET /api/watcher` (status) and `POST /api/watcher` (config).
Defaults to **off** at boot — never auto-starts, even if `enabled` was true
last run. The UI has a dedicated tab.

**Status** (`GET /api/watcher`):

```bash
curl -s http://localhost:24590/api/watcher | jq .
```

```json
{
  "ok": true,
  "enabled": false,
  "running": false,
  "in_dir": "/home/m/incoming",
  "out_dir": "/home/m/transcoded",
  "in_dir_ok": true,
  "out_dir_ok": true,
  "target_width": 1920,
  "target_height": 1080,
  "resize_mode": "letterbox",
  "last_error": null,
  "last_event": "done → myclip_resolve.mov",
  "processing": null,
  "processed_count": 7,
  "failed_count": 1,
  "log_lines": ["14:32:01 watcher started", "14:32:05 done → myclip_resolve.mov", ...]
}
```

**Configure / start / stop** (`POST /api/watcher`):

```bash
curl -X POST http://localhost:24590/api/watcher \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "in_dir": "/home/m/incoming",
    "out_dir": "/home/m/transcoded",
    "target_width": 1920,
    "target_height": 1080,
    "resize_mode": "letterbox"
  }'
```

| field | type | default | notes |
|---|---|---|---|
| `enabled` | bool \| null | — | `true` to start, `false` to stop. Omit to leave as-is. |
| `in_dir` | string \| null | — | absolute path to watched folder |
| `out_dir` | string \| null | — | absolute path for DNxHR `.mov` outputs |
| `target_width` | int \| null | 1920 | AR reference width (min 2) |
| `target_height` | int \| null | 1080 | AR reference height (min 2) |
| `resize_mode` | string \| null | `"letterbox"` | `"letterbox"` pads to AR with black bars; `"crop"` scales up then center-crops |

All fields except `enabled` persist to `data/watcher.json` on disk (paths
survive restarts). `enabled` is intentionally NOT persisted — the watcher
always boots off.

**How it works:**

- Polls `in_dir` every 2 seconds
- Detects new files by extension (`.mp4`, `.mov`, `.mkv`, etc.)
- Waits for file size to remain unchanged for 1.5 seconds (stabilization —
  avoids grabbing files still being copied)
- Transcodes: ffprobe → letterbox/crop to target AR → DNxHR-LB (`dnxhd`
  codec, `yuv422p` pixel format) with PCM 16-bit audio (silent audio track
  added if source has none)
- Moves original to `in_dir/dun/` on success
- Keeps up to 80 log lines; counts processed and failed
- If `in_dir` and `out_dir` resolve to the same path, it refuses to start

Every response is the same shape:
```json
{
  "ok": true,
  "operation": "square_crop",
  "output_path": "/home/you/clips/input_1x1s.mp4",
  "dry_run": false,
  "command": "ffmpeg -hide_banner -y -i ...",
  "stdout": "...",
  "stderr": "...",
  "error": null
}
```
**A 200 response with `"ok": false` is normal** — that's the operation
failing (bad file, ffmpeg error), not the request. HTTP 4xx/5xx means the
*request* was malformed (missing field, bad type) or the server itself
broke. Check `ok`, not just status code.

## Adding a new operation

1. Write a Pydantic params model + an `async def` handler that returns an
   `OperationResult`, in a `*_ops.py` file next to `transmute_ops.py` (own
   file for a new tool, or add to an existing one if it's another flag on
   a tool already there).
2. `register(OperationSpec(id=..., summary=..., description=..., params_model=..., handler=..., tags=[...]))`.
3. Add one import line to `app/operations/__init__.py`.

`main.py` never changes — it just walks the registry and builds a route
per entry. This is also the brief for handing a new tool to another
coding agent: "here's an OperationSpec, here's three examples, make one
for X" is close to unambiguous.

## Design decisions, and the bugs testing actually caught

- **Operations shell out to the existing scripts** rather than
  reimplementing their ffmpeg logic in Python. Lower risk (transmute's
  flag logic is already working and stays in one place), and it's the
  right shape for "wrap a CLI tool as a typed op" in general, not just
  for these two.
- **`from __future__ import annotations` in `main.py` silently broke
  request-body parsing.** Every op returned "field required" for `params`
  as if it were a query param — FastAPI's dynamic-route introspection
  needs a real `type` object on `params: spec.params_model`, and
  postponed evaluation turns that into an unresolvable string instead.
  Cost about ten minutes to track down; removing the import fixed every
  route at once, which is what dynamic route generation is supposed to
  buy you.
- **transmute auto-names outputs as bare filenames with no directory** —
  `clip_f:00001.png`, not `/full/path/clip_f:00001.png`. Fine when you're
  sitting in that directory typing the command yourself; wrong for a
  server, which has its own cwd that has nothing to do with where your
  input file lives. Fixed by running the subprocess with `cwd` set to the
  input's directory, and by resolving the parsed `Output:` line to an
  absolute path before it goes in the API response. Without this, the
  first real test run produced a "success" response pointing at a file
  that didn't exist where you'd look for it — would've been a nasty one
  to debug later from a UI three layers up.
- **Naming collision, not fixed, just known:** transmute's output-naming
  only branches on first/last/audio vs. not — it doesn't know or care
  which geometry flag rode along via `transmute_raw`. `-f -s` and `-f -b`
  both auto-name to `<name>_f:00001.png` and will silently overwrite each
  other if you don't pass an explicit `output_path`. Inherited from
  transmute itself, not introduced by the wrapper — pass `output_path`
  explicitly through `transmute_raw` if you're combining flags.

## Known gaps (next, once something actually needs them)

- **Batch/folder mode isn't wired up.** transmute supports it natively;
  the API only takes single files (or the fixed lists join/grid want)
  for now.
- **No upload endpoint.** Paths have to already exist on whatever
  filesystem the API process can see. Fine for a local tool talking to
  your own disk; an upload-then-return-a-path endpoint is a small,
  self-contained addition whenever a browser client needs to hand it
  bytes instead of a path.
- **No auth, no path sandboxing.** It'll open and shell out on any path
  it's given, with this process's own permissions. That's fine on
  localhost/your LAN talking to your own machine; do not put this on the
  open internet without adding both.
- **`dry_run` only exists on transmute ops** — `datamosh.sh` has no `-d`
  equivalent to hook into yet.
