"""QR Art Generator — QR code + Stable Diffusion ControlNet (OpenVINO) + IP-Adapter."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import finalize_output_path

_IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_WORKER = Path(__file__).resolve().parent / "qr_art_ov_worker.py"
_DEFAULT_GEN_DIR = Path("/tmp/mtapi_gen")

MODEL_ID = "rupeshs/sd-turbo-openvino"
CONTROLNET_ID = "monster-labs/control_v1p_sd15_qrcode_monster"
IP_ADAPTER_ID = "h94/IP-Adapter"
IP_ADAPTER_WEIGHT = "ip-adapter_sd15.safetensors"
DEVICE = "GPU"
FALLBACK_DEVICE = "CPU"
RESOLUTION_DEFAULT = 512
RESOLUTIONS = [(512, 512), (512, 768), (768, 512)]
IP_ADAPTER_MAX_RES = 512
OV_CACHE_DIR = "./models/ov_cache"
DEFAULTS = {
    "prompt": "anime city at night, neon lights, rain, highly detailed, studio ghibli style",
    "negative_prompt": "low quality, blurry, distorted, ugly, bad anatomy, text, watermark",
    "steps": 30,
    "guidance_scale": 9.0,
    "strength": 0.35,
    "seed": -1,
}


class QrArtParams(BaseModel):
    prompt: str = Field(..., min_length=1)
    negative_prompt: str = Field("")
    qr_text: str = Field(..., min_length=1, description="Text to encode in QR code")
    steps: int = Field(30, ge=1, le=50)
    guidance_scale: float = Field(9.0, ge=0.0, le=20.0)
    strength: float = Field(0.35, ge=0.05, le=0.95, description="Img2img strength (QR preservation)")
    seed: int | None = Field(None, description="Random seed; null = random")
    output_path: str | None = Field(
        None, description="PNG path; auto under /tmp/mtapi_gen if blank"
    )
    model_id: str = Field(MODEL_ID)
    device: str = Field(DEVICE)
    dry_run: bool = Field(False)
    use_ip_adapter: bool = Field(
        False, description="Enable IP-Adapter image prompting (reference image for appearance)"
    )
    ip_adapter_image: str = Field(
        "", description="Absolute path to reference image, or base64-encoded PNG/JPG"
    )
    ip_adapter_scale: float = Field(0.5, ge=0.0, le=1.0, description="IP-Adapter influence (0=subtle, 1=strong)")
    controlnet_scale: float = Field(
        1.1, ge=0.0, le=2.0, description="ControlNet QR Monster conditioning scale"
    )


def _resolve_fastsd_python() -> str:
    env = (os.environ.get("MTAPI_FASTSD_PYTHON") or "").strip()
    if env and Path(env).is_file():
        return env
    root = Path(
        os.environ.get("MTAPI_FASTSD_ROOT") or "/home/m/.gemini/antigravity-cli/scratch/fastsdcpu"
    )
    candidate = root / "env" / "bin" / "python"
    if candidate.is_file():
        return str(candidate)
    raise RuntimeError(
        f"FastSD python not found at {candidate}. "
        "Set MTAPI_FASTSD_PYTHON or install FastSD env."
    )


def _is_base64(data: str) -> bool:
    """Heuristic: base64 string (possibly with data: prefix) that isn't a path."""
    s = data.strip()
    if s.startswith("data:"):
        return True
    if s.startswith("/"):
        return False
    return len(s) > 100 and not s.endswith((".png", ".jpg", ".jpeg", ".webp"))


def _resolve_ip_adapter_image(raw: str, ws: JobWorkspace) -> str | None:
    """Return an absolute path to the IP-Adapter reference image.

    Accepts either a file path or a base64-encoded image string. Base64 is
    decoded into the workspace so the subprocess worker gets a real path.
    """
    if not raw or not raw.strip():
        return None
    raw = raw.strip()
    if _is_base64(raw):
        try:
            header = ""
            if raw.startswith("data:"):
                parts = raw.split(",", 1)
                header = parts[0]
                raw = parts[1]
            b64 = raw
            decoded = base64.b64decode(b64, validate=False)
            ext = ".png"
            for e in (".png", ".jpg", ".jpeg", ".webp"):
                if e in header.lower():
                    ext = e
                    break
            dest = ws.frames_in / "ip_adapter_ref.png"
            dest.write_bytes(decoded)
            return str(dest)
        except Exception:
            return None
    p = Path(raw).expanduser()
    if not p.is_file():
        return None
    return str(p.resolve())


async def qr_art_run(p: QrArtParams) -> OperationResult:
    from .. import job_control
    from ..job_workspace import JobWorkspace

    op = "qr_art"
    try:
        py = _resolve_fastsd_python()
    except RuntimeError as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=p.dry_run)

    out = finalize_output_path(
        p.output_path,
        source=_DEFAULT_GEN_DIR / "qr_art.png",
        default_suffix="_qr_art",
        default_ext=".png",
        allowed_exts=_IMAGE_EXTS,
    )

    summary = (
        f"qr_art text={p.qr_text!r} steps={p.steps} guidance={p.guidance_scale} "
        f"strength={p.strength} model={p.model_id} device={p.device}"
        + (f" ip_adapter=True scale={p.ip_adapter_scale} ctrl_scale={p.controlnet_scale}" if p.use_ip_adapter else "")
    )

    if p.dry_run:
        return OperationResult(
            ok=True,
            operation=op,
            output_path=str(out),
            dry_run=True,
            command=summary,
            stdout=(
                f"python={py}\n{summary}\n"
                f"output={out}\n"
            ),
        )

    ws = JobWorkspace(uuid.uuid4().hex[:12], prefix="qrart_")
    success = False
    logs = [summary]
    if p.use_ip_adapter:
        logs.append(
            f"IP-Adapter active: resolution clamped to {IP_ADAPTER_MAX_RES}x{IP_ADAPTER_MAX_RES} "
            f"(max enforced to keep peak RAM <12GB on 1335U)"
        )
    try:
        ws.create()
        qr_path = ws.frames_in / "qr_base.png"
        job_path = ws.frames_in / "_qr_art_job.json"

        import qrcode
        from PIL import Image

        qr_res = RESOLUTION_DEFAULT
        if p.use_ip_adapter:
            qr_res = IP_ADAPTER_MAX_RES

        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_H,
            box_size=16,
            border=4,
        )
        qr.add_data(p.qr_text)
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        qr_img = qr_img.resize((qr_res, qr_res), Image.NEAREST)
        qr_img.save(str(qr_path), format="PNG")
        logs.append(f"qr_base={qr_path}")

        ip_adapter_image_path = None
        if p.use_ip_adapter:
            ip_adapter_image_path = _resolve_ip_adapter_image(p.ip_adapter_image, ws)
            if ip_adapter_image_path is None:
                return OperationResult(
                    ok=False,
                    operation=op,
                    error="use_ip_adapter is true but ip_adapter_image could not be resolved "
                          "(invalid path or undecodable base64).",
                    stdout="\n".join(logs),
                )
            logs.append(f"ip_adapter_ref={ip_adapter_image_path}")

        job = {
            "output_path": str(out),
            "prompt": p.prompt.strip(),
            "negative_prompt": p.negative_prompt or "",
            "qr_image_path": str(qr_path),
            "steps": int(p.steps),
            "guidance_scale": float(p.guidance_scale),
            "strength": float(p.strength),
            "model_id": p.model_id,
            "device": (p.device or DEVICE).upper(),
            "seed": p.seed,
            "use_ip_adapter": bool(p.use_ip_adapter),
            "ip_adapter_image_path": ip_adapter_image_path or "",
            "ip_adapter_scale": float(p.ip_adapter_scale),
            "controlnet_id": CONTROLNET_ID,
            "controlnet_scale": float(p.controlnet_scale),
            "ip_adapter_id": IP_ADAPTER_ID,
            "ip_adapter_weight": IP_ADAPTER_WEIGHT,
            "ov_cache_dir": OV_CACHE_DIR,
            "resolution": IP_ADAPTER_MAX_RES if p.use_ip_adapter else RESOLUTION_DEFAULT,
        }
        job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")

        token = job_control.current_token()
        job_control.report_progress(
            f"qr_art 0/1",
            phase="qr_art",
            current=0,
            total=1,
            unit="images",
            token=token,
        )

        env = os.environ.copy()
        env["DEVICE"] = (p.device or DEVICE).lower()

        proc = await asyncio.create_subprocess_exec(
            py,
            str(_WORKER),
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
                if text.startswith("PROGRESS ") or text.startswith("DONE "):
                    job_control.report_progress(
                        f"qr_art 1/1",
                        phase="qr_art",
                        current=1,
                        total=1,
                        unit="images",
                        token=token,
                        latest_frame=str(out),
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
            err_text = (stderr_b or b"").decode(errors="replace")[-800:]
            out_tail = (stdout_b or b"").decode(errors="replace")[-400:]
            low = (err_text + out_tail).lower()
            fallback_reason = None
            if p.device and p.device.upper() != "CPU":
                if any(t in low for t in ["bad allocation", "clwaitforevents", "out of memory", "cuda error"]):
                    fallback_reason = f"{proc.returncode}: {err_text or out_tail or 'no output'}"
            if fallback_reason:
                logs.append(f"GPU failed ({fallback_reason}); retrying on CPU")
                fallback_result = await _qr_art_run_with_device(
                    p, ws, out, py, logs, token, device="CPU",
                    qr_path=qr_path,
                    ip_adapter_image_path=ip_adapter_image_path,
                )
                success = bool(fallback_result.ok)
                return fallback_result
            return OperationResult(
                ok=False,
                operation=op,
                error=f"worker exit {proc.returncode}: {err_text or out_tail or 'no output'}",
                stdout=stdout_b.decode(errors="replace")[-2000:],
            )

        if not Path(out).is_file():
            return OperationResult(
                ok=False,
                operation=op,
                error=f"Missing output: {out}",
                stdout=stdout_b.decode(errors="replace")[-2000:],
            )

        logs.append(f"wrote {out}")

        scannable = False
        decoded_data = ""
        scan_error = ""
        try:
            from pyzbar.pyzbar import decode as zbardecode
            from PIL import Image as PILImage

            with PILImage.open(out) as im:
                decoded = zbardecode(im)
                if decoded:
                    scannable = True
                    decoded_data = decoded[0].data.decode("utf-8", errors="ignore")
                else:
                    gray = im.convert("L")
                    decoded2 = zbardecode(gray)
                    if decoded2:
                        scannable = True
                        decoded_data = decoded2[0].data.decode("utf-8", errors="ignore")
        except Exception as e:
            scan_error = str(e)
            logs.append(f"pyzbar check failed: {e}")

        logs.append(
            f"scannable={'yes' if scannable else 'no'}"
            + (f" decoded={decoded_data!r}" if decoded_data else "")
            + (f" error={scan_error}" if scan_error else "")
        )

        meta = {
            "scannable": scannable,
            "decoded": decoded_data,
        }
        if scan_error:
            meta["scan_error"] = scan_error

        job_control.report_progress(
            f"qr_art done 1/1",
            phase="qr_art",
            current=1,
            total=1,
            unit="images",
            token=token,
        )

        success = True
        return OperationResult(
            ok=True,
            operation=op,
            output_path=str(out),
            command=summary,
            stdout="\n".join(logs),
            meta=meta,
        )
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), stdout="\n".join(logs)
        )
    except Exception as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), stdout="\n".join(logs)
        )
    finally:
        ws.cleanup(keep_on_failure=not success)


async def _qr_art_run_with_device(
    p: QrArtParams, ws: JobWorkspace, out: Path, py: str,
    logs: list[str], token: str, device: str, qr_path: Path,
    ip_adapter_image_path: str | None = None,
) -> OperationResult:
    job_path = ws.frames_in / "_qr_art_job_cpu.json"
    job = {
        "output_path": str(out),
        "prompt": p.prompt.strip(),
        "negative_prompt": p.negative_prompt or "",
        "qr_image_path": str(qr_path),
        "steps": int(p.steps),
        "guidance_scale": float(p.guidance_scale),
        "strength": float(p.strength),
        "model_id": p.model_id,
        "device": device,
        "seed": p.seed,
        "use_ip_adapter": bool(p.use_ip_adapter),
        "ip_adapter_image_path": ip_adapter_image_path or "",
        "ip_adapter_scale": float(p.ip_adapter_scale),
        "controlnet_id": CONTROLNET_ID,
        "controlnet_scale": float(p.controlnet_scale),
        "ip_adapter_id": IP_ADAPTER_ID,
        "ip_adapter_weight": IP_ADAPTER_WEIGHT,
        "ov_cache_dir": OV_CACHE_DIR,
        "resolution": IP_ADAPTER_MAX_RES if p.use_ip_adapter else RESOLUTION_DEFAULT,
    }
    job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")

    env = os.environ.copy()
    env["DEVICE"] = device.lower()

    proc = await asyncio.create_subprocess_exec(
        py,
        str(_WORKER),
        "--job",
        str(job_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    stdout_chunks: list[bytes] = []
    stderr_b = b""

    async def _pump() -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            stdout_chunks.append(line)

    wait_task = asyncio.create_task(proc.wait())
    pump = asyncio.create_task(_pump())
    try:
        while not wait_task.done():
            job_control.check_cancelled()
            await asyncio.sleep(0.4)
        await wait_task
        await pump
        stderr_b = await proc.stderr.read() if proc.stderr else b""
    except (job_control.JobCancelled, asyncio.CancelledError):
        proc.kill()
        await proc.wait()
        pump.cancel()
        return OperationResult(
            ok=False, operation="qr_art", error="Cancelled during CPU fallback", stdout="\n".join(logs)
        )

    stdout_b = b"".join(stdout_chunks)
    if proc.returncode != 0:
        err = (stderr_b or b"").decode(errors="replace")[-800:]
        out_t = (stdout_b or b"").decode(errors="replace")[-400:]
        return OperationResult(
            ok=False,
            operation="qr_art",
            error=f"CPU fallback also failed: {err or out_t or 'no output'}",
            stdout="\n".join(logs + [stdout_b.decode(errors="replace")[-500:]]),
        )

    if not Path(out).is_file():
        return OperationResult(
            ok=False,
            operation="qr_art",
            error=f"Missing output after CPU fallback: {out}",
            stdout=stdout_b.decode(errors="replace")[-2000:],
        )

    scannable = False
    decoded_data = ""
    scan_error = ""
    try:
        from pyzbar.pyzbar import decode as zbardecode
        from PIL import Image as PILImage

        with PILImage.open(out) as im:
            decoded = zbardecode(im)
            if decoded:
                scannable = True
                decoded_data = decoded[0].data.decode("utf-8", errors="ignore")
            else:
                gray = im.convert("L")
                decoded2 = zbardecode(gray)
                if decoded2:
                    scannable = True
                    decoded_data = decoded2[0].data.decode("utf-8", errors="ignore")
    except Exception as e:
        scan_error = str(e)

    meta = {"scannable": scannable, "decoded": decoded_data}
    if scan_error:
        meta["scan_error"] = scan_error

    logs.append(f"cpu_fallback=device={device} scannable={'yes' if scannable else 'no'}")
    return OperationResult(
        ok=True,
        operation="qr_art",
        output_path=str(out),
        command="qr_art (CPU fallback)",
        stdout="\n".join(logs),
        meta=meta,
    )


register(OperationSpec(
    id="qr_art",
    summary="QR Art Generator — OpenVINO img2img on QR code + optional IP-Adapter",
    description=(
        "Generates a scannable QR code from qr_text, then diffuses it with "
        "Stable Diffusion 1.5 img2img via OpenVINO. "
        "When use_ip_adapter is true, switches to a PyTorch "
        "StableDiffusionControlNetImg2ImgPipeline with ControlNet QR Monster "
        "(structure) + IP-Adapter (appearance) dual conditioning, "
        "enforcing 512x512 max resolution to keep RAM <12GB. "
        "Falls back to CPU on iGPU OOM. Validates scannability with pyzbar."
    ),
    params_model=QrArtParams,
    handler=qr_art_run,
    tags=["qr_art", "openvino", "diffusion", "img2img", "qrcode", "ip_adapter", "controlnet"],
))
