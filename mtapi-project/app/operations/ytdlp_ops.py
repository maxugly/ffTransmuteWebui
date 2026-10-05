"""
yt-dlp Media Downloader Operation — POST /ops/ytdlp.

Ingests media from YouTube and 1700+ platforms with options modeled after Seal,
time-range clipping, companion assets (subs, chat, description, comments),
and extended metadata retention for the Dual Pool architecture.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..job_control import report_progress
from ..pathutil import finalize_output_path

log = logging.getLogger("mtapi.ytdlp")

# Regex to parse yt-dlp download progress: [download]  45.2% of ~  25.40MiB at    5.12MiB/s ETA 00:03
_PROGRESS_RE = re.compile(
    r"\[download\]\s+([0-9.]+)%\s+of\s+(?:~?\s*([0-9.]+[A-Za-z]+))?\s+at\s+([0-9.]+[A-Za-z]+/s)?\s+ETA\s+([0-9:]+)"
)


class YtdlpParams(BaseModel):
    url: str = Field(..., description="Target media URL or playlist URL")
    output_dir: str | None = Field(
        None, description="Absolute directory to place downloaded files. Defaults to ~/Downloads."
    )
    output_template: str = Field(
        "%(title).200B [%(id)s].%(ext)s",
        description="yt-dlp output filename template",
    )

    # Mode & Format (Seal options)
    extract_audio: bool = Field(False, description="Extract audio instead of video")
    video_quality: str = Field("best", description="Max height: best, 2160, 1440, 1080, 720, 480")
    video_format: str = Field("mp4", description="Container: mp4, mkv, webm, original")
    audio_format: str = Field("mp3", description="Audio codec: mp3, m4a, opus, flac, wav, aac")
    audio_quality: str = Field("0", description="VBR 0 (best) or bitrate 320k, 256k, 192k, 128k")
    audio_multistreams: bool = Field(False, description="Merge multiple audio streams")

    # Time Range (Clipping)
    time_range_start: str | None = Field(None, description="Start time (HH:MM:SS or seconds)")
    time_range_end: str | None = Field(None, description="End time (HH:MM:SS or seconds)")

    # Captions & Chat
    write_subs: bool = Field(False, description="Download subtitle files")
    write_auto_subs: bool = Field(False, description="Include auto-generated subtitles")
    sub_langs: str = Field("en.*,all", description="Language regex or comma-separated list")
    sub_format: str = Field("srt", description="Subtitle conversion format: srt, vtt, ass")
    embed_subs: bool = Field(False, description="Embed subtitles into video container")
    write_live_chat: bool = Field(False, description="Download live chat replay (.live_chat.json)")

    # Metadata & Assets
    write_description: bool = Field(False, description="Write video description to .description file")
    write_comments: bool = Field(False, description="Retrieve comments into .info.json (performed as separate post-media pass)")
    max_comments: int = Field(100, ge=0, le=10000, description="Max comments to retrieve (default 100; 0 for unlimited)")
    write_info_json: bool = Field(True, description="Write full metadata .info.json")
    write_thumbnail: bool = Field(True, description="Save thumbnail image file")
    embed_thumbnail: bool = Field(False, description="Embed thumbnail in media file")
    crop_artwork: bool = Field(False, description="Crop audio thumbnail to 1:1 square")
    embed_metadata: bool = Field(True, description="Embed title/artist/chapters into container")

    # SponsorBlock
    sponsorblock_action: Literal["none", "mark", "remove"] = Field("none", description="none | mark | remove")
    sponsorblock_categories: list[str] = Field(
        default_factory=lambda: ["sponsor", "intro", "outro", "selfpromo"],
        description="SponsorBlock categories to process",
    )

    # Network & Performance
    concurrent_fragments: int = Field(4, ge=1, le=16, description="Parallel fragment downloads (-N)")
    use_aria2c: bool = Field(False, description="Use aria2c external downloader")
    limit_rate: str | None = Field(None, description="Maximum download rate (e.g. 5M, 500K)")
    proxy_url: str | None = Field(None, description="HTTP/SOCKS proxy URL")
    cookies_path: str | None = Field(None, description="Path to Netscape cookies.txt")
    cookies_from_browser: str | None = Field(None, description="Extract cookies from browser (chrome, firefox, brave)")
    force_ipv4: bool = Field(False, description="Force IPv4 connection")

    # Ingest Actions
    add_to_pool: bool = Field(True, description="Automatically ingest video into Video Pool")
    send_to_media_in: bool = Field(False, description="Send downloaded video to global Media In")
    add_to_sequence: bool = Field(False, description="Append downloaded video to Sequence")

    dry_run: bool = Field(False, description="Print resolved command without executing")


def _find_ytdlp_bin() -> str:
    found = shutil.which("yt-dlp")
    if found:
        return found
    user_bin = Path.home() / ".local" / "bin" / "yt-dlp"
    if user_bin.is_file():
        return str(user_bin)
    return "yt-dlp"


def _clean_date_str(raw: Any) -> str | None:
    if not raw:
        return None
    s = str(raw).strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s


def build_ytdlp_argv(params: YtdlpParams, target_dir: Path) -> list[str]:
    ytdlp_bin = _find_ytdlp_bin()
    argv = [ytdlp_bin, params.url.strip(), "--no-mtime", "--newline"]

    # JS runtime hint if node is present
    if shutil.which("node"):
        argv.extend(["--js-runtimes", "node"])

    # Mode & Format
    if params.extract_audio:
        argv.extend(["-x", "--audio-format", params.audio_format, "--audio-quality", params.audio_quality])
        if params.crop_artwork:
            argv.extend(["--ppa", "ffmpeg: -c:v mjpeg -vf crop=\"'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'\""])
    else:
        if params.video_quality and params.video_quality != "best":
            argv.extend(["-S", f"res:{params.video_quality}"])
        if params.video_format in ("mp4", "mkv", "webm"):
            argv.extend(["--merge-output-format", params.video_format])
        if params.audio_multistreams:
            argv.append("--audio-multistreams")

    # Time Range (Clipping)
    s = (params.time_range_start or "").strip()
    e = (params.time_range_end or "").strip()
    if s or e:
        start_val = s if s else "0"
        end_val = e if e else "inf"
        argv.extend(["--download-sections", f"*{start_val}-{end_val}"])

    # Captions & Chat
    langs: list[str] = []
    if params.write_subs or params.write_auto_subs or params.write_live_chat:
        if params.write_subs:
            argv.append("--write-subs")
        if params.write_auto_subs:
            argv.append("--write-auto-subs")
        if params.sub_langs:
            langs.extend([l.strip() for l in params.sub_langs.split(",") if l.strip()])
        if params.write_live_chat and "live_chat" not in langs:
            langs.append("live_chat")
        if langs:
            argv.extend(["--sub-langs", ",".join(langs)])
        if params.sub_format:
            argv.extend(["--convert-subs", params.sub_format])
        if params.embed_subs and not params.extract_audio:
            argv.append("--embed-subs")

    # Metadata & Companion Assets
    if params.write_description:
        argv.append("--write-description")
    # Note: comments are intentionally retrieved in a dedicated follow-up pass
    # (via build_ytdlp_comments_argv) after media download finishes, ensuring media
    # download completes cleanly without being blocked or throttled by comment pagination.
    if params.write_info_json or params.write_comments:
        argv.append("--write-info-json")
    if params.write_thumbnail:
        argv.append("--write-thumbnail")
    if params.embed_thumbnail and not params.crop_artwork:
        argv.append("--embed-thumbnail")
    if params.embed_metadata:
        argv.append("--embed-metadata")

    # SponsorBlock
    if params.sponsorblock_action == "mark":
        cats = [c.strip() for c in params.sponsorblock_categories if c.strip()]
        if cats:
            argv.extend(["--sponsorblock-mark", ",".join(cats)])
    elif params.sponsorblock_action == "remove":
        cats = [c.strip() for c in params.sponsorblock_categories if c.strip()]
        if cats:
            argv.extend(["--sponsorblock-remove", ",".join(cats)])

    # Network & Performance
    if params.concurrent_fragments > 1:
        argv.extend(["-N", str(params.concurrent_fragments)])
    if params.use_aria2c:
        argv.extend(["--downloader", "aria2c"])
    if params.limit_rate and params.limit_rate.strip():
        argv.extend(["--limit-rate", params.limit_rate.strip()])
    if params.proxy_url and params.proxy_url.strip():
        argv.extend(["--proxy", params.proxy_url.strip()])
    if params.cookies_path and Path(params.cookies_path.strip()).is_file():
        argv.extend(["--cookies", str(Path(params.cookies_path.strip()).resolve())])
    elif params.cookies_from_browser and params.cookies_from_browser.strip():
        argv.extend(["--cookies-from-browser", params.cookies_from_browser.strip()])
    if params.force_ipv4:
        argv.append("-4")

    # Output Template & Path
    out_pattern = target_dir / params.output_template
    argv.extend(["-o", str(out_pattern)])
    return argv


def build_ytdlp_comments_argv(params: YtdlpParams, target_dir: Path) -> list[str]:
    """
    Build yt-dlp argv specifically for fetching comments into .info.json without re-downloading media.
    Runs as a separate follow-up operation after media is securely written to disk.
    """
    ytdlp_bin = _find_ytdlp_bin()
    argv = [ytdlp_bin, params.url.strip(), "--no-mtime", "--newline"]

    # JS runtime hint if node is present
    if shutil.which("node"):
        argv.extend(["--js-runtimes", "node"])

    # Skip media download
    argv.append("--skip-download")
    argv.append("--write-comments")
    argv.append("--write-info-json")

    # Optional max_comments ceiling to avoid YouTube API throttling/hanging
    if params.max_comments and params.max_comments > 0:
        argv.extend(["--extractor-args", f"youtube:max_comments={params.max_comments}"])

    # Output Template & Path (must match media pass so sidecar .info.json aligns)
    out_pattern = target_dir / params.output_template
    argv.extend(["-o", str(out_pattern)])

    # Network & Performance settings (aligned with media pass)
    if params.proxy_url and params.proxy_url.strip():
        argv.extend(["--proxy", params.proxy_url.strip()])
    if params.cookies_path and Path(params.cookies_path.strip()).is_file():
        argv.extend(["--cookies", str(Path(params.cookies_path.strip()).resolve())])
    elif params.cookies_from_browser and params.cookies_from_browser.strip():
        argv.extend(["--cookies-from-browser", params.cookies_from_browser.strip()])
    if params.force_ipv4:
        argv.append("-4")

    return argv


def _construct_source_meta(
    info: dict[str, Any],
    url: str,
    output_media_path: Path | None,
    params: YtdlpParams,
) -> dict[str, Any]:
    extractor = str(info.get("extractor") or info.get("extractor_key") or "web").lower()
    is_yt = "youtube" in extractor
    author = info.get("uploader") or info.get("channel") or info.get("creator") or (extractor if not is_yt else None)
    channel = info.get("channel") or info.get("uploader")
    upload_date = _clean_date_str(info.get("upload_date") or info.get("release_date"))
    vid_id = str(info.get("id") or "")
    title = str(info.get("title") or output_media_path.stem if output_media_path else "")

    desc = info.get("description")
    desc_snippet = desc[:280] + "…" if isinstance(desc, str) and len(desc) > 280 else (desc or None)

    clipped = bool(params.time_range_start or params.time_range_end)
    timerange = {
        "clipped": clipped,
        "start": str(params.time_range_start or "0") if clipped else "",
        "end": str(params.time_range_end or "") if clipped else "",
    }

    # Detect sidecar files next to output media
    has_subs = []
    has_live_chat = False
    has_comments = bool(info.get("comments"))
    info_json_path = None
    comments_json_path = None

    if output_media_path and output_media_path.parent.is_dir():
        stem = output_media_path.stem
        parent = output_media_path.parent
        ij = parent / f"{stem}.info.json"
        if ij.is_file():
            info_json_path = str(ij.resolve())
        cj = parent / f"{stem}.comments.json"
        if cj.is_file():
            comments_json_path = str(cj.resolve())
            has_comments = True
        lc = parent / f"{stem}.live_chat.json"
        if lc.is_file():
            has_live_chat = True
        for sub_file in parent.glob(f"{glob_escape(stem)}*.srt"):
            parts = sub_file.stem.split(".")
            if len(parts) > 1:
                has_subs.append(parts[-1])
        for sub_file in parent.glob(f"{glob_escape(stem)}*.vtt"):
            parts = sub_file.stem.split(".")
            if len(parts) > 1 and parts[-1] not in has_subs:
                has_subs.append(parts[-1])

    return {
        "source": "yt-dlp",
        "site": extractor,
        "is_youtube": is_yt,
        "video_id": vid_id,
        "title": title,
        "author": author,
        "channel": channel,
        "channel_id": str(info.get("channel_id") or info.get("uploader_id") or ""),
        "publish_date": upload_date,
        "source_url": url,
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count") or (len(info["comments"]) if isinstance(info.get("comments"), list) else None),
        "tags": info.get("tags") if isinstance(info.get("tags"), list) else [],
        "description_snippet": desc_snippet,
        "timerange": timerange,
        "has_subs": has_subs,
        "has_live_chat": has_live_chat,
        "has_comments": has_comments,
        "info_json_path": info_json_path,
        "comments_json_path": comments_json_path,
        "downloaded_at": time.time(),
    }


def glob_escape(pathname: str) -> str:
    """Escape special glob characters in a path/filename."""
    drive, pathname = os.path.splitdrive(pathname)
    return drive + re.sub(r"([*?\[\]])", r"[\1]", pathname)


async def ytdlp_download(params: YtdlpParams) -> OperationResult:
    if not params.url or not params.url.strip():
        return OperationResult(
            ok=False, operation="ytdlp", error="URL cannot be empty"
        )

    # Determine target directory
    if params.output_dir and params.output_dir.strip():
        out_dir = Path(params.output_dir.strip()).expanduser()
    else:
        out_dir = Path.home() / "Downloads"
    out_dir.mkdir(parents=True, exist_ok=True)

    argv = build_ytdlp_argv(params, out_dir)
    cmd_str = " ".join(argv)
    comments_argv = build_ytdlp_comments_argv(params, out_dir) if params.write_comments else None

    if params.dry_run:
        full_cmd_str = cmd_str
        if comments_argv:
            comments_cmd_str = " ".join(comments_argv)
            full_cmd_str = (
                f"{cmd_str}\n\n"
                f"# --- Follow-up Comments Pass (runs separately after media download) ---\n"
                f"{comments_cmd_str}"
            )
        return OperationResult(
            ok=True,
            operation="ytdlp",
            dry_run=True,
            command=full_cmd_str,
            stdout=f"Dry run complete. Command(s):\n{full_cmd_str}",
            meta={"dry_run": True, "command": full_cmd_str},
        )

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def _process_line(line: str, is_err: bool, label: str) -> None:
        if is_err:
            stderr_lines.append(line)
            log.warning("[ytdlp %s err]: %s", label, line)
        else:
            stdout_lines.append(line)
            log.info("[ytdlp %s]: %s", label, line)
            if label == "media":
                m = _PROGRESS_RE.search(line)
                if m:
                    pct = float(m.group(1))
                    size_str = m.group(2) or ""
                    spd = m.group(3) or ""
                    eta = m.group(4) or ""
                    status_text = f"Downloading {pct:.1f}% ({spd} ETA {eta})"
                    report_progress(
                        status_text,
                        phase="download",
                        current=int(pct),
                        total=100,
                        unit="%",
                    )
            elif label == "comments":
                if "Downloading comment" in line or "Extracted" in line or "comments" in line:
                    report_progress(
                        f"Comments: {line}",
                        phase="comments",
                        current=50,
                        total=100,
                        unit="%",
                    )

    async def _read_stream(stream: asyncio.StreamReader, is_err: bool = False, label: str = "media") -> None:
        # Use chunked reading (read 8192 bytes) and split on either \r or \n.
        # This prevents asyncio.LimitOverrunError on carriage-return-delimited progress updates
        # and eliminates the 64KB buffer limit crash.
        buf = b""
        while True:
            try:
                chunk = await stream.read(8192)
            except Exception as e:
                log.warning("Stream read exception: %s", e)
                break
            if not chunk:
                break
            buf += chunk
            while True:
                idx_n = buf.find(b"\n")
                idx_r = buf.find(b"\r")
                if idx_n == -1 and idx_r == -1:
                    break
                if idx_n != -1 and (idx_r == -1 or idx_n < idx_r):
                    line_bytes = buf[:idx_n]
                    buf = buf[idx_n + 1:]
                else:
                    line_bytes = buf[:idx_r]
                    buf = buf[idx_r + 1:]

                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                _process_line(line, is_err, label)

        if buf:
            line = buf.decode("utf-8", errors="replace").strip()
            if line:
                _process_line(line, is_err, label)

    try:
        # Record files before download to detect what new file appeared
        pre_files = set(out_dir.iterdir())

        # Phase 1: Download Media
        report_progress("Starting yt-dlp media download…", phase="download", current=0, total=100, unit="%")
        t0 = time.time()

        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(out_dir),
            limit=1024 * 1024 * 16,
        )

        await asyncio.gather(
            _read_stream(proc.stdout, is_err=False, label="media"),
            _read_stream(proc.stderr, is_err=True, label="media"),
        )
        rc = await proc.wait()

        stdout_text = "\n".join(stdout_lines)
        stderr_text = "\n".join(stderr_lines)

        if rc != 0:
            err_msg = stderr_lines[-1] if stderr_lines else f"yt-dlp media download failed with exit code {rc}"
            return OperationResult(
                ok=False,
                operation="ytdlp",
                command=cmd_str,
                error=err_msg,
                stdout=stdout_text,
                stderr=stderr_text,
            )

        # Detect new media file in out_dir
        post_files = set(out_dir.iterdir())
        new_files = post_files - pre_files
        media_exts = {".mp4", ".mkv", ".webm", ".mov", ".mp3", ".m4a", ".opus", ".flac", ".wav", ".aac"}
        new_media = [f for f in new_files if f.suffix.lower() in media_exts]

        chosen_media: Path | None = None
        if new_media:
            # Choose the newest or largest media file
            chosen_media = max(new_media, key=lambda f: f.stat().st_mtime)
        else:
            # Check if an existing file was overwritten or updated
            all_media = [f for f in out_dir.iterdir() if f.suffix.lower() in media_exts]
            if all_media:
                chosen_media = max(all_media, key=lambda f: f.stat().st_mtime)

        # Phase 2: Comments Pass (Separate execution after media)
        if comments_argv:
            report_progress(
                "Media downloaded. Fetching comments into info.json…",
                phase="comments",
                current=0,
                total=100,
                unit="%",
            )
            try:
                proc_comm = await asyncio.create_subprocess_exec(
                    *comments_argv,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(out_dir),
                    limit=1024 * 1024 * 16,
                )
                await asyncio.gather(
                    _read_stream(proc_comm.stdout, is_err=False, label="comments"),
                    _read_stream(proc_comm.stderr, is_err=True, label="comments"),
                )
                rc_comm = await proc_comm.wait()
                if rc_comm != 0:
                    log.warning(
                        "yt-dlp comments fetch ended with code %s (media was saved successfully)",
                        rc_comm,
                    )
            except Exception as e:
                log.warning("yt-dlp comments pass error: %s (media was saved successfully)", e)

        # Read .info.json if available
        info_dict: dict[str, Any] = {}
        info_json_file = None
        if chosen_media:
            candidate_info = chosen_media.parent / f"{chosen_media.stem}.info.json"
            if candidate_info.is_file():
                info_json_file = candidate_info
        if not info_json_file:
            for nf in new_files:
                if nf.name.endswith(".info.json"):
                    info_json_file = nf
                    break

        if info_json_file and info_json_file.is_file():
            try:
                info_dict = json.loads(info_json_file.read_text(encoding="utf-8"))
            except Exception as e:
                log.warning("Could not parse emitted .info.json: %s", e)

        # Write clean, readable .comments.json companion file if comments are present in info_dict
        if chosen_media and isinstance(info_dict.get("comments"), list) and info_dict["comments"]:
            try:
                comments_file = chosen_media.parent / f"{chosen_media.stem}.comments.json"
                readable_comments = [
                    {
                        "author": c.get("author") or c.get("author_id"),
                        "text": c.get("text"),
                        "like_count": c.get("like_count"),
                        "time_text": c.get("time_text"),
                        "timestamp": c.get("timestamp"),
                        "id": c.get("id"),
                        "parent": c.get("parent"),
                        "is_pinned": bool(c.get("is_pinned")),
                        "author_is_uploader": bool(c.get("author_is_uploader")),
                    }
                    for c in info_dict["comments"]
                    if isinstance(c, dict)
                ]
                comments_file.write_text(json.dumps(readable_comments, indent=2, ensure_ascii=False), encoding="utf-8")
                log.info("Wrote %d readable comments to %s", len(readable_comments), comments_file)
            except Exception as e:
                log.warning("Could not write .comments.json sidecar: %s", e)

        source_meta = _construct_source_meta(info_dict, params.url, chosen_media, params)

        report_progress("Download complete", phase="done", current=100, total=100, unit="%")
        elapsed = time.time() - t0

        result_meta = {
            "source_meta": source_meta,
            "elapsed_s": round(elapsed, 2),
            "add_to_pool": params.add_to_pool,
            "send_to_media_in": params.send_to_media_in,
            "add_to_sequence": params.add_to_sequence,
        }

        full_executed_cmd = cmd_str
        if comments_argv:
            full_executed_cmd = f"{cmd_str}\n{' '.join(comments_argv)}"

        return OperationResult(
            ok=True,
            operation="ytdlp",
            output_path=str(chosen_media.resolve()) if chosen_media else str(out_dir),
            command=full_executed_cmd,
            stdout="\n".join(stdout_lines),
            stderr="\n".join(stderr_lines),
            meta=result_meta,
        )
    except Exception as e:
        log.exception("Unexpected error in ytdlp_download: %s", e)
        return OperationResult(
            ok=False,
            operation="ytdlp",
            command=cmd_str if "cmd_str" in locals() else "",
            error=str(e),
            stdout="\n".join(stdout_lines) if "stdout_lines" in locals() else "",
            stderr="\n".join(stderr_lines) if "stderr_lines" in locals() else "",
        )


register(
    OperationSpec(
        id="ytdlp",
        summary="yt-dlp Media Downloader — video/audio download with Seal options",
        description=(
            "Downloads media from YouTube and 1700+ platforms with options for formats, "
            "quality, time-range clipping, subtitles, live chat, descriptions, comments, "
            "and extended source metadata retention."
        ),
        params_model=YtdlpParams,
        handler=ytdlp_download,
        tags=["download", "ytdlp", "youtube", "ingest", "media"],
    )
)
