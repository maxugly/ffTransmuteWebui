"""digicam_2000s core — pure early-2000s cheap-camera photo look.

Sole owner of the algorithm. No FastAPI, no job machinery; file I/O only
via ``process_image``. Ported from ``junk/customScripts/Digicam-2000s-Pro.py``
with the fix list from ``docs/coder-digicam-prompt.md``:

1. ``jpeg_passes`` table ``[60,50,42,34,28][:passes]`` (prototype sliced
   ``[50,32]`` so 3-5 silently did 2).
2. ``grain_type: luma_only`` forces chroma terms to 0 (prototype ignored it).
3. One ``np.random.Generator`` per frame drives grain + stuck pixels +
   focus jitter (no ``random`` module, no global ``np.random.seed``).
4. ``tint_strength`` exposed.
5. ``timestamp_color`` as hex text (``#FFE600``), parsed backend-side.
6. ``vertical_banding`` / ``flash_falloff`` / ``vignette_strength`` knobs.
7. Stage order: resolution -> blur -> color -> noise -> flash -> defects ->
   timestamp -> interlace -> compression.
8. Barrel distortion: cheap numpy radial remap (was dead/0 in prototype).

Pillow + numpy only.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageDraw, ImageFont

RES_PRESETS: dict[str, tuple[int, int]] = {
    "144p": (192, 144),
    "240p": (320, 240),
    "320p": (432, 320),
    "vga": (640, 480),
    "1mp": (1024, 768),
    "720p": (960, 720),
}

JPEG_PASS_TABLE = [60, 50, 42, 34, 28]


@dataclass
class DigicamParams:
    # 1. Resolution
    width: int = 640
    height: int = 480
    downscale_method: str = "LANCZOS"
    pixelate: int = 0
    # 2. Lens
    blur_type: str = "gaussian"
    blur_radius: float = 0.7
    focus_jitter: float = 0.0
    # 3. Color / CCD
    contrast: float = 0.65
    brightness: float = 1.12
    saturation: float = 0.8
    gamma: float = 1.0
    warm_r: int = 22
    warm_g: int = 12
    warm_b: int = -8
    tint_strength: float = 0.0
    # 4. Grain
    noise_enabled: bool = True
    noise_amount: float = 22.0
    chroma_r_amount: float = 10.0
    chroma_b_amount: float = 8.0
    grain_type: str = "gaussian"
    deterministic: bool = True
    noise_seed: int = 2003
    # 5. Flash
    flash_enabled: bool = True
    flash_strength: float = 95.0
    flash_x: float = 0.48
    flash_y: float = 0.32
    flash_radius: float = 1.4
    flash_falloff: float = 1.8
    shadow_strength: float = 42.0
    vignette_strength: float = 0.6
    # 6. CCD defects
    chroma_aberration: float = 0.0
    barrel_distortion: float = 0.0
    stuck_pixels: int = 0
    vertical_banding: float = 0.0
    # 7. JPEG
    jpeg_passes: int = 2
    final_quality: int = 38
    subsampling: int = 0
    # 8. Extras
    timestamp_enabled: bool = False
    timestamp_text: str = "2003/10/12 21:42"
    timestamp_pos: str = "bottom_left"
    timestamp_color: str = "#FFE600"
    interlace: bool = False
    scanline_strength: float = 0.15
    # not a knob: filled by from_dict when frontend sends preset
    preset: str = field(default="custom", repr=False)


def _get_resample(name: str):
    return {
        "LANCZOS": Image.LANCZOS,
        "BILINEAR": Image.BILINEAR,
        "NEAREST": Image.NEAREST,
        "BICUBIC": Image.BICUBIC,
    }.get(str(name or "LANCZOS").upper(), Image.LANCZOS)


def _to_bool(v) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    s = str(v).strip().lower()
    return s in ("1", "true", "yes", "on")


def _to_int(v, default: int) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _to_float(v, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def parse_hex_color(s: str) -> tuple[int, int, int]:
    """Parse '#FFE600' / 'FFE600' / 'FE0' -> (r,g,b). Never raises."""
    try:
        t = str(s or "").strip().lstrip("#")
        if len(t) == 3:
            t = "".join(c * 2 for c in t)
        if len(t) != 6:
            return (255, 230, 0)
        return (int(t[0:2], 16), int(t[2:4], 16), int(t[4:6], 16))
    except Exception:
        return (255, 230, 0)


def params_from_dict(data: dict) -> DigicamParams:
    """Coerce a frontend/JSON dict (string values OK) into DigicamParams.

    Handles ``preset`` autofill (non-custom presets overwrite w/h),
    hex ``timestamp_color``, and bool-as-"0"/"1" knobs. Unknown keys ignored.
    """
    d = dict(data or {})
    p = DigicamParams()
    preset = str(d.get("preset", "custom") or "custom").lower()
    if preset in RES_PRESETS:
        p.width, p.height = RES_PRESETS[preset]
    p.preset = preset
    if "width" in d:
        p.width = _to_int(d["width"], p.width)
    if "height" in d:
        p.height = _to_int(d["height"], p.height)
    # preset already applied; explicit w/h win when preset == custom too
    p.width = max(32, min(1280, int(p.width)))
    p.height = max(32, min(1024, int(p.height)))

    def s(key, default):
        v = d.get(key, default)
        return str(v) if v is not None else str(default)

    p.downscale_method = s("downscale_method", p.downscale_method).upper()
    p.pixelate = _to_int(d.get("pixelate", p.pixelate), p.pixelate)
    p.blur_type = s("blur_type", p.blur_type).lower()
    p.blur_radius = _to_float(d.get("blur_radius", p.blur_radius), p.blur_radius)
    p.focus_jitter = _to_float(d.get("focus_jitter", p.focus_jitter), p.focus_jitter)
    p.contrast = _to_float(d.get("contrast", p.contrast), p.contrast)
    p.brightness = _to_float(d.get("brightness", p.brightness), p.brightness)
    p.saturation = _to_float(d.get("saturation", p.saturation), p.saturation)
    p.gamma = _to_float(d.get("gamma", p.gamma), p.gamma)
    p.warm_r = _to_int(d.get("warm_r", p.warm_r), p.warm_r)
    p.warm_g = _to_int(d.get("warm_g", p.warm_g), p.warm_g)
    p.warm_b = _to_int(d.get("warm_b", p.warm_b), p.warm_b)
    p.tint_strength = _to_float(d.get("tint_strength", p.tint_strength), p.tint_strength)
    for k in ("noise_enabled", "flash_enabled", "deterministic",
              "timestamp_enabled", "interlace"):
        if k in d:
            setattr(p, k, _to_bool(d[k]))
    p.noise_amount = _to_float(d.get("noise_amount", p.noise_amount), p.noise_amount)
    p.chroma_r_amount = _to_float(d.get("chroma_r_amount", p.chroma_r_amount), p.chroma_r_amount)
    p.chroma_b_amount = _to_float(d.get("chroma_b_amount", p.chroma_b_amount), p.chroma_b_amount)
    p.grain_type = s("grain_type", p.grain_type).lower()
    p.noise_seed = _to_int(d.get("noise_seed", p.noise_seed), p.noise_seed)
    p.flash_strength = _to_float(d.get("flash_strength", p.flash_strength), p.flash_strength)
    p.flash_x = _to_float(d.get("flash_x", p.flash_x), p.flash_x)
    p.flash_y = _to_float(d.get("flash_y", p.flash_y), p.flash_y)
    p.flash_radius = _to_float(d.get("flash_radius", p.flash_radius), p.flash_radius)
    p.flash_falloff = _to_float(d.get("flash_falloff", p.flash_falloff), p.flash_falloff)
    p.shadow_strength = _to_float(d.get("shadow_strength", p.shadow_strength), p.shadow_strength)
    p.vignette_strength = _to_float(d.get("vignette_strength", p.vignette_strength), p.vignette_strength)
    p.chroma_aberration = _to_float(d.get("chroma_aberration", p.chroma_aberration), p.chroma_aberration)
    p.barrel_distortion = _to_float(d.get("barrel_distortion", p.barrel_distortion), p.barrel_distortion)
    p.stuck_pixels = _to_int(d.get("stuck_pixels", p.stuck_pixels), p.stuck_pixels)
    p.vertical_banding = _to_float(d.get("vertical_banding", p.vertical_banding), p.vertical_banding)
    p.jpeg_passes = max(1, min(5, _to_int(d.get("jpeg_passes", p.jpeg_passes), p.jpeg_passes)))
    p.final_quality = max(5, min(95, _to_int(d.get("final_quality", p.final_quality), p.final_quality)))
    p.subsampling = _to_int(d.get("subsampling", p.subsampling), p.subsampling)
    if p.subsampling not in (0, 1, 2):
        p.subsampling = 0
    if "timestamp_text" in d:
        p.timestamp_text = str(d["timestamp_text"])
    if "timestamp_pos" in d:
        v = str(d["timestamp_pos"])
        p.timestamp_pos = v if v in ("bottom_left", "bottom_right", "top_left") else "bottom_left"
    if "timestamp_color" in d:
        p.timestamp_color = str(d["timestamp_color"])
    p.scanline_strength = _to_float(d.get("scanline_strength", p.scanline_strength), p.scanline_strength)
    return p


def rng_for_frame(p: DigicamParams, index: int) -> Optional[np.random.Generator]:
    """One Generator per frame. Deterministic on -> seed+index; off -> fresh."""
    if p.deterministic:
        try:
            return np.random.default_rng(int(p.noise_seed) + int(index))
        except Exception:
            return np.random.default_rng(int(index))
    return np.random.default_rng()


# ── stages ────────────────────────────────────────────────────────────────

def apply_resolution(img: Image.Image, p: DigicamParams) -> Image.Image:
    method = _get_resample(p.downscale_method)
    if img.size != (p.width, p.height):
        img = img.resize((p.width, p.height), method)
    if p.pixelate and int(p.pixelate) > 1:
        k = int(p.pixelate)
        small = img.resize(
            (max(1, p.width // k), max(1, p.height // k)), Image.NEAREST
        )
        img = small.resize((p.width, p.height), Image.NEAREST)
    return img


def apply_blur(img: Image.Image, p: DigicamParams, rng=None) -> Image.Image:
    r = float(p.blur_radius)
    if p.focus_jitter:
        try:
            jitter = float(rng.uniform(0, float(p.focus_jitter))) if rng is not None else float(
                np.random.default_rng().uniform(0, float(p.focus_jitter)))
        except Exception:
            jitter = 0.0
        r = r + jitter
    if p.blur_type == "gaussian" and r > 0:
        return img.filter(ImageFilter.GaussianBlur(radius=r))
    if p.blur_type == "box" and r > 0:
        return img.filter(ImageFilter.BoxBlur(r))
    return img


def apply_color(img: Image.Image, p: DigicamParams) -> Image.Image:
    img = ImageEnhance.Contrast(img).enhance(p.contrast)
    img = ImageEnhance.Brightness(img).enhance(p.brightness)
    if p.gamma != 1.0:
        arr = np.array(img).astype(np.float32) / 255.0
        arr = np.power(np.clip(arr, 0, 1), p.gamma)
        arr = (arr * 255).clip(0, 255).astype(np.uint8)
        img = Image.fromarray(arr)
    r, g, b = img.split()
    r = r.point(lambda i: min(255, max(0, i + p.warm_r)))
    g = g.point(lambda i: min(255, max(0, i + p.warm_g)))
    b = b.point(lambda i: min(255, max(0, i + p.warm_b)))
    img = Image.merge("RGB", (r, g, b))
    if p.tint_strength:
        yellow = Image.new("RGB", img.size, (255, 240, 150))
        img = Image.blend(img, yellow, float(p.tint_strength) * 0.2)
    img = ImageEnhance.Color(img).enhance(p.saturation)
    return img


def apply_noise(img: Image.Image, p: DigicamParams, rng=None) -> Image.Image:
    if not p.noise_enabled or p.noise_amount <= 0:
        return img
    if rng is None:
        rng = np.random.default_rng()
    arr = np.array(img).astype(np.float32)
    h, w, _ = arr.shape
    if p.grain_type == "uniform":
        luma = (rng.random((h, w)) - 0.5) * p.noise_amount * 2
    else:
        luma = rng.normal(0, p.noise_amount, (h, w))
    if p.grain_type == "luma_only":
        chroma_r = 0
        chroma_b = 0
    else:
        chroma_r = rng.normal(0, p.chroma_r_amount, (h, w)) if p.chroma_r_amount else 0
        chroma_b = rng.normal(0, p.chroma_b_amount, (h, w)) if p.chroma_b_amount else 0
    arr[:, :, 0] += luma + chroma_r
    arr[:, :, 1] += luma * 0.9
    arr[:, :, 2] += luma + chroma_b
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def apply_flash(img: Image.Image, p: DigicamParams) -> Image.Image:
    if not p.flash_enabled:
        return img
    arr = np.array(img).astype(np.float32)
    h, w, _ = arr.shape
    Y, X = np.ogrid[:h, :w]
    cx = w * p.flash_x
    cy = h * p.flash_y
    dist = np.sqrt((X - cx) ** 2 + (Y - cy) ** 2)
    max_dist = max(1e-6, float(np.sqrt(cx ** 2 + cy ** 2) * p.flash_radius))
    flash_mask = 1 - np.clip(dist / max_dist, 0, 1)
    flash_mask = np.power(np.clip(flash_mask, 0, 1), p.flash_falloff)
    flash = flash_mask * p.flash_strength
    arr[:, :, 0] += flash
    arr[:, :, 1] += flash
    arr[:, :, 2] += flash
    vignette = np.clip(dist / max_dist, 0, 1) ** 0.9
    shadow = vignette * p.shadow_strength
    arr -= shadow[:, :, None] * p.vignette_strength
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def apply_barrel(img: Image.Image, k: float) -> Image.Image:
    """Cheap numpy radial remap. k=0 is identity. Small knob (0-0.5)."""
    if not k:
        return img
    arr = np.array(img)
    h, w, c = arr.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    dx = (xs - cx) / max(cx, 1.0)
    dy = (ys - cy) / max(cy, 1.0)
    r2 = dx * dx + dy * dy
    scale = 1.0 + float(k) * r2
    sx = np.clip(cx + (xs - cx) / scale, 0, w - 1)
    sy = np.clip(cy + (ys - cy) / scale, 0, h - 1)
    x0 = np.floor(sx).astype(np.int32)
    y0 = np.floor(sy).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = (sx - x0)[..., None]
    fy = (sy - y0)[..., None]
    top = arr[y0, x0] * (1 - fx) + arr[y0, x1] * fx
    bot = arr[y1, x0] * (1 - fx) + arr[y1, x1] * fx
    out = top * (1 - fy) + bot * fy
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def apply_ccd_defects(img: Image.Image, p: DigicamParams, rng=None) -> Image.Image:
    if p.chroma_aberration and p.chroma_aberration > 0:
        arr = np.array(img)
        shift = int(round(float(p.chroma_aberration)))
        if shift:
            arr[:, :, 0] = np.roll(arr[:, :, 0], shift, axis=1)
            arr[:, :, 2] = np.roll(arr[:, :, 2], -shift, axis=1)
            img = Image.fromarray(arr)
    if p.barrel_distortion and p.barrel_distortion > 0:
        img = apply_barrel(img, float(p.barrel_distortion))
    if p.stuck_pixels and int(p.stuck_pixels) > 0:
        if rng is None:
            rng = np.random.default_rng()
        arr = np.array(img)
        h, w = arr.shape[:2]
        n = int(p.stuck_pixels)
        ys = rng.integers(0, h, size=n)
        xs = rng.integers(0, w, size=n)
        picks = rng.random(n)
        for y, x, pick in zip(ys, xs, picks):
            arr[int(y), int(x)] = [255, 0, 0] if pick > 0.5 else [0, 255, 255]
        img = Image.fromarray(arr)
    if p.vertical_banding and p.vertical_banding > 0:
        arr = np.array(img).astype(np.float32)
        h, w, _ = arr.shape
        band = np.sin(np.linspace(0, w / 2, w)) * float(p.vertical_banding) * 10
        arr += band[None, :, None]
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return img


def apply_compression(img: Image.Image, p: DigicamParams) -> Image.Image:
    passes = max(1, min(5, int(p.jpeg_passes)))
    qualities = JPEG_PASS_TABLE[:passes]
    for q in qualities:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=int(q),
                 subsampling=int(p.subsampling), optimize=False)
        buf.seek(0)
        img = Image.open(buf)
        img.load()
    return img


def apply_timestamp(img: Image.Image, p: DigicamParams) -> Image.Image:
    if not p.timestamp_enabled:
        return img
    try:
        font_size = max(12, img.height // 32)
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()
        text = str(p.timestamp_text)
        if p.timestamp_pos == "bottom_left":
            xy = (8, img.height - font_size - 12)
        elif p.timestamp_pos == "bottom_right":
            xy = (max(8, img.width - len(text) * int(font_size * 0.6) - 8),
                  img.height - font_size - 12)
        else:
            xy = (8, 8)
        color = parse_hex_color(p.timestamp_color)
        draw = ImageDraw.Draw(img)
        x, y = xy
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx != 0 or dy != 0:
                    draw.text((x + dx, y + dy), text, fill=(0, 0, 0), font=font)
        draw.text(xy, text, fill=color, font=font)
    except Exception:
        pass
    return img


def apply_interlace(img: Image.Image, p: DigicamParams) -> Image.Image:
    if not p.interlace:
        return img
    arr = np.array(img).astype(np.float32)
    arr[1::2] *= (1 - float(p.scanline_strength))
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def process_pil(img: Image.Image, p: DigicamParams, seed: int | None = None) -> Image.Image:
    """Full stage chain on an in-memory image.

    ``seed`` selects the per-frame Generator (None = fresh entropy).
    """
    rng = np.random.default_rng(seed) if seed is not None else np.random.default_rng()
    img = img.convert("RGB")
    img = apply_resolution(img, p)
    img = apply_blur(img, p, rng)
    img = apply_color(img, p)
    img = apply_noise(img, p, rng)
    img = apply_flash(img, p)
    img = apply_ccd_defects(img, p, rng)
    img = apply_timestamp(img, p)
    img = apply_interlace(img, p)
    img = apply_compression(img, p)
    return img


def process_image(input_path: str | Path, output_path: str | Path,
                  params: DigicamParams, seed: int | None = None) -> str:
    """File entry: open -> process_pil -> final JPEG save at final_quality."""
    img = Image.open(input_path).convert("RGB")
    use_seed: int | None
    if seed is not None:
        use_seed = seed
    elif params.deterministic:
        use_seed = int(params.noise_seed)
    else:
        use_seed = None
    out = process_pil(img, params, seed=use_seed)
    op = Path(output_path)
    op.parent.mkdir(parents=True, exist_ok=True)
    out.save(str(op), format="JPEG", quality=int(params.final_quality),
             subsampling=int(params.subsampling), optimize=False)
    return str(op)
