"""
Face-morph engine wrapper around ~/snc/cod/facemorph (bootstrapGuy layout).

Uses dlib 68-point landmarks + Delaunay triangulation (batch_morph_dir.py).
Runs with cwd=facemorph root so the relative landmark model path resolves.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

DEFAULT_FACEMORPH_ROOT = Path(
    os.environ.get("FACEMORPH_ROOT", "/home/m/snc/cod/facemorph")
).expanduser().resolve()

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}


def facemorph_root() -> Path:
    return DEFAULT_FACEMORPH_ROOT


def predictor_path(root: Path | None = None) -> Path:
    r = root or facemorph_root()
    return r / "code" / "utils" / "shape_predictor_68_face_landmarks.dat"


def ensure_facemorph_available() -> Path:
    root = facemorph_root()
    if not root.is_dir():
        raise FileNotFoundError(
            f"facemorph package not found at {root}. "
            "Expected ~/snc/cod/facemorph (see bootstrapGuy.txt)."
        )
    pred = predictor_path(root)
    if not pred.is_file():
        raise FileNotFoundError(
            f"Missing landmark model: {pred} "
            "(shape_predictor_68_face_landmarks.dat, ~96MB)."
        )
    try:
        import dlib  # noqa: F401
        import cv2  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            "facemorph needs dlib + opencv in the mtapi venv:\n"
            "  .venv/bin/python -m pip install 'dlib>=19.24' "
            "opencv-python-headless imutils scikit-image"
        ) from e
    return root


def get_image_files(image_dir: Path) -> list[str]:
    image_dir = Path(image_dir)
    files = []
    for p in sorted(image_dir.iterdir()):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            files.append(str(p.resolve()))
    return files


def _imread_bgr(path: str):
    """
    Load image as BGR for OpenCV morph pipeline.

    RGBA / transparent cutouts are composited onto mid-gray (not black) so
    HOG/YuNet and content-bbox face detection work better on withoutbg art.
    """
    import cv2
    import numpy as np

    # Prefer PIL so WebP + alpha are reliable across OpenCV builds
    try:
        from PIL import Image

        with Image.open(path) as im:
            if im.mode in ("RGBA", "LA") or (
                im.mode == "P" and "transparency" in im.info
            ):
                rgba = im.convert("RGBA")
                bg = Image.new("RGB", rgba.size, (200, 200, 200))
                bg.paste(rgba, mask=rgba.split()[-1])
                arr = np.asarray(bg)
                return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
            rgb = im.convert("RGB")
            arr = np.asarray(rgb)
            return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    except Exception:
        pass

    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if len(img.shape) == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        # BGRA → composite on mid-gray
        b, g, r, a = cv2.split(img)
        alpha = a.astype(np.float32) / 255.0
        bg = 200.0
        out = np.empty((*img.shape[:2], 3), dtype=np.float32)
        for i, ch in enumerate((b, g, r)):
            out[:, :, i] = ch.astype(np.float32) * alpha + bg * (1.0 - alpha)
        return out.astype(np.uint8)
    return img


def morph_image_list(
    image_files: list[str],
    output_path: Path,
    *,
    duration: float = 2.0,
    fps: int = 30,
    crf: int = 18,
    keep_frames: bool = False,
    progress_cb: Callable | None = None,
) -> dict[str, Any]:
    """
    Morph consecutive pairs in image_files → one video.
    Returns {ok, output_path, total_frames, pairs, skipped, error?}.
    """
    from .. import job_control

    root = ensure_facemorph_available()
    image_files = [str(Path(p).expanduser().resolve()) for p in image_files]
    if len(image_files) < 2:
        return {"ok": False, "error": f"Need at least 2 face images, got {len(image_files)}"}

    output_path = Path(output_path).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    frames_per_segment = max(2, int(float(duration) * int(fps)))
    frame_dir = Path(tempfile.mkdtemp(prefix="mtapi_facemorph_"))
    pairs_total = len(image_files) - 1

    if progress_cb:
        progress_cb(
            f"facemorph: {len(image_files)} images, {frames_per_segment} frames/pair @ {fps}fps",
            phase="facemorph",
            current=0,
            total=pairs_total,
            unit="pairs",
        )

    old_cwd = os.getcwd()
    code_dir = str(root / "code")
    root_s = str(root)
    for p in (root_s, code_dir):
        if p not in sys.path:
            sys.path.insert(0, p)

    try:
        os.chdir(root_s)  # so code/utils/shape_predictor_*.dat resolves

        import cv2
        from face_landmark_detection import generate_face_correspondences, NoFaceFound
        from delaunay_triangulation import make_delaunay
        import batch_morph_dir as bmd

        frame_offset = 0
        total_frames = 0
        pairs_done = 0
        skipped: list[str] = []

        for i in range(pairs_total):
            job_control.check_cancelled()
            path_a = image_files[i]
            path_b = image_files[i + 1]
            name_a = os.path.basename(path_a)
            name_b = os.path.basename(path_b)
            if progress_cb:
                progress_cb(
                    f"pair {i + 1}/{pairs_total}: {name_a} → {name_b}",
                    phase="facemorph",
                    current=i + 1,
                    total=pairs_total,
                    unit="pairs",
                )

            img_a = _imread_bgr(path_a)
            img_b = _imread_bgr(path_b)
            if img_a is None or img_b is None:
                skipped.append(
                    f"unreadable: {name_a if img_a is None else name_b} "
                    f"(try PNG/JPG; some WebP builds fail in OpenCV)"
                )
                continue

            try:
                size, img_a_crop, img_b_crop, pts_a, pts_b, corresp = \
                    generate_face_correspondences(img_a, img_b)
                if not pts_a or not pts_b or corresp is None:
                    raise NoFaceFound("empty landmark lists")
            except NoFaceFound as e:
                skipped.append(f"no face: {name_a} ↔ {name_b} ({e})")
                continue
            except Exception as e:
                # Old bug was corresp=None → "NoneType / int" when face miss
                msg = str(e)
                if "NoneType" in msg and "/" in msg:
                    skipped.append(
                        f"no face (landmark model failed): {name_a} ↔ {name_b}"
                    )
                else:
                    skipped.append(f"landmarks fail {name_a}↔{name_b}: {e}")
                continue

            tri = make_delaunay(size[1], size[0], corresp, img_a_crop, img_b_crop)
            skip_first = i > 0
            n = bmd.generate_morph_frames(
                img_a_crop, img_b_crop, pts_a, pts_b, tri, size,
                frames_per_segment, str(frame_dir), frame_offset, skip_first,
            )
            frame_offset += n
            total_frames += n
            pairs_done += 1

        if total_frames < 1:
            shutil.rmtree(frame_dir, ignore_errors=True)
            return {
                "ok": False,
                "error": "No morph frames produced. " + (
                    "; ".join(skipped) if skipped else "Check that faces are detectable."
                ),
                "skipped": skipped,
            }

        if progress_cb:
            progress_cb(
                f"encoding {total_frames} frames → {output_path.name}",
                phase="encode",
                current=pairs_done,
                total=pairs_total,
                unit="pairs",
            )

        crf_args = ["-crf", str(int(crf))]
        preset_args = ["-preset", "veryslow"] if int(crf) == 0 else ["-preset", "medium"]
        ffmpeg_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", str(int(fps)),
            "-i", str(frame_dir / "frame_%08d.png"),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            *crf_args,
            *preset_args,
            str(output_path),
        ]
        result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
        if result.returncode != 0 or not output_path.is_file():
            return {
                "ok": False,
                "error": (result.stderr or "").strip() or "ffmpeg encode failed",
                "frame_dir": str(frame_dir),
                "skipped": skipped,
            }

        out = {
            "ok": True,
            "output_path": str(output_path),
            "total_frames": total_frames,
            "pairs": pairs_done,
            "skipped": skipped,
            "frame_dir": str(frame_dir) if keep_frames else None,
        }
        if not keep_frames:
            shutil.rmtree(frame_dir, ignore_errors=True)
        if progress_cb:
            progress_cb(
                f"facemorph done → {output_path}",
                phase="done",
                current=pairs_done,
                total=pairs_total,
                unit="pairs",
            )
        return out
    finally:
        os.chdir(old_cwd)


def morph_directory(
    image_dir: str | Path,
    output_path: Path,
    **kwargs,
) -> dict[str, Any]:
    files = get_image_files(Path(image_dir).expanduser().resolve())
    return morph_image_list(files, output_path, **kwargs)
