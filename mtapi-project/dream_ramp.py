#!/usr/bin/env python3
"""
Ramped DeepDream — apply dream to a video with intensity increasing over time.

Usage:
    python dream_ramp.py /path/to/input.mp4 [--out output.mp4] [--step-max 0.03] [--model inception_v3]

The dream starts at zero and linearly ramps to full by the end of the clip.
Frames are extracted, dreamed individually, and re-encoded with original audio.

Requires the mtapi-project venv with TensorFlow installed.
Run from the mtapi-project directory or activate its venv first.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ── add mtapi-project to path so we can import the engine ──────────────
_HERE = Path(__file__).resolve().parent
_MTAPI = _HERE / "mtapi-project"
if str(_MTAPI) not in sys.path:
    sys.path.insert(0, str(_MTAPI))

from app.operations.deepdream_engine import dream_image, _probe_video


def ramp_value(t: float, start: float, end: float, curve: str = "linear") -> float:
    """Map t (0→1) to [start, end] with optional easing."""
    t = max(0.0, min(1.0, t))
    if curve == "ease-in":
        t = t * t
    elif curve == "ease-out":
        t = 1.0 - (1.0 - t) * (1.0 - t)
    elif curve == "ease-in-out":
        t = t * t * (3.0 - 2.0 * t)  # smoothstep
    return start + (end - start) * t


def main():
    parser = argparse.ArgumentParser(description="Ramped DeepDream video")
    parser.add_argument("input", type=Path, help="Input video file")
    parser.add_argument("--out", "-o", type=Path, help="Output path (default: <input>_dreamramp.mp4)")
    parser.add_argument("--model", default="inception_v3", choices=["inception_v3", "vgg16", "resnet50"])
    parser.add_argument("--layer-preset", default="classic", choices=["shallow", "mid", "deep", "classic", "full"])
    parser.add_argument("--step-min", type=float, default=0.0, help="Dream step at start (0 = no effect)")
    parser.add_argument("--step-max", type=float, default=0.03, help="Dream step at end")
    parser.add_argument("--iterations", type=int, default=20, help="Ascent iterations per frame")
    parser.add_argument("--octaves", type=int, default=3, help="Octave count")
    parser.add_argument("--octave-scale", type=float, default=1.4)
    parser.add_argument("--curve", default="ease-in-out", choices=["linear", "ease-in", "ease-out", "ease-in-out"])
    parser.add_argument("--frame-step", type=int, default=1, help="Process every Nth frame (1 = all)")
    parser.add_argument("--max-frames", type=int, default=0, help="Cap frames (0 = all)")
    parser.add_argument("--preview-width", type=int, default=0, help="Downscale for speed (0 = native)")
    args = parser.parse_args()

    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        print(f"ERROR: input not found: {input_path}")
        sys.exit(1)

    output_path = (args.out or input_path.parent / f"{input_path.stem}_dreamramp.mp4").expanduser().resolve()

    print(f"input : {input_path}")
    print(f"output: {output_path}")
    print(f"model : {args.model}  preset: {args.layer_preset}")
    print(f"step  : {args.step_min} → {args.step_max}  curve: {args.curve}")
    print(f"iters : {args.iterations}  octaves: {args.octaves}")

    # probe video
    meta = _probe_video(input_path)
    fps = meta.get("fps") or 25.0
    total_frames = meta.get("frames")
    print(f"video : {meta.get('width')}×{meta.get('height')}  {fps} fps  {total_frames or '?'} frames")

    # extract frames
    work = Path(tempfile.mkdtemp(prefix="dreamramp_"))
    frames_dir = work / "frames"
    dream_dir = work / "dream"
    frames_dir.mkdir()
    dream_dir.mkdir()

    print("extracting frames…")
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(input_path), "-vsync", "0", str(frames_dir / "f_%06d.png")],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"ERROR extracting frames: {r.stderr.strip()}")
        sys.exit(1)

    frames = sorted(frames_dir.glob("f_*.png"))
    if not frames:
        print("ERROR: no frames extracted")
        sys.exit(1)

    if args.max_frames > 0:
        frames = frames[:args.max_frames]

    n_frames = len(frames)
    print(f"dreaming {n_frames} frames (step every {args.frame_step})…")

    for idx, fr in enumerate(frames):
        out_fr = dream_dir / fr.name

        if args.frame_step > 1 and idx % args.frame_step != 0:
            # copy previous dream frame
            prev = sorted(dream_dir.glob("f_*.png"))
            src = prev[-1] if prev else fr
            shutil.copy2(src, out_fr)
            if idx % 10 == 0:
                print(f"  frame {idx + 1}/{n_frames} (copy)")
            continue

        # ramp the step value based on frame position
        t = idx / max(n_frames - 1, 1)
        current_step = ramp_value(t, args.step_min, args.step_max, args.curve)

        dream_image(
            fr,
            out_fr,
            model_name=args.model,
            layer_preset=args.layer_preset,
            step=current_step,
            iterations=args.iterations,
            num_octave=args.octaves,
            octave_scale=args.octave_scale,
            preview_width=args.preview_width if args.preview_width > 0 else None,
        )

        if idx % 5 == 0 or idx == n_frames - 1:
            pct = (idx + 1) / n_frames * 100
            print(f"  frame {idx + 1}/{n_frames} ({pct:.0f}%)  step={current_step:.4f}")

    # encode output
    print("encoding output video…")
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-framerate", str(fps),
         "-i", str(dream_dir / "f_%06d.png"),
         "-i", str(input_path),
         "-map", "0:v", "-map", "1:a?",
         "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
         "-c:a", "copy", "-shortest",
         str(output_path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"ERROR encoding: {r.stderr.strip()}")
        sys.exit(1)

    # cleanup
    shutil.rmtree(work)
    print(f"done → {output_path}")


if __name__ == "__main__":
    main()
