"""Text-to-image via OpenVINO (FastSD GPU python worker)."""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path

IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp"})

_WORKER = Path(__file__).resolve().parent.parent / "filters" / "txt2img_ov_worker.py"
_DEFAULT_GEN_DIR = Path("/tmp/mtapi_gen")


class Txt2ImgParams(BaseModel):
    prompt: str = Field(..., min_length=1)
    negative_prompt: str = Field("")
    output_path: str | None = Field(
        None, description="PNG path (or dir for count>1); auto under /tmp/mtapi_gen"
    )
    width: int = Field(512, ge=64, le=2048)
    height: int = Field(512, ge=64, le=2048)
    inference_steps: int = Field(4, ge=1, le=50)
    guidance_scale: float = Field(1.0, ge=0.0, le=20.0)
    model_id: str = Field("rupeshs/sd-turbo-openvino")
    device: str = Field("gpu")
    count: int = Field(1, ge=1, le=8, description="Number of images to generate")
    seed: int | None = Field(None, description="Base seed; null = random")
    dry_run: bool = Field(False)


def _even8(n: int) -> int:
    n = max(8, int(n))
    return n - (n % 8)


async def txt2img_run(p: Txt2ImgParams) -> OperationResult:
    from .. import job_control
    from ..filters.img2img import resolve_fastsd_python, resolve_fastsd_root

    op = "txt2img"
    try:
        py = resolve_fastsd_python()
        root = resolve_fastsd_root()
    except RuntimeError as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=p.dry_run)

    w, h = _even8(p.width), _even8(p.height)
    n = int(p.count)

    # Resolve output paths
    if p.output_path:
        out0 = Path(p.output_path).expanduser().resolve()
        if n > 1 and (out0.is_dir() or str(p.output_path).endswith(os.sep)):
            out_dir = out0
            out_dir.mkdir(parents=True, exist_ok=True)
            outputs = [out_dir / f"txt2img_{i:04d}.png" for i in range(n)]
        elif n > 1:
            # treat as base file stem
            stem = out0.stem if out0.suffix else out0.name
            parent = out0.parent if out0.suffix else out0
            if not out0.suffix:
                parent.mkdir(parents=True, exist_ok=True)
                outputs = [parent / f"{stem}_{i:04d}.png" for i in range(n)]
            else:
                parent.mkdir(parents=True, exist_ok=True)
                outputs = [
                    parent / f"{stem}_{i:04d}{out0.suffix}" for i in range(n)
                ]
        else:
            outputs = [
                finalize_output_path(
                    str(out0),
                    source=_DEFAULT_GEN_DIR / "txt2img.png",
                    default_suffix="",
                    default_ext=".png",
                    allowed_exts=IMAGE_EXTS,
                )
            ]
    else:
        _DEFAULT_GEN_DIR.mkdir(parents=True, exist_ok=True)
        if n == 1:
            outputs = [
                finalize_output_path(
                    None,
                    source=_DEFAULT_GEN_DIR / "txt2img.png",
                    default_suffix="",
                    default_ext=".png",
                    allowed_exts=IMAGE_EXTS,
                )
            ]
        else:
            batch = _DEFAULT_GEN_DIR / f"batch_{uuid.uuid4().hex[:8]}"
            batch.mkdir(parents=True, exist_ok=True)
            outputs = [batch / f"txt2img_{i:04d}.png" for i in range(n)]

    summary = (
        f"txt2img {w}x{h} n={n} steps={p.inference_steps} "
        f"model={p.model_id} device={p.device}"
    )

    if p.dry_run:
        return OperationResult(
            ok=True,
            operation=op,
            output_path=str(outputs[0] if n == 1 else outputs[0].parent),
            dry_run=True,
            command=summary,
            stdout=(
                f"python={py}\nfastsd_root={root}\n{summary}\n"
                f"outputs={[str(o) for o in outputs]}\n"
            ),
        )

    worker = _WORKER
    if not worker.is_file():
        return OperationResult(
            ok=False, operation=op, error=f"Worker missing: {worker}",
        )

    job_dir = Path("/tmp/mtapi_jobs") / f"txt2img_{uuid.uuid4().hex[:12]}"
    job_dir.mkdir(parents=True, exist_ok=True)
    job_path = job_dir / "job.json"
    job = {
        "outputs": [str(o) for o in outputs],
        "prompt": p.prompt.strip(),
        "negative_prompt": p.negative_prompt or "",
        "inference_steps": p.inference_steps,
        "guidance_scale": p.guidance_scale,
        "width": w,
        "height": h,
        "model_id": p.model_id,
        "device": (p.device or "gpu").upper(),
        "seed": p.seed,
    }
    job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")

    token = job_control.current_token()
    job_control.report_progress(
        f"txt2img 0/{n}",
        phase="txt2img",
        current=0,
        total=n,
        unit="images",
        token=token,
    )

    env = os.environ.copy()
    env["DEVICE"] = (p.device or "gpu").lower()

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

    async def _pump() -> None:
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
                    cur, tot = int(cur_s), int(tot_s)
                except Exception:
                    cur, tot = 0, n
                latest_frame = str(outputs[cur-1]) if cur > 0 and cur <= len(outputs) else None
                job_control.report_progress(
                    f"txt2img {cur}/{tot}",
                    phase="txt2img",
                    current=cur,
                    total=max(tot, 1),
                    unit="images",
                    token=token,
                    latest_frame=latest_frame,
                )

    wait_task = asyncio.create_task(proc.wait())
    pump = asyncio.create_task(_pump())
    logs = [summary]
    try:
        while not wait_task.done():
            job_control.check_cancelled()
            await asyncio.sleep(0.4)
        await wait_task
        await pump
        stderr_b = await proc.stderr.read() if proc.stderr else b""
    except job_control.JobCancelled as e:
        proc.kill()
        await proc.wait()
        return OperationResult(ok=False, operation=op, error=str(e))
    except Exception as e:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        return OperationResult(ok=False, operation=op, error=str(e))

    stdout_b = b"".join(stdout_chunks)
    if proc.returncode != 0:
        err = (stderr_b or b"").decode(errors="replace")[-800:]
        out_t = stdout_b.decode(errors="replace")[-400:]
        return OperationResult(
            ok=False,
            operation=op,
            error=f"worker exit {proc.returncode}: {err or out_t}",
            stdout=stdout_b.decode(errors="replace")[-2000:],
        )

    missing = [str(o) for o in outputs if not o.is_file()]
    if missing:
        return OperationResult(
            ok=False, operation=op, error=f"Missing outputs: {missing[:3]}",
        )

    job_control.report_progress(
        f"txt2img done {n}/{n}",
        phase="txt2img",
        current=n,
        total=n,
        unit="images",
        token=token,
    )
    logs.append(f"wrote {n} image(s)")
    logs.append(stdout_b.decode(errors="replace")[-500:])

    result_path = str(outputs[0] if n == 1 else outputs[0].parent)
    return OperationResult(
        ok=True,
        operation=op,
        output_path=result_path,
        command=summary,
        stdout="\n".join(logs),
    )


register(OperationSpec(
    id="txt2img",
    summary="OpenVINO text-to-image (FastSD GPU) — generate stills from a prompt",
    description=(
        "Runs OVStableDiffusionPipeline via FastSD's Python env (DEVICE=gpu). "
        "Default model rupeshs/sd-turbo-openvino. Outputs PNG under /tmp/mtapi_gen "
        "or output_path. count=1..8."
    ),
    params_model=Txt2ImgParams,
    handler=txt2img_run,
    tags=["txt2img", "openvino", "diffusion", "generate"],
))
