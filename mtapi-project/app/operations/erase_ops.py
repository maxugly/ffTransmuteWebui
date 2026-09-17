"""Erase tab ops: weights setup + rect/brush removal.

One op, iopaint's erase settings and nothing else (no feather/fade/
sharpen/blend/upscale/precision knobs). Painted `mask_b64` wins when
present, else the `mask_*` rect fallback. Outputs via
`finalize_output_path` (never-overwrite `_0001`, house behavior).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import urllib.request
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..filters.erase import (
    HD_MARGIN_DEFAULT,
    HD_RESIZE_LIMIT_DEFAULT,
    HD_TRIGGER_DEFAULT,
    MODEL_FILENAME,
    MODEL_LICENSE,
    MODEL_REPO,
    check_mask_area,
    decode_mask_png,
    draw_mask,
    erase_model_dir,
    get_compiled,
    inpaint_frame,
    introspect_ir,
    ir_path_for,
    make_erase_directory,
)
from ..pathutil import finalize_output_path
from ..staged_job import StageSpec, run_staged_job
from .watermark_ops import (
    IMAGE_EXTS,
    VIDEO_EXTS,
    _default_ext_for,
    _ensure_output_file,
    _validate_input,
)

SETUP_HINT = (
    "Erase weights not ready — open the Erase tab Setup row "
    "(Clean → Erase → Setup) or POST /ops/erase_setup."
)
MODEL_URL = f"{MODEL_REPO}/resolve/main/{MODEL_FILENAME}"
MAX_RECT_AREA = 0.25  # normalized area cap (LaMA hallucinates past this)
MAX_MASK_B64 = 2 * 1024 * 1024  # painted masks are tiny; refuse garbage


def _sha_file(onnx_path: Path) -> Path:
    return onnx_path.with_suffix(onnx_path.suffix + ".sha256")


class EraseRemoveParams(BaseModel):
    model_config = {"extra": "ignore"}

    input_path: str = Field(..., description="Absolute image/video path")
    output_path: str | None = Field(None, description="Explicit output file")
    out_dir: str | None = Field(None, description="Output folder (named from input)")
    dry_run: bool = Field(False)
    mask_b64: str | None = Field(None, description="Painted mask PNG data URL")
    mask_x: float = Field(0.80, ge=0.0, le=1.0)
    mask_y: float = Field(0.84, ge=0.0, le=1.0)
    mask_w: float = Field(0.17, gt=0.0, le=1.0)
    mask_h: float = Field(0.12, gt=0.0, le=1.0)
    hd_strategy: Literal["Original", "Crop", "Resize"] = Field("Crop")
    crop_trigger: int = Field(HD_TRIGGER_DEFAULT, ge=256, le=4096)
    crop_margin: int = Field(HD_MARGIN_DEFAULT, ge=0, le=512)
    resize_limit: int = Field(HD_RESIZE_LIMIT_DEFAULT, ge=512, le=4096)
    device: Literal["GPU", "CPU", "AUTO"] = Field("GPU")
    save_debug_mask: bool = Field(
        False, description="Save the exact binary mask to junk for troubleshooting"
    )
    start_frame: int = Field(1, ge=1)
    end_frame: int = Field(999999, ge=1)


class EraseSetupParams(BaseModel):
    model_config = {"extra": "ignore"}

    action: Literal["install", "update"] = Field("install")
    dry_run: bool = Field(False)


def _decode_mask_b64(raw: str) -> bytes:
    txt = (raw or "").strip()
    if "," in txt:  # data URL prefix
        txt = txt.split(",", 1)[1]
    if not txt:
        raise ValueError("empty mask")
    if len(txt) > MAX_MASK_B64:
        raise ValueError(f"mask payload too large ({len(txt)} chars)")
    try:
        return base64.b64decode(txt, validate=True)
    except Exception as e:
        raise ValueError(f"mask is not valid base64 PNG: {e}") from e


def _is_video_path(p: Path) -> bool:
    return p.suffix.lower() in VIDEO_EXTS


def _debug_mask_path(out: Path) -> Path:
    """Collision-safe diagnostic mask path; throwaways belong in junk."""
    root = Path(__file__).resolve().parent.parent.parent / "junk"
    root.mkdir(parents=True, exist_ok=True)
    base = root / f"{out.stem}_erase_mask.png"
    candidate = base
    i = 1
    while candidate.exists():
        candidate = root / f"{out.stem}_erase_mask_{i:04d}.png"
        i += 1
    return candidate


async def erase_remove(p: EraseRemoveParams) -> OperationResult:
    op = "erase_remove"
    src, err = _validate_input(p.input_path)
    if err:
        return OperationResult(ok=False, operation=op, error=err, dry_run=p.dry_run)
    assert src is not None
    area = float(p.mask_w) * float(p.mask_h)
    if area <= 0:
        return OperationResult(ok=False, operation=op,
                               error="mask rect has zero area",
                               dry_run=p.dry_run)
    if area > MAX_RECT_AREA:
        return OperationResult(
            ok=False, operation=op,
            error=(f"mask rect covers {area:.1%} of the frame (cap 25%) — "
                   f"LaMA hallucinates at that scale; paint a tighter mask."),
            dry_run=p.dry_run,
        )
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
    try:
        out = finalize_output_path(
            p.output_path, source=src, default_suffix="_clean",
            default_ext=_default_ext_for(src),
            output_dir=p.out_dir,
            allowed_exts=IMAGE_EXTS | VIDEO_EXTS,
        )
    except ValueError as e:
        return OperationResult(ok=False, operation=op, error=str(e),
                               dry_run=p.dry_run)
    if src.suffix.lower() not in (IMAGE_EXTS | VIDEO_EXTS):
        return OperationResult(
            ok=False, operation=op,
            error=f"Unsupported input type: {src.suffix or '(no extension)'}",
            dry_run=p.dry_run,
        )
    mask_png: bytes | None = None
    mask_src = "rect"
    if p.mask_b64:
        try:
            mask_png = _decode_mask_b64(p.mask_b64)
            mask_src = "painted"
        except ValueError as e:
            return OperationResult(ok=False, operation=op, error=str(e),
                                   dry_run=p.dry_run)
    if not ir_path_for(erase_model_dir()).is_file() and not p.dry_run:
        return OperationResult(ok=False, operation=op, error=SETUP_HINT,
                               dry_run=p.dry_run)

    mask_rect = (float(p.mask_x), float(p.mask_y),
                 float(p.mask_w), float(p.mask_h))
    debug_mask_path = _debug_mask_path(out) if p.save_debug_mask else None
    is_video = _is_video_path(src)
    summary = (f"erase_remove {src.name} → {out.name} "
               f"({p.hd_strategy}, mask={mask_src})")
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, output_path=None, dry_run=True,
            command=summary,
            stdout=f"{summary}\nWould write {out}\n",
            meta={"dry_run": True, "hd_strategy": p.hd_strategy,
                  "mask": {"x": mask_rect[0], "y": mask_rect[1],
                           "w": mask_rect[2], "h": mask_rect[3]},
                  "mask_src": mask_src},
        )

    if is_video:
        result = await run_staged_job(
            op_id=op,
            prefix="erase_",
            input_path=src,
            output_path=out,
            dry_run=False,
            dump_kwargs={"start_frame": p.start_frame,
                         "end_frame": p.end_frame},
            stages=[
                StageSpec(
                    "erase", "directory",
                    make_erase_directory(
                        mask_png=mask_png, mask_rect=mask_rect,
                        hd_strategy=str(p.hd_strategy),
                        crop_trigger=int(p.crop_trigger),
                        crop_margin=int(p.crop_margin),
                        resize_limit=int(p.resize_limit),
                        device=str(p.device),
                        model_dir=erase_model_dir(),
                        debug_mask_path=debug_mask_path,
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
        meta.update({"hd_strategy": p.hd_strategy, "mask_src": mask_src,
                     "mask": {"x": mask_rect[0], "y": mask_rect[1],
                               "w": mask_rect[2], "h": mask_rect[3]}})
        if debug_mask_path is not None:
            meta["debug_mask_path"] = str(debug_mask_path)
        result.meta = meta
        result.command = summary
        return result

    # Image path: single-shot in-process inference (start/end_frame are
    # video-only and ignored here — documented, never an error).
    import cv2

    token = job_control.current_token()
    try:
        def _run() -> dict:
            if token:
                job_control.bind(token)
            img = cv2.imread(str(src))
            if img is None:
                raise RuntimeError(f"unreadable image: {src}")
            h, w = img.shape[:2]
            if mask_png is not None:
                mask_bin = decode_mask_png(mask_png, w, h)
                if not (mask_bin > 0).any():
                    raise RuntimeError("painted mask is empty")
                check_mask_area(mask_bin, painted=True)
            else:
                mask_bin = draw_mask(w, h, mask_rect)
            compiled, settled = get_compiled(erase_model_dir(), str(p.device))
            spec = introspect_ir(ir_path_for(erase_model_dir()))
            done = inpaint_frame(img, mask_bin, compiled, spec,
                                 hd_strategy=str(p.hd_strategy),
                                 crop_trigger=int(p.crop_trigger),
                                 crop_margin=int(p.crop_margin),
                                 resize_limit=int(p.resize_limit))
            if debug_mask_path is not None:
                debug_mask_path.parent.mkdir(parents=True, exist_ok=True)
                if not cv2.imwrite(str(debug_mask_path),
                                   (mask_bin * 255).astype("uint8")):
                    raise RuntimeError(f"could not write debug mask {debug_mask_path}")
            out.parent.mkdir(parents=True, exist_ok=True)
            if not cv2.imwrite(str(out), done):
                raise RuntimeError(f"could not write {out}")
            return {"settled": settled, "w": w, "h": h}

        if token:
            job_control.report_progress(
                f"erase {src.name}", phase="erase",
                current=0, total=1, unit="frames", token=token,
            )
        info = await asyncio.to_thread(_run)
        if token:
            job_control.report_progress(
                "erase done: 1 frame", phase="erase",
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
    image_meta = {
        "device_settled": info["settled"],
        "hd_strategy": p.hd_strategy, "mask_src": mask_src,
        "mask": {"x": mx, "y": my, "w": mw, "h": mh,
                  "px": {"frame_w": info["w"], "frame_h": info["h"]}},
        "frame_count": 1,
    }
    if debug_mask_path is not None:
        image_meta["debug_mask_path"] = str(debug_mask_path)
    return OperationResult(
        ok=True, operation=op, output_path=str(out), dry_run=False,
        command=summary,
        stdout=(f"{summary}\nOutput: {out}\n"
                + (f"Debug mask: {debug_mask_path}\n"
                   if debug_mask_path is not None else "")),
        meta=image_meta,
    )


def _download(url: str, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "mtapi-erase-setup"})
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


async def erase_setup(p: EraseSetupParams) -> OperationResult:
    """Download ONNX → FP16 IR → CPU smoke + GPU probe.

    Cancel-safe between phases. Ends with a fresh status payload in meta +
    recommend_restart=false. Dry-run prints phases and changes nothing.
    """
    op = "erase_setup"
    d = erase_model_dir()
    onnx = d / MODEL_FILENAME
    ir = ir_path_for(d)
    phases = [
        f"download {MODEL_URL} → {onnx}",
        f"convert → FP16 IR {ir}",
        "compile-smoke on CPU (synthetic 512 input, no media needed)",
        "probe GPU compile (non-fatal — CPU path already proven above)",
    ]
    plan = "\n".join(f"phase {i + 1}: {ph}" for i, ph in enumerate(phases))
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, dry_run=True, command=plan,
            stdout=f"erase_setup {p.action} (dry run — nothing changed)\n{plan}\n",
            meta={"dry_run": True, "status": {"erase": get_erase_status()},
                  "recommend_restart": False},
        )
    logs = [f"erase_setup {p.action} ({MODEL_REPO}, {MODEL_LICENSE})"]
    token = job_control.current_token()

    def _phase(i: int, total: int) -> None:
        job_control.check_cancelled()
        if token:
            job_control.report_progress(
                f"setup phase {i + 1}/{total}", phase="setup",
                current=i, total=total, unit="phases", token=token,
            )

    try:
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

        _phase(3, len(phases))
        gpu_probe: dict = {"ok": False}

        def _gpu_smoke() -> dict:
            import numpy as np

            if token:
                job_control.bind(token)
            compiled, settled = get_compiled(d, "GPU")
            spec = introspect_ir(ir)
            n = spec["size"]
            img = np.zeros((1, 3, n, n), dtype=np.float32)
            msk = np.zeros((1, 1, n, n), dtype=np.float32)
            out = compiled({spec["image_name"]: img,
                            spec["mask_name"]: msk})[spec["output_name"]]
            return {"settled": settled,
                    "shape": [int(v) for v in out.shape],
                    "max": float(np.max(out))}

        try:
            gpu_probe = await asyncio.to_thread(_gpu_smoke)
            gpu_probe["ok"] = True
            logs.append(f"gpu smoke ok: settled={gpu_probe['settled']} "
                        f"shape={gpu_probe['shape']} max={gpu_probe['max']:.1f}")
        except Exception as e:  # noqa: BLE001 — non-fatal, CPU path stands
            gpu_probe = {"ok": False, "error": str(e)[:300]}
            logs.append(f"gpu smoke skipped: {gpu_probe['error']}")
    except job_control.JobCancelled as e:
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"erase": get_erase_status()},
                  "recommend_restart": False},
        )
    except Exception as e:  # noqa: BLE001 — HTTP 200 + ok:false
        return OperationResult(
            ok=False, operation=op, error=str(e), dry_run=False,
            command=plan, stdout="\n".join(logs),
            meta={"status": {"erase": get_erase_status()},
                  "recommend_restart": False},
        )
    if token:
        job_control.report_progress(
            "setup done", phase="done",
            current=len(phases), total=len(phases), unit="phases", token=token,
        )
    return OperationResult(
        ok=True, operation=op, command=plan, stdout="\n".join(logs),
        meta={"status": {"erase": get_erase_status()},
              "gpu_probe": gpu_probe,
              "recommend_restart": False, "repo": MODEL_REPO,
              "license": MODEL_LICENSE},
    )


def get_erase_status() -> dict:
    """Read-only status payload for GET /api/erase/status (no installs)."""
    d = erase_model_dir()
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
    return {"ok": True, "onnx_present": onnx.is_file(),
            "ir_present": ir.is_file(), "sha256": sha, "devices": devices}


register(OperationSpec(
    id="erase_remove",
    summary="Erase a static watermark (brush or rect, LaMA, OpenVINO)",
    description=(
        "lama-cleaner erase settings: binary mask, HD strategies "
        "(Original/Crop/Resize), masked-area-only composite. Painted mask "
        "wins, else the rect fallback. Video: dump → erase stage → encode "
        "(audio kept). Image: single-shot in-process."
    ),
    params_model=EraseRemoveParams,
    handler=erase_remove,
    tags=["watermark", "clean", "image", "video"],
))

register(OperationSpec(
    id="erase_setup",
    summary="Install/update erase weights (download + FP16 IR + CPU smoke)",
    description=(
        f"Downloads {MODEL_FILENAME} from {MODEL_REPO}, converts once to "
        "FP16 OpenVINO IR, compile-smokes on CPU plus a non-fatal GPU "
        "probe (GPU compiles with f32 inference precision — the default "
        "fp16 GPU path corrupts LaMA's spectral MatMuls). Tab installer "
        "row driver."
    ),
    params_model=EraseSetupParams,
    handler=erase_setup,
    tags=["watermark", "clean", "setup"],
))
