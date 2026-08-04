"""Shared sequence → optional dedupe → optional RIFE → encode.

Used by DeepDream Evolve, Style Transfer Evolve, and any future “strip of stills → video” op.
Does not invent dump/encode stacks — bookends via video_pipeline + filters.rife.
"""
from __future__ import annotations

import asyncio
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

from . import job_control

ProgressCb = Callable[..., None]


class EvolveRifeParams(BaseModel):
    """Shared API fields for strip→video ops that call ``build_evolve_video``.

    Inherit on op param models (DeepDream, Style Transfer, …) so RIFE knobs
    stay in one place. Op-specific evolve fields (metric, strength ramp, …)
    stay on the child model.
    """

    evolve_use_rife: bool = Field(False, description="RIFE between evolve keyframes")
    evolve_rife_multiplier: int = Field(2, ge=2, le=128)
    evolve_rife_model: str = Field("rife-v4.6")
    evolve_rife_tta: bool = Field(False)
    evolve_rife_uhd: bool = Field(False)
    evolve_save_stills: bool = Field(
        False, description="Write kept keyframes next to evolve video"
    )
    evolve_fps: float = Field(12.0, ge=1.0, le=60.0, description="Evolve output fps")


def even_dim(n: int) -> int:
    n = max(2, int(n))
    return n if n % 2 == 0 else n - 1


def letterbox_rgb(arr: np.ndarray, width: int, height: int) -> np.ndarray:
    """Letterbox HxWx3 uint8 to even width×height."""
    w, h = even_dim(width), even_dim(height)
    im = Image.fromarray(arr).convert("RGB")
    iw, ih = im.size
    scale = min(w / iw, h / ih)
    nw, nh = max(1, int(round(iw * scale))), max(1, int(round(ih * scale)))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (w, h), (0, 0, 0))
    canvas.paste(im, ((w - nw) // 2, (h - nh) // 2))
    return np.asarray(canvas)


def dedupe_paths(
    paths: Sequence[Path],
    *,
    metric: str = "phash",
    threshold: float = 0.0,
    progress_cb: ProgressCb | None = None,
    force_keep_last: bool = True,
) -> list[Path]:
    """Keep first; append if distance to last kept >= threshold (0 = keep all)."""
    from .image_sort.modes import MODES

    paths = [Path(p) for p in paths]
    if len(paths) <= 1:
        return list(paths)
    score_fn = MODES.get(metric) or MODES.get("phash")
    if score_fn is None:
        raise ValueError(f"Unknown evolve metric {metric!r}")
    thr = float(threshold)
    kept: list[Path] = [paths[0]]
    mid = paths[1:-1] if force_keep_last and len(paths) > 1 else paths[1:]
    for i, p in enumerate(mid, start=1):
        if thr <= 0:
            kept.append(p)
        else:
            try:
                d = float(score_fn(kept[-1], p))
            except Exception:
                kept.append(p)
                d = None
            else:
                if d >= thr:
                    kept.append(p)
        if progress_cb and (i % 10 == 0 or i == len(mid)):
            progress_cb(
                f"dedupe {i}/{len(mid)} kept={len(kept)}",
                phase="dedupe",
                current=i,
                total=max(1, len(mid)),
                unit="frames",
            )
    if force_keep_last and paths[-1] not in kept:
        kept.append(paths[-1])
    return kept


@dataclass
class EvolveRifeOpts:
    enabled: bool = False
    multiplier: int = 2
    model: str = "rife-v4.6"
    tta: bool = False
    uhd: bool = False


def rife_opts_from_evolve_params(p: object) -> EvolveRifeOpts:
    """Map ``EvolveRifeParams`` (or duck-typed attrs) → runtime opts."""
    return EvolveRifeOpts(
        enabled=bool(getattr(p, "evolve_use_rife", False)),
        multiplier=int(getattr(p, "evolve_rife_multiplier", 2) or 2),
        model=str(getattr(p, "evolve_rife_model", None) or "rife-v4.6"),
        tta=bool(getattr(p, "evolve_rife_tta", False)),
        uhd=bool(getattr(p, "evolve_rife_uhd", False)),
    )


@dataclass
class EvolveVideoResult:
    output_path: Path
    candidates: int
    kept: int
    used_rife: bool
    logs: list[str]


async def build_evolve_video(
    candidates_dir: str | Path,
    output_path: str | Path,
    *,
    fps: float = 12.0,
    rife: EvolveRifeOpts | None = None,
    dedupe_metric: str | None = "phash",
    dedupe_threshold: float = 0.0,
    target_size: tuple[int, int] | None = None,
    save_stills: bool = False,
    progress_cb: ProgressCb | None = None,
    workspace_prefix: str = "evolve_",
) -> EvolveVideoResult | None:
    """Conform candidates → optional dedupe → optional RIFE → encode.

    ``candidates_dir`` must contain ``frame_*.png`` (start 0 preferred).
    ``dedupe_metric=None`` skips dedupe (keep all, order preserved).
    ``dedupe_threshold<=0`` also keeps all when metric is set.
    """
    from .filters.rife import run_rife_directory
    from .job_workspace import JobWorkspace
    from .video_pipeline import cleanup as vp_cleanup
    from .video_pipeline import encode as vp_encode

    rife = rife or EvolveRifeOpts()
    cands = sorted(Path(candidates_dir).glob("frame_*.png"))
    logs: list[str] = []
    if len(cands) < 2:
        logs.append(f"evolve: skip (only {len(cands)} candidate(s))")
        return None

    def _prog(msg: str, **kw) -> None:
        if progress_cb:
            progress_cb(msg, **kw)

    _prog(
        f"evolve: {len(cands)} candidates",
        phase="evolve",
        current=0,
        total=len(cands),
        unit="frames",
    )

    if target_size is None:
        with Image.open(cands[-1]) as im:
            tw, th = even_dim(im.width), even_dim(im.height)
    else:
        tw, th = even_dim(target_size[0]), even_dim(target_size[1])

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix=workspace_prefix)
    success = False
    try:
        ws.create()
        conf_dir = ws.root / "conform"
        conf_dir.mkdir(parents=True, exist_ok=True)
        conformed: list[Path] = []
        for i, src in enumerate(cands):
            job_control.check_cancelled()
            dst = conf_dir / f"frame_{i:06d}.png"
            arr = np.asarray(Image.open(src).convert("RGB"))
            out_arr = letterbox_rgb(arr, tw, th)
            Image.fromarray(out_arr).save(dst, format="PNG", compress_level=1)
            conformed.append(dst)
            if i == 0 or (i + 1) % 5 == 0 or i + 1 == len(cands):
                _prog(
                    f"conform {i + 1}/{len(cands)}",
                    phase="conform",
                    current=i + 1,
                    total=len(cands),
                    unit="frames",
                    latest_frame=str(dst),
                )

        if dedupe_metric is None:
            kept = list(conformed)
            logs.append(f"evolve dedupe: off — kept all {len(kept)}")
        else:
            thr = float(dedupe_threshold)
            metric = (dedupe_metric or "phash").lower()
            kept = await asyncio.to_thread(
                dedupe_paths,
                conformed,
                metric=metric,
                threshold=thr,
                progress_cb=progress_cb,
                force_keep_last=True,
            )
            logs.append(
                f"evolve dedupe: kept {len(kept)}/{len(conformed)} "
                f"metric={metric} thr={thr:g}"
            )

        for f in ws.frames_in.glob("frame_*.png"):
            f.unlink(missing_ok=True)
        for i, src in enumerate(kept):
            shutil.copy2(src, ws.frames_in / f"frame_{i:06d}.png")

        encode_dir = ws.frames_in
        n_key = len(kept)
        used_rife = False

        if rife.enabled and n_key >= 2:
            m = max(2, min(128, int(rife.multiplier)))
            _prog(
                f"evolve RIFE ×{m}",
                phase="rife",
                current=0,
                total=n_key * m,
                unit="frames",
            )
            meta = await run_rife_directory(
                ws.frames_in,
                ws.frames_out,
                multiplier=m,
                model=rife.model or "rife-v4.6",
                tta=bool(rife.tta),
                uhd=bool(rife.uhd),
            )
            encode_dir = ws.frames_out
            used_rife = True
            logs.append(
                f"evolve rife: {meta.get('frame_count_in')} → {meta.get('frame_count_out')} ×{m}"
            )
        elif rife.enabled and n_key < 2:
            logs.append("evolve rife: skipped (need ≥2 kept frames)")

        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        _prog(
            f"evolve encode @ {float(fps):g} fps",
            phase="encode",
            current=0,
            total=1,
            unit="pass",
        )
        result = await vp_encode(
            ws,
            out,
            float(fps),
            mux_audio=False,
            frame_source_dir=encode_dir,
        )
        logs.append(f"evolve video: {result}")

        if save_stills:
            stills_dir = out.with_name(out.stem + "_stills")
            stills_dir.mkdir(parents=True, exist_ok=True)
            for i, src in enumerate(kept):
                shutil.copy2(src, stills_dir / f"frame_{i:06d}.png")
            logs.append(f"evolve stills: {len(kept)} → {stills_dir}")

        success = True
        _prog(
            "evolve done",
            phase="done",
            current=1,
            total=1,
            unit="pass",
            latest_frame=str(kept[-1]) if kept else None,
        )
        return EvolveVideoResult(
            output_path=Path(result),
            candidates=len(cands),
            kept=len(kept),
            used_rife=used_rife,
            logs=logs,
        )
    finally:
        await vp_cleanup(ws, keep_on_failure=not success)
