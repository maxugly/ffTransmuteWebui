"""
Watermark tab (Clean section) — LaMA inpaint removal, engine #2.

`lama-openvino`: user-drawn static normalized rectangle, inpainted with
`Carve/LaMa-ONNX` (`lama_fp32.onnx`, Apache-2.0, big-LaMA port) via direct
OpenVINO IR (FP16, compiled GPU/CPU). Video goes dump →
`app/filters/lama.py` (`directory`) → encode (invariant 1); images run the
same compiled model once in-process through the shared `inpaint_image()`
helper (no code fork).

V1 file (`watermark_ops.py`) is untouched: this module imports its
validation/naming/output helpers and registers two NEW ops
(`watermark_lama_remove`, `watermark_lama_setup`). `watermark_remove`
keeps refusing non-`gemini-reverse-alpha` engines with its existing error.

See docs/watermark-lama-spec.md (Phase 1 only — manual static rectangle;
Florence-2 Detect-assist §12 is NOT built here).
"""
from __future__ import annotations

import asyncio
import hashlib
import urllib.request
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..filters.lama import (
    MODEL_FILENAME,
    MODEL_LICENSE,
    MODEL_REPO,
    get_compiled,
    introspect_ir,
    ir_path_for,
    lama_model_dir,
    make_lama_directory,
    rasterize_mask,
)
from ..staged_job import StageSpec, run_staged_job
from .watermark_ops import (
    IMAGE_EXTS,
    VIDEO_EXTS,
    _default_output,
    _ensure_output_file,
    _resolve_output,
    _validate_input,
)

ENGINE_LAMA = "lama-openvino"

MODEL_URL = f"{MODEL_REPO}/resolve/main/{MODEL_FILENAME}"

SETUP_HINT = (
    "LaMA weights not ready — open the Watermark tab LaMA Setup row "
    "(Clean → Watermark → engine lama-openvino → Setup) or POST "
    "/ops/watermark_lama_setup."
)

MAX_RECT_AREA = 0.25  # normalized area cap (LaMA hallucinates past this)


def _sha_file(onnx_path: Path) -> Path:
    return onnx_path.with_suffix(onnx_path.suffix + ".sha256")


def get_lama_status() -> dict:
    """Additive status block for GET /api/watermark/status (read-only)."""
    d = lama_model_dir()
    onnx = d / MODEL_FILENAME
    ir = ir_path_for(d)
    sha: str | None = None
    sidecar = _sha_file(onnx) if onnx.is_file() else None
    if sidecar is not None and sidecar.is_file():
        try:
            sha = sidecar.read_text().strip().split()[0] or None
        except OSError:
            sha = None
    devices: list[str] = []
    try:
        import openvino as ov

        devices = [str(x) for x in ov.Core().available_devices]
    except Exception:
        pass
    return {"onnx_present": onnx.is_file(), "ir_present": ir.is_file(),
            "sha256": sha, "devices": devices}


# ── Params ────────────────────────────────────────────────────────────────

class WatermarkLamaRemoveParams(BaseModel):
    model_config = {"extra": "ignore"}

    input_path: str = Field(..., description="Absolute image/video path")
    output_path: str | None = Field(None, description="Explicit output file")
    out_dir: str | None = Field(None, description="Output folder (named from input)")
    overwrite: bool = Field(False)
    engine: str = Field(ENGINE_LAMA)
    mask_x: float = Field(0.80, ge=0.0, le=1.0)
    mask_y: float = Field(0.84, ge=0.0, le=1.0)
    mask_w: float = Field(0.17, gt=0.0, le=1.0)
    mask_h: float = Field(0.12, gt=0.0, le=1.0)
    feather_px: int = Field(1, ge=0, le=8)
    device: Literal["GPU", "CPU", "AUTO"] = Field("GPU")
    start_frame: int = Field(1, ge=1)
    end_frame: int = Field(999999, ge=1)
    dry_run: bool = Field(False)


class WatermarkLamaSetupParams(BaseModel):
    model_config = {"extra": "ignore"}

    action: Literal["install", "update"] = Field("install")
    dry_run: bool = Field(False)


# ── Validation ────────────────────────────────────────────────────────────

def _validate_rect(p: WatermarkLamaRemoveParams) -> str | None:
    area = float(p.mask_w) * float(p.mask_h)
    if area <= 0:
        return "mask rect has zero area (mask_w/mask_h must be > 0)"
    if area > MAX_RECT_AREA:
        return (
            f"mask rect covers {area:.1%} of the frame (cap 25%) — LaMA "
            f"hallucinates at that scale; shrink the rect or wait for the "
            f"general-ai diffusion engine."
        )
    return None


def _check_engine(engine: str) -> str | None:
    if engine == ENGINE_LAMA:
        return None
    return (
        f"unknown engine '{engine}' (this op handles '{ENGINE_LAMA}' only — "
        f"use the Watermark tab engine dropdown)."
    )


def _check_ir() -> str | None:
    if not ir_path_for(lama_model_dir()).is_file():
        return SETUP_HINT
    return None


def _is_video_path(p: Path) -> bool:
    return p.suffix.lower() in VIDEO_EXTS


# ── Handlers ──────────────────────────────────────────────────────────────

async def watermark_lama_remove(p: WatermarkLamaRemoveParams) -> OperationResult:
    op = "watermark_lama_remove"
    src, err = _validate_input(p.input_path)
    if err:
        return OperationResult(ok=False, operation=op, error=err, dry_run=p.dry_run)
    assert src is not None
    eng_err = _check_engine(p.engine)
    if eng_err:
        return OperationResult(ok=False, operation=op, error=eng_err, dry_run=p.dry_run)
    rect_err = _validate_rect(p)
    if rect_err:
        return OperationResult(ok=False, operation=op, error=rect_err, dry_run=p.dry_run)
    if p.output_path and p.out_dir:
        return OperationResult(
            ok=False, operation=op,
            error="Use either output_path or out_dir, not both.",
            dry_run=p.dry_run,
        )
    if p.out_dir and not Path(p.out_dir).expanduser().is_absolute():
        return OperationResult(
            ok=False, operation=op, error=f"out_dir must be absolute: {p.out_dir}",
            dry_run=p.dry_run,
        )
    if p.output_path and not Path(p.output_path).expanduser().is_absolute():
        return OperationResult(
            ok=False, operation=op,
            error=f"output_path must be absolute: {p.output_path}",
            dry_run=p.dry_run,
        )
    out = _resolve_output(src, p.output_path, p.out_dir)
    if out.exists() and not p.overwrite:
        return OperationResult(
            ok=False, operation=op,
            error=f"Output already exists (pass overwrite=true): {out}",
            dry_run=p.dry_run,
        )
    if src.suffix.lower() not in (IMAGE_EXTS | VIDEO_EXTS):
        return OperationResult(
            ok=False, operation=op,
            error=f"Unsupported input type: {src.suffix or '(no extension)'}",
            dry_run=p.dry_run,
        )
    ir_err = _check_ir()
    if ir_err and not p.dry_run:
        return OperationResult(ok=False, operation=op, error=ir_err, dry_run=p.dry_run)

    # Op collects the four mask_* floats → mask_rect tuple at the call
    # site; the tuple is never on the HTTP wire (audit-2 fix).
    mask_rect = (float(p.mask_x), float(p.mask_y),
                 float(p.mask_w), float(p.mask_h))
    is_video = _is_video_path(src)
    rect_txt = (f"rect x={mask_rect[0]:.3f} y={mask_rect[1]:.3f} "
                f"w={mask_rect[2]:.3f} h={mask_rect[3]:.3f} "
                f"({mask_rect[2] * mask_rect[3]:.1%})")
    summary = (f"watermark_lama_remove {src.name} → {out.name} "
               f"({p.engine}, {p.device}, {rect_txt})")

    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, output_path=None, dry_run=True,
            command=summary,
            stdout=f"{summary}\nWould write {out}\n",
            meta={"dry_run": True, "engine": p.engine,
                  "mask": {"x": mask_rect[0], "y": mask_rect[1],
                           "w": mask_rect[2], "h": mask_rect[3]}},
        )

    if is_video:
        result = await run_staged_job(
            op_id=op,
            prefix="lamawm_",
            input_path=src,
            output_path=out,
            dry_run=False,
            dump_kwargs={"start_frame": p.start_frame,
                         "end_frame": p.end_frame},
            stages=[
                StageSpec(
                    "lama", "directory",
                    make_lama_directory(
                        mask_rect=mask_rect,
                        feather_px=int(p.feather_px),
                        device=str(p.device),
                        model_dir=lama_model_dir(),
                    ),
                ),
            ],
            encode_kwargs={"mux_audio": True},
            summary=summary,
        )
        if not result.ok:
            return result
        file_err = _ensure_output_file(out)
        if file_err:
            return OperationResult(
                ok=False, operation=op, error=file_err, dry_run=False,
                command=summary,
            )
        meta = dict(result.meta or {})
        meta.update({"engine": p.engine,
                     "mask": {"x": mask_rect[0], "y": mask_rect[1],
                              "w": mask_rect[2], "h": mask_rect[3]}})
        result.meta = meta
        result.command = summary
        return result

    # Image path: single-shot in-process inference (start/end_frame are
    # video-only and ignored here — documented, never an error).
    try:
        import cv2

        from ..filters.lama import inpaint_image
    except ImportError as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=False)
    token = job_control.current_token()
    try:
        def _run() -> dict:
            if token:
                job_control.bind(token)
            img = cv2.imread(str(src))
            if img is None:
                raise RuntimeError(f"unreadable image: {src}")
            h, w = img.shape[:2]
            mask_full = rasterize_mask(w, h, mask_rect, int(p.feather_px))
            compiled, settled = get_compiled(lama_model_dir(), str(p.device))
            spec = introspect_ir(ir_path_for(lama_model_dir()))
            done = inpaint_image(img, mask_full, compiled, spec,
                                 canvas=spec["size"])
            out.parent.mkdir(parents=True, exist_ok=True)
            if not cv2.imwrite(str(out), done):
                raise RuntimeError(f"could not write {out}")
            return {"settled": settled, "w": w, "h": h}

        if token:
            job_control.report_progress(
                f"lama inpainting {src.name}", phase="lama",
                current=0, total=1, unit="frames", token=token,
            )
        info = await asyncio.to_thread(_run)
        if token:
            job_control.report_progress(
                "lama done: 1 frame", phase="lama",
                current=1, total=1, unit="frames", token=token,
            )
    except job_control.JobCancelled as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=False)
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false (invariant 10)
        return OperationResult(ok=False, operation=op, error=str(e),
                               dry_run=False, command=summary)
    file_err = _ensure_output_file(out)
    if file_err:
        return OperationResult(ok=False, operation=op, error=file_err,
                               dry_run=False, command=summary)
    mx, my, mw, mh = mask_rect
    return OperationResult(
        ok=True, operation=op, output_path=str(out), dry_run=False,
        command=summary, stdout=f"{summary}\nOutput: {out}\n",
        meta={"engine": p.engine, "device_settled": info["settled"],
              "mask": {"x": mx, "y": my, "w": mw, "h": mh,
                       "px": {"frame_w": info["w"], "frame_h": info["h"]}},
              "frame_count": 1},
    )


def _download(url: str, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "mtapi-lama-setup"})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            job_control.check_cancelled()
    tmp.replace(dest)
    return dest.stat().st_size


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


async def watermark_lama_setup(p: WatermarkLamaSetupParams) -> OperationResult:
    """Download ONNX → convert to FP16 IR → CPU compile-smoke.

    Cancel-safe between phases. Ends with a fresh status payload in meta +
    recommend_restart=false. Dry-run prints phases and changes nothing.
    """
    op = "watermark_lama_setup"
    d = lama_model_dir()
    onnx = d / MODEL_FILENAME
    ir = ir_path_for(d)
    phases = [
        f"download {MODEL_URL} → {onnx}",
        f"convert → FP16 IR {ir}",
        "compile-smoke on CPU (synthetic 512 input, no media needed)",
    ]
    plan = "\n".join(f"phase {i + 1}: {ph}" for i, ph in enumerate(phases))
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, dry_run=True, command=plan,
            stdout=f"watermark_lama_setup {p.action} (dry run — nothing changed)\n{plan}\n",
            meta={"dry_run": True, "status": {"lama": get_lama_status()},
                  "recommend_restart": False},
        )
    logs = [f"watermark_lama_setup {p.action} ({MODEL_REPO}, {MODEL_LICENSE})"]
    token = job_control.current_token()

    def _phase(i: int, total: int) -> None:
        job_control.check_cancelled()
        if token:
            job_control.report_progress(
                f"setup phase {i + 1}/{total}", phase="setup",
                current=i, total=total, unit="phases", token=token,
            )

    try:
        # Phase 1 — download if absent / byte-mismatched / update asked.
        _phase(0, len(phases))
        recorded: str | None = None
        if _sha_file(onnx).is_file() and onnx.is_file():
            try:
                recorded = _sha_file(onnx).read_text().strip().split()[0]
            except OSError:
                recorded = None
        need_dl = (
            p.action == "update" or not onnx.is_file()
            or (recorded is not None and _sha256(onnx) != recorded)
        )
        if need_dl:
            size = await asyncio.to_thread(_download, MODEL_URL, onnx)
            logs.append(f"downloaded {size} bytes → {onnx}")
        else:
            logs.append(f"onnx present, kept ({onnx.stat().st_size} bytes)")
        sha = await asyncio.to_thread(_sha256, onnx)
        await asyncio.to_thread(_sha_file(onnx).write_text, sha + "\n")
        logs.append(f"sha256 {sha[:16]}…")

        # Phase 2 — convert to FP16 IR (once; runtime only compiles).
        _phase(1, len(phases))
        if p.action == "update" or not ir.is_file():
            def _convert() -> None:
                import openvino as ov

                if token:
                    job_control.bind(token)
                model = ov.Core().read_model(str(onnx))
                ov.save_model(model, str(ir), compress_to_fp16=True)

            await asyncio.to_thread(_convert)
            logs.append(f"converted FP16 IR → {ir}")
        else:
            logs.append("IR present, kept")

        # Phase 3 — CPU compile-smoke on a synthetic input.
        _phase(2, len(phases))

        def _smoke() -> dict:
            import numpy as np

            if token:
                job_control.bind(token)
            compiled, _ = get_compiled(d, "CPU")
            spec = introspect_ir(ir)
            n = spec["size"]
            img = np.zeros((1, 3, n, n), dtype=np.float32)
            msk = np.zeros((1, 1, n, n), dtype=np.float32)
            out = compiled({spec["image_name"]: img,
                            spec["mask_name"]: msk})[spec["output_name"]]
            return {"shape": [int(v) for v in out.shape],
                    "max": float(np.max(out))}

        smoke = await asyncio.to_thread(_smoke)
        logs.append(f"cpu smoke ok: shape={smoke['shape']} max={smoke['max']:.1f}")
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"lama": get_lama_status()},
                  "recommend_restart": False},
        )
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"lama": get_lama_status()},
                  "recommend_restart": False},
        )
    if token:
        job_control.report_progress(
            "setup done", phase="done",
            current=len(phases), total=len(phases), unit="phases", token=token,
        )
    return OperationResult(
        ok=True, operation=op, command=plan, stdout="\n".join(logs),
        meta={"status": {"lama": get_lama_status()},
              "recommend_restart": False, "repo": MODEL_REPO,
              "license": MODEL_LICENSE},
    )


register(OperationSpec(
    id="watermark_lama_remove",
    summary="Remove static-rect watermark via LaMA inpaint (OpenVINO)",
    description=(
        "User-drawn normalized rectangle inpainted with Carve/LaMa-ONNX "
        "(FP16 OpenVINO IR, GPU/CPU). Video: dump → lama stage → encode "
        "(audio kept). Image: single-shot in-process. Rect area capped "
        "at 25% of frame."
    ),
    params_model=WatermarkLamaRemoveParams,
    handler=watermark_lama_remove,
    tags=["watermark", "clean", "image", "video"],
))

register(OperationSpec(
    id="watermark_lama_setup",
    summary="Install/update LaMA weights (download + FP16 IR + CPU smoke)",
    description=(
        f"Downloads {MODEL_FILENAME} from {MODEL_REPO}, converts once to "
        "FP16 OpenVINO IR, compile-smokes on CPU. Tab installer row driver."
    ),
    params_model=WatermarkLamaSetupParams,
    handler=watermark_lama_setup,
    tags=["watermark", "clean", "setup"],
))
