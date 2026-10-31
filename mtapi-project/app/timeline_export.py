"""
Pure timeline export generators: CMX 3600 EDL and FCPXML 1.10.

Zero filesystem or subprocess I/O. Deterministic timecode and frame math.
Spec: docs/sequence-timeline-export-spec.md §3.
"""
from __future__ import annotations

from pathlib import Path
import xml.etree.ElementTree as ET


def duration_to_frames(duration_seconds: float, fps: float = 30.0) -> int:
    """Convert clip duration in seconds to integer frame count (>= 1 for positive durations)."""
    tc_fps = max(1, int(round(float(fps))))
    if duration_seconds <= 0:
        return 0
    return max(1, int(round(float(duration_seconds) * tc_fps)))


def frames_to_tc(total_frames: int, fps: float = 30.0) -> str:
    """Format integer frame count as HH:MM:SS:FF at nominal integer frame rate."""
    tc_fps = max(1, int(round(float(fps))))
    f = max(0, int(total_frames))
    ff = f % tc_fps
    total_seconds = f // tc_fps
    ss = total_seconds % 60
    mm = (total_seconds // 60) % 60
    hh = total_seconds // 3600
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def generate_edl(
    clips: list[tuple[str, float]],
    *,
    fps: float = 30.0,
    title: str = "Untitled",
    source_paths: list[str] | None = None,
) -> str:
    """Pure function: list[(filename_or_path, duration_seconds)] -> CMX 3600 EDL string."""
    clean_title = (title or "Untitled").strip().replace("\n", " ").replace("\r", " ")
    tc_fps = max(1, int(round(float(fps))))
    # Standard 1 hour timeline start
    rec_cursor_frames = 3600 * tc_fps

    lines: list[str] = [
        f"TITLE: {clean_title}",
        "FCM: NON DROP FRAME",
        "",
    ]

    for idx, item in enumerate(clips, start=1):
        filename_or_path, dur = item
        p = Path(filename_or_path)
        full_name = p.name
        # Reel name: stem without extension, spaces to underscores, clipped to 8 chars for classic CMX column
        reel = p.stem.replace(" ", "_")[:8]
        if not reel:
            reel = f"AX{idx:02d}"

        clip_frames = duration_to_frames(dur, fps=fps)
        src_in = frames_to_tc(0, fps=fps)
        src_out = frames_to_tc(clip_frames, fps=fps)
        rec_in = frames_to_tc(rec_cursor_frames, fps=fps)
        rec_out = frames_to_tc(rec_cursor_frames + clip_frames, fps=fps)
        rec_cursor_frames += clip_frames

        event_line = f"{idx:03d}  {reel:<8} V     C        {src_in} {src_out} {rec_in} {rec_out}"
        lines.append(event_line)
        lines.append(f"* FROM CLIP NAME: {full_name}")

        src_full = None
        if source_paths and idx - 1 < len(source_paths) and source_paths[idx - 1]:
            src_full = source_paths[idx - 1]
        elif "/" in filename_or_path or "\\" in filename_or_path:
            src_full = filename_or_path
        if src_full:
            lines.append(f"* SOURCE FILE: {src_full}")

    lines.append("")
    return "\n".join(lines)


def generate_fcpxml(
    clips: list[tuple[str, float]],
    *,
    fps: float = 30.0,
    title: str = "Untitled",
    source_paths: list[str] | None = None,
) -> str:
    """Pure function: list[(filename_or_path, duration_seconds)] -> FCPXML string."""
    clean_title = (title or "Untitled").strip()
    tc_fps = max(1, int(round(float(fps))))
    rec_cursor_frames = 3600 * tc_fps

    total_clip_frames = sum(duration_to_frames(dur, fps=fps) for _, dur in clips)
    seq_duration_tc = frames_to_tc(total_clip_frames, fps=fps)

    root = ET.Element("fcpxml", version="1.10.0")
    assets_el = ET.SubElement(root, "assets")

    sequence_el = ET.SubElement(
        root,
        "sequence",
        id="seq-1",
        tc=frames_to_tc(rec_cursor_frames, fps=fps),
        duration=seq_duration_tc,
        fps=str(fps if fps != int(fps) else int(fps)),
        name=clean_title,
    )
    spine_el = ET.SubElement(sequence_el, "spine")

    for idx, item in enumerate(clips, start=1):
        filename_or_path, dur = item
        p = Path(filename_or_path)
        full_name = p.name
        asset_id = f"asset-{idx}"

        clip_frames = duration_to_frames(dur, fps=fps)
        clip_dur_tc = frames_to_tc(clip_frames, fps=fps)
        src_in_tc = frames_to_tc(0, fps=fps)
        rec_offset_tc = frames_to_tc(rec_cursor_frames, fps=fps)
        rec_cursor_frames += clip_frames

        src_full = None
        if source_paths and idx - 1 < len(source_paths) and source_paths[idx - 1]:
            src_full = source_paths[idx - 1]
        elif "/" in filename_or_path or "\\" in filename_or_path:
            src_full = filename_or_path

        asset_attribs: dict[str, str] = {
            "id": asset_id,
            "name": full_name,
            "duration": clip_dur_tc,
            "frames": str(clip_frames),
            "tc": src_in_tc,
        }
        if src_full:
            asset_attribs["src"] = f"file://{src_full}" if not src_full.startswith("file://") else src_full

        ET.SubElement(assets_el, "asset", **asset_attribs)

        ET.SubElement(
            spine_el,
            "clip",
            ref=asset_id,
            name=full_name,
            offset=rec_offset_tc,
            duration=clip_dur_tc,
            **{"in": src_in_tc, "out": clip_dur_tc},
        )

    xml_bytes = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return xml_bytes.decode("utf-8")
