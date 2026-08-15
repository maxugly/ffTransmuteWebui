"""Media-related routes: video, image, probe, media_info, thumbnail, export_frame, frame-strip."""
import asyncio
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import media
from .. import job_control
from .. import shell


def register(app: FastAPI, probe_fn) -> None:
    @app.get("/api/video", tags=["meta"])
    async def get_video(path: str):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="Video file not found")
        return FileResponse(str(path_obj))

    @app.get("/api/image", tags=["meta"])
    async def get_image(path: str):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="Image file not found")
        return FileResponse(str(path_obj))

    @app.get("/api/probe", tags=["meta"])
    async def probe_video(path: str):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        info = await probe_fn(path_obj)
        if not info.get("ok"):
            return info
        true_frames = info.get("frames") or 0
        info["true_frames"] = true_frames
        info["frames"] = max(true_frames, 100)
        return info

    @app.get("/api/media_info", tags=["meta"])
    async def media_info(path: str, ensure_thumbs: bool = True):
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        return await media.open_media(
            path_obj,
            probe_fn=probe_fn,
            ensure_thumbs_flag=ensure_thumbs,
            record_open=True,
        )

    @app.get("/api/media_signature", tags=["meta"])
    async def media_signature(path: str):
        """Return size + mtime_ns via OS stat. Never invokes ffmpeg."""
        path_obj = Path(path).expanduser().resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        st = path_obj.stat()
        return {
            "ok": True,
            "path": str(path_obj),
            "size": int(st.st_size),
            "mtime_ns": int(st.st_mtime_ns),
        }

    @app.get("/api/thumbnail", tags=["meta"])
    async def get_thumbnail(
        path: str | None = None,
        hash: str | None = None,
        which: str = "first",
        frame: int | None = None,
        s: str = "H",
    ):
        """Serve a thumbnail JPEG.

        * ``which=first|last`` — permanent first/last of the whole file (default).
        * ``frame=N`` — **1-based** frame index (Cut / range previews). Takes
          precedence over ``which`` when provided.
        """
        size = media.normalize_thumb_size(s)
        content_hash = hash
        source: Path | None = None
        if path:
            path_obj = Path(path).resolve()
            if not path_obj.exists() or not path_obj.is_file():
                raise HTTPException(status_code=404, detail="File not found")
            source = path_obj
            content_hash, _ = await media.resolve_hash(path_obj)
            if media.load_record(content_hash) is None:
                await media.open_media(
                    path_obj,
                    probe_fn=probe_fn,
                    ensure_thumbs_flag=False,
                    record_open=False,
                )
        elif not content_hash:
            raise HTTPException(status_code=400, detail="Provide path or hash")

        # Range / scrub frame (1-based inclusive)
        if frame is not None:
            try:
                frame_n = int(frame)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="frame must be an integer")
            if frame_n < 1:
                raise HTTPException(status_code=400, detail="frame must be >= 1")
            fps = None
            rec = media.load_record(content_hash)
            if rec:
                try:
                    fps = float(rec.get("fps") or 0) or None
                except (TypeError, ValueError):
                    fps = None
            thumb = await media.get_frame_thumb_file(
                content_hash, frame_n, source_path=source, fps=fps, size=size,
            )
            if not thumb:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to extract frame {frame_n}",
                )
            return await _serve_thumbnail(thumb, content_hash, f"frame:{frame_n}", size)

        which = (which or "first").lower()
        if which not in ("first", "last"):
            raise HTTPException(status_code=400, detail="which must be 'first' or 'last'")
        thumb = await media.get_thumb_file(content_hash, which, source_path=source, size=size)
        if not thumb:
            raise HTTPException(status_code=500, detail=f"Failed to extract {which} frame")
        return await _serve_thumbnail(thumb, content_hash, which, size)

    async def _serve_thumbnail(path: Path, content_hash: str, which: str, size: str):
        settings = media.load_settings()
        cache_key = (content_hash, which, size)
        if settings.get("thumbnails_to_ram"):
            cached = await media.thumbnail_cache.get(cache_key)
            if cached is None:
                cached = await asyncio.to_thread(path.read_bytes)
                await media.thumbnail_cache.put(cache_key, cached)
            return Response(
                content=cached,
                media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )
        return FileResponse(
            str(path),
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    @app.get("/api/media/{content_hash}", tags=["meta"])
    async def get_media_by_hash(content_hash: str):
        record = media.load_record(content_hash)
        if not record:
            raise HTTPException(status_code=404, detail="Unknown media hash")
        path = None
        for p in record.get("paths") or []:
            if Path(p).is_file():
                path = Path(p)
                break
        return media._public_payload(record, path, was_cached=True)

    @app.post("/api/export_frame", tags=["meta"])
    async def export_frame(body: dict):
        path = (body or {}).get("path")
        which = ((body or {}).get("which") or "first").lower()
        output_path = (body or {}).get("output_path") or None
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if which not in ("first", "last"):
            raise HTTPException(status_code=400, detail="which must be 'first' or 'last'")
        path_obj = Path(path).resolve()
        if not path_obj.exists() or not path_obj.is_file():
            raise HTTPException(status_code=404, detail="Source file not found")
        out = Path(output_path).resolve() if output_path else None
        return await media.export_frame_png(path_obj, which=which, output_path=out)

    @app.get("/api/media_cache", tags=["meta"])
    async def media_cache_info():
        return {"ok": True, **media.media_cache_stats()}

    # ── frame strip ──────────────────────────────────────────────────────────

    FRAME_LIMIT = 500

    def _frame_strip_dir(content_hash: str) -> Path:
        return media._frames_dir(content_hash)

    def _frame_strip_exists(content_hash: str, frame_count: int) -> bool:
        d = _frame_strip_dir(content_hash)
        last = d / f"frame_{frame_count:06d}.jpg"
        return last.exists()

    @app.post("/media/frame-strip", tags=["meta"])
    async def create_frame_strip(body: dict):
        path = (body or {}).get("path")
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        path_obj = Path(path).expanduser().resolve()
        if not path_obj.is_file():
            raise HTTPException(status_code=404, detail="File not found")

        content_hash, _ = await media.resolve_hash(path_obj)

        info = await probe_fn(path_obj)
        frame_count = int(info.get("frames") or 0)
        if frame_count <= 0:
            return JSONResponse(
                {"ok": False, "error": "Could not determine frame count"},
                status_code=200,
            )

        if frame_count > FRAME_LIMIT:
            return JSONResponse(
                {
                    "ok": False,
                    "error": f"Video has {frame_count} frames (limit: {FRAME_LIMIT})",
                    "frame_count": frame_count,
                },
                status_code=200,
            )

        d = _frame_strip_dir(content_hash)
        if _frame_strip_exists(content_hash, frame_count):
            prefix = f"/media/frame-strip/{content_hash}"
            frame_urls = [f"{prefix}/frame_{i:06d}.jpg" for i in range(1, frame_count + 1)]
            return JSONResponse({
                "ok": True,
                "hash": content_hash,
                "frame_count": frame_count,
                "frame_urls": frame_urls,
                "cached": True,
            })

        d.mkdir(parents=True, exist_ok=True)
        in_pattern = str(d / "frame_%06d.jpg")
        scale_w = 120

        argv = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(path_obj),
            "-vf", f"scale={scale_w}:-1",
            "-q:v", "5",
            "-start_number", "1",
            in_pattern,
        ]

        job_control.check_cancelled()
        code, _stdout, stderr = await shell.run_command(argv)
        if code != 0:
            return JSONResponse({
                "ok": False,
                "error": f"ffmpeg frame extraction failed: {stderr.strip() or f'exit code {code}'}",
            })

        prefix = f"/media/frame-strip/{content_hash}"
        frame_urls = [f"{prefix}/frame_{i:06d}.jpg" for i in range(1, frame_count + 1)]
        return JSONResponse({
            "ok": True,
            "hash": content_hash,
            "frame_count": frame_count,
            "frame_urls": frame_urls,
            "cached": False,
        })

    @app.get("/media/frame-strip/{content_hash}/{filename:path}", tags=["meta"])
    async def serve_frame_strip(content_hash: str, filename: str):
        fp = _frame_strip_dir(content_hash) / filename
        if not fp.is_file():
            raise HTTPException(status_code=404, detail="Frame not found")
        return FileResponse(str(fp), media_type="image/jpeg")
