"""
Frame matching: compares query pHash against pool candidates.

Uses cache for resolution, thumbnails for phash generation, and pool for candidates.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .cache import resolve_hash
from .thumbnails import ensure_phashes, ensure_thumbs, hamming_distance_hex
from .pool import load_pool_state

log = logging.getLogger("mtapi.media_store")


async def match_frames(
    query_path: Path,
    *,
    mode: str = "next",
    max_distance: int = 10,
    candidate_paths: list[str] | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """
    Compare query frame pHash against pool candidates.

    mode=next: query LAST vs each candidate FIRST  (what can follow this clip)
    mode=prev: query FIRST vs each candidate LAST  (what could precede)
    mode=both: run both directions, tag each hit

    Candidates default to all items in saved pool_state.json.
    """
    query_path = query_path.resolve()
    if not query_path.is_file():
        return {"ok": False, "error": "Query file not found"}

    mode = (mode or "next").lower()
    if mode not in ("next", "prev", "both"):
        return {"ok": False, "error": "mode must be next|prev|both"}

    max_distance = max(0, min(64, int(max_distance)))
    limit = max(1, min(200, int(limit)))

    q_hash, _ = await resolve_hash(query_path)
    await ensure_thumbs(q_hash, query_path)
    q_ph = await ensure_phashes(q_hash, query_path)

    if mode == "next" and not q_ph.get("last"):
        return {"ok": False, "error": "Could not compute query last-frame pHash"}
    if mode == "prev" and not q_ph.get("first"):
        return {"ok": False, "error": "Could not compute query first-frame pHash"}
    if mode == "both" and not (q_ph.get("first") or q_ph.get("last")):
        return {"ok": False, "error": "Could not compute query frame pHashes"}

    if candidate_paths is None:
        pool = load_pool_state()
        candidate_paths = [it["path"] for it in (pool.get("items") or []) if it.get("path")]

    matches: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    skipped_self = 0
    errors = 0

    for raw in candidate_paths:
        try:
            cpath = Path(raw).resolve()
            if not cpath.is_file():
                continue
            c_hash, _ = await resolve_hash(cpath)
            if c_hash == q_hash:
                skipped_self += 1
                continue
            if c_hash in seen_hashes:
                continue
            seen_hashes.add(c_hash)

            await ensure_thumbs(c_hash, cpath)
            c_ph = await ensure_phashes(c_hash, cpath)

            directions: list[tuple[str, str, str]] = []
            if mode in ("next", "both"):
                directions.append(("next", "last", "first"))
            if mode in ("prev", "both"):
                directions.append(("prev", "first", "last"))

            best_for_cand: dict[str, Any] | None = None
            for dlabel, q_which, c_which in directions:
                qh = q_ph.get(q_which)
                ch = c_ph.get(c_which)
                if not qh or not ch:
                    continue
                dist = hamming_distance_hex(qh, ch)
                if dist is None or dist > max_distance:
                    continue
                if dist == 0:
                    tier = "exact"
                elif dist <= 5:
                    tier = "near"
                elif dist <= 10:
                    tier = "close"
                else:
                    tier = "loose"
                similarity = round(100.0 * (1.0 - dist / 64.0), 2)
                hit = {
                    "path": str(cpath),
                    "name": cpath.name,
                    "hash": c_hash,
                    "distance": dist,
                    "similarity": similarity,
                    "tier": tier,
                    "direction": dlabel,
                    "query_frame": q_which,
                    "match_frame": c_which,
                    "query_phash": qh,
                    "match_phash": ch,
                }
                if best_for_cand is None or dist < best_for_cand["distance"]:
                    best_for_cand = hit

            if best_for_cand:
                matches.append(best_for_cand)
        except Exception as e:
            errors += 1
            log.warning("match candidate failed %s: %s", raw, e)

    matches.sort(key=lambda m: (m["distance"], m["name"].lower()))
    matches = matches[:limit]

    return {
        "ok": True,
        "mode": mode,
        "max_distance": max_distance,
        "query": {
            "path": str(query_path),
            "name": query_path.name,
            "hash": q_hash,
            "phashes": {k: v for k, v in q_ph.items() if v},
        },
        "candidates_scanned": len(seen_hashes) + skipped_self,
        "skipped_self": skipped_self,
        "errors": errors,
        "match_count": len(matches),
        "matches": matches,
    }
