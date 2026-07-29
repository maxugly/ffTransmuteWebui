"""
PipelineChain — disk-based cascading filter chain.

Processes a list of filter_fns through staged workspace directories.
Only one frame in RAM at a time — strictly disk-based.

Workspace layout:
  stage_0/   dumped PNGs from input video
  stage_1/   output of filter 1
  ...
  stage_N/   output of filter N (final, encoded to video)

Usage:
  chain = PipelineChain(workspace, filters)
  await chain.run(input_path, output_path, fps=30.0)
  workspace.cleanup()
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable, Coroutine

from .job_workspace import JobWorkspace
from .video_pipeline import dump, encode as vp_encode, FilterFn
from . import job_control


class Stage:
    """Metadata for one filter stage."""
    def __init__(self, name: str, filter_fn: FilterFn, stage_dir: Path):
        self.name = name
        self.filter_fn = filter_fn
        self.stage_dir = stage_dir


class PipelineChain:
    def __init__(self, workspace: JobWorkspace, filters: list[tuple[str, FilterFn]]):
        self.workspace = workspace
        self.stages: list[Stage] = []
        for i, (name, fn) in enumerate(filters):
            sd = workspace.root / f"stage_{i + 1}"
            self.stages.append(Stage(name, fn, sd))

    async def run(
        self,
        input_path: str | Path,
        output_path: str | Path,
        *,
        fps: float = 0.0,
        mux_audio: bool = True,
        progress_cb: Callable[..., Any] | None = None,
    ) -> str:
        """Execute the full chain: dump → filter stages → encode. Returns output_path."""
        input_path = Path(input_path).resolve()
        stage_count = len(self.stages)

        # ── dump ──────────────────────────────────────────────────────────
        dump_info = await dump(self.workspace, input_path)
        if fps <= 0:
            fps = dump_info["fps"]

        if progress_cb:
            progress_cb("dump", 0, dump_info["frame_count"])

        # ── initial stage_0 = frames_in ───────────────────────────────────
        current_src = self.workspace.frames_in
        total_frames = dump_info["frame_count"]

        # ── cascade through filters ───────────────────────────────────────
        for stage_idx, stage in enumerate(self.stages):
            job_control.check_cancelled()

            if progress_cb:
                progress_cb(
                    f"stage {stage_idx + 1}/{stage_count}: {stage.name}",
                    0, total_frames,
                )

            stage.stage_dir.mkdir(parents=True, exist_ok=True)
            frames = sorted(current_src.glob("frame_*.png"))
            if not frames:
                raise RuntimeError(
                    f"No frames in stage_{stage_idx} for filter '{stage.name}'"
                )

            total_frames = len(frames)
            for idx, src in enumerate(frames):
                job_control.check_cancelled()
                dst = stage.stage_dir / src.name
                await stage.filter_fn(src, dst, idx)
                if progress_cb:
                    progress_cb(
                        f"stage {stage_idx + 1}/{stage_count}: {stage.name}",
                        idx + 1, total_frames,
                    )

            current_src = stage.stage_dir

        # ── encode from final stage ───────────────────────────────────────
        import shutil
        final_stage = self.stages[-1].stage_dir
        out_dir = self.workspace.frames_out
        out_dir.mkdir(parents=True, exist_ok=True)
        for f in sorted(final_stage.glob("frame_*.png")):
            dst = out_dir / f.name
            if not dst.exists():
                shutil.copy2(str(f), str(dst))

        result = await vp_encode(
            self.workspace, output_path, float(fps), mux_audio=mux_audio,
        )
        return result
