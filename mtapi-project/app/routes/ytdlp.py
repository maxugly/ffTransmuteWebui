"""
yt-dlp inspect/info route: GET /api/ytdlp/info and GET /api/ytdlp/version.

Provides fast preview probe and version verification without downloading media.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query

log = logging.getLogger("mtapi.ytdlp")


def _find_ytdlp_bin() -> str:
    found = shutil.which("yt-dlp")
    if found:
        return found
    user_bin = Path.home() / ".local" / "bin" / "yt-dlp"
    if user_bin.is_file():
        return str(user_bin)
    return "yt-dlp"


def _clean_date(raw: Any) -> str | None:
    if not raw:
        return None
    s = str(raw).strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s


def register(app: FastAPI) -> None:
    @app.get("/api/ytdlp/version", tags=["ytdlp"])
    async def ytdlp_version():
        bin_path = _find_ytdlp_bin()
        try:
            proc = await asyncio.create_subprocess_exec(
                bin_path,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, stderr_b = await proc.communicate()
            if proc.returncode == 0:
                ver = stdout_b.decode().strip()
                return {"ok": True, "version": ver, "bin": bin_path}
            return {"ok": False, "error": stderr_b.decode().strip(), "bin": bin_path}
        except Exception as e:
            return {"ok": False, "error": str(e), "bin": bin_path}

    @app.get("/api/ytdlp/info", tags=["ytdlp"])
    async def ytdlp_info(url: str = Query(..., description="Target media URL")):
        if not url or not url.strip():
            return {"ok": False, "error": "URL cannot be empty"}

        bin_path = _find_ytdlp_bin()
        argv = [bin_path, "--dump-single-json", "--skip-download", "--no-warnings"]
        if shutil.which("node"):
            argv.extend(["--js-runtimes", "node"])
        argv.append(url.strip())

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, stderr_b = await proc.communicate()
            if proc.returncode != 0:
                err = stderr_b.decode().strip() or "yt-dlp probe failed"
                return {"ok": False, "error": err}

            data = json.loads(stdout_b.decode(errors="replace"))
        except Exception as e:
            log.warning("yt-dlp info probe failed for %s: %s", url, e)
            return {"ok": False, "error": str(e)}

        extractor = str(data.get("extractor") or data.get("extractor_key") or "web").lower()
        is_yt = "youtube" in extractor
        author = data.get("uploader") or data.get("channel") or data.get("creator") or (extractor if not is_yt else "Unknown")
        channel = data.get("channel") or data.get("uploader")

        # Extract available heights
        formats = data.get("formats") or []
        heights = set()
        for f in formats:
            h = f.get("height")
            if h and isinstance(h, (int, float)) and h > 0:
                heights.add(int(h))
        sorted_heights = sorted(list(heights), reverse=True)

        subs = list((data.get("subtitles") or {}).keys())
        auto_subs = list((data.get("automatic_captions") or {}).keys())
        has_chat = "live_chat" in (data.get("subtitles") or {})

        info_summary = {
            "id": data.get("id"),
            "title": data.get("title") or "Untitled",
            "author": author,
            "channel": channel,
            "upload_date": _clean_date(data.get("upload_date") or data.get("release_date")),
            "duration": data.get("duration"),
            "thumbnail": data.get("thumbnail"),
            "view_count": data.get("view_count"),
            "like_count": data.get("like_count"),
            "comment_count": data.get("comment_count"),
            "tags": data.get("tags") if isinstance(data.get("tags"), list) else [],
            "description": data.get("description"),
            "extractor": extractor,
            "is_youtube": is_yt,
            "available_resolutions": sorted_heights,
            "subtitles": subs,
            "auto_subtitles": auto_subs,
            "has_live_chat": has_chat,
        }

        return {"ok": True, "info": info_summary}

    @app.get("/api/ytdlp/ryd", tags=["ytdlp"])
    async def ytdlp_ryd(video_id: str = Query(..., description="YouTube video ID")):
        return await fetch_ryd_stats(video_id.strip())


_RYD_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_RYD_TTL = 3600  # 1 hour


async def fetch_ryd_stats(video_id: str) -> dict[str, Any]:
    if not video_id:
        return {"ok": False, "error": "No video_id provided"}
    import time
    now = time.time()
    cached = _RYD_CACHE.get(video_id)
    if cached and (now - cached[0] < _RYD_TTL):
        return cached[1]

    url = f"https://returnyoutubedislikeapi.com/votes?videoId={video_id}"
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                likes = int(data.get("likes") or 0)
                dislikes = int(data.get("dislikes") or 0)
                total = likes + dislikes
                ratio = round((likes / total) * 100, 1) if total > 0 else 0.0
                rating = round(float(data.get("rating") or 0.0), 2)
                views = int(data.get("viewCount") or 0)
                res = {
                    "ok": True,
                    "video_id": video_id,
                    "likes": likes,
                    "dislikes": dislikes,
                    "rating": rating,
                    "like_ratio": ratio,
                    "view_count": views,
                }
                _RYD_CACHE[video_id] = (now, res)
                return res
            elif resp.status_code == 404:
                return {"ok": False, "error": "Video not found in Return YouTube Dislike database"}
            else:
                return {"ok": False, "error": f"RYD API HTTP {resp.status_code}"}
    except Exception as e:
        log.warning("Return YouTube Dislike fetch failed for %s: %s", video_id, e)
        return {"ok": False, "error": f"Could not reach Return YouTube Dislike API: {e}"}
