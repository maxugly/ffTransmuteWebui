"""
Shared bookend runner — dump → stages → encode with progress, cancel, cleanup.

Replaces the repeated JobWorkspace + dump + stage(s) + encode + cleanup +
OperationResult boilerplate across filter-platform ops.

Usage::

    from .staged_job import run_staged_job, StageSpec

    async def my_handler(p: MyParams) -> OperationResult:
        return await run_staged_job(
            op_id="my_op",
            prefix="myop_",
            input_path=p.input_path,
            output_path=out,
            dry_run=p.dry_run,
            dump_kwargs={"start_frame": p.start_frame, "end_frame": p.end_frame},
            stages=[
                StageSpec("mystage", "directory", my_dir_fn),
            ],
            encode_kwargs={"mux_audio": True},
        )

See docs/filter-platform-spec.md and docs/coder-dry-platform-prompt.md.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import job_control
from .contract import OperationResult
from .job_workspace import JobWorkspace
from .video_pipeline import cleanup as vp_cleanup
from .video_pipeline import dump as vp_dump
from .video_pipeline import encode as vp_encode
from .video_pipeline import probe as vp_probe

DirStageFn = Callable[[Path, Path], Any]  # async (src, dst) -> dict


@dataclass
class StageSpec:
    """One pipeline stage (directory only for now)."""
    name: str
    kind: str  # "directory"
    fn: DirStageFn
    progress_total: int | None = None


async def run_staged_job(
    *,
    op_id: str,
    prefix: str,
    input_path: Path | str,
    output_path: Path | str,
    dry_run: bool = False,
    dump_kwargs: dict | None = None,
    stages: list[StageSpec] | None = None,
    encode_fps: float | None = None,
    encode_kwargs: dict | None = None,
    no_probe: bool = False,
    summary: str | None = None,
    probe_skip: bool = False,
) -> OperationResult:
    """Run a complete dump → stages → encode job with managed lifecycle.

    Args:
        op_id: Operation id for result.
        prefix: JobWorkspace prefix (e.g. "rife_", "cut_").
        input_path: Source video.
        output_path: Destination.
        dry_run: Print plan only.
        dump_kwargs: Forwarded to video_pipeline.dump (start_frame, end_frame, etc.).
        stages: Ordered list of StageSpec. Empty = dump→encode only (cut path).
        encode_fps: Override fps for encode. Default: use dump fps scaled by stage
                     output/input ratio when stages present.
        encode_kwargs: Forwarded to video_pipeline.encode (**kwargs).
        no_probe: Skip probe before dump (use when fps is known from caller).
        summary: Human-readable summary for logs. Auto-generated if None.
        probe_skip: If True, skip probe entirely (caller provides fps/duration info
                    via dump_kwargs or stages). Dump will still probe internally.
    """
    inp = Path(input_path).expanduser().resolve()
    out = Path(output_path).expanduser().resolve()

    if not inp.is_file():
        return OperationResult(
            ok=False, operation=op_id,
            error=f"Input not found: {inp}", dry_run=dry_run,
        )

    stage_list = stages or []
    _dk = dump_kwargs or {}
    _ek = encode_kwargs or {}

    summary = summary or f"{op_id} {inp.name}"

    # ── Dry run ──────────────────────────────────────────────────────────
    if dry_run:
        lines = [summary]
        lines.append(f"# dump")
        lines.append(
            f"  ffmpeg -i {inp} → frames_in/frame_%06d.png "
            f"(start={_dk.get('start_frame', 1)}, end={_dk.get('end_frame', 999999)})"
        )
        for s in stage_list:
            lines.append(f"# stage: {s.name} ({s.kind})")
        lines.append(f"# encode")
        lines.append(
            f"  ffmpeg -framerate <fps> -i frames_out/frame_%06d.png "
            f"{' '.join(f'{k}={v}' for k, v in _ek.items() if k not in ('extra_vf', 'frame_source_dir', 'encode_preset', 'silence_on_no_audio'))} {out}"
        )
        return OperationResult(
            ok=True, operation=op_id, output_path=str(out),
            dry_run=True, command=summary, stdout="\n".join(lines),
        )

    # ── Probe (optional) ─────────────────────────────────────────────────
    fps_from_probe: float | None = None
    if not probe_skip:
        try:
            info = await vp_probe(inp)
            fps_from_probe = float(info.get("fps") or 0)
            if fps_from_probe <= 0:
                fps_from_probe = 25.0
        except Exception:
            fps_from_probe = 25.0

    # ── Workspace ────────────────────────────────────────────────────────
    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix=prefix)
    success = False
    logs: list[str] = [summary]

    try:
        # ── Dump ─────────────────────────────────────────────────────────
        dump_info = await vp_dump(ws, inp, **_dk)
        dump_fps = float(dump_info.get("fps") or fps_from_probe or 25.0)
        dump_n = int(dump_info.get("frame_count") or 0)
        logs.append(
            f"dump: {dump_n} frames @ {dump_fps} fps "
            f"(src {_dk.get('start_frame', 1)}–"
            f"{_dk.get('end_frame', 999999) if _dk.get('end_frame', 999999) < 999999 else 'end'})"
        )

        if dump_n < 1 and stage_list:
            return OperationResult(
                ok=False, operation=op_id, error="dump produced no frames",
                stdout="\n".join(logs),
            )

        # ── Stages ───────────────────────────────────────────────────────
        current_src = ws.frames_in
        total_in = dump_n
        total_out = dump_n

        for i, stage in enumerate(stage_list):
            job_control.check_cancelled()

            is_last = (i == len(stage_list) - 1)
            dst_dir = ws.frames_out if is_last else ws.root / f"stage_{i}"
            dst_dir.mkdir(parents=True, exist_ok=True)

            prog_total = stage.progress_total or total_in
            job_control.report_progress(
                f"{stage.name} stage", phase=stage.name,
                current=0, total=prog_total, unit="frames",
            )

            meta = await stage.fn(current_src, dst_dir)
            logs.append(
                f"{stage.name}: {meta.get('frame_count_in', '?')}"
                f" → {meta.get('frame_count_out', '?')} frames"
            )

            out_n = int(meta.get("frame_count_out") or 0)
            if out_n <= 0:
                return OperationResult(
                    ok=False, operation=op_id,
                    error=f"stage '{stage.name}' produced no frames",
                    stdout="\n".join(logs),
                )

            total_out = out_n
            current_src = dst_dir

        # ── Determine encode fps ─────────────────────────────────────────
        if encode_fps is not None:
            final_fps = encode_fps
        elif stage_list and total_in > 0 and total_out != total_in:
            final_fps = dump_fps * (total_out / total_in)
        else:
            final_fps = dump_fps

        # ── Encode ───────────────────────────────────────────────────────
        encode_src: Path | None = _ek.pop("frame_source_dir", None)  # type: ignore[assignment]
        if encode_src is None:
            encode_src = ws.frames_out if stage_list else ws.frames_in

        job_control.report_progress(
            "encode", phase="encode", current=0, total=1, unit="pass",
        )

        result_path = await vp_encode(
            ws, str(out), final_fps,
            frame_source_dir=encode_src,
            **_ek,
        )

        job_control.report_progress(
            "encode done", phase="encode", current=1, total=1, unit="pass",
        )
        logs.append(f"Output: {result_path} @ {final_fps:.4g} fps")
        success = True

        return OperationResult(
            ok=True, operation=op_id, output_path=str(result_path),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )

    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op_id, error=str(e),
            dry_run=False, command=summary, stdout="\n".join(logs),
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation=op_id, error=str(e),
            dry_run=False, command=summary,
            stdout="\n".join(logs), stderr=str(e),
        )
    finally:
        await vp_cleanup(ws, keep_on_failure=not success)
