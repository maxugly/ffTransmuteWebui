"""
Core DeepDream: dream_image + temporal helpers (optical flow, blend, transform).

Video / ouroboros bookends live in deepdream_ops (filters.deepdream + JobWorkspace).
"""
from __future__ import annotations

import shutil
import tempfile as _tf
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .models import (
    DEFAULT_MODEL,
    FRAME_TRANSFORMS,
    MIN_DREAM_SIDE,
    MODEL_MIN_SIDE,
    MODEL_PRESETS,
    MODEL_STEP_SCALE,
    _build_feature_extractor,
    _deprocess,
    _even_min,
    _maybe_preview_resize,
    _normalize_model_name,
    _preprocess,
    _require_tf,
)


# ── live preview helpers (UI Live: ON via job_control.latest_frame) ────────

def _live_preview_path() -> Path:
    """Stable per-job PNG overwritten during ascent for Live preview."""
    import re
    from ... import job_control

    tok = job_control.current_token() or "anon"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", str(tok))[:80] or "anon"
    d = Path("/tmp/mtapi_live")
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{safe}.png"


def _emit_progress(progress_cb, msg: str, **kw) -> None:
    """Push progress to callback and/or job_control (for Live when cb is None)."""
    from ... import job_control

    if progress_cb is not None:
        try:
            progress_cb(msg, **kw)
            return
        except TypeError:
            # Legacy: progress_cb(msg) only
            try:
                progress_cb(msg)
            except Exception:
                pass
            if kw.get("latest_frame"):
                try:
                    job_control.report_progress(msg, **kw)
                except Exception:
                    pass
            return
        except Exception:
            pass
    # No usable callback — still publish for Live preview
    try:
        job_control.report_progress(msg, **kw)
    except Exception:
        pass


def _publish_live_tensor(
    img,
    model_name: str,
    progress_cb,
    msg: str,
    *,
    evolve: "EvolveCapture | None" = None,
    evolve_kind: str = "mid",
    evolve_force: bool = False,
    rgb_override: np.ndarray | None = None,
    **kw,
) -> str | None:
    """Deprocess tensor → live PNG (+ optional evolve strip) and attach latest_frame."""
    try:
        if rgb_override is not None:
            out_arr = np.asarray(rgb_override)
            if out_arr.dtype != np.uint8:
                out_arr = np.clip(out_arr, 0, 255).astype(np.uint8)
        else:
            arr = img.numpy() if hasattr(img, "numpy") else np.asarray(img)
            out_arr = _deprocess(arr, model_name)
        live = _live_preview_path()
        Image.fromarray(out_arr).save(live, format="PNG", compress_level=1)
        path = str(live)
        if evolve is not None:
            evolve.add_rgb(out_arr, kind=evolve_kind, force=evolve_force)
        _emit_progress(progress_cb, msg, latest_frame=path, **kw)
        return path
    except Exception:
        _emit_progress(progress_cb, msg, **kw)
        return None


class EvolveCapture:
    """Ordered unique PNGs for DeepDream Evolve video."""

    def __init__(
        self,
        directory: str | Path,
        *,
        max_candidates: int = 500,
        capture_every: int = 0,
    ) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.max_candidates = max(2, int(max_candidates))
        self.capture_every = max(0, int(capture_every))
        self.paths: list[Path] = []
        self._ascent_pubs = 0

    def add_file(self, src: str | Path, *, kind: str = "mid", force: bool = False) -> Path | None:
        src_p = Path(src)
        if not src_p.is_file():
            return None
        with Image.open(src_p) as im:
            arr = np.asarray(im.convert("RGB"))
        return self.add_rgb(arr, kind=kind, force=force)

    def add_rgb(
        self,
        arr: np.ndarray,
        *,
        kind: str = "mid",
        force: bool = False,
    ) -> Path | None:
        if len(self.paths) >= self.max_candidates and not force:
            return None
        if not force and kind == "ascent" and self.capture_every > 0:
            self._ascent_pubs += 1
            if self._ascent_pubs != 1 and (self._ascent_pubs % self.capture_every) != 0:
                return None
        idx = len(self.paths)
        path = self.dir / f"frame_{idx:06d}.png"
        rgb = np.asarray(arr)
        if rgb.dtype != np.uint8:
            rgb = np.clip(rgb, 0, 255).astype(np.uint8)
        Image.fromarray(rgb).save(path, format="PNG", compress_level=1)
        self.paths.append(path)
        return path


# ── dream_image ────────────────────────────────────────────────────────────

def dream_image(
    input_path: Path,
    output_path: Path,
    *,
    model_name: str = DEFAULT_MODEL,
    layer_preset: str = "classic",
    layer_weights: dict[str, float] | None = None,
    step: float = 0.01,
    iterations: int = 20,
    num_octave: int = 3,
    octave_scale: float = 1.4,
    max_loss: float | None = 15.0,
    jitter: bool = True,
    reinject_detail: bool = True,
    blend: float = 1.0,
    guide_path: str | Path | None = None,
    preview_width: int | None = None,
    progress_cb=None,
    evolve_dir: str | Path | None = None,
    evolve_max_candidates: int = 500,
    evolve_capture_every: int = 0,
) -> Path:
    """Run DeepDream on a single image. Returns output_path.

    ``model_name``: inception_v3 | vgg16 | resnet50 (real different nets).
    ``guide_path`` enables guided dreaming (Google / DeepDreamAnim style).
    ``preview_width`` downscales wide inputs for faster iteration.

    During ascent, periodically writes ``/tmp/mtapi_live/{job_token}.png`` and
    reports ``latest_frame`` so the WebUI Live preview can show mid-dream frames.

    When ``evolve_dir`` is set, also appends unique candidate PNGs for Evolve video.
    """
    tf, keras = _require_tf()

    model_name = _normalize_model_name(model_name)
    min_side = MODEL_MIN_SIDE.get(model_name, MIN_DREAM_SIDE)

    input_path = Path(input_path)
    preview_tmp = None
    if preview_width and int(preview_width) > 0:
        work = Path(_tf.mkdtemp(prefix="mtapi_prev_"))
        preview_tmp = work
        input_path = _maybe_preview_resize(input_path, int(preview_width), work)
        if input_path.name.startswith("_preview_"):
            _emit_progress(progress_cb, f"preview width={preview_width}px")

    evolve: EvolveCapture | None = None
    if evolve_dir:
        evolve = EvolveCapture(
            evolve_dir,
            max_candidates=int(evolve_max_candidates) or 500,
            capture_every=int(evolve_capture_every) or 0,
        )
        evolve.add_file(input_path, kind="original", force=True)

    if layer_weights:
        layer_settings = {k: float(v) for k, v in layer_weights.items() if float(v) > 0}
    else:
        presets = MODEL_PRESETS.get(model_name) or MODEL_PRESETS[DEFAULT_MODEL]
        layer_settings = dict(presets.get(layer_preset) or presets.get("classic") or next(iter(presets.values())))
    if not layer_settings:
        layer_settings = dict(MODEL_PRESETS[DEFAULT_MODEL]["classic"])

    if max_loss is not None and max_loss <= 0:
        max_loss = None

    # Map UI "step" into this model's preprocessed tensor scale
    step_scale = float(MODEL_STEP_SCALE.get(model_name, 1.0))
    effective_lr = float(step) * step_scale

    _emit_progress(
        progress_cb,
        f"model={model_name} layers={list(layer_settings.keys())} "
        f"step={float(step):g}×{step_scale:g}→lr={effective_lr:g}",
        phase="model",
    )

    feature_extractor, _model = _build_feature_extractor(keras, model_name, layer_settings)

    guide_feats: dict[str, Any] | None = None
    if guide_path:
        gp = Path(guide_path).expanduser().resolve()
        if not gp.is_file():
            raise FileNotFoundError(f"Guide image not found: {gp}")
        _emit_progress(progress_cb, f"guided dream ← {gp.name}")
        g_img = _preprocess(tf, keras, gp, model_name)
        g_img = tf.image.resize(g_img, (224, 224))
        raw = feature_extractor(g_img)
        if isinstance(raw, dict):
            guide_feats = {k: tf.constant(v) for k, v in raw.items()}
        else:
            name = next(iter(layer_settings))
            guide_feats = {name: tf.constant(raw)}

    def compute_loss(input_image):
        features = feature_extractor(input_image)
        if not isinstance(features, dict):
            name = next(iter(layer_settings))
            features = {name: features}
        loss = tf.zeros(shape=())
        for name, activation in features.items():
            coeff = float(layer_settings.get(name, 1.0))
            if guide_feats is not None and name in guide_feats:
                y = guide_feats[name]
                y = tf.image.resize(y, tf.shape(activation)[1:3])
                ch = tf.shape(activation)[-1]
                x = tf.reshape(activation, [-1, ch])
                yf = tf.reshape(y, [-1, ch])
                x_n = tf.nn.l2_normalize(x, axis=-1)
                y_n = tf.nn.l2_normalize(yf, axis=-1)
                A = tf.matmul(x_n, y_n, transpose_b=True)
                idx = tf.argmax(A, axis=1)
                matched = tf.gather(yf, idx)
                loss = loss + coeff * tf.reduce_mean(x * matched)
            else:
                act_shape = tf.shape(activation)
                h, w = act_shape[1], act_shape[2]
                use_crop = tf.logical_and(h > 6, w > 6)
                crop = tf.cond(
                    use_crop,
                    lambda a=activation: a[:, 2:-2, 2:-2, :],
                    lambda a=activation: a,
                )
                scaling = tf.reduce_prod(tf.cast(tf.shape(crop), "float32"))
                scaling = tf.maximum(scaling, 1.0)
                loss = loss + coeff * tf.reduce_sum(tf.square(crop)) / scaling
        return loss

    def gradient_ascent_step(img, learning_rate):
        with tf.GradientTape() as tape:
            tape.watch(img)
            loss = compute_loss(img)
        grads = tape.gradient(loss, img)
        # Mean-abs normalize so step is comparable across images; then
        # model scale (Inception vs VGG) is applied via learning_rate.
        grads = grads / tf.maximum(tf.reduce_mean(tf.abs(grads)), 1e-6)
        img = img + learning_rate * grads
        return loss, img

    def gradient_ascent_loop(img, iterations, learning_rate, max_loss=None, *, octave_i=0, n_octaves=1):
        from ... import job_control
        h = int(img.shape[1]) if img.shape[1] is not None else MIN_DREAM_SIDE
        w = int(img.shape[2]) if img.shape[2] is not None else MIN_DREAM_SIDE
        max_jit = max(1, min(16, min(h, w) // 8))
        # Publish live every step when short; every 2–5 steps when long
        n_it = int(iterations)
        live_every = 1 if n_it <= 8 else (2 if n_it <= 20 else 5)
        # max_loss is an absolute ceiling on the *ascent objective*. Inception
        # classic losses are O(1)–O(20); VGG/ResNet mean-square activations are
        # often O(1e5)–O(1e6). If the first step's loss already exceeds max_loss,
        # the threshold is the wrong scale for this model — ignore it so we do
        # not early-stop after 1 step and return a near-copy of the input.
        effective_max = float(max_loss) if max_loss is not None else None
        baseline_loss: float | None = None
        for i in range(n_it):
            job_control.check_cancelled()
            ox = oy = 0
            if jitter:
                ox = int(np.random.randint(-max_jit, max_jit + 1))
                oy = int(np.random.randint(-max_jit, max_jit + 1))
                img = tf.roll(tf.roll(img, ox, 2), oy, 1)
            loss, img = gradient_ascent_step(img, learning_rate)
            if jitter and (ox or oy):
                img = tf.roll(tf.roll(img, -ox, 2), -oy, 1)
            loss_f = float(loss)
            if baseline_loss is None:
                baseline_loss = loss_f
                if effective_max is not None and baseline_loss >= effective_max:
                    _emit_progress(
                        progress_cb,
                        f"max_loss={effective_max:g} ignored "
                        f"(baseline loss {baseline_loss:.2f} already ≥ threshold; "
                        f"wrong scale for {model_name} — run full {n_it} steps)",
                        phase="ascent",
                        current=i + 1,
                        total=n_it,
                        unit="steps",
                    )
                    effective_max = None
            if effective_max is not None and loss_f > effective_max:
                _publish_live_tensor(
                    img, model_name, progress_cb,
                    f"ascent early-stop step {i + 1}/{n_it} loss={loss_f:.2f}",
                    evolve=evolve, evolve_kind="ascent",
                    phase="ascent", current=i + 1, total=n_it, unit="steps",
                )
                break
            if i == 0 or (i + 1) % live_every == 0 or i + 1 == n_it:
                _publish_live_tensor(
                    img, model_name, progress_cb,
                    f"ascent step {i + 1}/{n_it} loss={loss_f:.2f}"
                    + (f" (oct {octave_i + 1}/{n_octaves})" if n_octaves > 1 else ""),
                    evolve=evolve, evolve_kind="ascent",
                    phase="ascent", current=i + 1, total=n_it, unit="steps",
                )
        return img

    try:
        original_img = _preprocess(tf, keras, input_path, model_name)
        original_shape = tuple(int(x) for x in original_img.shape[1:3])

        work_h = _even_min(original_shape[0], min_side)
        work_w = _even_min(original_shape[1], min_side)
        work_shape = (work_h, work_w)
        if work_shape != original_shape:
            _emit_progress(
                progress_cb,
                f"upscaling {original_shape[1]}×{original_shape[0]} → "
                f"{work_w}×{work_h} for {model_name} (min side {min_side}px)",
            )
            work_img = tf.image.resize(original_img, work_shape, method="bilinear")
        else:
            work_img = original_img

        successive_shapes: list[tuple[int, int]] = [work_shape]
        n_oct = max(1, int(num_octave))
        scale = max(1.05, float(octave_scale))
        for i in range(1, n_oct):
            h = _even_min(int(work_h / (scale ** i)), min_side)
            w = _even_min(int(work_w / (scale ** i)), min_side)
            shape = (h, w)
            if shape == successive_shapes[-1]:
                break
            if shape not in successive_shapes:
                successive_shapes.append(shape)
        successive_shapes = successive_shapes[::-1]

        n_shapes = len(successive_shapes)
        _emit_progress(
            progress_cb,
            f"octaves: {' → '.join(f'{w}×{h}' for h, w in successive_shapes)}",
            phase="octaves",
            current=0,
            total=n_shapes,
            unit="octaves",
        )

        shrunk_original_img = tf.image.resize(work_img, successive_shapes[0])
        img = tf.identity(work_img)

        from ... import job_control
        for i, shape in enumerate(successive_shapes):
            job_control.check_cancelled()
            _emit_progress(
                progress_cb,
                f"octave {i + 1}/{n_shapes} shape={shape[1]}×{shape[0]}",
                phase="octave",
                current=i + 1,
                total=n_shapes,
                unit="octaves",
            )
            img = tf.image.resize(img, shape)
            img = gradient_ascent_loop(
                img,
                iterations=iterations,
                learning_rate=effective_lr,
                max_loss=max_loss,
                octave_i=i,
                n_octaves=n_shapes,
            )
            if reinject_detail:
                upscaled_shrunk = tf.image.resize(shrunk_original_img, shape)
                same_size_original = tf.image.resize(work_img, shape)
                lost_detail = same_size_original - upscaled_shrunk
                img = img + lost_detail
                shrunk_original_img = tf.image.resize(work_img, shape)
            # End-of-octave still (shows reinjected detail)
            _publish_live_tensor(
                img, model_name, progress_cb,
                f"octave {i + 1}/{n_shapes} done",
                evolve=evolve, evolve_kind="octave", evolve_force=True,
                phase="octave", current=i + 1, total=n_shapes, unit="octaves",
            )

        img = tf.image.resize(img, original_shape)
        out_arr = _deprocess(img.numpy(), model_name)

        blend = float(max(0.0, min(1.0, blend)))
        if blend < 1.0:
            base = Image.open(input_path).convert("RGB").resize(
                (out_arr.shape[1], out_arr.shape[0]), Image.Resampling.LANCZOS
            )
            base_np = np.asarray(base, dtype=np.float32)
            dream_np = out_arr.astype(np.float32)
            mixed = base_np * (1.0 - blend) + dream_np * blend
            out_arr = np.clip(mixed, 0, 255).astype(np.uint8)

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        keras.utils.save_img(str(output_path), out_arr)
        # Final still for Live + force into evolve strip
        _publish_live_tensor(
            None, model_name, progress_cb,
            f"saved {output_path.name}",
            evolve=evolve, evolve_kind="final", evolve_force=True,
            rgb_override=out_arr,
            phase="done", current=1, total=1, unit="images",
        )
        _emit_progress(
            progress_cb,
            f"saved {output_path.name}",
            phase="done",
            current=1,
            total=1,
            unit="images",
            latest_frame=str(output_path),
        )
        return output_path
    finally:
        if preview_tmp is not None:
            shutil.rmtree(preview_tmp, ignore_errors=True)


# ── temporal helpers ───────────────────────────────────────────────────────

def linear_blend(img1, img2, alpha: float):
    """Blend two HxWx3 arrays: (1-alpha)*img1 + alpha*img2."""
    a = float(max(0.0, min(1.0, alpha)))
    a1 = np.asarray(img1, dtype=np.float32)
    a2 = np.asarray(img2, dtype=np.float32)
    if a1.shape != a2.shape:
        im1 = Image.fromarray(np.clip(a1, 0, 255).astype(np.uint8)).resize(
            (a2.shape[1], a2.shape[0]), Image.Resampling.BILINEAR
        )
        a1 = np.asarray(im1, dtype=np.float32)
    out = a1 + a * (a2 - a1)
    return np.clip(out, 0, 255).astype(np.uint8)


def _optical_flow_seed(
    prev_src: np.ndarray,
    prev_dream: np.ndarray,
    curr_src: np.ndarray,
) -> np.ndarray:
    """Warp dream residual from prev→curr with Farneback optical flow."""
    import cv2

    prev_src = np.asarray(prev_src, dtype=np.float32)
    prev_dream = np.asarray(prev_dream, dtype=np.float32)
    curr_src = np.asarray(curr_src, dtype=np.float32)
    if prev_src.shape[:2] != curr_src.shape[:2]:
        prev_src = cv2.resize(prev_src, (curr_src.shape[1], curr_src.shape[0]))
        prev_dream = cv2.resize(prev_dream, (curr_src.shape[1], curr_src.shape[0]))

    h, w = curr_src.shape[:2]
    prev_g = cv2.cvtColor(np.clip(prev_src, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    curr_g = cv2.cvtColor(np.clip(curr_src, 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)

    flow = cv2.calcOpticalFlowFarneback(
        prev_g, curr_g,
        None,
        pyr_scale=0.5, levels=3, winsize=15,
        iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
    )
    flow = -flow
    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    map_x = flow[:, :, 0] + grid_x
    map_y = flow[:, :, 1] + grid_y

    halludiff = prev_dream - prev_src
    warped = cv2.remap(
        halludiff.astype(np.float32),
        map_x, map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT,
    )
    seed = curr_src + warped
    return np.clip(seed, 0, 255).astype(np.uint8)


def _cycle_layer_weights(base: dict[str, float], frame_idx: int, cycle: bool) -> dict[str, float]:
    if not cycle or not base:
        return base
    names = list(base.keys())
    if len(names) <= 1:
        return base
    pick = names[frame_idx % len(names)]
    return {pick: float(base[pick])}


def transform_frame(
    frame,
    *,
    mode: str = "zoom_rotate",
    zoom: float = 1.04,
    rotation_deg: float = 1.5,
    translate_x: float = 5.0,
    translate_y: float = 5.0,
    fps: float = 30.0,
):
    """Apply a geometric transform for Ouroboros feedback (PIL affine)."""
    import math

    mode = (mode or "none").lower().replace("-", "_")
    if mode not in FRAME_TRANSFORMS:
        mode = "none"
    if mode == "none":
        return frame

    arr = np.asarray(frame)
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError("transform_frame expects HxWx3 image")
    h, w = arr.shape[:2]
    ref_fps = 30.0
    fps = float(fps) if fps and fps > 0 else ref_fps
    rate = ref_fps / fps

    z = 1.0
    deg = 0.0
    tx = ty = 0.0
    if mode in ("zoom", "zoom_rotate"):
        z = 1.0 + (float(zoom) - 1.0) * rate
    if mode in ("rotate", "zoom_rotate"):
        deg = float(rotation_deg) * rate
    if mode == "translate":
        tx = float(translate_x) * rate
        ty = float(translate_y) * rate

    if arr.dtype != np.uint8:
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    else:
        im = Image.fromarray(arr)

    cx, cy = w / 2.0, h / 2.0
    ang = math.radians(deg)
    cos_a, sin_a = math.cos(ang), math.sin(ang)
    s = 1.0 / z if abs(z) > 1e-6 else 1.0
    a = cos_a * s
    b = sin_a * s
    d = -sin_a * s
    e = cos_a * s
    c = cx - a * cx - b * cy - tx
    f = cy - d * cx - e * cy - ty

    out = im.transform(
        (w, h),
        Image.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC,
        fillcolor=(0, 0, 0),
    )
    return np.asarray(out)
