# Clip Variant Registry Spec (backend-only)

> **Status:** Spec (backend-only; frontend deferred to a single unified pass — see §7)
> **Companion specs:**
> - `sequence_codec_export_spec_2.0.md` — Join codec export (`target`). Will register its output as a `export` variant.
> - `sequence_rife_interpolation_spec.md` — RIFE pre-processing. Will register its output as a `rifed` variant (audio muxed, kept).
> **Verified against tree @** `mtapi-project` (paths/functions below confirmed to exist).

---

## 1. Goal

A single logical clip can have multiple physical derivatives that all belong together:

- **original** — the source the user imported (implicit root; no `variants` entry needed).
- **rifed** — RIFE-interpolated version (more frames, smoother), audio muxed in, *kept* as a first-class artifact.
- **export** — a codec-export output of the clip (e.g. DNxHR/ProRes for Resolve), also kept.

Today each derivative is a separate hashed record in the media cache (`app/media/cache.py`),
and `record_operation()` already links them via `parent_hash` in `history` (cache.py:255).
That link exists but is **not surfaced as a named, queryable association**. This spec adds a
first-class `variants` map to the record so the system (and later the UI) can say "clip X has
a rifed and an export variant" without walking history.

**Out of scope (explicitly):** proxy clips, transcode variants, sidecar-JSON export, and all
UI. The `kind` field is a free string so `proxy`/`transcode` can be added later with zero
schema change — but no logic for them is specified here.

---

## 2. Where things live

- **Association:** central media DB only. Each clip is a content-addressed record at
  `BY_HASH_DIR/<hash>/record.json` (cache.py: `save_record`/`load_record`). The `variants`
  map lives *inside the original clip's record*. No sidecar JSON next to files.
- **Variant files:** stored **next to the original** on disk. If original is
  `/films/clipA.mp4`, its rifed variant lands at `/films/clipA_rifed.mov` and its export at
  `/films/clipA_dnxhr_hq.mov`. The DB records both the hash and the path. (A future option
  could mirror variants into `BY_HASH_DIR`, but that is NOT specified now.)

---

## 3. Record shape (extension to existing `_empty_record`)

`app/media/cache.py` `_empty_record` (line 121) gains one field:

```python
def _empty_record(content_hash: str, size: int = 0) -> dict[str, Any]:
    now = time.time()
    return {
        "hash": content_hash,
        "algo": HASH_ALGO,
        "size": size,
        "paths": [],
        "meta": None,
        "thumbs": {"first": False, "last": False},
        "history": [],
        "variants": {},   # NEW: { kind: [variant_entry, ...], ... }
        "created_at": now,
        "updated_at": now,
        "open_count": 0,
    }
```

**Variant entry schema:**
```python
{
    "kind": "rifed" | "export",        # free string; seed set = {rifed, export}
    "hash": "<content hash of the variant file>",
    "path": "/abs/path/to/clipA_rifed.mov",
    "created_at": <unix ts>,
    "detail": { ... arbitrary, e.g. for rifed: {"multiplier": 4, "target_fps": 60},
                for export: {"preset": "dnxhr_hq"} },
}
```

`variants` is keyed by `kind` → list, so a clip can hold multiple exports (different presets)
or multiple rifed passes if ever wanted. Most clips will have at most one of each.

> The existing `parent_hash` link in `history` (cache.py:255) stays as-is — it's a useful
> audit trail. `variants` is the *fast, named* association layered on top. No removal of
> existing behavior.

---

## 4. New helper: `register_variant`

Add to `app/media/cache.py`:

```python
async def register_variant(
    parent_path: str | Path,
    *,
    kind: str,
    variant_path: str | Path,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Attach a derived clip (rifed/export/...) to its original's record.

    - Hashes the variant file (content-addressed, cached).
    - Loads the ORIGINAL clip's record by path (resolve_hash → record).
    - Appends a variant_entry under record["variants"][kind].
    - Returns the updated parent record, or None if parent not found.
    No file moves/copies — the caller is responsible for writing variant_path
    next to the original (§2).
    """
```

Behavior:
- `parent_hash, _ = await resolve_hash(Path(parent_path).resolve())` (cache.py:200).
- `variant_hash, _ = await resolve_hash(Path(variant_path).resolve())`.
- Load parent record; if missing, return None (caller may create it via open_media first).
- `entry = {"kind": kind, "hash": variant_hash, "path": str(variant_path.resolve()),
  "created_at": time.time(), "detail": detail or {}}`.
- `rec.setdefault("variants", {}).setdefault(kind, []).append(entry)` (cap list length, e.g. 32, like `paths`).
- `save_record(rec)`.
- Also `_remember_path` for the variant path (so the variant file is indexed too).

Add a reader too. **Must be defensive about old records** (created before this spec
existed, so their JSON has no `variants` key) and about **stale files** (variant files
live next to the original, outside the cache's custody, so a user can delete/rename them
via their OS file manager — the parent record would otherwise point at a dead path):

```python
VARIANT_CAP = 32  # max kept per kind, like record["paths"]

def get_variants(
    parent_path: str | Path,
    *,
    include_missing: bool = False,
) -> dict[str, list[dict]]:
    """Return record['variants'] for the clip at parent_path, or {}.

    - Old records without a 'variants' key return {} (no KeyError).
    - By default, entries whose 'path' no longer exists on disk are dropped,
      so callers never load dead files. Pass include_missing=True to keep them
      (e.g. so the UI can show the variant greyed-out as "missing").
    """
    rec = load_record(...)  # resolve parent hash via resolve_hash first
    if not rec:
        return {}
    variants = rec.get("variants", {})
    if include_missing:
        return variants
    return {
        kind: [v for v in entries if v.get("path") and os.path.exists(v["path"])]
        for kind, entries in variants.items()
    }
```

**FIFO cap (point of care for the builder):** when appending, truncate from the FRONT
(oldest first) so the newest variant is always kept:

```python
    lst = rec.setdefault("variants", {}).setdefault(kind, [])
    lst.append(entry)
    del lst[:-VARIANT_CAP]   # keep newest VARIANT_CAP; NOT lst[:VARIANT_CAP] (that drops new)
```

Both helpers are thin wrappers over the existing `resolve_hash` / `load_record` /
`save_record` — no new storage engine, no sidecars.

---

## 5. How the other backends use this

### 5.1 RIFE-keeps-audio (from `sequence_rife_interpolation_spec.md`)
In the pre-processing loop (spec §4.2), when a clip is RIFE'd:
1. Encode RIFE frames → video-only intermediate at `effective_fps * multiplier`.
2. **Mux audio ONLY if the original actually has it.** Probe the original for an audio
   stream first (reuse `app.operations.datamosh.common._probe_has_audio(original_path)`,
   or `video_pipeline.probe(...).get("has_audio")`):
   - **Original HAS audio:** mux it into the RIFE video → write a durable file **next to
     the original**: `<original_stem>_rifed.mov`. Use `concat_clips(..., audio_inputs=[original_path])`
     from the RIFE spec, or a single `ffmpeg -i rife_video -i original -map 0:v -map 1:a
     -c:a copy` mux. The result MUST carry audio.
   - **Original is SILENT (no audio stream):** do NOT attempt `-map 1:a` — FFmpeg hard-crashes
     on a missing stream. Skip the mux; register the video-only RIFE output directly as the
     variant. (No audio to lose.)
3. `await register_variant(original_path, kind="rifed", variant_path=rifed_file,
   detail={"multiplier": multiplier, "target_fps": target_fps, "has_audio": <bool>})`.
4. The rifed file is NOT deleted — it's a kept, addressable variant. The join flow uses
   `processed_paths[i] = rifed_file` for stitching (as the RIFE spec already says), and the
   variant registration is what makes it discoverable later ("show me the rifed version").

### 5.2 Codec export (from `sequence_codec_export_spec_2.0.md`)
When `_join_with_preset` produces an exported clip for an *input* (or, more naturally, when a
single-clip export op runs), register it:
`await register_variant(source_clip_path, kind="export", variant_path=out,
detail={"preset": target})`.
For the Join case, each input clip that gets exported can register its own `export` variant.
(Minimal addition once `register_variant` exists — no new storage work.)

---

## 6. Verification (must run for real)

- Pick `/tmp/clipA.mp4` (any clip). `open_media` it (or `resolve_hash`) so its record exists.
- Simulate a rifed derivative: `ffmpeg -i /tmp/clipA.mp4 -c:v libx264 -crf 18 /tmp/clipA_rifed.mov`
  (stand-in for the real RIFE+mux step).
- `await register_variant("/tmp/clipA.mp4", kind="rifed", variant_path="/tmp/clipA_rifed.mov", detail={"multiplier":2})`.
- `get_variants("/tmp/clipA.mp4")` → `{"rifed": [{hash, path, detail, created_at}]}`.
- Confirm `load_record(original_hash)["variants"]` matches and `record.json` on disk was written
  (no sidecar next to the file — only under `BY_HASH_DIR`).
- Confirm the variant file is still next to the original on disk (§2), not moved into the cache.
- `py_compile app/media/cache.py`; run `e2e_test.py` / pytest if present. Report real exit codes.

---

## 7. Frontend (DEFERRED — single unified pass)

When the backends (codec-export, variant registry, RIFE-keeps-audio) are verified, ONE frontend
spec covers:
- the multi-variant clip node (original expands to rifed/export children; pick which feeds join),
- the codec-export `target` dropdown (already backend-done, GUI missing),
- the RIFE `use_rife` + `target_fps` controls (already spec'd, GUI missing).

All three are "intertwined" in the clip UI, so one coherent build avoids three scattered passes.
This spec does NOT specify frontend behavior.
