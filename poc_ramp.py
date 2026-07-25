#!/usr/bin/env python3
"""PoC: dead-simple speed ramp via frame remapping. No ffmpeg filter math."""
import math, os, shutil, subprocess, sys, tempfile

SRC = sys.argv[1]         # source video
DUR = float(sys.argv[2])  # target output duration (seconds)
FPS = int(sys.argv[3])    # output frame rate (24)
START = 4.0               # spin_down: start fast
END = 0.333               # spin_down: end slow

# Dump frames
tmp = tempfile.mkdtemp(prefix="poc_")
subprocess.run(["ffmpeg","-y","-v","error","-i",SRC,"-an","-vsync","0",
    "-start_number","0",f"{tmp}/src_%06d.png"], check=True)
pngs = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
total = len(pngs)
print(f"Dumped {total} frames")

# Frame map: for each output frame, which source frame?
out_frames = int(DUR * FPS)
C = total / (START + (END - START) / 2)
print(f"C={C:.4f}  out_frames={out_frames}")

os.makedirs(f"{tmp}/out", exist_ok=True)
mapping = []
for i in range(out_frames):
    t = i / out_frames
    raw = C * (START * t + (END - START) * t * t / 2)
    src = min(max(int(round(raw)), 0), total - 1)
    mapping.append(src)

# Show extremes
print(f"First 5: {mapping[:5]}  (gaps: {[mapping[j+1]-mapping[j] for j in range(4)]})")
print(f"Last 5:  {mapping[-5:]}  (gaps: {[mapping[-5+j+1]-mapping[-5+j] for j in range(4)]})")

# Copy frames
for out_n, src_n in enumerate(mapping):
    src_path = f"{tmp}/src_{src_n:06d}.png"
    out_path = f"{tmp}/out/out_{out_n:06d}.png"
    if not os.path.exists(out_path):
        shutil.copy2(src_path, out_path)

# Encode
out = f"/tmp/poc_ramp_{DUR:.0f}s_{FPS}fps.mp4"
subprocess.run(["ffmpeg","-y","-v","error","-framerate",str(FPS),
    "-i",f"{tmp}/out/out_%06d.png","-c:v","libx264","-preset","ultrafast",
    "-crf","18","-pix_fmt","yuv420p","-an",out], check=True)

dur = float(subprocess.run(["ffprobe","-v","error","-show_entries",
    "format=duration","-of","csv=p=0",out], capture_output=True, text=True).stdout.strip())
print(f"Output: {dur:.2f}s @ {FPS}fps → {out}")

shutil.rmtree(tmp)
