"""
Watermark tab (Clean section) — Gemini visible-watermark removal + metadata.

V1 engine: vendored `GargantuaX/gemini-watermark-remover` (reverse alpha
blending — mathematically exact, not inpainting), invoked file-to-file via
its `bin/gwr.mjs` CLI through `shell.run_command` (argv list only, never
a shell string; nothing in main.py — invariant 2).

This op is file-to-file, NOT filter-platform: no dump → app/filters/* →
encode involvement (invariant 1 untouched).

See docs/watermark-tab-spec.md. Pinned tag: v1.0.43 (commit e9ba84d).

Upstream CLI honesty notes (verified against the vendored copy):
- The CLI has ONE command: `gwr remove <input> --output|--out-dir`. There is
  NO output-less probe mode, so `watermark_detect` runs `remove --json` into
  a temp file, parses the decision tier out of the JSON, then deletes the
  temp output. No persistent file is left behind.
- Image file decode/encode needs the `sharp` package inside the vendored dir
  (upstream optional peer). Video path needs `mediabunny` (bundled dep).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..shell import run_command

PINNED_TAG = "v1.0.43"
PINNED_COMMIT = "e9ba84d8e5465928d4b9343a1fe121d0cae0e3da"
UPSTREAM_REPO = "https://github.com/GargantuaX/gemini-watermark-remover"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"}

ENGINE_V1 = "gemini-reverse-alpha"
PLANNED_ENGINES = ("general-ai", "synthid-detect")

INSTALL_HINT = (
    "Gemini watermark tool not ready — open the Watermark tab installer card "
    "(Clean → Watermark → Install/Refresh) or POST /ops/watermark_setup."
)


def _tools_dir() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "tools" / "gemini-watermark-remover"


def gwr_entrypoint() -> Path:
    """Absolute path to the vendored `bin/gwr.mjs`."""
    return _tools_dir() / "bin" / "gwr.mjs"


def resolve_node() -> str | None:
    """Node binary off PATH (shutil.which). None when missing."""
    return shutil.which("node")


def get_watermark_status() -> dict:
    """Read-only status payload for GET /api/watermark/status (no installs).

    Best-effort `node --version` subprocess only; never fails — missing
    pieces report `found/present: false` so the tab installer card can
    render and offer Install.
    """
    node_bin = resolve_node()
    node_info: dict = {"found": bool(node_bin)}
    if node_bin:
        import subprocess as _sp

        try:
            out = _sp.run(
                [node_bin, "--version"], capture_output=True, text=True, timeout=10,
            )
            ver = (out.stdout or "").strip()
            if ver:
                node_info["version"] = ver
        except Exception:
            pass
    tools = _tools_dir()
    gwr = gwr_entrypoint()
    gwr_info: dict = {"present": gwr.is_file(), "tag": PINNED_TAG}
    if tools.is_dir():
        import subprocess as _sp

        try:
            out = _sp.run(
                ["git", "-C", str(tools), "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=10,
            )
            commit = (out.stdout or "").strip()
            if commit:
                gwr_info["commit"] = commit[:7]
                gwr_info["commit_full"] = commit
        except Exception:
            pass
    sharp_info = {"present": (tools / "node_modules" / "sharp").is_dir()}
    pm_info = {"pnpm": bool(shutil.which("pnpm")), "npm": bool(shutil.which("npm"))}
    return {"ok": True, "node": node_info, "gwr": gwr_info,
            "sharp": sharp_info, "pm": pm_info}


def _precheck(op_id: str) -> str | None:
    """Fail-fast tool check. Returns error string or None when ready."""
    if not resolve_node():
        return f"node not found on PATH — {INSTALL_HINT}"
    if not gwr_entrypoint().is_file():
        return f"vendored gwr CLI missing at {gwr_entrypoint()} — {INSTALL_HINT}"
    return None


def _check_engine(engine: str) -> str | None:
    if engine == ENGINE_V1:
        return None
    if engine in PLANNED_ENGINES:
        return f"engine '{engine}' not installed yet"
    return f"unknown engine '{engine}' (V1 supports '{ENGINE_V1}' only)"


def _is_video_path(p: Path) -> bool:
    return p.suffix.lower() in VIDEO_EXTS


def _default_output(src: Path) -> Path:
    ext = src.suffix if src.suffix.lower() in (IMAGE_EXTS | VIDEO_EXTS) else None
    if _is_video_path(src):
        return src.with_name(f"{src.stem}_clean.mp4")
    if ext:
        return src.with_name(f"{src.stem}_clean{src.suffix}")
    return src.with_name(f"{src.stem}_clean.png")


def _resolve_output(src: Path, output_path: str | None, out_dir: str | None) -> Path:
    if out_dir:
        return Path(out_dir).expanduser() / _default_output(src).name
    if output_path:
        return Path(output_path).expanduser()
    return _default_output(src)


def build_remove_argv(
    node: str, gwr: str, input_path: str, output_path: str,
    overwrite: bool = False, video_bitrate_mbps: float | None = None,
    video_timeout_ms: int | None = None, is_video: bool = False,
) -> list[str]:
    """Argv for `gwr remove`. Always `--json` (we parse applied/decisionTier)."""
    argv = [node, gwr, "remove", input_path,
            "--output", output_path, "--json"]
    if overwrite:
        argv.append("--overwrite")
    if is_video and video_bitrate_mbps:
        argv.extend(["--video-bitrate-mbps", str(video_bitrate_mbps)])
    if is_video and video_timeout_ms:
        argv.extend(["--video-timeout-ms", str(video_timeout_ms)])
    return argv


def parse_remove_json(stdout: str) -> dict:
    """Pull the single-result object out of `--json` stdout ({} on garbage)."""
    try:
        data = json.loads((stdout or "").strip())
    except Exception:
        return {}
    if isinstance(data, list):
        data = data[0] if data else {}
    return data if isinstance(data, dict) else {}


def _ensure_output_file(path: Path) -> str | None:
    if not path.is_file():
        return f"gwr produced no output: {path}"
    try:
        if path.stat().st_size < 32:
            return f"gwr produced an empty output: {path}"
    except OSError as e:
        return f"could not stat gwr output {path}: {e}"
    return None


# ── Params ────────────────────────────────────────────────────────────────

class WatermarkRemoveParams(BaseModel):
    model_config = {"extra": "ignore"}

    input_path: str = Field(..., description="Absolute image/video path")
    output_path: str | None = Field(None, description="Explicit output file")
    out_dir: str | None = Field(None, description="Output folder (named from input)")
    overwrite: bool = Field(False)
    engine: str = Field(ENGINE_V1)
    video_bitrate_mbps: float = Field(12, ge=4, le=40)
    video_timeout_ms: int | None = Field(None, gt=0)
    dry_run: bool = Field(False)


class WatermarkDetectParams(BaseModel):
    model_config = {"extra": "ignore"}

    input_path: str = Field(...)
    engine: str = Field(ENGINE_V1)


class MetadataInspectParams(BaseModel):
    model_config = {"extra": "ignore"}

    input_path: str = Field(...)


class MetadataStripParams(BaseModel):
    model_config = {"extra": "ignore"}

    input_path: str = Field(...)
    output_path: str | None = Field(None)
    overwrite: bool = Field(False)
    dry_run: bool = Field(False)


class WatermarkSetupParams(BaseModel):
    model_config = {"extra": "ignore"}

    action: Literal["install", "update"] = Field("install")
    dry_run: bool = Field(False)


# ── Validation shared ─────────────────────────────────────────────────────

def _validate_input(input_path: str) -> tuple[Path | None, str | None]:
    raw = (input_path or "").strip()
    if not raw:
        return None, "input_path is required"
    p = Path(raw).expanduser()
    if not p.is_absolute():
        return None, f"input_path must be absolute: {raw}"
    if not p.is_file():
        return None, f"Input not found: {p}"
    return p, None


def _validate_outputs(
    op_id: str, src: Path, output_path: str | None, out_dir: str | None,
    overwrite: bool,
) -> tuple[Path | None, str | None]:
    if output_path and out_dir:
        return None, "Use either output_path or out_dir, not both."
    if out_dir and not Path(out_dir).expanduser().is_absolute():
        return None, f"out_dir must be absolute: {out_dir}"
    if output_path and not Path(output_path).expanduser().is_absolute():
        return None, f"output_path must be absolute: {output_path}"
    out = _resolve_output(src, output_path, out_dir)
    if out.exists() and not overwrite:
        return None, f"Output already exists (pass overwrite=true): {out}"
    return out, None


# ── Handlers ──────────────────────────────────────────────────────────────

async def watermark_remove(p: WatermarkRemoveParams) -> OperationResult:
    op = "watermark_remove"
    src, err = _validate_input(p.input_path)
    if err:
        return OperationResult(ok=False, operation=op, error=err, dry_run=p.dry_run)
    assert src is not None
    eng_err = _check_engine(p.engine)
    if eng_err:
        return OperationResult(ok=False, operation=op, error=eng_err, dry_run=p.dry_run)
    out, err = _validate_outputs(op, src, p.output_path, p.out_dir, p.overwrite)
    if err:
        return OperationResult(ok=False, operation=op, error=err, dry_run=p.dry_run)
    assert out is not None

    tool_err = _precheck(op)
    if tool_err:
        return OperationResult(ok=False, operation=op, error=tool_err, dry_run=p.dry_run)

    is_video = _is_video_path(src)
    if src.suffix.lower() not in (IMAGE_EXTS | VIDEO_EXTS):
        return OperationResult(
            ok=False, operation=op,
            error=f"Unsupported input type: {src.suffix or '(no extension)'}",
            dry_run=p.dry_run,
        )
    node = resolve_node()
    assert node is not None
    argv = build_remove_argv(
        node, str(gwr_entrypoint()), str(src), str(out),
        overwrite=p.overwrite,
        video_bitrate_mbps=float(p.video_bitrate_mbps) if is_video else None,
        video_timeout_ms=p.video_timeout_ms if is_video else None,
        is_video=is_video,
    )
    summary = f"watermark_remove {src.name} → {out.name} ({p.engine})"
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, output_path=None, dry_run=True,
            command=" ".join(argv), stdout=f"{summary}\nWould write {out}\n",
            meta={"dry_run": True, "engine": p.engine},
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    token = job_control.current_token()
    if token:
        job_control.report_progress(
            f"watermark remove starting → {out.name}",
            phase="watermark", current=0, total=1, unit="step", token=token,
        )
    code, stdout, stderr = await run_command(argv)
    if code != 0:
        return OperationResult(
            ok=False, operation=op,
            error=f"gwr remove failed (exit {code}): "
                  f"{(stderr or '').strip()[-300:] or 'no stderr'}",
            dry_run=False, command=" ".join(argv),
            meta={"engine": p.engine},
        )
    file_err = _ensure_output_file(out)
    if file_err:
        return OperationResult(
            ok=False, operation=op, error=file_err, dry_run=False,
            command=" ".join(argv), stdout=stdout[-2000:], stderr=stderr[-2000:],
            meta={"engine": p.engine},
        )
    result = parse_remove_json(stdout)
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    if token:
        job_control.report_progress(
            "watermark remove done", phase="done",
            current=1, total=1, unit="step", token=token,
        )
    return OperationResult(
        ok=True, operation=op, output_path=str(out), dry_run=False,
        command=" ".join(argv), stdout=f"{summary}\nOutput: {out}\n",
        stderr=stderr[-2000:],
        meta={"engine": p.engine, "applied": meta.get("applied"),
              "decisionTier": meta.get("decisionTier"),
              "skipReason": meta.get("skipReason")},
    )


async def watermark_detect(p: WatermarkDetectParams) -> OperationResult:
    """Read-only readout. Upstream has no probeless mode, so this runs
    `remove --json` into a temp file, parses the decision tier, and deletes
    the temp output. Nothing persistent is written."""
    op = "watermark_detect"
    src, err = _validate_input(p.input_path)
    if err:
        return OperationResult(ok=False, operation=op, error=err)
    assert src is not None
    eng_err = _check_engine(p.engine)
    if eng_err:
        return OperationResult(ok=False, operation=op, error=eng_err)
    if src.suffix.lower() not in (IMAGE_EXTS | VIDEO_EXTS):
        return OperationResult(
            ok=False, operation=op,
            error=f"Unsupported input type: {src.suffix or '(no extension)'}",
        )
    tool_err = _precheck(op)
    if tool_err:
        return OperationResult(ok=False, operation=op, error=tool_err)

    node = resolve_node()
    assert node is not None
    tmpdir = Path(tempfile.mkdtemp(prefix="mtapi_wm_detect_"))
    probe_out = tmpdir / f"probe{src.suffix or '.png'}"
    argv = build_remove_argv(
        node, str(gwr_entrypoint()), str(src), str(probe_out),
        overwrite=True, is_video=_is_video_path(src),
    )
    code, stdout, stderr = await run_command(argv)
    try:
        if probe_out.is_file():
            probe_out.unlink()
        tmpdir.rmdir()
    except OSError:
        pass
    if code != 0:
        return OperationResult(
            ok=False, operation=op,
            error=f"gwr probe failed (exit {code}): "
                  f"{(stderr or '').strip()[-300:] or 'no stderr'}",
            command=" ".join(argv),
        )
    result = parse_remove_json(stdout)
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    tier = meta.get("decisionTier")
    found = bool(meta.get("applied")) or (isinstance(tier, str) and tier not in ("insufficient",))
    if meta.get("skipReason") == "no-watermark-detected":
        found = False
    box = None
    pos = meta.get("position")
    size = meta.get("size")
    if isinstance(pos, dict) or isinstance(size, dict):
        box = {"position": pos, "size": size}
    return OperationResult(
        ok=True, operation=op, command=" ".join(argv),
        stdout=f"detect {src.name}: found={found} tier={tier}\n",
        meta={"watermark_found": found, "tier": tier, "box": box,
              "applied": meta.get("applied"),
              "skipReason": meta.get("skipReason"), "engine": p.engine},
    )


async def metadata_inspect(p: MetadataInspectParams) -> OperationResult:
    """Read-only tag readout: ffprobe format/streams + Pillow EXIF (+ exiftool
    only if already on PATH). No new Python dep."""
    op = "metadata_inspect"
    src, err = _validate_input(p.input_path)
    if err:
        return OperationResult(ok=False, operation=op, error=err)
    assert src is not None
    tags: dict = {"path": str(src)}
    notes: list[str] = []
    code, stdout, stderr = await run_command([
        "ffprobe", "-v", "error", "-show_format", "-show_streams",
        "-of", "json", str(src),
    ])
    if code == 0:
        try:
            probe = json.loads(stdout or "{}")
            tags["ffprobe_format"] = (probe.get("format") or {}).get("tags") or {}
            tags["ffprobe_streams"] = [
                {k: s.get(k) for k in ("codec_type", "codec_name", "tags")
                 if k in s}
                for s in (probe.get("streams") or [])
            ]
            notes.append("source=ffprobe")
        except Exception as e:
            notes.append(f"ffprobe parse failed: {e}")
    else:
        notes.append(f"ffprobe unavailable: {(stderr or '').strip()[-120:]}")
    try:
        from PIL import Image as _Image

        with _Image.open(src) as im:
            tags["pillow_format"] = im.format
            tags["pillow_info"] = {k: str(v) for k, v in (im.info or {}).items()}
            try:
                exif = im.getexif()
                tags["exif_count"] = len(exif) if exif is not None else 0
            except Exception:
                tags["exif_count"] = None
            notes.append("source=pillow")
    except Exception as e:
        notes.append(f"pillow unreadable (probably video): {e}")
    if shutil.which("exiftool"):
        code, stdout, _ = await run_command(["exiftool", "-j", str(src)])
        if code == 0:
            try:
                tags["exiftool"] = json.loads(stdout or "[]")
                notes.append("source=exiftool")
            except Exception:
                pass
    return OperationResult(
        ok=True, operation=op,
        stdout=f"inspect {src.name}: {'; '.join(notes)}\n",
        meta={"tags": tags, "sources": notes},
    )


async def metadata_strip(p: MetadataStripParams) -> OperationResult:
    """Tag-stripped copy. Video: remux `-map_metadata -1` (stream copy, no
    re-encode). Image: Pillow re-save without EXIF."""
    op = "metadata_strip"
    src, err = _validate_input(p.input_path)
    if err:
        return OperationResult(ok=False, operation=op, error=err, dry_run=p.dry_run)
    assert src is not None
    out, err = _validate_outputs(op, src, p.output_path, None, p.overwrite)
    if err:
        return OperationResult(ok=False, operation=op, error=err, dry_run=p.dry_run)
    assert out is not None

    if _is_video_path(src):
        argv = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(src), "-map_metadata", "-1",
                "-c", "copy", str(out)]
        summary = f"metadata_strip {src.name} → {out.name} (remux, no re-encode)"
        if p.dry_run:
            return OperationResult(
                ok=True, operation=op, output_path=None, dry_run=True,
                command=" ".join(argv), stdout=f"{summary}\nWould write {out}\n",
                meta={"dry_run": True},
            )
        out.parent.mkdir(parents=True, exist_ok=True)
        code, _, stderr = await run_command(argv)
        if code != 0:
            return OperationResult(
                ok=False, operation=op,
                error=f"ffmpeg remux failed (exit {code}): "
                      f"{(stderr or '').strip()[-300:] or 'no stderr'}",
                dry_run=False, command=" ".join(argv),
            )
        file_err = _ensure_output_file(out)
        if file_err:
            return OperationResult(
                ok=False, operation=op, error=file_err, dry_run=False,
                command=" ".join(argv),
            )
        return OperationResult(
            ok=True, operation=op, output_path=str(out), dry_run=False,
            command=" ".join(argv), stdout=f"{summary}\nOutput: {out}\n",
        )

    # Image path — Pillow re-save, EXIF dropped.
    try:
        from PIL import Image as _Image
    except ImportError:
        return OperationResult(
            ok=False, operation=op, error="Pillow not installed", dry_run=p.dry_run,
        )
    summary = f"metadata_strip {src.name} → {out.name} (EXIF dropped)"
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, output_path=None, dry_run=True,
            command=summary, stdout=f"{summary}\nWould write {out}\n",
            meta={"dry_run": True},
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        token = job_control.current_token()

        def _strip() -> None:
            if token:
                job_control.bind(token)
            with _Image.open(src) as im:
                fmt = (im.format or out.suffix.lstrip(".") or "png").upper()
                if fmt == "JPG":
                    fmt = "JPEG"
                dst = im.copy()
                save_kw: dict = {}
                if fmt == "JPEG":
                    save_kw["quality"] = 95
                dst.save(out, fmt, **save_kw)

        await asyncio.to_thread(_strip)
    except job_control.JobCancelled as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=False)
    except Exception as e:
        return OperationResult(ok=False, operation=op, error=str(e), dry_run=False)
    file_err = _ensure_output_file(out)
    if file_err:
        return OperationResult(ok=False, operation=op, error=file_err, dry_run=False)
    return OperationResult(
        ok=True, operation=op, output_path=str(out), dry_run=False,
        command=summary, stdout=f"{summary}\nOutput: {out}\n",
    )


async def watermark_setup(p: WatermarkSetupParams) -> OperationResult:
    """Clone at the pinned tag if absent, else fetch + checkout pinned tag;
    then prod-install JS deps with the available manager (pnpm preferred,
    npm fallback). Cancel-safe between phases. Ends with a fresh status
    payload in meta + recommend_restart=false (no server restart needed)."""
    op = "watermark_setup"
    tools = _tools_dir()
    gwr_present = gwr_entrypoint().is_file()
    has_git = (tools / ".git").is_dir()
    phases: list[list[str]] = []
    if not gwr_present and not has_git and tools.is_dir():
        # Flat-vendored copy was pruned away or never installed: clear the
        # way so the clone below lands in an empty dir.
        import shutil as _shutil

        _shutil.rmtree(tools, ignore_errors=True)
    if not gwr_present:
        phases.append(["git", "clone", "--depth", "1", "--branch", PINNED_TAG,
                       UPSTREAM_REPO, str(tools)])
    elif has_git:
        phases.append(["git", "-C", str(tools), "fetch", "--tags", "--depth", "1"])
        phases.append(["git", "-C", str(tools), "checkout", PINNED_TAG])
    # else: flat vendor copy (nested .git untracked by design) — nothing to
    # check out; tag stays PINNED_TAG, phases below just (re)install deps.
    pm = "pnpm" if shutil.which("pnpm") else ("npm" if shutil.which("npm") else None)
    if pm == "pnpm":
        phases.append(["pnpm", "--dir", str(tools), "install", "--prod"])
    elif pm == "npm":
        phases.append(["npm", "--prefix", str(tools), "install",
                       "--omit=dev", "--no-audit", "--no-fund"])
    plan = "\n".join(" ".join(ph) for ph in phases)
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, dry_run=True, command=plan,
            stdout=f"watermark_setup {p.action} (dry run — nothing changed)\n{plan}\n",
            meta={"dry_run": True, "status": get_watermark_status(),
                  "recommend_restart": False},
        )
    if pm is None:
        return OperationResult(
            ok=False, operation=op, error="neither pnpm nor npm found on PATH",
            command=plan,
        )
    logs = [f"watermark_setup {p.action} (tag {PINNED_TAG})"]
    token = job_control.current_token()
    for i, argv in enumerate(phases):
        job_control.check_cancelled()
        if token:
            job_control.report_progress(
                f"setup phase {i + 1}/{len(phases)}", phase="setup",
                current=i, total=len(phases), unit="phases", token=token,
            )
        code, stdout, stderr = await run_command(argv)
        logs.append(f"$ {' '.join(argv)}\n{(stdout or '').strip()[-500:]}")
        if code != 0:
            return OperationResult(
                ok=False, operation=op,
                error=f"setup phase failed (exit {code}): "
                      f"{(stderr or '').strip()[-300:] or 'no stderr'}",
                command=plan, stdout="\n".join(logs), stderr=stderr[-2000:],
                meta={"status": get_watermark_status(),
                      "recommend_restart": False},
            )
    if token:
        job_control.report_progress(
            "setup done", phase="done",
            current=len(phases), total=len(phases), unit="phases", token=token,
        )
    # Guarantee sharp for the CLI file path (optional peer upstream).
    if not (tools / "node_modules" / "sharp").is_dir() and pm == "npm":
        code, _, _ = await run_command(
            ["npm", "--prefix", str(tools), "install", "sharp",
             "--no-audit", "--no-fund"])
        logs.append(f"sharp ensure exit={code}")
    return OperationResult(
        ok=True, operation=op, command=plan, stdout="\n".join(logs),
        meta={"status": get_watermark_status(), "recommend_restart": False,
              "tag": PINNED_TAG, "commit": PINNED_COMMIT},
    )


register(OperationSpec(
    id="watermark_remove",
    summary="Remove Gemini visible watermark (reverse-alpha, file-to-file)",
    description=(
        "Vendored gemini-watermark-remover: mathematically exact reverse "
        "alpha blending (not inpainting). Image + video, file-to-file. "
        "Visible bottom-right logo only; does not remove invisible / "
        "steganographic watermarks (no SynthID)."
    ),
    params_model=WatermarkRemoveParams,
    handler=watermark_remove,
    tags=["watermark", "clean", "image", "video"],
))

register(OperationSpec(
    id="watermark_detect",
    summary="Detect Gemini visible watermark (read-only readout)",
    description=(
        "Probe path: runs the engine with --json and returns "
        "meta {watermark_found, tier, box}. Writes no persistent file."
    ),
    params_model=WatermarkDetectParams,
    handler=watermark_detect,
    tags=["watermark", "clean", "detect"],
))

register(OperationSpec(
    id="metadata_inspect",
    summary="Inspect container metadata tags (read-only)",
    description="ffprobe format/stream tags + Pillow EXIF (+ exiftool if on PATH).",
    params_model=MetadataInspectParams,
    handler=metadata_inspect,
    tags=["watermark", "clean", "metadata"],
))

register(OperationSpec(
    id="metadata_strip",
    summary="Write a tag-stripped copy (video remux / image re-save)",
    description=(
        "Video: remux with -map_metadata -1 (stream copy, no re-encode). "
        "Image: Pillow re-save without EXIF."
    ),
    params_model=MetadataStripParams,
    handler=metadata_strip,
    tags=["watermark", "clean", "metadata"],
))

register(OperationSpec(
    id="watermark_setup",
    summary="Install/update the vendored watermark tool",
    description=(
        f"Clone at pinned tag {PINNED_TAG} if absent, else fetch + checkout; "
        "then prod-install JS deps. Tab installer card driver."
    ),
    params_model=WatermarkSetupParams,
    handler=watermark_setup,
    tags=["watermark", "clean", "setup"],
))
