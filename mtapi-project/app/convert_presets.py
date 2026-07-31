"""
Convert / Export encode & dump preset registry.

Single source of truth for all §3 targets (codec presets + frame dumps).
Used by video_pipeline.encode, convert_ops orchestrator, and eventually
PipelineChain final encode. No other module should fork ffmpeg args for
ProRes/DNxHR/VP9/AV1/FFV1.

Keys match the spec's stable ids; values are EncodePreset / DumpPreset.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class EncodePreset:
    """Video encode recipe for one target codec/container."""
    id: str
    container: str                      # e.g. ".mp4", ".mov", ".webm", ".mkv"
    codec: str
    pix_fmt: str = "yuv420p"
    crf: int = 23
    crf_param: str = "-crf"             # x264/x265 use -crf; VP9 uses -b:v 0 -crf
    preset: str = "medium"              # x264/x265 preset
    audio_codec: str = "aac"
    audio_bitrate: str = "192k"
    even_floor: bool = True             # force even width/height for yuv420p
    extra: list[str] = field(default_factory=list)
    profile: int | None = None          # ProRes profile index
    profile_param: str = "-profile:v"   # e.g. prores_ks -profile:v
    container_ext: str = ""             # overridden ext if != container
    silence_mode: str = "silence"       # "silence" | "drop" | "none"
    label: str = ""
    blurb: str = ""
    group: str = ""                     # "intermediate" | "delivery" | "archive"


@dataclass
class DumpPreset:
    """Frame dump recipe for one image format."""
    id: str
    extension: str                      # "png" | "webp" | "jpg" | "tiff"
    pattern: str = "frame_%06d"
    quality_args: list[str] = field(default_factory=list)
    label: str = ""
    blurb: str = ""


# ── Encode presets ──────────────────────────────────────────────────────────
# All encode presets: §3.1–3.3 of resolve-transcode-spec.md

ENCODE_PRESETS: dict[str, EncodePreset] = {
    # ── Intermediates ───────────────────────────────────────────────────
    "prores_hq": EncodePreset(
        id="prores_hq",
        group="intermediate",
        label="ProRes 422 HQ (Apple intermediate · Resolve / FCP)",
        blurb="High-quality edit intermediate. 10-bit 4:2:2. Large files, very editable.",
        container=".mov", codec="prores_ks", profile=3,
        pix_fmt="yuv422p10le", audio_codec="pcm_s16le", audio_bitrate="",
        even_floor=False, crf=0, crf_param="", preset="",
    ),
    "prores_proxy": EncodePreset(
        id="prores_proxy",
        group="intermediate",
        label="ProRes Proxy (lightweight intermediate · offline edit)",
        blurb="Small/fast ProRes for rough cuts; not delivery.",
        container=".mov", codec="prores_ks", profile=0,
        pix_fmt="yuv422p10le", audio_codec="pcm_s16le", audio_bitrate="",
        even_floor=False, crf=0, crf_param="", preset="",
    ),
    "dnxhr_lb": EncodePreset(
        id="dnxhr_lb",
        group="intermediate",
        label="DNxHR LB (Avid / Resolve intermediate · low bandwidth)",
        blurb="Same family as Folder Watcher default. Smallest DNxHR; good for proxies.",
        container=".mov", codec="dnxhd", pix_fmt="yuv422p",
        audio_codec="pcm_s16le", audio_bitrate="",
        even_floor=False, crf=0, crf_param="", preset="",
        extra=["-profile:v", "dnxhr_lb"],
    ),
    "dnxhr_sq": EncodePreset(
        id="dnxhr_sq",
        group="intermediate",
        label="DNxHR SQ (Avid / Resolve intermediate · standard quality)",
        blurb="Balanced size vs quality for general Resolve work.",
        container=".mov", codec="dnxhd", pix_fmt="yuv422p",
        audio_codec="pcm_s16le", audio_bitrate="",
        even_floor=False, crf=0, crf_param="", preset="",
        extra=["-profile:v", "dnxhr_sq"],
    ),
    "dnxhr_hq": EncodePreset(
        id="dnxhr_hq",
        group="intermediate",
        label="DNxHR HQ (Avid / Resolve intermediate · high quality)",
        blurb="Heavier intermediate when LB/SQ look soft or you need more headroom.",
        container=".mov", codec="dnxhd", pix_fmt="yuv422p",
        audio_codec="pcm_s16le", audio_bitrate="",
        even_floor=False, crf=0, crf_param="", preset="",
        extra=["-profile:v", "dnxhr_hq"],
    ),

    # ── Delivery ────────────────────────────────────────────────────────
    "h264_avc": EncodePreset(
        id="h264_avc",
        group="delivery",
        label="H.264 / AVC · MP4 (universal playback)",
        blurb="Default \"it just plays everywhere\" export. YouTube-ish, phones, most browsers, Discord, etc.",
        container=".mp4", codec="libx264", crf=23, preset="medium",
        pix_fmt="yuv420p", audio_codec="aac", audio_bitrate="192k",
        extra=["-movflags", "+faststart"], even_floor=True,
    ),
    "h264_avc_hq": EncodePreset(
        id="h264_avc_hq",
        group="delivery",
        label="H.264 / AVC · MP4 high quality (near-master delivery)",
        blurb="Same universal codec, visually cleaner (CRF 18). Bigger files. Good for archival-ish masters.",
        container=".mp4", codec="libx264", crf=18, preset="slow",
        pix_fmt="yuv420p", audio_codec="aac", audio_bitrate="256k",
        extra=["-movflags", "+faststart"], even_floor=True,
    ),
    "h265_hevc": EncodePreset(
        id="h265_hevc",
        group="delivery",
        label="H.265 / HEVC · MP4 (efficient modern devices)",
        blurb="Half the bitrate of H.264 for similar look. Great for 4K phones/storage; slightly weaker browser support.",
        container=".mp4", codec="libx265", crf=26, preset="medium",
        pix_fmt="yuv420p", audio_codec="aac", audio_bitrate="192k",
        extra=["-tag:v", "hvc1"], even_floor=True,
    ),
    "h265_hevc_hq": EncodePreset(
        id="h265_hevc_hq",
        group="delivery",
        label="H.265 / HEVC · MP4 high quality",
        blurb="Cleaner HEVC (CRF 20). Still much smaller than ProRes/DNxHR.",
        container=".mp4", codec="libx265", crf=20, preset="medium",
        pix_fmt="yuv420p", audio_codec="aac", audio_bitrate="256k",
        extra=["-tag:v", "hvc1"], even_floor=True,
    ),
    "webm_vp9": EncodePreset(
        id="webm_vp9",
        group="delivery",
        label="VP9 · WebM (web / open formats)",
        blurb="Browser-friendly open stack. Good for web embeds; encode is slower than x264. Opus audio.",
        container=".webm", codec="libvpx-vp9", crf=30, preset="",
        pix_fmt="yuv420p", audio_codec="libopus", audio_bitrate="160k",
        extra=["-b:v", "0", "-row-mt", "1"], even_floor=True,
        crf_param="-crf",
    ),
    "av1_mp4": EncodePreset(
        id="av1_mp4",
        group="delivery",
        label="AV1 · MP4 (next-gen efficient delivery)",
        blurb="Newer than HEVC; excellent compression. Encode can be slow (SVT-AV1).",
        container=".mp4", codec="libsvtav1", crf=30, preset="6",
        pix_fmt="yuv420p", audio_codec="aac", audio_bitrate="192k",
        even_floor=True, crf_param="-crf",
    ),

    # ── Archive ─────────────────────────────────────────────────────────
    "ffv1_mkv": EncodePreset(
        id="ffv1_mkv",
        group="archive",
        label="FFV1 · MKV (lossless archive / mezzanine)",
        blurb="Bit-exact-ish lossless video archive. Huge. Good for storing between pipelines.",
        container=".mkv", codec="ffv1", pix_fmt="yuv420p",
        audio_codec="pcm_s16le", audio_bitrate="",
        even_floor=False, crf=0, crf_param="", preset="",
        extra=["-level", "3"],
    ),
}


# ── Dump presets (frames_*) ─────────────────────────────────────────────────

DUMP_PRESETS: dict[str, DumpPreset] = {
    "frames_png": DumpPreset(
        id="frames_png", extension="png",
        label="PNG image sequence · folder (lossless frames out · pipeline-native)",
        blurb="Canonical dump. Same format/pattern as video_pipeline.dump / filter stages.",
    ),
    "frames_webp": DumpPreset(
        id="frames_webp", extension="webp",
        quality_args=["-quality", "90"],
        label="WebP image sequence · folder (efficient stills out)",
        blurb="Smaller than PNG for human/export use. Not mid-chain for filters.",
    ),
    "frames_jpg": DumpPreset(
        id="frames_jpg", extension="jpg",
        quality_args=["-q:v", "2"],
        label="JPEG / JPG image sequence · folder (small stills out)",
        blurb="Smallest common dump. Lossy. Bad for multi-generation filter work.",
    ),
    "frames_tiff": DumpPreset(
        id="frames_tiff", extension="tiff",
        label="TIFF image sequence · folder (print / VFX style stills)",
        blurb="Low priority. Prefer PNG for pipeline compatibility.",
    ),
}


# ── Lookup helpers ──────────────────────────────────────────────────────────

def get_auto_name(stem: str, preset_id: str) -> str:
    """Auto-name suffix per preset id (e.g. '_h264_avc.mp4')."""
    suffix_map = {
        "prores_hq": "_prores_hq.mov",
        "prores_proxy": "_prores_proxy.mov",
        "dnxhr_lb": "_dnxhr_lb.mov",
        "dnxhr_sq": "_dnxhr_sq.mov",
        "dnxhr_hq": "_dnxhr_hq.mov",
        "h264_avc": "_h264_avc.mp4",
        "h264_avc_hq": "_h264_avc_hq.mp4",
        "h265_hevc": "_h265_hevc.mp4",
        "h265_hevc_hq": "_h265_hevc_hq.mp4",
        "webm_vp9": "_vp9.webm",
        "av1_mp4": "_av1.mp4",
        "ffv1_mkv": "_ffv1.mkv",
        "frames_png": "_frames_png",
        "frames_webp": "_frames_webp",
        "frames_jpg": "_frames_jpg",
        "frames_tiff": "_frames_tiff",
    }
    suffix = suffix_map.get(preset_id, f"_{preset_id}")
    return f"{stem}{suffix}"


def is_video_encode_target(target_id: str) -> bool:
    """True for encode presets (video codecs), false for frames_* dumps."""
    return target_id in ENCODE_PRESETS


def is_dump_target(target_id: str) -> bool:
    """True for frames_* targets."""
    return target_id in DUMP_PRESETS


def is_valid_target(target_id: str) -> bool:
    return target_id in ENCODE_PRESETS or target_id in DUMP_PRESETS


def get_target_group(target_id: str) -> str:
    """Return UI group label for a preset id."""
    ep = ENCODE_PRESETS.get(target_id)
    if ep:
        return ep.group
    return "frames"


# ── Video/image extensions ──────────────────────────────────────────────────

VIDEO_EXTS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi",
                        ".mpg", ".mpeg", ".wmv", ".flv", ".ts", ".m2ts"})

IMAGE_EXTS = frozenset({".png", ".webp", ".jpg", ".jpeg", ".tif", ".tiff"})

GIF_EXTS = frozenset({".gif"})

ALL_VIDEO_EXTS = VIDEO_EXTS | GIF_EXTS
