"""
Sequence conform operation (docs/sequence-conform-copy-spec.md).

Conform is a cache-fill op: direct file-to-file ffmpeg (geometry + fps +
baked timing/audio in ONE encode with the conform preset). Never alters the
original — the conformed sibling is registered as kind="conformed".
Cut never consumes or creates conformed Sequence variants.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from .. import job_control

ConformMode = Literal["pad", "crop", "stretch"]


def conform_variant_name(
    parent: Path, *, mode: str, width: int, height: int, preset: str, sig: str
) -> Path:
    stem = parent.stem
    ext = (parent.suffix or ".mp4").lower()
    # Container follows preset; keep source ext unless preset demands .mov.
    try:
        from ..convert_presets import ENCODE_PRESETS
        ep = ENCODE_PRESETS.get(preset)
        if ep is not None:
            ext = (ep.container_ext or ep.container or ext).lower()
            if ext and not ext.startswith("."):
                ext = f".{ext}"
    except Exception:
        pass
    return parent.parent / f"{stem}_conformed_{mode}_{width}x{height}_{preset}_{sig}{ext}"


def signature_short(sig: dict) -> str:
    raw = "|".join(f"{k}={sig.get(k)}" for k in (
        "mode", "aspect", "width", "height", "target_fps",
        "time_factor", "preset", "audio_policy",
        "rife_multiplier", "source_variant", "source_size", "source_mtime",
    ))
    return hashlib.blake2b(raw.encode(), digest_size=6).hexdigest()


class ConformParams(BaseModel):
    input_path: str = Field(..., description="Absolute source clip path")
    source_variant: str = Field("original", description="Selected source variant (original|rifed|dnxhr|...)")
    mode: ConformMode = Field("pad", description="Geometry reconcile: pad|crop|stretch")
    aspect: str = Field("16:9", description="Conform canvas aspect (W:H, WxH, or named)")
    width: int = Field(..., gt=0, description="Conform canvas width")
    height: int = Field(..., gt=0, description="Conform canvas height")
    target_fps: float | None = Field(None, gt=0, description="Target fps (null = keep native)")
    target_duration: float | None = Field(None, gt=0, description="Baked duration (null = native)")
    preset: str = Field("h264_avc_hq", description="Conform preset id (allow-list only)")
    audio_policy: str = Field("encoded", description="Audio policy baked into conform")
    rife_multiplier: int | None = Field(None, ge=2, le=128, description="RIFE multiplier when conforming RIFE output")
    dry_run: bool = False


async def conform(p: ConformParams) -> OperationResult:
    from ..convert_presets import CONFORM_PRESETS, ENCODE_PRESETS, is_conform_preset
    from ..video_pipeline import (
        conform_clip, conform_signature, probe,
        _time_factor,
    )
    from ..media import register_variant

    summary = f"conform {Path(p.input_path).name} → {p.preset}"
    if p.preset not in tuple(CONFORM_PRESETS) or not is_conform_preset(p.preset):
        return OperationResult(ok=False, operation="conform",
                               error=f"preset {p.preset} not in conform allow-list",
                               command=summary)
    if p.mode not in ("pad", "crop", "stretch"):
        return OperationResult(ok=False, operation="conform",
                               error=f"invalid mode: {p.mode}", command=summary)
    src = Path(p.input_path).expanduser()
    if not src.is_absolute():
        return OperationResult(ok=False, operation="conform",
                               error=f"path must be absolute: {p.input_path}",
                               command=summary)
    if not src.is_file():
        return OperationResult(ok=False, operation="conform",
                               error=f"input not found: {src}", command=summary)
    try:
        info = await probe(src)
    except Exception as e:
        return OperationResult(ok=False, operation="conform", error=str(e), command=summary)

    native_dur = float(info.get("duration") or 0.0)
    factor = _time_factor(p.target_duration, native_dur) if p.target_duration else 1.0
    if abs(factor - 1.0) < 1e-3:
        factor = 1.0
    st = src.stat()
    # Collision-safe signature-bearing name beside the source.
    sig_core = {
        "mode": p.mode, "aspect": p.aspect, "width": int(p.width),
        "height": int(p.height), "target_fps": float(p.target_fps) if p.target_fps else None,
        "time_factor": float(factor), "preset": p.preset,
        "audio_policy": p.audio_policy, "rife_multiplier": p.rife_multiplier,
        "source_variant": p.source_variant or "original",
        "source_size": int(st.st_size), "source_mtime": float(st.st_mtime),
    }
    short = signature_short(sig_core)
    out = conform_variant_name(src, mode=p.mode, width=int(p.width),
                               height=int(p.height), preset=p.preset, sig=short)
    if p.dry_run:
        return OperationResult(ok=True, operation="conform", output_path=str(out),
                               dry_run=True, command=summary,
                               stdout=f"Command: {summary}\nOutput: {out}\n(dry run)")
    try:
        token = job_control.current_token()
        if token:
            job_control.report_progress(f"conform → {out.name}", phase="conform",
                                        current=0, total=1, unit="step", token=token)
        await conform_clip(
            src, out, mode=p.mode, width=int(p.width), height=int(p.height),
            target_fps=p.target_fps, time_factor=float(factor),
            encode_preset=ENCODE_PRESETS[p.preset],
            duration=native_dur, has_audio=bool(info.get("has_audio")),
        )
        sig = conform_signature(
            parent_path=str(src.resolve()), variant_path=str(out.resolve()),
            source_size=int(st.st_size), source_mtime=float(st.st_mtime),
            source_variant=p.source_variant or "original", mode=p.mode,
            aspect=p.aspect, width=int(p.width), height=int(p.height),
            target_fps=p.target_fps, time_factor=float(factor),
            preset=p.preset, audio_policy=p.audio_policy,
            rife_multiplier=p.rife_multiplier,
        )
        await register_variant(str(src.resolve()), kind="conformed",
                               variant_path=out.resolve(), detail=sig)
        return OperationResult(ok=True, operation="conform", output_path=str(out),
                               command=summary,
                               stdout=f"conformed → {out}",
                               meta={"signature": sig})
    except Exception as e:
        return OperationResult(ok=False, operation="conform", error=str(e),
                               command=summary, stderr=str(e))


register(OperationSpec(
    id="conform",
    summary="Conform one clip to the sequence canvas/preset (cache-fill)",
    description=(
        "Direct file-to-file ffmpeg with the conform preset. Writes a sibling "
        "*_conformed_* file and registers kind='conformed'. Never alters the original."
    ),
    params_model=ConformParams,
    handler=conform,
    tags=["sequence", "conform"],
))
