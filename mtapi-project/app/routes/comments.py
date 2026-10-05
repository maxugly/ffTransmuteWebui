import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query
from starlette.responses import JSONResponse

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/comments", tags=["comments"])


def _scan_comment_files() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    downloads_dir = Path.home() / "Downloads"
    if downloads_dir.is_dir():
        # First scan for .comments.json sidecars (preferred)
        for p in sorted(downloads_dir.glob("*.comments.json"), key=lambda f: f.stat().st_mtime, reverse=True):
            try:
                st = p.stat()
                stem = p.name[:-14]  # strip .comments.json
                # try to extract video_id from stem: "Title [id]"
                vid_id = ""
                title = stem
                if "[" in stem and stem.endswith("]"):
                    title = stem[:stem.rfind("[")].strip()
                    vid_id = stem[stem.rfind("[") + 1:-1].strip()

                # Peek count without loading entire file if large
                count = None
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    count = len(data) if isinstance(data, list) else len(data.get("comments", []))
                except Exception:
                    pass

                results.append({
                    "path": str(p.resolve()),
                    "title": title,
                    "video_id": vid_id,
                    "filename": p.name,
                    "comment_count": count,
                    "mtime": st.st_mtime,
                    "is_companion": True,
                })
                if vid_id:
                    seen_ids.add(vid_id)
            except Exception as e:
                log.debug("Error checking comments file %s: %s", p, e)

        # Also scan for .info.json files that have comments
        for p in sorted(downloads_dir.glob("*.info.json"), key=lambda f: f.stat().st_mtime, reverse=True):
            try:
                st = p.stat()
                if st.st_size == 0 or st.st_size > 100 * 1024 * 1024:
                    continue
                stem = p.name[:-10]  # strip .info.json
                vid_id = ""
                title = stem
                if "[" in stem and stem.endswith("]"):
                    title = stem[:stem.rfind("[")].strip()
                    vid_id = stem[stem.rfind("[") + 1:-1].strip()

                if vid_id and vid_id in seen_ids:
                    continue

                # Check if it has comments
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    comments = data.get("comments")
                    if isinstance(comments, list) and comments:
                        results.append({
                            "path": str(p.resolve()),
                            "title": data.get("title") or title,
                            "video_id": data.get("id") or vid_id,
                            "filename": p.name,
                            "comment_count": len(comments),
                            "mtime": st.st_mtime,
                            "is_companion": False,
                        })
                        if vid_id:
                            seen_ids.add(vid_id)
                except Exception:
                    pass
            except Exception as e:
                log.debug("Error checking info.json file %s: %s", p, e)

    return results


@router.get("/files")
async def list_comment_files() -> JSONResponse:
    try:
        files = _scan_comment_files()
        return JSONResponse({"ok": True, "files": files})
    except Exception as e:
        log.exception("Error listing comment files: %s", e)
        return JSONResponse({"ok": False, "error": str(e), "files": []})


@router.get("/data")
async def get_comment_data(path: str = Query(...)) -> JSONResponse:
    try:
        p = Path(path.strip()).expanduser()
        if not p.is_file():
            return JSONResponse({"ok": False, "error": f"File not found: {path}"})
        if p.suffix.lower() != ".json":
            return JSONResponse({"ok": False, "error": f"Not a JSON file: {path}"})

        content = p.read_text(encoding="utf-8")
        if not content.strip():
            return JSONResponse({"ok": False, "error": "File is empty (0 bytes)"})

        raw = json.loads(content)
        title = ""
        video_id = ""
        channel = ""
        uploader_id = ""
        raw_comments: list[dict[str, Any]] = []

        if isinstance(raw, list):
            # Formatted list of comments
            raw_comments = raw
            title = p.stem.replace(".comments", "")
            if "[" in title and title.endswith("]"):
                video_id = title[title.rfind("[") + 1:-1].strip()
                title = title[:title.rfind("[")].strip()
        elif isinstance(raw, dict):
            # info.json sidecar or dict wrapper
            title = raw.get("title") or p.stem.replace(".info", "")
            video_id = raw.get("id") or ""
            channel = raw.get("channel") or raw.get("uploader") or ""
            uploader_id = raw.get("channel_id") or raw.get("uploader_id") or ""
            raw_comments = raw.get("comments") or []
            if not isinstance(raw_comments, list):
                raw_comments = []

        # Build Reddit-style 2-level hierarchy: top-level threads + nested replies
        top_threads: list[dict[str, Any]] = []
        thread_by_id: dict[str, dict[str, Any]] = {}
        pending_replies: list[dict[str, Any]] = []

        for c in raw_comments:
            if not isinstance(c, dict):
                continue
            cid = str(c.get("id") or "")
            author = str(c.get("author") or c.get("author_id") or "Anonymous").strip()
            text = str(c.get("text") or "").strip()
            parent = c.get("parent")
            likes = int(c.get("like_count") or 0)
            is_pinned = bool(c.get("is_pinned"))
            is_creator = bool(c.get("author_is_uploader") or (uploader_id and c.get("author_id") == uploader_id))
            time_text = c.get("time_text")
            raw_ts = c.get("timestamp")
            timestamp = None
            if raw_ts is not None:
                try:
                    timestamp = int(raw_ts)
                except (ValueError, TypeError):
                    pass

            item = {
                "id": cid,
                "author": author,
                "author_id": c.get("author_id"),
                "author_thumbnail": c.get("author_thumbnail"),
                "text": text,
                "like_count": likes,
                "time_text": time_text,
                "timestamp": timestamp,
                "is_pinned": is_pinned,
                "is_creator": is_creator,
                "parent": parent,
            }

            if not parent or parent == "root":
                item["replies"] = []
                top_threads.append(item)
                if cid:
                    thread_by_id[cid] = item
            else:
                pending_replies.append(item)

        # Attach replies to their parent thread
        for rep in pending_replies:
            pid = str(rep.get("parent") or "")
            target_thread = thread_by_id.get(pid)
            if not target_thread:
                # If replying to a sub-comment, check if parent's prefix matches a top-level thread
                base_id = pid.split(".")[0] if "." in pid else pid
                target_thread = thread_by_id.get(base_id)

            if target_thread:
                target_thread["replies"].append(rep)
            else:
                # Orphan reply: promote to top-level so it is never lost
                rep["replies"] = []
                top_threads.append(rep)
                if rep.get("id"):
                    thread_by_id[rep["id"]] = rep

        return JSONResponse({
            "ok": True,
            "title": title,
            "video_id": video_id,
            "channel": channel,
            "total_count": len(raw_comments),
            "threads_count": len(top_threads),
            "threads": top_threads,
        })
    except Exception as e:
        log.exception("Error loading comment data: %s", e)
        return JSONResponse({"ok": False, "error": str(e)})


@router.get("/ryd")
async def get_comments_ryd(video_id: str = Query(...)) -> JSONResponse:
    from app.routes.ytdlp import fetch_ryd_stats
    data = await fetch_ryd_stats(video_id.strip())
    return JSONResponse(data)


def register(app: Any) -> None:
    app.include_router(router)
