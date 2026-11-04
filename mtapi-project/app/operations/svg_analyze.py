"""Pure SVG structure analysis — convertico-style readout.

Counts every element type, computes nesting depth, collects colors used in
fill/stroke/stop-color/lighting-color/color attributes and inline styles,
and flags embedded images. Stdlib only (xml.etree); no external deps.

Route surface: app/routes/vectorize.py GET /vectorize/analyze?path=<svg>
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

_COLOR_ATTRS = ("fill", "stroke", "stop-color", "flood-color", "lighting-color", "color")
_IGNORE_COLORS = {
    "", "none", "inherit", "currentcolor", "transparent",
    "context-fill", "context-stroke", "url",
}
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3,8})$")
_RGB_RE = re.compile(
    r"^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})"
    r"\s*(?:[,/ ]\s*([\d.]+%?)\s*)?\)$"
)
_XLINK_HREF = "{http://www.w3.org/1999/xlink}href"

_MAX_COLORS = 300
_MAX_IMAGES = 100


def _expand_hex(hexdigits: str) -> str:
    """Normalize 3/4/6/8-digit hex to a stable 6-digit lowercase form."""
    h = hexdigits.lower()
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    # Drop alpha when it is part of the value (keep the color comparable).
    if len(h) == 8:
        h = h[:6]
    return f"#{h}"


def _parse_color(value: str) -> str | None:
    v = (value or "").strip().lower()
    if not v or v in _IGNORE_COLORS:
        return None
    if v.startswith("#"):
        m = _HEX_RE.match(v)
        if m:
            return _expand_hex(m.group(1))
        return None
    if v.startswith("rgb"):
        m = _RGB_RE.match(v)
        if not m:
            return None
        r, g, b = (int(x) for x in m.group(1, 2, 3))
        if r > 255 or g > 255 or b > 255:
            return None
        return f"#{r:02x}{g:02x}{b:02x}"
    if v.startswith(("url(", "data:", "var(")):
        return None
    # Named color (e.g. "red", "steelblue") — keep as-is; frontend renders it.
    if re.fullmatch(r"[a-z]+", v):
        return v
    return None


def _style_colors(style: str) -> list[str]:
    out: list[str] = []
    if not style:
        return out
    for part in style.split(";"):
        if ":" not in part:
            continue
        key, _, value = part.partition(":")
        if key.strip().lower() in _COLOR_ATTRS:
            parsed = _parse_color(value)
            if parsed:
                out.append(parsed)
    return out


def _element_href(el: ET.Element) -> str | None:
    href = el.get("href")
    if href is None:
        href = el.get(_XLINK_HREF)
    return href


def _analyze_tree(root: ET.Element, file_size: int) -> dict:
    element_counts: Counter[str] = Counter()
    color_counts: Counter[str] = Counter()
    color_source_counts: Counter[str] = Counter()
    images: list[dict] = []
    max_depth = 0
    depth_histogram: Counter[int] = Counter()

    def walk(el: ET.Element, depth: int) -> None:
        nonlocal max_depth
        max_depth = max(max_depth, depth)
        depth_histogram[depth] += 1
        tag = el.tag.rsplit("}", 1)[-1]
        element_counts[tag] += 1

        if tag == "image":
            href = _element_href(el)
            if href is None:
                kind = "missing"
                preview = None
            elif href.startswith("data:"):
                kind = "data:" + href[5:].split(";")[0]
                preview = href[:80]
            else:
                kind = "external"
                preview = href[:120]
            images.append({"kind": kind, "href_preview": preview})

        for attr in _COLOR_ATTRS:
            parsed = _parse_color(el.get(attr) or "")
            if parsed:
                color_counts[parsed] += 1
                color_source_counts[attr] += 1
        for parsed in _style_colors(el.get("style") or ""):
            color_counts[parsed] += 1
            color_source_counts["style"] += 1

        for child in el:
            walk(child, depth + 1)

    walk(root, 1)

    total = sum(element_counts.values())
    if total == 0:
        total = 1  # a single self-closing root still counts as one element

    top_colors = [
        {"color": c, "count": n}
        for c, n in color_counts.most_common(_MAX_COLORS)
    ]
    top_elements = [
        {"tag": t, "count": n}
        for t, n in element_counts.most_common()
    ]

    flags: list[str] = []
    if images:
        flags.append(
            f"{len(images)} embedded image(s)" if any(
                i["kind"].startswith("data:") for i in images
            ) else f"{len(images)} referenced image(s)"
        )

    return {
        "ok": True,
        "file_size_bytes": file_size,
        "document": {
            "width": root.get("width"),
            "height": root.get("height"),
            "view_box": root.get("viewBox") or root.get("viewbox"),
        },
        "totals": {
            "elements": total,
            "max_depth": max_depth,
            "distinct_tags": len(element_counts),
            "groups": element_counts.get("g", 0),
            "paths": element_counts.get("path", 0),
            "shapes": sum(
                element_counts.get(t, 0)
                for t in ("rect", "circle", "ellipse", "line", "polyline", "polygon")
            ),
            "text_elements": sum(
                element_counts.get(t, 0)
                for t in ("text", "tspan", "textPath")
            ),
            "gradients": sum(
                element_counts.get(t, 0)
                for t in ("linearGradient", "radialGradient")
            ),
            "images": len(images),
            "distinct_colors": len(color_counts),
        },
        "element_counts": top_elements,
        "depth_histogram": [
            {"depth": d, "count": n}
            for d, n in sorted(depth_histogram.items())
        ],
        "colors": top_colors,
        "color_sources": dict(color_source_counts),
        "embedded_images": images[:_MAX_IMAGES],
        "flags": flags,
    }


def analyze_svg_bytes(data: bytes | str) -> dict:
    """Analyze SVG XML held in memory. Raises ValueError on malformed XML."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise ValueError(f"not valid SVG/XML: {e}") from e
    return _analyze_tree(root, len(data))


def analyze_svg_file(path: str | Path) -> dict:
    """Analyze an SVG file on disk (absolute path)."""
    p = Path(path)
    data = p.read_bytes()
    return analyze_svg_bytes(data)
