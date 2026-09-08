"""
Single-clip VFR → CFR (+ optional RIFE).

Base = fast CFR normalize (one ffmpeg pass, no PNG dump). With the RIFE
toggle the job becomes dump → [CFR stage] → RIFE stage → encode, where the
`→ CFR First` switch controls whether timestamps are normalized before
interpolation (fixes fast-pan wobble on phone/screen-capture VFR footage).

See docs/singleclip-cfr-spec.md and docs/filter-platform-spec.md.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..frame_range import end_frame_field, start_frame_field
from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path, unique_output_path
from ..shell import run_command
from ..staged_job import StageSpec, run_staged_job

RifeModel = Literal["rife-v4.6", "rife-v4", "rife-v2.4", "rife-v2.3"]

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class CfrParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    target_fps: float | None = Field(
        None, ge=1, le=240,
        description="CFR rate. Blank/null = Auto (avg_frame_rate, fallback r_frame_rate).",
    )
    use_rife: bool = Field(False, description="Interpolate with RIFE after CFR normalize")
    cfr_first: bool = Field(
        True,
        description="Normalize to CFR before RIFE (fixes fast-pan wobble). "
                    "Off = legacy direct-RIFE on source timestamps. "
                    "Meaningless without RIFE — coerced to False.",
    )
    multiplier: int = Field(2, ge=2, le=128, description="RIFE frame density (2–128)")
    model: RifeModel = Field("rife-v4.6", description="RIFE model variant")
    tta: bool = Field(False, description="RIFE spatial TTA mode — cleaner but slower")
    uhd: bool = Field(False, description="RIFE UHD mode for high-res sources")
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = Field(False, description="Print plan only")


def _parse_rate(raw: str | None) -> float:
    """Parse an ffprobe x/y rate string. 0.0 when unknown (e.g. '0/0')."""
    if not raw:
        return 0.0
    try:
        if "/" in raw:
            a, b = raw.split("/", 1)
            denom = float(b)
            return float(a) / denom if denom > 0 else 0.0
        return float(raw)
    except Exception:
        return 0.0


def _sane_fps(v: float | None) -> bool:
    return v is not None and 1.0 <= float(v) <= 240.0


def resolve_cfr_fps(probe_info: dict, target_fps: float | None) -> float | None:
    """Resolve the CFR target rate.

    Explicit `target_fps` wins. Else Auto = probe `avg_frame_rate` when sane
    (1–240), else `r_frame_rate` fallback. None when nothing resolves.
    """
    if _sane_fps(target_fps):
        return float(target_fps)  # type: ignore[arg-type]
    avg = probe_info.get("fps_avg")
    try:
        avg_f = float(avg) if avg is not None else 0.0
    except (TypeError, ValueError):
        avg_f = 0.0
    if _sane_fps(avg_f):
        return avg_f
    # Fall back to r_frame_rate (probe["fps"] keeps r semantics).
    try:
        r_f = float(probe_info.get("fps") or 0.0)
    except (TypeError, ValueError):
        r_f = 0.0
    if _sane_fps(r_f):
        return r_f
    r2 = probe_info.get("fps_r")
    try:
        r2_f = float(r2) if r2 is not None else 0.0
    except (TypeError, ValueError):
        r2_f = 0.0
    return r2_f if _sane_fps(r2_f) else None


def _effective_cfr_first(use_rife: bool, cfr_first: bool) -> bool:
    """`cfr_first` without RIFE is meaningless — coerce to False."""
    return bool(cfr_first) if use_rife else False


async def cfr_normalize(p: CfrParams) -> OperationResult:
    """VFR → CFR fast path, or dump → [CFR] → RIFE → encode."""
    from ..filters.cfr import make_cfr_directory_fn
    from ..filters.rife import make_rife_directory_fn, resolve_rife_bin
    from ..video_pipeline import probe as vp_probe

    input_path = Path(p.input_path).expanduser().resolve()
    if not input_path.is_file():
        return OperationResult(
            ok=False, operation="cfr",
            error=f"Input not found: {input_path}", dry_run=p.dry_run,
        )

    use_rife = bool(p.use_rife)
    cfr_first = _effective_cfr_first(use_rife, p.cfr_first)

    if use_rife:
        try:
            resolve_rife_bin()
        except RuntimeError as e:
            return OperationResult(
                ok=False, operation="cfr", error=str(e), dry_run=p.dry_run,
            )

    try:
        info = await vp_probe(str(input_path))
    except Exception as e:
        return OperationResult(
            ok=False, operation="cfr",
            error=f"Could not probe input: {e}", dry_run=p.dry_run,
        )

    fps = resolve_cfr_fps(info, p.target_fps)
    if fps is None:
        return OperationResult(
            ok=False, operation="cfr",
            error="Could not resolve a CFR target rate "
                  f"(target_fps={p.target_fps}, avg={info.get('fps_avg')}, "
                  f"r={info.get('fps_r')})",
            dry_run=p.dry_run,
        )

    src_fps = float(info.get("fps") or fps)
    if src_fps <= 0:
        src_fps = fps
    has_audio = bool(info.get("has_audio"))

    suffix = "_cfr_rife" if use_rife else "_cfr"
    out = finalize_output_path(
        p.output_path, source=input_path, default_suffix=suffix,
        default_ext=".mp4", allowed_exts=VIDEO_EXTS,
    )
    # Original source is immutable — never encode onto the input path.
    if out.resolve() == input_path.resolve():
        out = unique_output_path(
            input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix}")
        )

    sf = int(p.start_frame) if p.start_frame is not None else 1
    ef = int(p.end_frame) if p.end_frame is not None else 999999
    if sf < 1:
        sf = 1
    if ef < sf:
        ef = sf
    full_clip = sf <= 1 and ef >= 999999

    meta = {
        "target_fps": fps,
        "auto": p.target_fps is None,
        "use_rife": use_rife,
        "cfr_first": cfr_first,
        "is_vfr_guess": bool(info.get("is_vfr_guess")),
        "fps_avg": info.get("fps_avg"),
        "fps_r": info.get("fps_r"),
    }

    # ── Path A — CFR-only: fast single ffmpeg pass, no PNG dump ──────────
    if not use_rife:
        meta["path"] = "A"
        argv: list[str] = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(input_path),
        ]
        if not full_clip:
            start_t = max(0.0, (sf - 1) / src_fps)
            end_t = max(start_t + 1e-6, ef / src_fps)
            argv.extend(["-ss", f"{start_t:.6f}", "-to", f"{end_t:.6f}"])
        argv.extend(["-vf", f"fps={fps:.6g}", "-fps_mode", "cfr"])
        if has_audio:
            argv.extend(["-c:a", "aac", "-b:a", "192k"])
        else:
            argv.append("-an")
        argv.append(str(out))

        summary = f"cfr {input_path.name} → {fps:.6g}fps CFR (fast pass)"
        plan = (
            f"{summary}\n"
            f"Input: VFR-guess={meta['is_vfr_guess']} "
            f"(avg={info.get('fps_avg')}, r={info.get('fps_r')})\n"
            f"Path A: ffmpeg -vf fps={fps:.6g} -fps_mode cfr "
            f"({'audio kept' if has_audio else 'no audio'})\n"
            f"Range: {'full clip' if full_clip else f'frames {sf}–{ef}'}\n"
            f"Output: {out}\n"
        )
        if p.dry_run:
            meta_out = dict(meta)
            return OperationResult(
                ok=True, operation="cfr", output_path=str(out),
                dry_run=True, command=" ".join(argv), stdout=plan,
                meta=meta_out,
            )

        token = job_control.current_token()
        if token:
            job_control.report_progress(
                f"cfr encode starting → {out.name}",
                phase="encode", current=0, total=1, unit="step", token=token,
            )
        code, _, stderr = await run_command(argv)
        if code != 0:
            return OperationResult(
                ok=False, operation="cfr",
                error=f"ffmpeg CFR pass failed (exit {code}): "
                      f"{(stderr or '').strip()[-300:] or 'no stderr'}",
                dry_run=False, command=" ".join(argv), stdout=plan,
                meta=dict(meta),
            )
        if not out.is_file() or out.stat().st_size < 32:
            return OperationResult(
                ok=False, operation="cfr",
                error=f"ffmpeg CFR pass produced no output: {out}",
                dry_run=False, command=" ".join(argv), stdout=plan,
                meta=dict(meta),
            )
        if token:
            job_control.report_progress(
                "cfr encode done",
                phase="encode", current=1, total=1, unit="step", token=token,
            )
        return OperationResult(
            ok=True, operation="cfr", output_path=str(out),
            dry_run=False, command=" ".join(argv),
            stdout=plan + f"Done: {out} @ {fps:.6g}fps CFR\n",
            meta=dict(meta),
        )

    # ── Paths B/C — staged: dump → [CFR] → RIFE → encode ─────────────────
    stages: list[StageSpec] = []
    if cfr_first:
        meta["path"] = "B"
        stages.append(StageSpec(
            "cfr", "directory",
            make_cfr_directory_fn(fps, input_fps=src_fps),
        ))
    else:
        meta["path"] = "C"
    stages.append(StageSpec(
        "rife", "directory",
        make_rife_directory_fn(
            multiplier=p.multiplier, model=p.model, tta=p.tta, uhd=p.uhd,
        ),
    ))

    summary = (
        f"cfr {input_path.name} → {fps:.6g}fps "
        f"(+ RIFE ×{p.multiplier} {p.model}, "
        f"{'cfr-first' if cfr_first else 'direct'})"
    )
    result = await run_staged_job(
        op_id="cfr",
        prefix="cfr_",
        input_path=input_path,
        output_path=out,
        dry_run=p.dry_run,
        dump_kwargs={"start_frame": sf, "end_frame": ef},
        stages=stages,
        encode_fps=float(p.target_fps) if p.target_fps else None,
        encode_kwargs={"mux_audio": True},
        summary=summary,
    )
    extra = dict(result.meta or {})
    extra.update(meta)
    result.meta = extra
    return result


register(OperationSpec(
    id="cfr",
    summary="VFR → CFR normalize (+ optional RIFE)",
    description=(
        "Normalize uneven phone/screen-capture VFR timestamps to CFR. "
        "Base = fast single ffmpeg pass (no PNG dump). "
        "Optional RIFE interpolation runs after an explicit CFR-first "
        "resample stage (default ON) so RIFE sees even-spaced input; "
        "off = legacy direct-RIFE on source timestamps. "
        "Auto rate uses avg_frame_rate, falling back to r_frame_rate."
    ),
    params_model=CfrParams,
    handler=cfr_normalize,
    tags=["cfr", "vfr", "rife", "interpolation", "filter"],
))
