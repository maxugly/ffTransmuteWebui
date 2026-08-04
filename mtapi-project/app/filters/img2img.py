"""OpenVINO img2img directory stage — mark frames, copy the rest.

kind=directory. Shared by /ops/pipeline and /ops/img2img.
Runs a one-shot worker under FastSD's Python (optimum-intel + OpenVINO GPU).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any

from .. import job_control
from . import register_stage

_DEFAULT_FASTSD_ROOT = Path(
    "/home/m/.gemini/antigravity-cli/scratch/fastsdcpu"
)
_WORKER = Path(__file__).resolve().parent / "img2img_ov_worker.py"


def resolve_fastsd_root() -> Path:
    env = (os.environ.get("MTAPI_FASTSD_ROOT") or "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        if p.is_dir():
            return p
    if _DEFAULT_FASTSD_ROOT.is_dir():
        return _DEFAULT_FASTSD_ROOT
    raise RuntimeError(
        "FastSD root not found. Set MTAPI_FASTSD_ROOT to the fastsdcpu checkout "
        f"(expected {_DEFAULT_FASTSD_ROOT})."
    )


def resolve_fastsd_python() -> str:
    env = (os.environ.get("MTAPI_FASTSD_PYTHON") or "").strip()
    if env and Path(env).is_file():
        return env
    root = resolve_fastsd_root()
    candidate = root / "env" / "bin" / "python"
    if candidate.is_file():
        return str(candidate)
    raise RuntimeError(
        f"FastSD python not found at {candidate}. "
        "Set MTAPI_FASTSD_PYTHON or install FastSD env."
    )


def _list_frames(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    frames = sorted(directory.glob("frame_*.png"))
    if frames:
        return frames
    return sorted(directory.glob("*.png"))


def resolve_selection(
    n: int,
    frame_indices: list[int] | None,
    frame_range: list[int] | None,
) -> set[int]:
    """0-based indices to img2img. Empty args → all frames."""
    if n <= 0:
        return set()
    if frame_indices is not None and len(frame_indices) > 0:
        return {int(i) for i in frame_indices if 0 <= int(i) < n}
    if frame_range is not None and len(frame_range) >= 2:
        a, b = int(frame_range[0]), int(frame_range[1])
        if a > b:
            a, b = b, a
        a = max(0, a)
        b = min(n - 1, b)
        return set(range(a, b + 1))
    return set(range(n))


async def run_img2img_directory(
    src_dir: Path | str,
    dst_dir: Path | str,
    *,
    prompt: str = "",
    negative_prompt: str = "",
    strength: float = 0.35,
    inference_steps: int = 4,
    guidance_scale: float = 1.0,
    model_id: str = "rupeshs/sd-turbo-openvino",
    device: str = "gpu",
    frame_indices: list[int] | None = None,
    frame_range: list[int] | None = None,
    max_side: int = 0,
) -> dict[str, Any]:
    """Copy all frames; OpenVINO-img2img only selected indices."""
    src = Path(src_dir).resolve()
    dst = Path(dst_dir).resolve()
    dst.mkdir(parents=True, exist_ok=True)

    frames = _list_frames(src)
    if not frames:
        raise RuntimeError(f"No PNG frames in {src}")

    prompt = (prompt or "").strip()
    selected = resolve_selection(len(frames), frame_indices, frame_range)
    if selected and not prompt:
        raise ValueError("img2img requires a non-empty prompt when frames are selected")

    # Always materialize full sequence in dst
    marked: list[tuple[Path, Path]] = []
    for i, fpath in enumerate(frames):
        out = dst / fpath.name
        if i not in selected:
            if not out.exists() or out.stat().st_mtime < fpath.stat().st_mtime:
                shutil.copy2(fpath, out)
        else:
            marked.append((fpath, out))

    token = job_control.current_token()
    n_mark = len(marked)
    job_control.report_progress(
        f"img2img {0}/{n_mark} marked ({len(frames)} total)",
        phase="img2img",
        current=0,
        total=max(n_mark, 1),
        unit="frames",
        token=token,
    )

    if n_mark == 0:
        return {
            "frame_count": len(frames),
            "img2img_count": 0,
            "model_id": model_id,
        }

    py = resolve_fastsd_python()
    worker = _WORKER
    if not worker.is_file():
        raise RuntimeError(f"Worker script missing: {worker}")

    job_path = dst / "_img2img_job.json"
    job = {
        "pairs": [{"in": str(a.resolve()), "out": str(b.resolve())} for a, b in marked],
        "prompt": prompt,
        "negative_prompt": negative_prompt or "",
        "strength": float(strength),
        "inference_steps": int(inference_steps),
        "guidance_scale": float(guidance_scale),
        "model_id": model_id,
        "device": (device or "gpu").upper(),
        "max_side": int(max_side or 0),
    }
    job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")

    env = os.environ.copy()
    env["DEVICE"] = (device or "gpu").lower()

    proc = await asyncio.create_subprocess_exec(
        py,
        str(worker),
        "--job",
        str(job_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    stdout_chunks: list[bytes] = []
    stderr_b = b""

    async def _pump_stdout() -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            stdout_chunks.append(line)
            text = line.decode(errors="replace").strip()
            if text.startswith("PROGRESS "):
                try:
                    part = text.split()[1]
                    cur_s, tot_s = part.split("/")
                    done, tot = int(cur_s), int(tot_s)
                except Exception:
                    done, tot = 0, n_mark
                job_control.report_progress(
                    f"img2img {done}/{tot}",
                    phase="img2img",
                    current=done,
                    total=max(tot, 1),
                    unit="frames",
                    token=token,
                )

    wait_task = asyncio.create_task(proc.wait())
    pump = asyncio.create_task(_pump_stdout())
    try:
        while not wait_task.done():
            job_control.check_cancelled()
            await asyncio.sleep(0.4)
        await wait_task
        await pump
        stderr_b = await proc.stderr.read() if proc.stderr else b""
    except job_control.JobCancelled:
        proc.kill()
        await proc.wait()
        pump.cancel()
        raise
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        pump.cancel()
        raise

    stdout_b = b"".join(stdout_chunks)
    if proc.returncode != 0:
        err = (stderr_b or b"").decode(errors="replace")[-800:]
        out_tail = (stdout_b or b"").decode(errors="replace")[-400:]
        raise RuntimeError(
            f"img2img worker failed (exit {proc.returncode}): {err or out_tail or 'no output'}"
        )

    # Ensure all marked outputs exist
    missing = [str(b) for a, b in marked if not b.is_file()]
    if missing:
        raise RuntimeError(f"img2img worker missing outputs: {missing[:3]}")

    job_control.report_progress(
        f"img2img done {n_mark}/{n_mark}",
        phase="img2img",
        current=n_mark,
        total=n_mark,
        unit="frames",
        token=token,
    )

    return {
        "frame_count": len(frames),
        "img2img_count": n_mark,
        "model_id": model_id,
        "command": f"{py} {worker} --job {job_path}",
    }


def make_img2img_stage(
    *,
    prompt: str = "",
    negative_prompt: str = "",
    strength: float = 0.35,
    inference_steps: int = 4,
    guidance_scale: float = 1.0,
    model_id: str = "rupeshs/sd-turbo-openvino",
    device: str = "gpu",
    frame_indices: list[int] | None = None,
    frame_range: list[int] | None = None,
    max_side: int = 0,
    **_extra: Any,
):
    """Factory for pipeline registry. Returned callable has kind='directory'."""

    async def directory_fn(src_dir: Path, dst_dir: Path) -> dict[str, Any]:
        return await run_img2img_directory(
            src_dir,
            dst_dir,
            prompt=prompt,
            negative_prompt=negative_prompt,
            strength=float(strength),
            inference_steps=int(inference_steps),
            guidance_scale=float(guidance_scale),
            model_id=str(model_id),
            device=str(device),
            frame_indices=list(frame_indices) if frame_indices is not None else None,
            frame_range=list(frame_range) if frame_range is not None else None,
            max_side=int(max_side or 0),
        )

    directory_fn.kind = "directory"  # type: ignore[attr-defined]
    directory_fn.stage_name = "img2img"  # type: ignore[attr-defined]
    return directory_fn


register_stage("img2img", make_img2img_stage)
