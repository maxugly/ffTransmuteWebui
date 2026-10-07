"""Shared pytest plumbing for the whole suite — agents should not have to
rebuild this per test file.

What this does for you:
  * `app` is importable from any working directory (sys.path injection).
  * Fixtures below give every test an isolated, env-pinned sandbox so no
    test ever touches ~/.cache, real skills, or a previous test's state.

Standard agent recipe for a pure-logic unit test (no server, no ffmpeg):

    def test_something(tmp_path, mtapi_env):
        ...                     # write inputs under tmp_path, call app code

Fixtures provided here:
    tmp_path                (pytest built-in) unique empty dir per test
    clean_environ           (pytest built-in) restores os.environ afterwards
    mtapi_env               pins MTAPI_* env vars into a per-test sandbox
    workspace_root          the sandbox root (= mtapi_env["jobs_root"].parent)
    fake_video              a tiny real .mp4 generated with ffmpeg (skips if absent)
    op_registry             fresh isolated app.contract.REGISTRY dict

Run just these fast tests with:
    python -m pytest tests/test_agent_invariants.py -q
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

# ── make `app` importable regardless of where pytest was launched ──────────
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture()
def mtapi_env(tmp_path, clean_environ):
    """Pin every MTAPI_* sandbox env var to per-test directories.

    Returns the dict of env-var → path so tests can assert against them.
    Anything reading these vars (job_workspace, skills_store, shell.BIN_DIR)
    gets a hermetic location instead of the developer's machine.
    """
    sandbox = {
        "MTAPI_JOBS_ROOT": tmp_path / "jobs",
        "MTAPI_SKILLS_ROOT": tmp_path / "skills-home",
        "MTAPI_BIN_DIR": tmp_path / "bin",
    }
    for key, val in sandbox.items():
        clean_environ[key] = str(val)
    return {k: Path(v) for k, v in sandbox.items()}


@pytest.fixture()
def workspace_root(mtapi_env):
    """The per-test jobs root (JobWorkspace parents land under here)."""
    root = mtapi_env["MTAPI_JOBS_ROOT"]
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture(scope="session")
def has_ffmpeg():
    """True when ffmpeg is on PATH; used by fixtures that need real media."""
    return shutil.which("ffmpeg") is not None


@pytest.fixture()
def fake_video(tmp_path, has_ffmpeg, request):
    """A tiny real 8-frame 320x240/25fps mp4 with silent audio, or skip.

    Ground truth (invariant: assert against real files, not mocks):
        8 frames @ 25 fps → duration ≈ 0.32 s, 320x240, one aac audio stream.
    """
    if not has_ffmpeg:
        pytest.skip("ffmpeg not on PATH — cannot generate a real fixture clip")
    out = tmp_path / "fixture.mp4"
    rc = subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=0.32",
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
            "-t", "0.32", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(out),
        ],
        capture_output=True,
    )
    if rc.returncode != 0 or not out.is_file():
        pytest.skip(f"ffmpeg could not render the fixture clip: {rc.stderr[-400:]!r}")
    return out


@pytest.fixture()
def op_registry(monkeypatch):
    """A fresh REGISTRY dict swapped into app.contract for registration tests.

    Yields the dict; app.contract.register() writes into it during the test,
    and the original registry is restored automatically afterwards.
    """
    from app import contract

    scratch: dict = {}
    monkeypatch.setattr(contract, "REGISTRY", scratch)
    return scratch
