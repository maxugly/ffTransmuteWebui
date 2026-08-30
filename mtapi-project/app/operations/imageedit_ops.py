"""
Image Edit operation — POST /ops/imageedit.
"""
from __future__ import annotations

import shlex
import asyncio
from pathlib import Path

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..pathutil import unique_output_path

class ImageEditParams(BaseModel):
    paths: list[str] = Field(..., description="Images to process")
    output: str | None = Field(None, description="Output file or dir")
    engine: str = Field("ffmpeg", description="Processing engine")
    outputFormat: str = Field("png", description="Output format")
    stack: list[dict] = Field(default_factory=list, description="Operations")
    dry_run: bool = Field(False)

async def _run_cmd(cmd: list[str], dry_run: bool) -> tuple[bool, str]:
    cmd_str = shlex.join(cmd)
    if dry_run:
        return True, cmd_str + " (dry run)"
    
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        return False, stderr.decode().strip() or "Command failed"
    return True, stdout.decode().strip() + f"\n[Executed]: {cmd_str}"

def _resolve_output_for(in_path: Path, output: str | None, output_format: str) -> Path:
    if output:
        out = Path(output).expanduser().resolve()
        if out.is_dir():
            out = out / f"{in_path.stem}_edited.{output_format}"
    else:
        out = in_path.parent / f"{in_path.stem}_edited.{output_format}"
    return unique_output_path(out)


async def _process_one(p: ImageEditParams, in_path: Path, out_path: Path) -> tuple[bool, str, str | None]:
    """Run the full stack on a single image. Returns (ok, log, out_path-or-None)."""
    if p.engine == "imagemagick":
        cmd = ["magick", str(in_path)]
        for op in p.stack:
            if op["type"] == "scale":
                cmd.extend(["-resize", f"{op['width']}x{op['height']}!"])
            elif op["type"] == "crop":
                cmd.extend(["-crop", f"{op['width']}x{op['height']}+{op.get('x', 0)}+{op.get('y', 0)}", "+repage"])
            elif op["type"] == "pad":
                cmd.extend(["-gravity", "center", "-background", op.get('color', 'black'), "-extent", f"{op['width']}x{op['height']}"])
        cmd.append(str(out_path))

        ok, msg = await _run_cmd(cmd, p.dry_run)
        return ok, msg, (str(out_path) if ok and not p.dry_run else None)

    if p.engine == "ffmpeg":
        cmd = ["ffmpeg", "-y", "-i", str(in_path)]
        vf = []
        for op in p.stack:
            if op["type"] == "scale":
                vf.append(f"scale={op['width']}:{op['height']}")
            elif op["type"] == "crop":
                vf.append(f"crop={op['width']}:{op['height']}:{op.get('x', 0)}:{op.get('y', 0)}")
            elif op["type"] == "pad":
                vf.append(f"pad={op['width']}:{op['height']}:-1:-1:color={op.get('color', 'black')}")

        if vf:
            cmd.extend(["-vf", ",".join(vf)])

        cmd.append(str(out_path))
        ok, msg = await _run_cmd(cmd, p.dry_run)
        return ok, msg, (str(out_path) if ok and not p.dry_run else None)

    if p.engine == "pillow":
        if p.dry_run:
            return True, "Pillow engine (dry run) - would run in python process", None
        try:
            from PIL import Image
            img = Image.open(in_path)

            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA")

            for op in p.stack:
                if op["type"] == "scale":
                    img = img.resize((int(op['width']), int(op['height'])), Image.LANCZOS)
                elif op["type"] == "crop":
                    x = int(op.get('x', 0))
                    y = int(op.get('y', 0))
                    w = int(op['width'])
                    h = int(op['height'])
                    img = img.crop((x, y, x + w, y + h))
                elif op["type"] == "pad":
                    w = int(op['width'])
                    h = int(op['height'])
                    bg_color = op.get('color', 'black')
                    new_img = Image.new(img.mode, (w, h), color=bg_color)
                    paste_x = (w - img.width) // 2
                    paste_y = (h - img.height) // 2
                    new_img.paste(img, (paste_x, paste_y))
                    img = new_img

            if p.outputFormat.lower() in ("jpg", "jpeg") and img.mode == "RGBA":
                img = img.convert("RGB")

            img.save(out_path)
            return True, f"Pillow successfully saved to {out_path}", str(out_path)
        except Exception as e:
            return False, str(e), None

    return False, f"Unknown engine: {p.engine}", None


async def imageedit(p: ImageEditParams) -> OperationResult:
    if not p.paths:
        return OperationResult(ok=False, operation="imageedit", error="No input paths provided.")

    logs: list[str] = []
    outputs: list[str] = []
    all_ok = True
    missing: list[str] = []

    for raw in p.paths:
        in_path = Path(raw).expanduser().resolve()
        if not in_path.exists():
            missing.append(str(in_path))
            all_ok = False
            logs.append(f"Input not found: {in_path}")
            continue

        out_path = _resolve_output_for(in_path, p.output, p.outputFormat)
        ok, msg, produced = await _process_one(p, in_path, out_path)
        logs.append(msg)
        if ok and produced:
            outputs.append(produced)
        elif not ok:
            all_ok = False

    if not all_ok:
        return OperationResult(
            ok=False, operation="imageedit",
            error=(f"Failed to process {len(missing)} missing input(s) and/or one or more engine steps failed. "
                   f"Missing: {', '.join(missing)}" if missing else "One or more images failed to process."),
            stdout="\n".join(logs),
        )

    return OperationResult(
        ok=True,
        operation="imageedit",
        output_path=outputs[0] if outputs and not p.dry_run else None,
        stdout="\n".join(logs),
    )

register(OperationSpec(
    id="imageedit",
    summary="Image Edit (Scale, Crop, Pad)",
    description="Format static images via ImageMagick, FFmpeg, or Pillow.",
    params_model=ImageEditParams,
    handler=imageedit,
    tags=["image", "convert"],
))
