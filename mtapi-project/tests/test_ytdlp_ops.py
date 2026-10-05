"""
Tests for yt-dlp operation builder, metadata extraction, and pool normalization.
"""
from pathlib import Path
import pytest

from app.operations.ytdlp_ops import (
    YtdlpParams,
    build_ytdlp_argv,
    build_ytdlp_comments_argv,
    _construct_source_meta,
    ytdlp_download,
)
from app.media.pool import _normalize_source_meta, _normalize_media_entry


def test_build_ytdlp_argv_basic():
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        output_template="%(title)s.%(ext)s",
    )
    argv = build_ytdlp_argv(params, Path("/tmp"))
    assert argv[0].endswith("yt-dlp")
    assert "https://www.youtube.com/watch?v=dQw4w9WgXcQ" in argv
    assert "-o" in argv
    assert str(Path("/tmp/%(title)s.%(ext)s")) in argv


def test_build_ytdlp_argv_audio_and_crop():
    params = YtdlpParams(
        url="https://example.com/audio",
        extract_audio=True,
        audio_format="opus",
        audio_quality="320k",
        crop_artwork=True,
    )
    argv = build_ytdlp_argv(params, Path("/tmp"))
    assert "-x" in argv
    assert "--audio-format" in argv
    assert "opus" in argv
    assert "--audio-quality" in argv
    assert "320k" in argv
    assert "--ppa" in argv


def test_build_ytdlp_argv_timerange_clipping():
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        time_range_start="00:01:23",
        time_range_end="00:02:45",
    )
    argv = build_ytdlp_argv(params, Path("/tmp"))
    assert "--download-sections" in argv
    assert "*00:01:23-00:02:45" in argv


def test_build_ytdlp_argv_captions_chat_comments_description():
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        write_subs=True,
        write_auto_subs=True,
        sub_langs="en,es",
        sub_format="vtt",
        embed_subs=True,
        write_live_chat=True,
        write_description=True,
        write_comments=True,
        write_info_json=True,
    )
    argv = build_ytdlp_argv(params, Path("/tmp"))
    assert "--write-subs" in argv
    assert "--write-auto-subs" in argv
    assert "--sub-langs" in argv
    sub_langs_arg = argv[argv.index("--sub-langs") + 1]
    assert "en" in sub_langs_arg and "live_chat" in sub_langs_arg
    assert "--convert-subs" in argv
    assert "vtt" in argv
    assert "--embed-subs" in argv
    assert "--write-description" in argv
    # Comments are intentionally NOT in the media pass argv
    assert "--write-comments" not in argv
    assert "--write-info-json" in argv


def test_build_ytdlp_comments_argv():
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        write_comments=True,
        max_comments=50,
        proxy_url="http://127.0.0.1:8080",
        force_ipv4=True,
    )
    comm_argv = build_ytdlp_comments_argv(params, Path("/tmp"))
    assert "--skip-download" in comm_argv
    assert "--write-comments" in comm_argv
    assert "--write-info-json" in comm_argv
    assert "--extractor-args" in comm_argv
    assert "youtube:max_comments=50" in comm_argv
    assert "--proxy" in comm_argv
    assert "http://127.0.0.1:8080" in comm_argv
    assert "-4" in comm_argv


def test_build_ytdlp_argv_sponsorblock_and_network():
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=test",
        sponsorblock_action="remove",
        sponsorblock_categories=["sponsor", "intro"],
        concurrent_fragments=8,
        use_aria2c=True,
        limit_rate="10M",
        proxy_url="http://127.0.0.1:8080",
        force_ipv4=True,
    )
    argv = build_ytdlp_argv(params, Path("/tmp"))
    assert "--sponsorblock-remove" in argv
    assert "sponsor,intro" in argv
    assert "-N" in argv
    assert "8" in argv
    assert "--downloader" in argv
    assert "aria2c" in argv
    assert "--limit-rate" in argv
    assert "10M" in argv
    assert "--proxy" in argv
    assert "http://127.0.0.1:8080" in argv
    assert "-4" in argv


def test_construct_source_meta_youtube():
    info = {
        "id": "abc12345",
        "title": "Cool Video",
        "uploader": "Test Channel",
        "channel": "Test Channel",
        "channel_id": "UC123",
        "upload_date": "20240315",
        "view_count": 10000,
        "like_count": 500,
        "tags": ["ambient", "drone"],
        "description": "A very cool description text.",
        "extractor": "youtube",
        "comments": [{"text": "great"}],
    }
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=abc12345",
        time_range_start="00:10",
        time_range_end="00:30",
    )
    media_path = Path("/tmp/Cool Video [abc12345].mp4")
    sm = _construct_source_meta(info, params.url, media_path, params)
    assert sm["source"] == "yt-dlp"
    assert sm["site"] == "youtube"
    assert sm["is_youtube"] is True
    assert sm["video_id"] == "abc12345"
    assert sm["title"] == "Cool Video"
    assert sm["author"] == "Test Channel"
    assert sm["publish_date"] == "2024-03-15"
    assert sm["view_count"] == 10000
    assert sm["tags"] == ["ambient", "drone"]
    assert sm["timerange"]["clipped"] is True
    assert sm["timerange"]["start"] == "00:10"
    assert sm["timerange"]["end"] == "00:30"
    assert sm["has_comments"] is True


def test_construct_source_meta_non_youtube():
    info = {
        "id": "vimeo_9876",
        "title": "Art Project",
        "uploader": "Indie Filmmaker",
        "upload_date": None,
        "extractor": "vimeo",
        "tags": ["art"],
    }
    params = YtdlpParams(url="https://vimeo.com/9876")
    sm = _construct_source_meta(info, params.url, Path("/tmp/art.mp4"), params)
    assert sm["source"] == "yt-dlp"
    assert sm["site"] == "vimeo"
    assert sm["is_youtube"] is False
    assert sm["publish_date"] is None
    assert sm["author"] == "Indie Filmmaker"
    assert sm["timerange"]["clipped"] is False


def test_normalize_source_meta():
    raw = {
        "source": "yt-dlp",
        "site": "youtube",
        "is_youtube": True,
        "video_id": "xyz",
        "title": "Title",
        "author": "Creator",
        "publish_date": "2024-01-01",
        "view_count": "5000",
        "tags": ["one", "two"],
        "timerange": {"clipped": True, "start": "0", "end": "10"},
        "unknown_junk": "should be stripped",
    }
    norm = _normalize_source_meta(raw)
    assert norm is not None
    assert norm["source"] == "yt-dlp"
    assert norm["view_count"] == 5000
    assert norm["publish_date"] == "2024-01-01"
    assert norm["timerange"]["clipped"] is True
    assert "unknown_junk" not in norm


def test_ytdlp_dry_run():
    import asyncio
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        dry_run=True,
    )
    res = asyncio.run(ytdlp_download(params))
    assert res.ok is True
    assert res.dry_run is True
    assert "yt-dlp" in res.command
    assert res.meta.get("dry_run") is True


def test_ytdlp_dry_run_with_comments():
    import asyncio
    params = YtdlpParams(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        write_comments=True,
        max_comments=25,
        dry_run=True,
    )
    res = asyncio.run(ytdlp_download(params))
    assert res.ok is True
    assert res.dry_run is True
    assert "--skip-download" in res.command
    assert "--write-comments" in res.command
    assert "youtube:max_comments=25" in res.command


def test_ytdlp_version_route():
    from starlette.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    res = client.get("/api/ytdlp/version")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "version" in data


def test_ytdlp_carriage_return_stream_handling():
    import asyncio

    async def _run():
        # Simulate a stream with 150KB of carriage-return progress lines without newlines
        # (which triggered LimitOverrunError in asyncio.StreamReader.readline's 64KB default limit)
        data = b"".join(f"[download] {i:03d}% of 1.0GiB\r".encode("utf-8") for i in range(4000))
        reader = asyncio.StreamReader()
        reader.feed_data(data)
        reader.feed_eof()

        collected = []
        buf = b""
        while True:
            chunk = await reader.read(8192)
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
                if line:
                    collected.append(line)

        assert len(collected) == 4000
        assert "[download] 000% of 1.0GiB" in collected[0]
        assert "[download] 3999% of 1.0GiB" in collected[-1]

    asyncio.run(_run())


def test_comments_json_sidecar_generation(tmp_path):
    import json
    from app.operations.ytdlp_ops import _construct_source_meta

    media_file = tmp_path / "video.mp4"
    media_file.write_text("fake media")

    comments_data = [
        {"author": "@alice", "text": "awesome!", "like_count": 42, "time_text": "1 hour ago", "timestamp": 12345, "id": "c1"},
        {"author": "@bob", "text": "cool stuff", "like_count": 5, "time_text": "2 hours ago", "timestamp": 12340, "id": "c2"},
    ]
    comments_file = tmp_path / "video.comments.json"
    comments_file.write_text(json.dumps(comments_data, indent=2))

    params = YtdlpParams(url="https://www.youtube.com/watch?v=123")
    sm = _construct_source_meta({}, params.url, media_file, params)
    assert sm["has_comments"] is True
    assert sm["comments_json_path"] == str(comments_file.resolve())




