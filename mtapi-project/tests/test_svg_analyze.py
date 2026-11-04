"""Pure-logic tests for the convertico-style SVG analyzer (no server needed)."""
import pytest

from app.operations.svg_analyze import (
    analyze_svg_bytes,
    analyze_svg_file,
    _parse_color,
    _expand_hex,
)

SAMPLE = """<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="640" height="480" viewBox="0 0 640 480">
  <defs>
    <linearGradient id="g1">
      <stop offset="0" stop-color="#ff0000"/>
      <stop offset="1" stop-color="#00ff00"/>
    </linearGradient>
  </defs>
  <g fill="#ff0000" stroke="rgb(0, 0, 255)">
    <g>
      <g>
        <path d="M0 0 L10 10" style="fill:#aabbcc;stroke:none"/>
        <rect x="0" y="0" width="5" height="5"/>
        <circle cx="1" cy="1" r="2" fill="rebeccapurple"/>
      </g>
    </g>
    <ellipse cx="2" cy="2" rx="1" ry="1"/>
    <image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" width="8" height="8"/>
    <image xlink:href="https://example.com/a.png" width="4" height="4"/>
    <image width="2" height="2"/>
    <text x="0" y="0">hi</text>
  </g>
</svg>"""


def test_color_parsing():
    assert _expand_hex("abc") == "#aabbcc"
    assert _expand_hex("AABBCC") == "#aabbcc"
    assert _expand_hex("aabbccdd") == "#aabbcc"
    assert _parse_color("#AABBCC") == "#aabbcc"
    assert _parse_color("rgb(1, 2, 3)") == "#010203"
    assert _parse_color("rgba(1, 2, 3, 0.5)") == "#010203"
    assert _parse_color("none") is None
    assert _parse_color("url(#g1)") is None
    assert _parse_color("steelblue") == "steelblue"


def test_counts_and_depth():
    res = analyze_svg_bytes(SAMPLE)
    assert res["ok"] is True
    totals = res["totals"]
    # svg, defs, linearGradient, 2 stops, 3 g, path, rect, circle, ellipse, 3 images, text
    assert totals["elements"] == 16
    counts = {e["tag"]: e["count"] for e in res["element_counts"]}
    assert counts["path"] == 1
    assert counts["rect"] == 1
    assert counts["circle"] == 1
    assert counts["ellipse"] == 1
    assert counts["image"] == 3
    assert counts["linearGradient"] == 1
    assert counts["stop"] == 2
    assert res["document"] == {"width": "640", "height": "480", "view_box": "0 0 640 480"}
    # Nesting: svg(1) > g(2) > g(3) > g(4) > path/rect/circle(5)
    assert res["totals"]["max_depth"] == 5
    hist = {h["depth"]: h["count"] for h in res["depth_histogram"]}
    assert hist[5] == 3


def test_colors_inventory():
    res = analyze_svg_bytes(SAMPLE)
    colors = {c["color"]: c["count"] for c in res["colors"]}
    # Colors are counted per attribute/style as authored (no CSS cascade).
    assert colors["#ff0000"] == 2  # one stop + g fill attr
    assert colors["#00ff00"] == 1
    assert colors["#0000ff"] == 1  # stroke rgb on g
    assert colors["#aabbcc"] == 1  # inline style
    assert colors["rebeccapurple"] == 1  # named color kept as-is
    assert res["totals"]["distinct_colors"] >= 5


def test_embedded_images_flagged():
    res = analyze_svg_bytes(SAMPLE)
    kinds = [i["kind"] for i in res["embedded_images"]]
    assert "data:image/png" in kinds
    assert "external" in kinds
    assert "missing" in kinds
    assert res["totals"]["images"] == 3
    assert any("image" in f for f in res["flags"])


def test_file_analysis(tmp_path):
    svg = tmp_path / "probe.svg"
    svg.write_text(SAMPLE)
    res = analyze_svg_file(svg)
    assert res["ok"] is True
    assert res["file_size_bytes"] == len(SAMPLE.encode("utf-8"))


def test_malformed_raises():
    with pytest.raises(ValueError):
        analyze_svg_bytes("<svg><unclosed></svg>")
    with pytest.raises(ValueError):
        analyze_svg_bytes("not xml at all")
