#!/usr/bin/env python3
"""
speedramp_png.py — brute-force speed ramp via frame remapping.

Dumps video to PNGs, applies an exponential time-remap curve by
copying/duplicating/dropping frames, re-encodes from the mapped
sequence. No ffmpeg setpts expressions. No timestamp math. Just
file copies. Cannot fail.

Same pattern as deepdream_ops, facemorph_ops, styletransfer_ops.

Usage:
    python speedramp_png.py input.mp4 output.mp4 --direction spin_down --duration 5.0

The curve is exponential. For spin_down, speed starts at start_speed
(default 4×) and decays to end_speed (default ⅓×). For spin_up,
reversed. Audio is dropped for now (-an).
"""

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile

# Use consolidated ffprobe helpers (sync wrappers — this is a standalone CLI)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "mtapi-project"))
from app.probe import probe_duration_sync as _dur, probe_fps_sync as _fps
from app.probe import probe_frame_count_sync as _fc


# ── helpers ──────────────────────────────────────────────────────────────

def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Run a command, die on failure."""
    r = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if r.returncode != 0:
        print(f"FAILED: {' '.join(cmd)}", file=sys.stderr)
        print(r.stderr[:2000], file=sys.stderr)
        sys.exit(r.returncode)
    return r


# TODO: remove — use probe_duration_sync / probe_fps_sync / probe_frame_count_sync directly
def probe(path: str, key: str) -> str:
    """ffprobe a single value. key = 'stream=width,height' etc."""
    r = subprocess.run([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", f"stream={key}",
        "-of", "csv=p=0",
        path,
    ], capture_output=True, text=True)
    return r.stdout.strip()


# TODO: remove — use _dur / _fps / _fc directly
def duration(path: str) -> float:
    return _dur(path)


def fps(path: str) -> float:
    return _fps(path)


def frame_count(path: str) -> int:
    return _fc(path)


# ── curve math ──────────────────────────────────────────────────────────

def compute_curve(
    direction: str,
    duration: float,
    start_speed: float,
    end_speed: float,
    input_dur: float,
    input_fps: float,
) -> dict:
    """
    Compute an exponential time-remap curve.

    Returns a dict with:
      - output_frames: total output frames (= duration × input_fps)
      - source_frame[n]: which input frame (0-based) to use for output frame n
      - k, A: curve parameters (for logging)
    """
    S, E = start_speed, end_speed
    if direction == "spin_up":
        S, E = end_speed, start_speed  # start slow, end fast

    if direction == "spin_down":
        k = math.log(S / E) / duration
        A = S / k

        def curve_source_time(t_out: float) -> float:
            return A * (1 - math.exp(-k * t_out))
    else:
        k = math.log(E / S) / duration
        A = S / k

        def curve_source_time(t_out: float) -> float:
            return A * (math.exp(k * t_out) - 1)

    requested_input_needed = curve_source_time(duration)
    available_input = max(input_dur, 1.0 / input_fps)

    # A short source cannot realize the requested absolute speeds over the
    # requested output duration. Scale the whole curve so its shape and speed
    # ratio survive while its final point lands on the final source frame.
    adjusted = False
    scale = min(1.0, available_input / requested_input_needed)
    if scale < 1.0:
        adjusted = True
    effective_S = S * scale
    effective_E = E * scale
    total_input_needed = requested_input_needed * scale
    output_frames = int(duration * input_fps)

    source_frame = []
    for out_n in range(output_frames):
        # Include both endpoints so the final output frame maps to the final
        # source frame rather than leaving a one-frame tail unmapped.
        t_out = (out_n / max(output_frames - 1, 1)) * duration
        t_in = scale * curve_source_time(t_out)  # corresponding input time
        src_n = int(round(t_in * input_fps))

        # Clamp to available input frames
        max_frame = int(input_dur * input_fps) - 1
        src_n = min(src_n, max_frame)
        src_n = max(src_n, 0)

        source_frame.append(src_n)

    return {
        "output_frames": output_frames,
        "source_frame": source_frame,
        "k": k,
        "A": A,
        "total_input_needed": total_input_needed,
        "requested_input_needed": requested_input_needed,
        "requested_end_speed": end_speed,
        "effective_start_speed": effective_S,
        "effective_end_speed": effective_E,
        "scale": scale,
        "end_speed_adjusted": adjusted,
        "input_available": input_dur,
        "input_frames_available": int(input_dur * input_fps),
    }


# ── main ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="PNG-based speed ramp")
    parser.add_argument("input", help="Source video")
    parser.add_argument("output", help="Output video (.mp4)")
    parser.add_argument("--direction", choices=["spin_up", "spin_down"],
                        default="spin_down")
    parser.add_argument("--duration", type=float, default=5.0,
                        help="Target output duration in seconds")
    parser.add_argument("--output-fps", type=float, default=24.0,
                        help="Output frame rate (default: 24, lower = more dramatic effect)")
    parser.add_argument("--start-speed", type=float, default=4.0,
                        help="Speed at start (default: 4×)")
    parser.add_argument("--end-speed", type=float, default=0.333,
                        help="Speed at end (default: ⅓×)")
    parser.add_argument("--keep-pngs", action="store_true",
                        help="Don't delete the temp PNG directory")
    parser.add_argument("--crf", type=int, default=18,
                        help="H.264 quality (default: 18)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would happen, don't execute")
    args = parser.parse_args()

    # ── probe input ──────────────────────────────────────────────────

    input_fps_val = fps(args.input)
    input_dur = duration(args.input)
    input_width = probe(args.input, "width")
    input_height = probe(args.input, "height")
    input_frames = int(input_dur * input_fps_val)

    print(f"Input: {args.input}")
    print(f"  {input_width}×{input_height}, {input_fps_val}fps, "
          f"{input_dur:.2f}s, ~{input_frames} frames")

    # ── compute curve ────────────────────────────────────────────────

    curve = compute_curve(
        args.direction, args.duration,
        args.start_speed, args.end_speed,
        input_dur, args.output_fps,
    )

    effective_end = curve["effective_end_speed"]
    print(f"Curve: {args.direction}, {curve['effective_start_speed']}×→{effective_end:.6g}×, "
          f"{args.duration}s target, {args.output_fps}fps output")
    print(f"  k={curve['k']:.4f}, A={curve['A']:.4f}")
    print(f"  input needed: {curve['total_input_needed']:.2f}s, "
          f"available: {curve['input_available']:.2f}s")
    print(f"  output frames: {curve['output_frames']} "
          f"({curve['output_frames']/args.output_fps:.2f}s)")

    if curve["end_speed_adjusted"]:
        print(f"  ⚠ source is short; scaled the whole curve by "
              f"{curve['scale']:.6g} to preserve its shape and reach the final "
              f"source frame ({curve['effective_start_speed']:.6g}×→"
              f"{effective_end:.6g}× effective speeds)")

    if args.dry_run:
        print("Dry run — exiting.")
        return

    # ── phase 1: dump PNGs ───────────────────────────────────────────

    tmpdir = tempfile.mkdtemp(prefix="speedramp_")
    print(f"\nPhase 1: dumping {input_frames} frames → {tmpdir}/")

    run([
        "ffmpeg", "-y", "-v", "error",
        "-i", args.input,
        "-an",                          # no audio
        "-vsync", "0",                  # every frame, no dup/drop
        "-start_number", "0",
        f"{tmpdir}/src_%06d.png",
    ])

    # Verify PNG count
    pngs = sorted(f for f in os.listdir(tmpdir) if f.endswith(".png"))
    print(f"  got {len(pngs)} PNGs")

    # ── phase 2: remap frames ────────────────────────────────────────

    print(f"Phase 2: remapping {curve['output_frames']} output frames")

    outdir = os.path.join(tmpdir, "out")
    os.makedirs(outdir, exist_ok=True)

    # Pre-map: which unique source frames do we need?
    needed = sorted(set(curve["source_frame"]))
    num_unique = len(needed)

    # Build map: src_frame_number -> list of output frame numbers
    out_for_src: dict[int, list[int]] = {}
    for out_n, src_n in enumerate(curve["source_frame"]):
        out_for_src.setdefault(src_n, []).append(out_n)

    for i, src_n in enumerate(needed):
        src_path = os.path.join(tmpdir, f"src_{src_n:06d}.png")
        for out_n in out_for_src.get(src_n, []):
            out_path = os.path.join(outdir, f"out_{out_n:06d}.png")
            if os.path.exists(out_path):
                continue  # already placed (duplicate reference)
            shutil.copy2(src_path, out_path)
        if (i + 1) % 50 == 0 or i == num_unique - 1:
            print(f"  {i+1}/{num_unique} unique source frames placed")

    out_count = len([f for f in os.listdir(outdir) if f.endswith(".png")])
    dropped = input_frames - num_unique
    duplicated = curve["output_frames"] - num_unique
    print(f"  output: {out_count} PNGs ({num_unique} unique, "
          f"{dropped} dropped, {duplicated} duped)")

    # ── phase 3: re-encode ───────────────────────────────────────────

    print(f"Phase 3: encoding → {args.output}")

    run([
        "ffmpeg", "-y", "-v", "error",
        "-framerate", str(args.output_fps),
        "-i", f"{outdir}/out_%06d.png",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", str(args.crf),
        "-pix_fmt", "yuv420p",
        "-an",
        args.output,
    ])

    # Verify output
    out_dur = duration(args.output)
    out_size = os.path.getsize(args.output) / 1024 / 1024
    try:
        out_frames = frame_count(args.output)
    except ValueError:
        out_frames = int(out_dur * args.output_fps)
    print(f"  output: {out_dur:.2f}s, ~{out_frames} frames, "
          f"{out_size:.1f} MB")

    # ── cleanup ──────────────────────────────────────────────────────

    if not args.keep_pngs:
        shutil.rmtree(tmpdir)
        print(f"  cleaned up {tmpdir}")
    else:
        print(f"  kept PNGs at {tmpdir}")

    print(f"\nDone: {args.output}")


if __name__ == "__main__":
    main()
