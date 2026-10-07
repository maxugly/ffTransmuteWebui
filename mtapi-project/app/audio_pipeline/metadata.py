"""Embedded metadata + header extraction (spec §18).

Two sources, because neither covers everything:

1. **ffprobe** — Vorbis comments (FLAC/OGG), ID3v2 (MP3), iTunes atoms
   (MP4/M4A), RIFF INFO (WAV), and whatever else libavformat knows. Fast
   (~50 ms), one subprocess, already a dependency of this app.
2. **Tracker headers** — XM / IT / S3M / MOD are *not* audio containers, so
   ffprobe reads nothing useful from them. These are parsed here directly from
   the header structs, which is also how "acidized" files are recognised: they
   carry tracker, author/credit and initial-BPM strings the audio path never
   sees.

Everything lands normalised *and* raw: the promoted fields exist so the catalog
can filter on them, while ``raw`` keeps every tag exactly as written so nothing
is lost and nothing is silently normalized away.
"""
from __future__ import annotations

import json
import os
import re
import struct
from pathlib import Path
from typing import Any

# ── tracker / "acidized" extensions we parse ourselves ────────────────────
TRACKER_EXTS = {".xm", ".it", ".mod", ".s3m", ".stm", ".mtm", ".itp", ".acid"}

# Canonical pitch-class spelling so a tag ("Abm") and a detection ("G# minor")
# can be compared rather than string-compared.
_FLAT_TO_SHARP = {
    "DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#", "CB": "B",
    "DJ": "D#", "EJ": "F#", "GJ": "A#", "AJ": "B#",
}
_SHARP_FLAT = {
    "C#": "DB", "D#": "EB", "F#": "GB", "G#": "AB", "A#": "BB", "B#": "CB",
}
# Semitone values, not scale degrees — B is 11, not 6.
_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Canonical keys are sharp-spelled, so this table is keyed sharp.
_CANONICAL_TO_CAMELOT = {
    "Ab minor": "1A", "D# minor": "2A", "Bb minor": "3A", "F minor": "4A",
    "C minor": "5A", "G minor": "6A", "D minor": "7A", "A minor": "8A",
    "E minor": "9A", "B minor": "10A", "F# minor": "11A", "C# minor": "12A",
    "B major": "1B", "F# major": "2B", "Db major": "3B", "Ab major": "4B",
    "Eb major": "5B", "Bb major": "6B", "F major": "7B", "C major": "8B",
    "G major": "9B", "D major": "10B", "A major": "11B", "E major": "12B",
}

_PC_TO_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def short_key(canonical: str | None) -> str | None:
    """Compact key for tight table columns: 'C major' → 'CM', 'G# minor' → 'G#m'.

    M/m and #/b exactly as the user asked — never a word, never a guess.
    """
    if not canonical:
        return None
    parts = str(canonical).strip().split(" ")
    if len(parts) < 2:
        return None
    tonic, mode = parts[0], parts[1].lower()
    if mode.startswith("maj"):
        return f"{tonic}M"
    if mode.startswith("min"):
        return f"{tonic}m"
    return None


def key_to_camelot(canonical: str | None) -> str | None:
    """Canonical key → Camelot number+letter (flats resolve to their sharp twin)."""
    if not canonical:
        return None
    key = str(canonical).strip()
    if key in _CANONICAL_TO_CAMELOT:
        return _CANONICAL_TO_CAMELOT[key]
    # Enharmonic twins, both spellings: 'Db major' → 'C# major' is in the
    # table, but 'G# minor' must first become its 'Ab minor' twin.
    tonic, _, mode = key.partition(" ")
    if mode and tonic:
        twin = _FLAT_TO_SHARP.get(tonic.upper()) or _SHARP_FLAT.get(tonic.upper())
        if twin:
            twin = twin[0] + twin[1:].lower()  # 'AB' → 'Ab', 'G#' stays 'G#'
            hit = _CANONICAL_TO_CAMELOT.get(f"{twin} {mode}")
            if hit:
                return hit
    return None


def flip_camelot(camelot: str | None) -> str | None:
    """Camelot complementary: same number, other letter — 8A ↔ 8B."""
    if not camelot:
        return None
    m = re.match(r"^\s*(\d{1,2})\s*([ABab])\s*$", str(camelot))
    if not m:
        return None
    other = "B" if m.group(2).upper() == "A" else "A"
    return f"{int(m.group(1))}{other}"


def relative_key(canonical: str | None) -> str | None:
    """The complementary (relative) key: C major ↔ A minor.

    A relative pair shares every pitch, so this is the number the user compares
    when the detector says one and the tag says the other.
    """
    pc = key_pitch_class(canonical)
    if pc is None or not canonical:
        return None
    is_minor = str(canonical).lower().endswith("minor")
    partner_pc = (pc + 3) % 12 if is_minor else (pc - 3) % 12
    return f"{_PC_TO_SHARP[partner_pc]} {'major' if is_minor else 'minor'}"



def normalize_key_tag(raw: str | None) -> str | None:
    """'Abm' / 'A minor' / 'CMAJ' → canonical 'G# minor' (sharps, long form)."""
    if not raw:
        return None
    text = str(raw).strip()
    if not text:
        return None
    # Camelot-ish or DJ shorthand: Abm / A#m / Cmin / C maj
    m = re.match(r"^([A-Ga-g])([#b♯♭]?)(m|min|major|maj)?$", text.replace(" ", ""))
    if not m:
        return None
    letter, accidental, mode = m.groups()
    accidental = accidental.replace("♯", "#").replace("♭", "b")
    tonic = letter.upper() + accidental
    mode_l = (mode or "").lower()
    is_minor = mode_l in ("m", "min", "minor")
    # Flat → sharp spelling so a DJ tag ("Abm") compares to a detection
    # ("G# minor") by pitch class rather than by string.
    if accidental == "b":
        sharp = _FLAT_TO_SHARP.get(tonic.upper())
        if sharp:
            tonic = sharp
    return f"{tonic} {'minor' if is_minor else 'major'}"


def key_pitch_class(canonical: str | None) -> int | None:
    """0-11 pitch class of a canonical key, for enharmonic-safe comparison."""
    if not canonical:
        return None
    tonic = canonical.split(" ")[0]
    tonic = _FLAT_TO_SHARP.get(tonic.upper(), tonic)
    base, acc = tonic[0], (tonic[1] if len(tonic) > 1 else "")
    if base not in _SEMITONES:
        return None
    value = _SEMITONES[base]
    if acc == "#":
        value += 1
    elif acc == "b":
        value -= 1
    return value % 12


def parse_camelot(raw: str | None) -> str | None:
    """'10a' / '1A' → '10A'. Camelot wheel is how DJs actually cross-reference."""
    if not raw:
        return None
    m = re.match(r"^\s*(\d{1,2})\s*([ABab])\s*$", str(raw))
    if not m:
        return None
    return f"{int(m.group(1))}{m.group(2).upper()}"


def parse_bpm(raw: Any) -> float | None:
    if raw is None:
        return None
    try:
        value = float(str(raw).strip().split()[0])
    except (TypeError, ValueError, IndexError):
        return None
    if not (20.0 <= value <= 400.0):
        return None
    return round(value, 2)


def _clean_c_string(data: bytes) -> str:
    text = data.split(b"\x00", 1)[0]
    for encoding in ("utf-8", "latin-1", "cp437"):
        try:
            return text.decode(encoding).strip()
        except UnicodeDecodeError:
            continue
    return text.decode("latin-1", "replace").strip()


# ── tracker headers ───────────────────────────────────────────────────────
def parse_tracker_header(path: Path) -> dict[str, Any]:
    """Read a tracker module's header. Returns {} when it isn't one."""
    ext = path.suffix.lower()
    if ext not in TRACKER_EXTS:
        return {}
    try:
        with open(path, "rb") as f:
            data = f.read(4096)
    except OSError:
        return {}
    if len(data) < 64:
        return {}

    out: dict[str, Any] = {"header_format": ext.lstrip("."), "acidized": False}
    try:
        if ext == ".xm":
            if not data.startswith(b"Extended Module: "):
                return {}
            name = _clean_c_string(data[17:37])
            tracker = _clean_c_string(data[39:59])
            # header size at 60, songlength 64, restart 66, channels 68,
            # patterns 70, instruments 72, flags 74, tempo 76, bpm 78
            bpm = struct.unpack_from("<H", data, 78)[0] if len(data) > 80 else 0
            out.update({
                "title": name, "tracker": tracker,
                "bpm": bpm if 20 <= bpm <= 400 else None,
                "channels": struct.unpack_from("<H", data, 68)[0] if len(data) > 70 else None,
                "patterns": struct.unpack_from("<H", data, 70)[0] if len(data) > 72 else None,
                "instruments": struct.unpack_from("<H", data, 72)[0] if len(data) > 74 else None,
            })
        elif ext == ".it":
            if not data.startswith(b"IMPM"):
                return {}
            name = _clean_c_string(data[4:30])
            # initialtempo at 0x30 (48) = initial BPM
            itempo = struct.unpack_from("<H", data, 0x30)[0] if len(data) > 0x32 else 0
            ispeed = struct.unpack_from("<H", data, 0x32)[0] if len(data) > 0x34 else 0
            out.update({
                "title": name,
                "bpm": itempo if 20 <= itempo <= 400 else None,
                "speed": ispeed or None,
                "patterns": struct.unpack_from("<H", data, 0x40)[0] if len(data) > 0x42 else None,
                "channels": struct.unpack_from("<H", data, 0x42)[0] if len(data) > 0x44 else None,
            })
        elif ext in (".s3m", ".stm"):
            if data[28:30] != b"\x1a\x1a":
                return {}
            title = _clean_c_string(data[0:28])
            tracker_id = struct.unpack_from("<H", data, 46)[0] if len(data) > 48 else 0
            out.update({"title": title, "tracker_id": tracker_id or None})
        elif ext in (".mod", ".mtm"):
            if data[1080:1084] not in (b"M.K.", b"M!K!", b"FLT4", b"FLT8", b"4CHN", b"6CHN",
                                       b"8CHN", b"CD81", b"OKTA", b"TDZ1"):
                return {}
            title = _clean_c_string(data[0:20])
            samples = []
            for i in range(31):
                off = 20 + i * 30
                if off + 22 <= len(data):
                    sname = _clean_c_string(data[off:off + 22])
                    if sname:
                        samples.append(sname)
            out.update({"title": title, "sample_names": samples})
        else:
            return {}
    except struct.error:
        return {}

    # Acidized detection: these modules carry extra credit text that plain
    # trackers lack, and DJ tools look for it.
    blob = data[:2048].lower()
    if b"acid" in blob or b"made with" in blob or b"created by" in blob:
        out["acidized"] = True
        credits = []
        for pattern in (rb"made with ([^\x00]{2,60})", rb"created by ([^\x00]{2,60})",
                        rb"(?:acidified|acidized)([^\x00]{0,40})"):
            for match in re.findall(pattern, blob):
                try:
                    credits.append(match.decode("latin-1").strip())
                except Exception:
                    continue
        if credits:
            out["credits"] = credits[:4]
    return out


# ── ffprobe path ──────────────────────────────────────────────────────────
_PROMOTE = {
    "title": ("title", "TIT2", "track"),
    "artist": ("artist", "TPE1", "album_artist", "performer"),
    "album": ("album", "TALB", "album"),
    "date": ("date", "TDRC", "year", "creation_time"),
    "genre": ("genre", "TCON"),
    "comment": ("comment", "COMM", "description"),
    "encoder": ("encoder", "encoded_by", "ENCODER"),
    "bpm": ("bpm", "TBPM", "BPM"),
    "key": ("key", "TKEY", "KEY", "initialkey", "initial_key"),
    "initial_key": ("initialkey", "initial_key", "TKEY"),
    "camelot": ("camelotkey", "camelot", "camelot_key"),
    "playlist_key": ("playlistkey", "playlist_key"),
    "grouping": ("grouping", "TIT1", "content_group"),
    "composer": ("composer", "TCOM"),
    "mood": ("mood", "TMOO"),
}


async def read_ffprobe_tags(path: str | Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """(normalised, raw) tags via ffprobe. Never raises."""
    from app.shell import run_command

    out: dict[str, Any] = {}
    raw: dict[str, Any] = {}
    argv = ["ffprobe", "-v", "error", "-show_entries",
            "format=duration,bit_rate:format_tags:stream=codec_type,codec_name,width,height,sample_rate,channels",
            "-of", "json", str(path)]
    try:
        code, stdout, _err = await run_command(argv)
        if code != 0 or not stdout.strip():
            return out, raw
        data = json.loads(stdout)
    except Exception:
        return out, raw

    fmt = data.get("format") or {}
    tags = fmt.get("tags") or {}
    if not tags:
        return out, raw
    lowered = {str(k).lower(): v for k, v in tags.items()}
    for target, candidates in _PROMOTE.items():
        for candidate in candidates:
            value = lowered.get(candidate.lower())
            if value not in (None, ""):
                raw.setdefault(target, value)
                break
    out["bpm"] = parse_bpm(raw.get("bpm"))
    out["key_canonical"] = normalize_key_tag(raw.get("key") or raw.get("initial_key"))
    out["initial_key_canonical"] = normalize_key_tag(raw.get("initial_key")) or out["key_canonical"]
    out["camelot"] = parse_camelot(raw.get("camelot"))
    out["raw"] = lowered
    try:
        out["bit_rate"] = int(fmt.get("bit_rate") or 0) or None
    except (TypeError, ValueError):
        out["bit_rate"] = None
    return out, raw


def build_tags(ffprobe_norm: dict[str, Any], ffprobe_raw: dict[str, Any],
               tracker: dict[str, Any] | None) -> dict[str, Any]:
    """Merge both sources. Tracker headers win on conflicts — they are what the
    author actually typed into the tracker, while container tags are often
    rewritten by later transcodes."""
    merged: dict[str, Any] = {}
    merged.update({k: v for k, v in ffprobe_raw.items() if k != "raw"})
    merged.update({k: v for k, v in (ffprobe_norm or {}).items() if k != "raw"})
    if tracker:
        for key, value in tracker.items():
            if value not in (None, [], {}):
                merged[key] = value
        if tracker.get("title") and not ffprobe_raw.get("title"):
            merged["title"] = tracker["title"]
        if tracker.get("bpm"):
            merged["tracker_bpm"] = tracker["bpm"]
    # Final normalisation after the merge so tracker values get it too.
    merged["bpm"] = parse_bpm(merged.get("bpm") or merged.get("tracker_bpm"))
    merged["key_canonical"] = normalize_key_tag(merged.get("key") or merged.get("initial_key"))
    merged["initial_key_canonical"] = normalize_key_tag(
        merged.get("initial_key") or merged.get("key"))
    merged["camelot"] = parse_camelot(merged.get("camelot"))
    if ffprobe_norm.get("raw"):
        merged.setdefault("raw_tags", ffprobe_norm["raw"])
    return merged


def compare_with_tags(tags: dict[str, Any] | None, detected: dict[str, Any]) -> dict[str, Any]:
    """How far the detection sits from the human/DJ annotation.

    Tempo is compared octave-aware because a 2× disagreement is the single most
    common detector failure and should read as "same pulse, different counting",
    not as "totally wrong".
    """
    tags = tags or {}
    out: dict[str, Any] = {}
    tag_bpm = tags.get("bpm")
    det_bpm = detected.get("tempo")
    if tag_bpm and det_bpm:
        delta = round(float(det_bpm) - float(tag_bpm), 2)
        out["tempo_vs_tag_bpm"] = delta
        ratio = float(det_bpm) / float(tag_bpm) if tag_bpm else 0.0
        # Octave equivalence: does *some* 2^k multiple of the detected tempo sit
        # on the tagged one? Tested directly rather than by iterative folding,
        # which mishandled ratios near 1.0.
        equivalent = any(
            abs(ratio / (2.0 ** k) - 1.0) <= 0.03 for k in (-2, -1, 0, 1, 2)
        )
        out["tempo_ratio"] = round(ratio, 4)
        out["tempo_octave_equivalent"] = equivalent
        # ~2% (or 1.5 BPM, whichever is looser) is agreement for a human tag.
        out["tempo_agrees_with_tag"] = abs(delta) <= max(1.5, 0.02 * float(tag_bpm))
    tag_key = tags.get("initial_key_canonical") or tags.get("key_canonical")
    det_key = detected.get("key")
    if tag_key and det_key:
        tag_pc = key_pitch_class(tag_key)
        det_pc = key_pitch_class(det_key)
        out["tag_key"] = tag_key
        out["detected_key"] = det_key
        out["key_pitch_class_delta"] = ((det_pc - tag_pc) % 12) if (
            tag_pc is not None and det_pc is not None) else None
        out["key_matches_tag"] = tag_pc is not None and det_pc is not None and tag_pc == det_pc
        # A relative key sits a minor third away (minor ↔ its relative major),
        # sharing the key signature. This is the classic detector confusion.
        if tag_pc is not None and det_pc is not None and not out["key_matches_tag"]:
            out["key_relative_of_tag"] = (det_pc - tag_pc) % 12 == 3
    return out