"""
Sequence Erase → RIFE → Conform lineage registry.

Spec: docs/sequence-erase-pipeline-spec.md §2–§3, §5.3, §6.

A ``lineageId`` identifies the underlying source clip (one media lineage),
not a Sequence occurrence (``sequence[].id`` stays the occurrence identity).
Masks belong to a lineage; all occurrences of one source share the mask.

This module is pure orchestration bookkeeping: stdlib only. It never spawns
subprocesses and never touches ffmpeg/RIFE/ONNX — stage work stays inside
the existing ``erase_remove`` / ``rife`` / ``conform`` operations.

On-disk layout (sibling of the media cache, never a pHash/wall source):

    <LINEAGE_ROOT>/<lineageId>/mask.png    canonical binary mask
    <LINEAGE_ROOT>/<lineageId>/mask.json   mask ref: id, dims, erase settings

Pool/Sequence entries carry only references (``lineage_id``, ``clean_path``,
``clean_signature``, ``erase_mask_id``, ``erase_settings``); the store holds
the bytes.
"""

import base64
import hashlib
import json
import os
import struct
import time
import uuid
from pathlib import Path
from typing import Any

LINEAGE_VERSION = 1

MASK_THRESHOLD = 127
CLEAN_KIND = "clean"


def lineage_root() -> Path:
    """Absolute lineage store root (masks only — never a pHash source)."""
    env = os.environ.get("MTAPI_LINEAGES")
    if env:
        return Path(env).expanduser().resolve()
    from .config import MEDIA_ROOT

    return MEDIA_ROOT.parent / "lineages"


def lineage_dir(lineage_id: str) -> Path:
    return lineage_root() / str(lineage_id)


def mask_path_for(lineage_id: str) -> Path:
    return lineage_dir(lineage_id) / "mask.png"


def mask_meta_path_for(lineage_id: str) -> Path:
    return lineage_dir(lineage_id) / "mask.json"


def new_lineage_id() -> str:
    return str(uuid.uuid4())


def normalize_lineage_id(value: Any) -> str | None:
    """A persisted lineage ID is reused only when it is a valid UUID."""
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value.strip()))
    except (ValueError, AttributeError):
        return None


def canonical_source_path(raw: Any) -> str | None:
    if not raw:
        return None
    try:
        p = Path(str(raw)).expanduser()
    except OSError:
        return None
    try:
        return str(p.resolve()) if p.exists() else str(p)
    except OSError:
        return str(p)


def ensure_lineage_id_for_path(path: Any, existing: Any = None) -> str:
    """Reuse a persisted lineage ID, else mint one for this source path."""
    kept = normalize_lineage_id(existing)
    if kept:
        return kept
    return new_lineage_id()


def migrate_entries(
    items: list[dict[str, Any]] | None,
    sequence: list[dict[str, Any]] | None,
) -> dict[str, str]:
    """Assign stable lineage IDs per distinct canonical source path.

    Pure migration helper (no media reads): reuses valid persisted IDs,
    mints one UUID per distinct canonical path, and writes it back onto
    every pool item and Sequence entry in place. Returns path → lineageId.
    ``sequence[].id`` (occurrence identity) is never touched.
    """
    by_path: dict[str, str] = {}
    for row in list(items or []) + list(sequence or []):
        if not isinstance(row, dict):
            continue
        canon = canonical_source_path(row.get("path"))
        if not canon:
            continue
        lid = by_path.get(canon)
        if lid is None:
            lid = ensure_lineage_id_for_path(canon, row.get("lineage_id") or row.get("lineageId"))
            by_path[canon] = lid
        row["lineage_id"] = lid
    return by_path


def group_occurrences_by_lineage(
    sequence: list[dict[str, Any]] | None,
) -> dict[str, list[dict[str, Any]]]:
    """Occurrence rows bucketed by lineage (dedup key for batch work)."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in sequence or []:
        if not isinstance(row, dict):
            continue
        lid = normalize_lineage_id(row.get("lineage_id") or row.get("lineageId"))
        key = lid or f"path:{canonical_source_path(row.get('path')) or row.get('path')}"
        groups.setdefault(key, []).append(row)
    return groups


# ── mask bytes ─────────────────────────────────────────────────────────────


def decode_mask_b64(raw: str) -> bytes:
    txt = (raw or "").strip()
    if "," in txt:  # data-URL prefix
        txt = txt.split(",", 1)[1]
    if not txt:
        raise ValueError("empty mask")
    try:
        return base64.b64decode(txt, validate=True)
    except Exception as e:
        raise ValueError(f"mask is not valid base64 PNG: {e}") from e


def png_dimensions(png: bytes) -> tuple[int, int]:
    """IHDR dimensions without image deps (stdlib struct parse)."""
    if len(png) < 33 or png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("mask is not a PNG")
    # IHDR chunk follows the 8-byte signature: length(4) + "IHDR"(4) + data(13).
    length = struct.unpack(">I", png[8:12])[0]
    if png[12:16] != b"IHDR" or length < 13:
        raise ValueError("mask PNG has no IHDR")
    w, h = struct.unpack(">II", png[16:24])
    if w <= 0 or h <= 0 or w > 8192 or h > 8192:
        raise ValueError(f"mask PNG dimensions out of range: {w}x{h}")
    return w, h


def mask_signature(mask_bytes: bytes) -> str:
    """Mask content hash — the mask signature (spec §3.2)."""
    return hashlib.sha256(bytes(mask_bytes)).hexdigest()


ERASE_SETTING_KEYS = (
    "hd_strategy",
    "crop_trigger",
    "crop_margin",
    "resize_limit",
    "device",
)

ERASE_DEFAULTS: dict[str, Any] = {
    "hd_strategy": "Crop",
    "crop_trigger": 800,
    "crop_margin": 128,
    "resize_limit": 1280,
    "device": "GPU",
}


def normalize_erase_settings(raw: Any) -> dict[str, Any]:
    """Canonical erase-setting subset that participates in signatures."""
    src = dict(raw) if isinstance(raw, dict) else {}
    out: dict[str, Any] = {}
    for key in ERASE_SETTING_KEYS:
        val = src.get(key, ERASE_DEFAULTS[key])
        if key in ("crop_trigger", "crop_margin", "resize_limit"):
            try:
                val = int(val)
            except (TypeError, ValueError):
                val = ERASE_DEFAULTS[key]
        else:
            val = str(val)
        out[key] = val
    return out


def erase_signature(mask_id: str, width: int, height: int, settings: dict[str, Any]) -> str:
    """Short signature binding mask content + dims + erase settings."""
    norm = normalize_erase_settings(settings)
    raw = "|".join([
        str(mask_id), str(int(width)), str(int(height)),
        *(f"{k}={norm[k]}" for k in ERASE_SETTING_KEYS),
    ])
    return hashlib.blake2b(raw.encode(), digest_size=8).hexdigest()


def clean_output_name(source: Path, mask_sig: str, erase_sig: str) -> Path:
    """Collision-safe sibling name (spec §3.2); never the source itself."""
    stem = source.stem
    ext = (source.suffix or ".mp4").lower()
    return source.parent / f"{stem}_clean_{mask_sig[:8]}_{erase_sig[:8]}{ext}"


def save_mask(
    lineage_id: str,
    mask_png: bytes,
    width: int,
    height: int,
    settings: Any = None,
) -> dict[str, Any]:
    """Persist the canonical lineage mask; returns the mask record."""
    lid = normalize_lineage_id(lineage_id)
    if not lid:
        raise ValueError(f"invalid lineage_id: {lineage_id!r}")
    png_w, png_h = png_dimensions(mask_png)
    if int(width) != png_w or int(height) != png_h:
        raise ValueError(
            f"mask dimensions {png_w}x{png_h} != declared {width}x{height}"
        )
    norm = normalize_erase_settings(settings)
    mid = mask_signature(mask_png)
    d = lineage_dir(lid)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "mask.png.tmp"
    tmp.write_bytes(mask_png)
    tmp.replace(mask_path_for(lid))
    record = {
        "lineage_id": lid,
        "mask_id": mid,
        "mask_path": str(mask_path_for(lid)),
        "width": png_w,
        "height": png_h,
        "threshold": MASK_THRESHOLD,
        "erase_settings": norm,
        "updated_at": time.time(),
        "version": LINEAGE_VERSION,
    }
    meta_tmp = d / "mask.json.tmp"
    meta_tmp.write_text(json.dumps(record, indent=2), encoding="utf-8")
    meta_tmp.replace(mask_meta_path_for(lid))
    return record


def load_mask_record(lineage_id: str) -> dict[str, Any] | None:
    lid = normalize_lineage_id(lineage_id)
    if not lid:
        return None
    meta = mask_meta_path_for(lid)
    if not meta.is_file():
        return None
    try:
        record = json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    if not mask_path_for(lid).is_file():
        return None
    return record


def load_mask_bytes(lineage_id: str) -> bytes | None:
    lid = normalize_lineage_id(lineage_id)
    if not lid:
        return None
    try:
        return mask_path_for(lid).read_bytes()
    except OSError:
        return None


def clear_mask(lineage_id: str) -> bool:
    """Remove a lineage mask (files kept for artifacts are never deleted)."""
    lid = normalize_lineage_id(lineage_id)
    if not lid:
        return False
    removed = False
    for p in (mask_path_for(lid), mask_meta_path_for(lid)):
        try:
            if p.is_file():
                p.unlink()
                removed = True
        except OSError:
            pass
    return removed


# ── artifact validity (spec §5.3) ──────────────────────────────────────────


def source_stat(path: Any) -> dict[str, Any] | None:
    try:
        st = Path(str(path)).expanduser().stat()
    except OSError:
        return None
    return {"size": int(st.st_size), "mtime": float(st.st_mtime)}


def output_usable(path: Any) -> bool:
    try:
        p = Path(str(path)).expanduser()
        return p.is_file() and p.stat().st_size > 0
    except OSError:
        return False


def clean_detail(
    *,
    lineage_id: str,
    original_path: str,
    mask_id: str,
    width: int,
    height: int,
    settings: Any,
    source_size: int,
    source_mtime: float,
    output_path: str,
) -> dict[str, Any]:
    norm = normalize_erase_settings(settings)
    return {
        "kind": CLEAN_KIND,
        "lineage_id": lineage_id,
        "derived_from": str(original_path),
        "mask_id": str(mask_id),
        "mask_width": int(width),
        "mask_height": int(height),
        "erase_signature": erase_signature(mask_id, width, height, norm),
        "erase_settings": norm,
        "source_size": int(source_size),
        "source_mtime": float(source_mtime),
        "output_path": str(output_path),
    }


def is_clean_detail_valid(
    detail: Any,
    *,
    lineage_id: str,
    original_path: str,
    mask_id: str,
    width: int,
    height: int,
    settings: Any,
    source_size: int | None = None,
    source_mtime: float | None = None,
) -> tuple[bool, str]:
    """Complete-signature reuse check for a clean artifact (spec §5.1.3)."""
    if not isinstance(detail, dict):
        return False, "no clean record"
    if detail.get("lineage_id") != lineage_id:
        return False, "lineage mismatch"
    if detail.get("derived_from") != str(original_path):
        return False, "source mismatch"
    if detail.get("mask_id") != str(mask_id):
        return False, "mask changed"
    if int(detail.get("mask_width") or 0) != int(width) or int(detail.get("mask_height") or 0) != int(height):
        return False, "mask dimensions changed"
    want_sig = erase_signature(mask_id, width, height, settings)
    if detail.get("erase_signature") != want_sig:
        return False, "erase settings changed"
    if source_size is not None and detail.get("source_size") != int(source_size):
        return False, "source replaced"
    if source_mtime is not None:
        try:
            if abs(float(detail.get("source_mtime") or 0) - float(source_mtime)) > 1e-3:
                return False, "source replaced"
        except (TypeError, ValueError):
            return False, "source replaced"
    out = detail.get("output_path") or detail.get("path")
    if not output_usable(out):
        return False, "output missing"
    return True, "valid"


def find_valid_clean(
    variants: dict[str, Any] | None,
    **expected: Any,
) -> dict[str, Any] | None:
    """Newest valid clean variant, or None (reuse by complete signature)."""
    cands = (variants or {}).get(CLEAN_KIND) or []
    for v in reversed(cands):
        if not isinstance(v, dict):
            continue
        detail = v.get("detail") or {}
        merged = {**detail, "output_path": v.get("path") or detail.get("output_path")}
        ok, _ = is_clean_detail_valid(merged, **expected)
        if ok:
            return v
    return None


def downstream_after_mask_change() -> list[str]:
    """A changed mask invalidates clean + every downstream artifact (spec §5.3)."""
    return ["erase", "rife", "conformed"]


def downstream_after_timing_change() -> list[str]:
    """A changed occurrence time/conform setting invalidates only conform."""
    return ["conformed"]
