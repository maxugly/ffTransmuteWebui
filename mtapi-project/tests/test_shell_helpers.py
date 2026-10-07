"""Agent-friendly unit tests for the pure decision logic in app/shell.py.

Why these are "agent friendly":
  * No server, no ffmpeg, no network — deterministic in <1 s.
  * Table-driven: adding a case is one tuple, not a new test function.
  * Failure messages show input → expected → actual side by side.

Covered rules (app/shell.py):
  ensure_video_output_path — ffmpeg cannot mux to extensionless/unknown names;
    video-family extensions pass through untouched, everything else lands on .mp4.
  parse_line               — transmute's `Output:` / `Command:` echo contract
    (AGENTS.md invariant 3) that keeps Python and bash naming from drifting.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.shell import ensure_video_output_path, parse_line  # noqa: E402


# ── ensure_video_output_path: exhaustive table ───────────────────────────────
# (input, expected) — every row documents one branch of the rule.
ENSURE_CASES = [
    # falsy inputs pass straight through (caller decides what empty means)
    (None, None),
    ("", ""),                          # empty string is falsy → returned as-is
    ("   ", None),                      # whitespace-only collapses to None
    # recognized video extensions: untouched (stripped only)
    ("/x/clip.mp4", "/x/clip.mp4"),
    ("/x/clip.MP4", "/x/clip.MP4"),     # case-insensitive family match
    ("/x/clip.mkv", "/x/clip.mkv"),
    ("/x/clip.webm", "/x/clip.webm"),
    ("/x/clip.mov", "/x/clip.mov"),
    ("/x/clip.m4v", "/x/clip.m4v"),
    ("/x/clip.avi", "/x/clip.avi"),
    # extensionless numeric name (".../1") must gain .mp4
    ("/out/jobs/1", "/out/jobs/1.mp4"),
    ("/out/jobs/output", "/out/jobs/output.mp4"),
    # unknown but plausible-looking short alnum ext → replaced with .mp4
    ("/x/clip.xyz", "/x/clip.mp4"),
    ("/x/clip.png", "/x/clip.mp4"),     # image ext is not a video muxer target
    ("/x/a.b", "/x/a.mp4"),             # 1-char ext still counts as alnum<=6
    # multi-part tails: splitext takes the LAST dot, so '.gz' rewrites too —
    # pinning this documented behaviour, surprising as it looks
    ("/x/weird.tar.gz", "/x/weird.tar.mp4"),
]


@pytest.mark.parametrize("raw,expected", ENSURE_CASES)
def test_ensure_video_output_path_table(raw, expected):
    """Each documented branch maps input → expected output exactly."""
    got = ensure_video_output_path(raw)
    assert got == expected, f"ensure_video_output_path({raw!r}) → {got!r}, want {expected!r}"


def test_ensure_video_output_path_strips_surrounding_space():
    """A padded real path still matches its family and comes back stripped."""
    assert ensure_video_output_path("  /x/clip.mp4  ") == "/x/clip.mp4"
    assert ensure_video_output_path("  /x/noext  ") == "/x/noext.mp4"


def test_ensure_video_output_path_is_idempotent_on_video_paths():
    """Feeding the function its own output must not double-extend."""
    once = ensure_video_output_path("/x/name")
    assert ensure_video_output_path(once) == once


# ── parse_line: the transmute stdout contract ────────────────────────────────

TRANSMUTE_STDOUT = (
    "Some preamble noise\n"
    "Output: /data/out/clip_1x1s.mp4\n"
    "Command: ffmpeg -y -i in.mp4 -vf crop ... out.mp4\n"
    "Output: /data/out/SECOND.png\n"          # first match wins
)


@pytest.mark.parametrize("prefix,expected", [
    ("Output:", "/data/out/clip_1x1s.mp4"),
    ("Command:", "ffmpeg -y -i in.mp4 -vf crop ... out.mp4"),
])
def test_parse_line_pulls_first_prefixed_value(prefix, expected):
    assert parse_line(TRANSMUTE_STDOUT, prefix) == expected


@pytest.mark.parametrize("stdout,prefix", [
    ("", "Output:"),                                   # empty stdout
    ("no prefixes here", "Output:"),                  # absent prefix
    ("Outpu: typo.mp4", "Output:"),                   # near-miss must NOT match
    ("  Output: indented-not-at-line-start", "Output:"),  # startswith is strict
])
def test_parse_line_returns_none_when_prefix_absent(stdout, prefix):
    assert parse_line(stdout, prefix) is None


def test_parse_line_strips_trailing_whitespace_and_cr():
    """Windows/CRLF echoes must still yield a clean value."""
    assert parse_line("Output: /a/b.png\r\n", "Output:") == "/a/b.png"
