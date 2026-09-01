# /api/variants Security Restriction — spec

> **Status:** Implemented (layer 1 shipped; layer 2 REJECTED — see note)
> **Why:** efficiency reviewer flagged `/api/variants` (routes/meta.py) as a CPU/IO
> amplification vector — `get_variants` calls `resolve_hash(parent)`, which does a
> FULL-FILE blake2b hash of whatever path the caller supplies, on every GET,
> unauthenticated, uncached. A request loop or large path pins the box.
> **Fix:** never hash arbitrary caller input on a read endpoint. Use the mtime index.

## The problem (verified)
`app/media/cache.py`:
- `get_variants` (line ~316) calls `parent_hash, _ = await resolve_hash(parent)` (line ~330).
- `resolve_hash` (line 201): on a cache MISS it calls `hash_file(path)` — a full-file
  read (`_hash_file_sync`, line 93). So an unauthenticated GET that supplies a path
  NOT already in the index triggers a full hash of that file. Repeat = DoS-ish.

## The fix
ONE layer — the index lookup. (The originally-specced MEDIA_ROOT guard was REJECTED;
see note below.)

1. **Use the index, not a hash.** Replace `resolve_hash(parent)` with
   `lookup_cached_hash(parent)` (line 74). It returns the hash IFF the path is
   indexed AND size+mtime still match — NO file read on a miss (returns `None`).
   If `None` → the clip was never opened/indexed → return `{}` immediately.
   This is correct: variants are only registered for clips that were hashed during
   a join/RIFE op, so the parent is always in the index. A path outside the index
   has no variants to return anyway.

> **NOTE — MEDIA_ROOT guard REJECTED (2026-08-09):** the spec's layer 2 proposed
> rejecting any path not under `MEDIA_ROOT`. This was WRONG and was dropped during
> implementation. Reason: the frontend queries `/api/variants` for clips anywhere on
> disk — e.g. test clips in `/tmp` (FastSAM/RIFE test assets), user imports outside
> the media cache dir. The guard returned `{}` for those and SILENTLY BROKE the
> variant nodes the frontend depends on (verified: `/tmp/teste.mp4` returned `{}`).
> The real mitigation is layer 1 (`lookup_cached_hash`): on a miss it only does a
> cheap `stat()` + index lookup, NO full-file read. So an unauthenticated GET for
> `/etc/passwd` or a 50GB unindexed file returns `{}` in ~10ms — amplification closed
> without the guard. **Do NOT re-add the MEDIA_ROOT guard.** If true path scoping is
> ever wanted, scope to the pool's known paths or add auth — not a blind MEDIA_ROOT check.

## Exact edit (cache.py, get_variants) — SHIPPED VERSION
```python
async def get_variants(
    parent_path: str | Path,
    *,
    include_missing: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    parent = Path(parent_path).expanduser().resolve()
    # layer 1 only: index lookup, NEVER hash arbitrary caller input
    parent_hash = lookup_cached_hash(parent)   # sync; returns None on miss (no file read)
    if not parent_hash:
        return {}
    rec = load_record(parent_hash)
    if not rec:
        return {}
    variants = rec.get("variants", {})
    if include_missing:
        return variants
    return {
        kind: [v for v in entries if v.get("path") and Path(v["path"]).exists()]
        for kind, entries in variants.items()
    }
```
    if not parent_hash:
        return {}
    rec = load_record(parent_hash)
    if not rec:
        return {}
    variants = rec.get("variants", {})
    if include_missing:
        return variants
    return {
        kind: [v for v in entries if v.get("path") and Path(v["path"]).exists()]
        for kind, entries in variants.items()
    }
```
Note: `lookup_cached_hash` is SYNC (line 74) — call it directly, do not `await`.
Keep the `_lock_for_hash`/`load_record` lock behavior as-is (load_record reads the
record file; it's cheap and already used elsewhere).

## Verification
- `curl "http://localhost:24590/api/variants?path=/tmp/a.mp4"` → still returns the
  rifed variant (a.mp4 was indexed during the join).
- `curl "http://localhost:24590/api/variants?path=/etc/passwd"` → `{}` (outside
  MEDIA_ROOT; also not indexed). No hash of /etc/passwd.
- `curl "...?path=/home/m/some_huge_unindexed_file.mov"` → `{}` immediately, and a
  `time` wrap shows it did NOT read the whole file (compare to pre-fix: it would
  hash). Verify with `time curl` on a large unindexed path — should be ms, not the
  file-read duration.
- `py_compile app/media/cache.py app/routes/meta.py`. e2e_test.py EXIT=0.

## Constraints
- Do NOT change `resolve_hash` itself (other callers rely on its hash-on-miss).
- Do NOT change `register_variant` (it must still hash to build the record).
- Frontend untouched (the unified frontend already calls /api/variants correctly).
- This is a backend-only hardening; no new endpoint, no signature change to
  get_variants (callers pass a path, still get the dict).
