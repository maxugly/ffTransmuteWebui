"""
Uniform speed change — setpts + atempo, optional RIFE when frames are short.

Modes:
  • Fast path (use_rife=false): ffmpeg setpts + atempo / pitch / drop
  • Quality path (use_rife=true): dump → RIFE ×M → encode at speed-adjusted fps

Target FPS: output presentation rate after speed change.
Frame budget: needed = (duration/speed)*target_fps; available = frames*(M if RIFE else 1).
"""
from __future__ import annotations

import math
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..frame_range import end_frame_field, start_frame_field
from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path
from ..shell import run_command

RifeModel = Literal["rife-v4.6", "rife-v4", "rife-v2.4", "rife-v2.3"]
AudioMode = Literal["preserve", "pitch", "drop"]
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}


class SpeedChangeParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    speed: float = Field(
        1.0, gt=0.05, le=100.0,
        description="Speed factor: 2 = 2× faster, 0.5 = half speed",
    )
    target_fps: float | None = Field(
        None, ge=1, le=240,
        description="Output FPS after speed change (default = source fps)",
    )
    audio_mode: AudioMode = Field(
        "preserve",
        description="preserve=atempo pitch-lock, pitch=chipmunk/deep, drop=no audio",
    )
    use_rife: bool = Field(
        False,
        description="Interpolate frames with RIFE before speed/encode (helps slow-mo)",
    )
    multiplier: int = Field(2, ge=2, le=128, description="RIFE frame density (2–128)")
    model: RifeModel = Field("rife-v4.6", description="RIFE model")
    tta: bool = Field(False, description="RIFE spatial TTA")
    uhd: bool = Field(False, description="RIFE UHD mode")
    start_frame: int = start_frame_field()
    end_frame: int = end_frame_field()
    dry_run: bool = Field(False, description="Plan only")


def _build_atempo_chain(speed: float) -> str:
    """Chain atempo filters — each stage is in [0.5, 100]."""
    parts: list[str] = []
    remaining = float(speed)
    while remaining < 0.5 - 1e-9:
        parts.append("atempo=0.5")
        remaining /= 0.5
    while remaining > 100.0 + 1e-9:
        parts.append("atempo=100.0")
        remaining /= 100.0
    if abs(remaining - 1.0) > 1e-3:
        parts.append(f"atempo={remaining:.6f}")
    return ",".join(parts) if parts else "anull"


def frame_budget(
    frame_count: int,
    src_fps: float,
    speed: float,
    target_fps: float,
    *,
    use_rife: bool,
    multiplier: int,
) -> dict[str, Any]:
    """Return needed/available frame counts for target fps after speed change."""
    n = max(int(frame_count), 0)
    f = float(src_fps) if src_fps > 0 else 24.0
    s = float(speed) if speed > 0 else 1.0
    tf = float(target_fps) if target_fps and target_fps > 0 else f
    dur = n / f if f > 0 else 0.0
    out_dur = dur / s if s > 0 else dur
    needed = out_dur * tf
    m = int(multiplier) if use_rife else 1
    if use_rife:
        m = max(m, 2)
    available = n * m
    ok = available + 0.01 >= needed
    # Suggested min RIFE M to cover budget (ceil to 2..8)
    need_m = 1
    if n > 0 and needed > n:
        need_m = int(math.ceil(needed / n))
        need_m = max(2, min(8, need_m))
    return {
        "src_frames": n,
        "src_fps": f,
        "src_duration": dur,
        "out_duration": out_dur,
        "target_fps": tf,
        "speed": s,
        "needed_frames": needed,
        "available_frames": available,
        "rife_multiplier": m if use_rife else 1,
        "ok": ok,
        "suggested_rife_m": need_m if needed > n else 1,
        "shortfall": max(0.0, needed - available),
    }


async def speedchange(p: SpeedChangeParams) -> OperationResult:
    from .. import job_control
    from ..job_workspace import JobWorkspace
    from ..video_pipeline import probe, dump, encode, cleanup
    from ..filters.rife import run_rife_directory, resolve_rife_bin

    inp = Path(p.input_path).expanduser().resolve()
    if not inp.is_file():
        return OperationResult(
            ok=False, operation="speedchange",
            error=f"Input not found: {inp}", dry_run=p.dry_run,
        )
    if abs(p.speed - 1.0) < 0.001 and not p.use_rife and not p.target_fps:
        return OperationResult(
            ok=False, operation="speedchange",
            error="Speed is 1.0 with no RIFE/target_fps — nothing to do.",
            dry_run=p.dry_run,
        )

    try:
        info = await probe(str(inp))
    except Exception as e:
        return OperationResult(
            ok=False, operation="speedchange", error=f"probe failed: {e}",
            dry_run=p.dry_run,
        )

    src_fps = float(info.get("fps") or 24.0)
    n_full = int(info.get("frame_count") or 0)
    # Approximate range length for budget (full clip if range is wide open)
    n = n_full
    if p.start_frame > 1 or (p.end_frame < 999999 and p.end_frame > 0):
        end = p.end_frame if p.end_frame < 999999 else n_full
        start = max(1, p.start_frame)
        n = max(0, end - start + 1)

    target_fps = float(p.target_fps) if p.target_fps else src_fps
    budget = frame_budget(
        n, src_fps, p.speed, target_fps,
        use_rife=p.use_rife, multiplier=p.multiplier,
    )

    out = finalize_output_path(
        p.output_path,
        source=inp,
        default_suffix=f"_speed{p.speed:g}x".replace(".", "p"),
        default_ext=".mp4",
        allowed_exts=VIDEO_EXTS,
    )

    summary = (
        f"speedchange {inp.name} {p.speed:g}× → {target_fps:g}fps "
        f"audio={p.audio_mode} rife={p.use_rife}"
        + (f"×{p.multiplier}" if p.use_rife else "")
    )
    budget_line = (
        f"frames: need ~{budget['needed_frames']:.1f} for {budget['out_duration']:.2f}s "
        f"@ {target_fps:g}fps · have {budget['available_frames']} "
        f"({'OK' if budget['ok'] else 'SHORT — enable RIFE or lower fps/speed'})"
    )
    if not budget["ok"] and budget["suggested_rife_m"] > 1:
        budget_line += f" · try RIFE ×{budget['suggested_rife_m']}+"

    if p.dry_run:
        plan = f"{summary}\n{budget_line}\n"
        if p.use_rife:
            try:
                bin_path = resolve_rife_bin()
            except RuntimeError as e:
                return OperationResult(
                    ok=False, operation="speedchange", error=str(e), dry_run=True,
                )
            plan += (
                f"# dump → {bin_path} -n N*{p.multiplier} → encode @ "
                f"{budget['available_frames'] / max(budget['out_duration'], 1e-9):.4g} fps\n"
            )
        else:
            setpts = 1.0 / p.speed
            plan += f"# ffmpeg -vf setpts={setpts:.6f}*PTS -r {target_fps:g} …\n"
        return OperationResult(
            ok=True, operation="speedchange", output_path=str(out),
            dry_run=True, command=summary, stdout=plan,
        )

    logs = [summary, budget_line]
    job_control.report_progress(
        "speedchange start", phase="speed", current=0, total=1, unit="pass",
    )

    # ── Fast path: pure ffmpeg ────────────────────────────────────────────
    if not p.use_rife:
        setpts = 1.0 / p.speed
        vf = f"setpts={setpts:.6f}*PTS"
        # Force output rate (may drop/dup if short — UI warns)
        argv = [
            "ffmpeg", "-hide_banner", "-y",
            "-i", str(inp),
            "-vf", vf,
            "-r", f"{target_fps:.6g}",
            "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
        ]
        has_audio = bool(info.get("has_audio"))
        if not has_audio or p.audio_mode == "drop":
            argv.append("-an")
        elif p.audio_mode == "preserve":
            argv.extend(["-af", _build_atempo_chain(p.speed), "-c:a", "aac", "-b:a", "192k"])
        else:  # pitch
            argv.extend([
                "-af", f"asetpts={setpts:.6f}*PTS",
                "-c:a", "aac", "-b:a", "192k",
            ])
        # Frame range via -ss/-to is awkward with setpts; honor via select if needed later
        argv.append(str(out))
        job_control.report_progress("ffmpeg speed", phase="encode", current=0, total=1, unit="pass")
        code, stdout, stderr = await run_command(argv)
        if code != 0:
            return OperationResult(
                ok=False, operation="speedchange", error=(stderr or "ffmpeg failed")[-800:],
                dry_run=False, command=summary, stdout="\n".join(logs), stderr=stderr,
            )
        job_control.report_progress("encode done", phase="encode", current=1, total=1, unit="pass")
        logs.append(f"Output: {out}")
        return OperationResult(
            ok=True, operation="speedchange", output_path=str(out),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )

    # ── RIFE path: dump → rife → encode (duration = src/speed) ────────────
    try:
        resolve_rife_bin()
    except RuntimeError as e:
        return OperationResult(
            ok=False, operation="speedchange", error=str(e), dry_run=False,
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="speedchange_")
    success = False
    try:
        job_control.report_progress("dump", phase="dump", current=0, total=1, unit="pass")
        dump_info = await dump(
            ws, str(inp), start_frame=p.start_frame, end_frame=p.end_frame,
        )
        in_n = int(dump_info["frame_count"])
        dump_fps = float(dump_info.get("fps") or src_fps)
        logs.append(f"dump: {in_n} frames @ {dump_fps:.4g} fps")

        job_control.report_progress(
            f"RIFE {p.multiplier}x",
            phase="rife", current=0, total=in_n * p.multiplier, unit="frames",
        )
        meta = await run_rife_directory(
            ws.frames_in, ws.frames_out,
            multiplier=p.multiplier, model=p.model, tta=p.tta, uhd=p.uhd,
        )
        out_n = int(meta["frame_count_out"])
        logs.append(f"rife: {meta['frame_count_in']} → {out_n} frames")

        # Dense frames span source duration; speed S → out duration D/S
        src_dur = in_n / dump_fps if dump_fps > 0 else float(info.get("duration") or 0)
        out_dur = src_dur / p.speed if p.speed > 0 else src_dur
        needed = int(math.ceil(out_dur * target_fps)) if out_dur > 0 else out_n

        # If we have more frames than needed for target_fps @ speed duration, thin evenly
        frame_src = ws.frames_out
        if p.target_fps and out_n > needed + 1 and needed >= 2:
            thin_dir = ws.root / "frames_thin"
            thin_dir.mkdir(parents=True, exist_ok=True)
            srcs = sorted(ws.frames_out.glob("frame_*.png"))
            for i in range(needed):
                j = int(round(i * (out_n - 1) / max(needed - 1, 1)))
                j = min(j, out_n - 1)
                (thin_dir / f"frame_{i:06d}.png").write_bytes(srcs[j].read_bytes())
            frame_src = thin_dir
            out_n = needed
            logs.append(f"thin: → {needed} frames for {target_fps:g}fps @ {out_dur:.2f}s")
            encode_fps = target_fps
        else:
            # Duration-preserving rate from dense sequence
            encode_fps = out_n / out_dur if out_dur > 0 else target_fps
            if p.target_fps and abs(encode_fps - target_fps) > 0.5:
                logs.append(
                    f"note: encode fps {encode_fps:.3g} (budget short of {target_fps:g})"
                )

        logs.append(
            f"encode @ {encode_fps:.4g} fps · ~duration {out_n / max(encode_fps, 1e-9):.2f}s "
            f"(speed target duration {out_dur:.2f}s)"
        )

        # Audio: remap dumped audio with atempo when present
        mux = bool(ws.audio_path) and p.audio_mode != "drop"
        if mux and p.audio_mode == "preserve" and abs(p.speed - 1.0) > 0.001:
            # atempo-filter audio sidecar into workspace
            a_in = Path(ws.audio_path)
            a_out = ws.root / f"audio_speed{a_in.suffix}"
            af = _build_atempo_chain(p.speed)
            acode, _, aerr = await run_command([
                "ffmpeg", "-hide_banner", "-y", "-i", str(a_in),
                "-af", af, str(a_out),
            ])
            if acode == 0 and a_out.is_file():
                ws.audio_path = a_out
                logs.append(f"audio: atempo chain ({p.speed:g}×)")
            else:
                logs.append(f"audio atempo failed — dropping audio: {aerr[-200:]}")
                ws.audio_path = None
                mux = False
        elif mux and p.audio_mode == "pitch":
            # Keep raw audio but video duration changes — drop to avoid desync
            logs.append("audio pitch mode with RIFE path: dropping audio (use fast path for pitch)")
            ws.audio_path = None
            mux = False

        job_control.report_progress("encode", phase="encode", current=0, total=1, unit="pass")
        result_path = await encode(
            ws, out, encode_fps, mux_audio=mux, crf=18, preset="fast",
            frame_source_dir=frame_src,
        )
        job_control.report_progress("encode done", phase="encode", current=1, total=1, unit="pass")
        logs.append(f"Output: {result_path}")
        success = True
        return OperationResult(
            ok=True, operation="speedchange", output_path=str(result_path),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation="speedchange", error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        await cleanup(ws, keep_on_failure=not success)


register(OperationSpec(
    id="speedchange",
    summary="Uniform speed change with optional RIFE + target FPS",
    description=(
        "Speed up or slow down a clip. Fast path: setpts + atempo. "
        "Optional RIFE multiplies frames when slow-mo needs more density for a "
        "target FPS. UI shows red when frame budget is short."
    ),
    params_model=SpeedChangeParams,
    handler=speedchange,
    tags=["speed", "time", "rife", "utility"],
))
