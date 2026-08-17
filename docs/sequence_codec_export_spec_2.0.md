# Sequence Export Codec Selection Spec — v2.0

> **Status:** Proposed (not yet implemented)
> **Supersedes:** `sequence_codec_export_spec.md` (v1.0)
> **Scope:** Join / Multi-clip codec export only. Resolution/aspect reconciliation
> (pad / crop / stretch) already works via `transmute -j` and is **out of scope** here —
> v1.0 mixed the two; this version separates them so the codec work can land without
> re-litigating reconcile.
> **Verified against tree @** `mtapi-project` (paths below confirmed to exist).

---

## 1. Goal

`join` (and the Pool Sequence Builder) currently outputs to whatever `transmute -j`
hardcodes — H.264 CRF 18 in an `.mp4`. We want stitched sequences to export to the
same professional targets the Convert tab already supports: DaVinci Resolve intermediates
(`dnxhr_lb` / `dnxhr_sq` / `dnxhr_hq`), ProRes, HEVC/AV1 delivery, FFV1 archive, etc.

The codec recipes already exist in one place (`app/convert_presets.py` →
`ENCODE_PRESETS`). We reuse them — we do **not** fork ffmpeg args into the join op.

---

## 2. Decisions (resolved with user)

| # | Question | Decision |
|---|----------|----------|
| 1 | How does the frontend get the preset list? | **New `/api/presets` endpoint** serving `ENCODE_PRESETS` from `convert_presets.py`. Single source of truth (DRY). (v1.0 incorrectly said "fetch from `/api/meta` as Convert does" — Convert *hardcodes* in `convert.js`; there is no preset endpoint today.) |
| 2 | Backend stitch when a target codec is requested? | **Stitch entirely in Python** via a new `video_pipeline.concat_clips(...)`. No bash `transmute -j` call on the target-preset path. (v1.0's Option B still called `_run_transmute` for the stitch, which contradicts "reuse the Python preset engine" — you can't force bash's output codec without the very `-E` flag it wanted to avoid.) |
| 3 | Scope? | **Codec export only.** Reconcile (pad/crop/stretch) is already implemented and untouched. |

---

## 3. Ground truth (verified file paths)

| What | Path | Notes |
|------|------|-------|
| Preset registry | `app/convert_presets.py` | `ENCODE_PRESETS: dict[str, EncodePreset]` (real). `EncodePreset` has `container`, `codec`, `label`, `blurb`, `group`, `extra`, `pix_fmt`, etc. |
| Encode engine | `app/video_pipeline.py` → `encode(...)` | Accepts `encode_preset` kwarg (real). **No concat/stitch function exists yet** — must be added. |
| Join op | `app/operations/transmute_ops.py` | `JoinParams` (line ~214) + `join()` (line ~243). Currently calls `_run_transmute("join", ...)` (bash). No `target` field today. |
| Convert op (template) | `app/operations/convert_ops.py` | Canonical "load preset → `encode(...)`" pattern (Path B/C). Mirror this. |
| Join params model | `app/operations/transmute_ops.py::JoinParams` | Add optional `target: str | None = None`. |
| Frontend Join UI | `app/static/js/tabs/transmute.js` (Multi mode) + `app/static/js/pool/grid.js` (Pool Sequence Builder module) | Dropdown + payload wiring lives here. Exact insertion points unverified — see §6. |
| Frontend glue | `app/static/js/job-control.js`, `app/static/js/pool/persistence.js` | Build + send `POST /ops/join` body (persistence.js already POSTs `/ops/join` at ~line 570). |
| Routes | `app/routes/meta.py` (+ `app/main.py` registers `meta`) | Add `/api/presets` here or in a new `routes/presets.py`. |
| Bash join (reference only) | `bin/transmute` | `join_vf_for_mode()` (line ~183) + concat at ~445/476. Source of truth for the Python stitch's reconcile math — **not** called at runtime on the target path. |

> **Gotcha fixed from v1.0:** v1.0 pointed at `app/static/js/tabs/transmute.js` and
> `app/static/js/pool/grid.js` correctly by luck, but also claimed `/api/meta` serves
> presets — it does not (it serves watcher/cancel/ops). And it named `app/convert_presets.py`
> correctly but described `ENCODE_PRESETS` as if the frontend already consumed it via meta.
> v2.0 uses real names and a real new endpoint.

---

## 4. Backend — new `video_pipeline.concat_clips`

Add an async `concat_clips` to `app/video_pipeline.py`. It replicates the bash
`transmute -j` reconcile + concat, in Python, producing one stitched intermediate
(in the workspace). It does **not** encode to the target codec — that's `encode()`'s job.

Signature (proposed):

```python
async def concat_clips(
    workspace: JobWorkspace,
    inputs: list[str | Path],
    output_path: str | Path,
    *,
    mode: str = "pad",            # pad | crop | stretch  (reconcile)
    aspect: str = "auto",         # auto|1:1|16:9|...|W:H|WxH
    durations: list[float | None] | None = None,  # optional per-clip stretch
) -> dict[str, Any]:
    """Stitch clips end-to-end with reconcile; returns {output_path, fps, ...}."""
```

Reconcile math (mirror `bin/transmute::join_vf_for_mode`, lines ~183-200):

- Compute canvas `W x H` = max content size, snapped to `aspect` (see `snap_canvas_to_ar`, line ~154).
- Per clip `i`, build a filter fragment:
  - `pad`:     `scale=W:H:force_original_aspect_ratio=decrease:flags=lanczos,pad=W:H:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=...[v{i}]`
  - `crop`:    `scale=W:H:force_original_aspect_ratio=increase:flags=lanczos,crop=W:H:(iw-ow)/2:(ih-oh)/2,setsar=1,setpts=...[v{i}]`
  - `stretch`: `scale=W:H:flags=lanczos,setsar=1,setpts=...[v{i}]`
- If `durations` set, apply `setpts` tempo (rubberband audio) per clip like bash `TIME_FACTOR`.
- Concat: `concat=n=N:v=1:a=1[v][a]` (or `a=0` if no audio present in any input).
- Encode the stitched intermediate with a **neutral, fast, near-lossless** codec
  (`libx264 -crf 18 -preset medium`, like bash does today) — this is a temp file inside
  the workspace, NOT the user-facing deliverable.

> Why a temp intermediate + separate `encode()`? Same two-stage pattern Convert uses
> (dump → encode, or load_frames_dir → encode). Keeps the codec recipe in exactly one
> place (`convert_presets.py`) and lets `concat_clips` stay codec-agnostic.

---

## 5. Backend — Join op changes

In `app/operations/transmute_ops.py`:

1. **Add field** to `JoinParams`:
   ```python
   target: str | None = Field(
       None,
       description="Preset id from ENCODE_PRESETS (e.g. 'dnxhr_hq'). "
                   "None = legacy H.264 CRF18 (backward compatible).",
   )
   ```

2. **Branch in `join()`**:
   ```python
   async def join(p: JoinParams) -> OperationResult:
       if p.target:
           if p.target not in ENCODE_PRESETS:
               return OperationResult(ok=False, operation="join",
                                      error=f"Unknown target preset: {p.target}")
           ep = ENCODE_PRESETS[p.target]
           ws = JobWorkspace()  # or unique temp workspace
           intermediate = ws.root / "joined_tmp.mkv"   # neutral container
           await concat_clips(ws, p.input_paths, intermediate,
                              mode=p.mode, aspect=p.aspect, durations=p.durations)
           out = p.output_path or unique_output_path(f"join_{p.target}")
           await encode(ws, out, fps, encode_preset=ep,
                        frame_source_dir=..., mux_audio=True,
                        silence_on_no_audio=True)
           return OperationResult(ok=True, operation="join", output_path=str(out))
       # legacy path unchanged:
       flags = ["-j", p.mode, "-A", p.aspect or "auto"]
       ...
       return await _run_transmute("join", ",", ".join(p.input_paths), flags, ...)
   ```
   Import `ENCODE_PRESETS` from `..convert_presets` and `concat_clips`, `encode` from `..video_pipeline`.

   Constraint: `encode()` consumes a **frame directory** or a **video input**. Confirm
   `concat_clips` output feeds `encode` the way `convert_ops` feeds it (video → dump → encode,
   or direct video encode). If `encode()` requires a frame dir, run `dump()` on the intermediate
   first (mirror Path C in `convert_ops.py`). **Verify this at implementation time** — see §8.

---

## 6. Frontend — dropdown + payload

1. **New endpoint consumer.** Add `/api/presets` (§7). Frontend JS fetches it once and builds
   the "Target Format" `<select>` grouped by `group` (intermediate / delivery / archive),
   reusing the `GROUP_LABELS` + option markup already in `convert.js` (lines ~4-55) — don't
   re-hardcode the list.

2. **Insertion points (verify at implementation — paths confirmed to exist, exact DOM hooks not):**
   - `app/static/js/tabs/transmute.js` — Multi mode form: add `<select id="multiCodec">`
     next to the reconcile (Mode/Aspect) dropdown. Default = empty (`""` → legacy H.264).
   - `app/static/js/pool/grid.js` — Pool Sequence Builder form: same dropdown.
   - `app/static/js/job-control.js` + `app/static/js/pool/persistence.js` — include
     `target: multiCodec.value || null` in the `POST /ops/join` body (persistence.js already
     POSTs `/ops/join` at ~line 570).

3. **Payload:** `{ input_paths, mode, aspect, target, durations?, output_path?, dry_run? }`.
   `target` omitted/empty ⇒ legacy behavior, zero regression for existing users.

---

## 7. Backend — new `/api/presets` endpoint

Add to `app/routes/meta.py` (or a small `routes/presets.py` registered in `app/main.py`):

```python
from ..convert_presets import ENCODE_PRESETS

@app.get("/api/presets", tags=["meta"])
async def api_presets():
    return {
        pid: {
            "id": ep.id,
            "label": ep.label,
            "blurb": ep.blurb,
            "group": ep.group,
            "container": ep.container,
            "codec": ep.codec,
        }
        for pid, ep in ENCODE_PRESETS.items()
    }
```

Single source of truth: frontend and backend both read `ENCODE_PRESETS`. Adding a preset to
`convert_presets.py` automatically surfaces it in Join, Convert, and the API.

---

## 8. Open questions / verify-at-implementation

1. **`encode()` input shape.** `convert_ops` feeds `encode()` either a frame dir (Path B/C)
   or via `dump()`. Confirm whether `concat_clips`'s video output can be passed straight to
   `encode()` or must be dumped to frames first. Pick the path `convert_ops` already uses.
2. **Audio on concat.** bash uses `concat=n=N:v=1:a=1` when any input has audio. Replicate:
   probe each input; if none have audio, use `a=0` and let `encode(..., mux_audio=...)`
   decide. (Reuse `_probe_has_audio` from `app/operations/datamosh/common.py` or promote to
   a shared helper.)
3. **`durations` tempo** — only if v2.0 keeps the existing `durations` param (it does;
   unchanged). `concat_clips` must honor it via `setpts`/rubberband like bash `TIME_FACTOR`.
4. **`unique_output_path` + container.** Target preset dictates container (`.mov` for DNxHR/ProRes,
   `.mp4` for H.264/HEVC/AV1, `.mkv` for FFV1). Use `ENCODE_PRESETS[p.target].container` for the
   output extension, not the legacy `.mp4`. `convert_presets` already maps this (`container_ext`).

---

## 9. Summary of changes

| Layer | Change |
|-------|--------|
| `app/convert_presets.py` | No change (already the source of truth). |
| `app/video_pipeline.py` | **Add** `concat_clips(...)` — Python stitch mirroring bash `transmute -j` reconcile + concat. |
| `app/operations/transmute_ops.py` | Add `target` to `JoinParams`; branch `join()` to Python stitch + `encode(encode_preset=...)`. Legacy path unchanged. |
| `app/routes/meta.py` | **Add** `GET /api/presets` returning `ENCODE_PRESETS` as JSON. |
| `app/static/js/tabs/transmute.js` | Add "Target Format" `<select>` (Multi mode), populated from `/api/presets`. |
| `app/static/js/pool/grid.js` | Same dropdown for Pool Sequence Builder. |
| `app/static/js/job-control.js` + `pool/persistence.js` | Send `target` in `POST /ops/join`. |
| `app/static/js/convert.js` | No change — but its `PRESETS_BY_GROUP` becomes redundant once `/api/presets` exists. Optional future cleanup: have Convert consume the endpoint too. |

**Backward compatibility:** `target` optional + empty ⇒ identical to today's H.264 CRF18 join.
No existing user flow changes.
