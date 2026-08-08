"""
Image Edit operation — POST /ops/imageedit.
"""
from __future__ import annotations

import os
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

async def imageedit(p: ImageEditParams) -> OperationResult:
    if not p.paths:
        return OperationResult(ok=False, operation="imageedit", error="No input paths provided.")
    
    # Process only the first path for now (batching can be added later)
    in_path = Path(p.paths[0]).expanduser().resolve()
    if not in_path.exists():
        return OperationResult(ok=False, operation="imageedit", error=f"Input not found: {in_path}")
    
    if p.output:
        out_path = Path(p.output).expanduser().resolve()
        if out_path.is_dir():
            out_path = out_path / f"{in_path.stem}_edited.{p.outputFormat}"
    else:
        out_path = in_path.parent / f"{in_path.stem}_edited.{p.outputFormat}"
        
    out_path = unique_output_path(out_path)
    
    logs = []
    success = False
    
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
        success = ok
        logs.append(msg)
        if not ok:
            return OperationResult(ok=False, operation="imageedit", error=msg)
            
    elif p.engine == "ffmpeg":
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
        success = ok
        logs.append(msg)
        if not ok:
            return OperationResult(ok=False, operation="imageedit", error=msg)
            
    elif p.engine == "pillow":
        if p.dry_run:
            logs.append("Pillow engine (dry run) - would run in python process")
            success = True
        else:
            try:
                from PIL import Image, ImageOps
                img = Image.open(in_path)
                
                # Convert to RGBA if we need to pad with transparency, etc.
                # but let's just use RGB or RGBA depending on format
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
                        # Center pad
                        bg_color = op.get('color', 'black')
                        new_img = Image.new(img.mode, (w, h), color=bg_color)
                        paste_x = (w - img.width) // 2
                        paste_y = (h - img.height) // 2
                        new_img.paste(img, (paste_x, paste_y))
                        img = new_img
                
                if p.outputFormat.lower() in ("jpg", "jpeg") and img.mode == "RGBA":
                    img = img.convert("RGB")
                    
                img.save(out_path)
                success = True
                logs.append(f"Pillow successfully saved to {out_path}")
            except Exception as e:
                return OperationResult(ok=False, operation="imageedit", error=str(e))
    else:
        return OperationResult(ok=False, operation="imageedit", error=f"Unknown engine: {p.engine}")

    return OperationResult(
        ok=success, 
        operation="imageedit",
        output_path=str(out_path) if not p.dry_run else None,
        stdout="\n".join(logs)
    )

register(OperationSpec(
    id="imageedit",
    summary="Image Edit (Scale, Crop, Pad)",
    description="Format static images via ImageMagick, FFmpeg, or Pillow.",
    params_model=ImageEditParams,
    handler=imageedit,
    tags=["image", "convert"],
))
