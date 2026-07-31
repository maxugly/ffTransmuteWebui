#!/usr/bin/env python3
"""
speedramp_png.py — CLI for exponential speed ramp via frame remapping.

Uses the same curve + remap as mtapi filters.speedramp / POST /ops/speed_ramp.
Audio is dropped (-an).

Usage:
    python speedramp_png.py input.mp4 output.mp4 --direction spin_down --duration 5.0
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "mtapi-project"))
from app.probe import probe_duration_sync as _dur, probe_fps_sync as _fps  # noqa: E402
from app.probe import probe_frame_count_sync as _fc  # noqa: E402
from app.video_pipeline import dump_frames_sync, encode_frames_sync  # noqa: E402
from app.filters.speedramp import compute_curve, remap_frames  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="PNG-based speed ramp (filter-platform curve)")
    parser.add_argument("input", help="Source video")
    parser.add_argument("output", help="Output video (.mp4)")
    parser.add_argument("--direction", choices=["spin_up", "spin_down"], default="spin_down")
    parser.add_argument("--duration", type=float, default=5.0, help="Target output duration (s)")
    parser.add_argument(
        "--output-fps", type=float, default=0.0,
        help="Output frame rate (default: source fps)",
    )
    parser.add_argument("--start-speed", type=float, default=4.0)
    parser.add_argument("--end-speed", type=float, default=0.333)
    parser.add_argument("--keep-pngs", action="store_true")
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    input_fps_val = _fps(args.input)
    input_dur = _dur(args.input)
    out_fps = float(args.output_fps) if args.output_fps and args.output_fps > 0 else input_fps_val
    try:
        input_frames = _fc(args.input)
    except Exception:
        input_frames = int(input_dur * input_fps_val)

    print(f"Input: {args.input}")
    print(f"  {input_fps_val}fps, {input_dur:.2f}s, ~{input_frames} frames")

    curve = compute_curve(
        args.direction, args.duration,
        args.start_speed, args.end_speed,
        input_dur, out_fps,
    )
    print(
        f"Curve: {args.direction}, "
        f"{curve['effective_start_speed']:.4g}×→{curve['effective_end_speed']:.4g}×, "
        f"{args.duration}s @ {out_fps}fps"
    )
    print(f"  input needed: {curve['total_input_needed']:.2f}s / available {input_dur:.2f}s")
    print(f"  output frames: {curve['output_frames']}")
    if curve["end_speed_adjusted"]:
        print(f"  ⚠ short source; scale={curve['scale']:.4g}")

    if args.dry_run:
        print("Dry run — exiting.")
        return

    tmpdir = tempfile.mkdtemp(prefix="speedramp_")
    try:
        frames_in = os.path.join(tmpdir, "in")
        frames_out = os.path.join(tmpdir, "out")
        os.makedirs(frames_in)
        print(f"\nPhase 1: dump → {frames_in}/")
        dump_frames_sync(args.input, frames_in, frame_pattern="frame_%06d.png", start_number=0)
        n = len([f for f in os.listdir(frames_in) if f.endswith(".png")])
        print(f"  got {n} PNGs")

        print(f"Phase 2: remap {curve['output_frames']} frames")
        # Recompute with actual dump count clamp happens in run — remap after clamp
        max_i = n - 1 if n else 0
        source_frame = [min(s, max_i) for s in curve["source_frame"]]
        remap_frames(frames_in, frames_out, source_frame)
        out_count = len([f for f in os.listdir(frames_out) if f.endswith(".png")])
        print(f"  output: {out_count} PNGs")

        print(f"Phase 3: encode → {args.output}")
        encode_frames_sync(
            frames_out, args.output, out_fps,
            frame_pattern="frame_%06d.png", start_number=0, crf=args.crf,
        )
        out_dur = _dur(args.output)
        out_size = os.path.getsize(args.output) / 1024 / 1024
        print(f"  output: {out_dur:.2f}s, {out_size:.1f} MB")
        print(f"\nDone: {args.output}")
    finally:
        if not args.keep_pngs:
            shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            print(f"  kept PNGs at {tmpdir}")


if __name__ == "__main__":
    main()
