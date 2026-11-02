"""Vectorize unit and API tests."""
import asyncio
import os
import sys
from pathlib import Path
import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.operations.vectorize_ops import VectorizeParams, vectorize_run


def test_vectorize_status():
    r = requests.get("http://localhost:24590/vectorize/status")
    d = r.json()
    assert d.get("ok") is True
    assert "engines" in d


def test_vectorize_manifest():
    r = requests.get("http://localhost:24590/vectorize/manifest")
    d = r.json()
    assert d.get("ok") is True
    assert "manifests" in d
    assert "vtracer" in d["manifests"]


def test_vectorize_params_and_dry_run():
    p = VectorizeParams(
        input_path="/tmp/vtest.png",
        output_path="/tmp/vout_dry.svg",
        enabled=["vtracer"],
        dry_run=True,
    )
    assert p.dry_run is True
    assert p.output_path == "/tmp/vout_dry.svg"

    res = asyncio.run(vectorize_run(p))
    assert res.ok is True
    assert res.dry_run is True
    assert res.output_path == "/tmp/vout_dry.svg"


def test_vectorize_missing_input():
    p = VectorizeParams(
        input_path="/nonexistent/image.png",
        enabled=["vtracer"],
        dry_run=False,
    )
    res = asyncio.run(vectorize_run(p))
    assert res.ok is False
    assert "input not found" in res.error.lower()


def test_vectorize_real_vtracer():
    assert Path("/tmp/vtest.png").exists()
    out_svg = "/tmp/test_vtracer_unit_run.svg"
    if Path(out_svg).exists():
        Path(out_svg).unlink()

    p = VectorizeParams(
        input_path="/tmp/vtest.png",
        output_path=out_svg,
        enabled=["vtracer"],
        options={"vtracer": {"preset": "photo", "color_count": 16}},
        dry_run=False,
    )
    res = asyncio.run(vectorize_run(p))
    assert res.ok is True
    assert res.output_path == out_svg
    assert Path(out_svg).exists()
    assert Path(out_svg).stat().st_size > 0


def test_vectorize_real_inkscape():
    assert Path("/tmp/vtest.png").exists()
    out_svg = "/tmp/test_inkscape_unit_run.svg"
    if Path(out_svg).exists():
        Path(out_svg).unlink()

    p = VectorizeParams(
        input_path="/tmp/vtest.png",
        output_path=out_svg,
        enabled=["inkscape"],
        options={"inkscape": {"colors": 16, "smooth": True}},
        dry_run=False,
    )
    res = asyncio.run(vectorize_run(p))
    assert res.ok is True
    assert res.output_path == out_svg
    assert Path(out_svg).exists()
    assert Path(out_svg).stat().st_size > 0
