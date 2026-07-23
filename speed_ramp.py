#!/usr/bin/env python3
"""
Speed-ramp a video: start fast, slow down to normal speed by the end.

Usage:
    python speed_ramp.py input.mp4 [--out output.mp4] [--start-speed 4] [--sharpness 3]

The video plays at --start-speed × normal at the beginning and ramps down
to 1× by the end. Higher --sharpness makes the slowdown happen later and
more abruptly. The clip is shorter overall (fast sections take less time).

Audio is preserved using atempo + asetpts for speed-matched pitch correction.
Pure ffmpeg — no Python deps beyond stdlib.
"""

import argparse
import subprocess
import sys
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Speed-ramp a video (fast → normal)")
    parser.add_argument("input", type=Path, help="Input video file")
    parser.add_argument("--out", "-o", type=Path, help="Output path (default: <input>_speedramp.mp4)")
    parser.add_argument("--start-speed", type=float, default=4.0,
                        help="Speed multiplier at start (default: 4×)")
    parser.add_argument("--sharpness", type=float, default=3.0,
                        help="Curve sharpness: 1=linear, 3=cubic (default)")
    parser.add_argument("--end-speed", type=float, default=1.0,
                        help="Speed multiplier at end (default: 1× = normal)")
    args = parser.parse_args()

    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        print(f"ERROR: input not found: {input_path}")
        sys.exit(1)

    output_path = (args.out or input_path.parent / f"{input_path.stem}_speedramp.mp4").expanduser().resolve()

    # Probe video
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_format", "-show_streams", "-select_streams", "v:0",
         str(input_path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"ERROR probing video: {r.stderr.strip()}")
        sys.exit(1)

    info = json.loads(r.stdout)
    v_stream = info["streams"][0] if info.get("streams") else {}
    total_frames = int(v_stream.get("nb_frames", 0))
    fps_parts = v_stream.get("avg_frame_rate", "30/1").split("/")
    fps = float(fps_parts[0]) / float(fps_parts[1]) if len(fps_parts) == 2 else 30.0
    duration = float(info.get("format", {}).get("duration", 0))
    has_audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))

    if total_frames <= 0 and duration > 0:
        total_frames = int(duration * fps)

    print(f"input : {input_path}")
    print(f"output: {output_path}")
    print(f"video : {total_frames} frames  {fps:.2f} fps  {duration:.1f}s")
    print(f"speed : {args.start_speed}× → {args.end_speed}×  sharpness={args.sharpness}")
    print(f"audio : {'yes' if has_audio else 'no'}")

    # Build setpts expression.
    # At frame N out of TOTAL, position t = N / total_frames
    # speed(t) = end_speed + (start_speed - end_speed) * (1 - t)^sharpness
    # new PTS = original_PTS / speed(t)
    #
    # In ffmpeg filter syntax:
    #  N        = frame number
    #  TOTAL    = total_frames
    #  t        = N / TOTAL
    #  speed    = S1 + (S0 - S1) * (1 - t)^P
    #  setpts   = N / (FR * speed)
    s0 = args.start_speed
    s1 = args.end_speed
    p = args.sharpness
    tf = total_frames

    setpts = f"N/(FR*({s1}+({s0}-{s1})*exp({p}*log(1-N/{tf}))))"

    print("encoding…")

    if has_audio:
        # Video with setpts + audio with asetpts (same curve) and atempo correction.
        # atempo only takes fixed values so we use the midpoint speed as compromise.
        avg_speed = (s0 + s1) / 2
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(input_path),
            "-filter_complex",
            f"[0:v]setpts={setpts}[v];"
            f"[0:a]asetpts={setpts},atempo={1/avg_speed}[a]",
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            str(output_path),
        ]
    else:
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(input_path),
            "-filter:v", f"setpts={setpts}",
            "-an",
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            str(output_path),
        ]

    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        stderr = r.stderr.strip()
        print(f"ERROR: {stderr}")
        # retry video-only if audio filter combo failed
        if has_audio and "atempo" in stderr:
            print("retrying video-only…")
            cmd2 = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(input_path),
                "-filter:v", f"setpts={setpts}",
                "-an",
                "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
                str(output_path),
            ]
            r2 = subprocess.run(cmd2, capture_output=True, text=True)
            if r2.returncode != 0:
                print(f"ERROR: {r2.stderr.strip()}")
                sys.exit(1)
        else:
            sys.exit(1)

    print(f"done → {output_path}")


if __name__ == "__main__":
    main()
