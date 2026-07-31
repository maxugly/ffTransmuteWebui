"""
PipelineChain — disk-based cascading filter chain.

Supports:
  per_frame stages — FilterFn(input_png, output_png, index) 1:1
  directory stages — async (src_dir, dst_dir) -> dict, may change frame count
                     (callable.kind == "directory")

Workspace layout:
  frames_in/   dumped PNGs
  stage_1/…    stage outputs
  frames_out/  final sequence for encode

See docs/filter-platform-spec.md.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Callable

from .job_workspace import JobWorkspace
from .video_pipeline import dump, encode as vp_encode
from . import job_control


def _is_directory_stage(fn: Any) -> bool:
    return getattr(fn, "kind", None) == "directory"


class Stage:
    """One named stage (per_frame or directory)."""

    def __init__(self, name: str, fn: Any, stage_dir: Path):
        self.name = name
        self.fn = fn
        self.stage_dir = stage_dir
        self.kind = "directory" if _is_directory_stage(fn) else "per_frame"


class PipelineChain:
    def __init__(self, workspace: JobWorkspace, filters: list[tuple[str, Any]]):
        """filters: list of (name, callable) — FilterFn or directory_fn."""
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
        """dump → stages → encode. Returns output_path."""
        input_path = Path(input_path).resolve()
        stage_count = len(self.stages)
        if stage_count == 0:
            raise RuntimeError("PipelineChain requires at least one filter")

        dump_info = await dump(self.workspace, input_path)
        if fps <= 0:
            fps = float(dump_info["fps"])

        if progress_cb:
            progress_cb("dump", 0, dump_info["frame_count"])

        current_src = self.workspace.frames_in
        dump_count = int(dump_info["frame_count"] or 0)

        for stage_idx, stage in enumerate(self.stages):
            job_control.check_cancelled()
            stage.stage_dir.mkdir(parents=True, exist_ok=True)

            frames = sorted(current_src.glob("frame_*.png"))
            if not frames:
                frames = sorted(current_src.glob("*.png"))
            if not frames:
                raise RuntimeError(
                    f"No frames before filter '{stage.name}' (stage {stage_idx})"
                )
            total_frames = len(frames)

            if progress_cb:
                progress_cb(
                    f"stage {stage_idx + 1}/{stage_count}: {stage.name}",
                    0, total_frames,
                )

            if stage.kind == "directory":
                await stage.fn(current_src, stage.stage_dir)
                out_frames = sorted(stage.stage_dir.glob("frame_*.png"))
                if progress_cb:
                    progress_cb(
                        f"stage {stage_idx + 1}/{stage_count}: {stage.name}",
                        len(out_frames), max(len(out_frames), 1),
                    )
            else:
                for idx, src in enumerate(frames):
                    job_control.check_cancelled()
                    dst = stage.stage_dir / src.name
                    await stage.fn(src, dst, idx)
                    if progress_cb:
                        progress_cb(
                            f"stage {stage_idx + 1}/{stage_count}: {stage.name}",
                            idx + 1, total_frames,
                        )

            current_src = stage.stage_dir

        # ── encode from final stage ───────────────────────────────────────
        final_stage = self.stages[-1].stage_dir
        out_dir = self.workspace.frames_out
        out_dir.mkdir(parents=True, exist_ok=True)
        for f in sorted(final_stage.glob("frame_*.png")):
            dst = out_dir / f.name
            if not dst.exists():
                shutil.copy2(str(f), str(dst))

        final_count = len(sorted(out_dir.glob("frame_*.png")))
        if dump_count > 0 and final_count > 0 and final_count != dump_count:
            fps = float(fps) * (final_count / dump_count)

        return await vp_encode(
            self.workspace, output_path, float(fps), mux_audio=mux_audio,
        )
