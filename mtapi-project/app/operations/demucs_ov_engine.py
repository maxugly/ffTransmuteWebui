"""
Demucs stem-separation engine — OpenVINO Route C2 hybrid (GPU path for the Stems tab).

Port of the proven ``separate.py`` runtime from the testLamaEraser Demucs
project: the STFT / magnitude / mask / ISTFT stages stay on the host
(``torch`` + ``demucs`` — required at runtime), while OpenVINO runs only the
real-valued neural core::

    inputs:  audio_chunk [1, 2, L] + spec_chunk [1, C, 2048, T]
    outputs: time_stems_chunk [1, S, 2, L] + freq_stems_chunk [1, S, 4, 2048, T]

Per-chunk finishing (``_mask`` → ``_ispec`` → time+freq mix) runs on the host
exactly as ``HTDemucs.forward`` does after ``_mask``. Full-track assembly is
deterministic chunked inference + triangular weighted overlap-add with
Demucs global normalization (no epsilon — parity with the pinned reference;
near-zero-scale inputs short-circuit to silence stems via an explicit guard).

Artifacts resolve in this order:
  1. ``$DEMUCS_OV_DIR``
  2. ``mtapi-project/junk/models/demucs_ov/`` (installed via
     ``POST /ops/demucs_ov_setup``)
  3. The dev-machine build at ``/home/m/snc/cod/testLamaEraser/``

Device: ``GPU`` is strict — any GPU compile/infer failure raises (no silent
CPU fallback; the tab's Device dropdown must mean what it says). Pass
``allow_fallback=True`` only for diagnostics (setup probes).

Only ``openvino`` + ``torch`` + ``demucs`` + ``numpy`` are needed at runtime.
All three heavy imports are lazy so the server boots without them; missing
deps raise a loud actionable error at op time, never at import time.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

# ── Model catalog ─────────────────────────────────────────────────────────
# IR stems are the source .xml basenames; each needs its .bin sibling.
# Expected source labels come from the pinned demucs 4.1.0 checkpoints
# (verified: htdemucs=4, htdemucs_6s=6 incl. guitar/piano, htdemucs_ft=bag of 4).
MODEL_SPECS: dict[str, dict[str, Any]] = {
    "htdemucs": {
        "irs": ["htdemucs_c2.xml"],
        "sources": ["drums", "bass", "other", "vocals"],
        "label": "htdemucs · 4 stems",
    },
    "htdemucs_6s": {
        "irs": ["htdemucs_6s_c2.xml"],
        "sources": ["drums", "bass", "other", "vocals", "guitar", "piano"],
        "label": "htdemucs_6s · 6 stems (+guitar/piano)",
    },
    "htdemucs_ft": {
        "irs": [
            "htdemucs_ft_c2_m0.xml",
            "htdemucs_ft_c2_m1.xml",
            "htdemucs_ft_c2_m2.xml",
            "htdemucs_ft_c2_m3.xml",
        ],
        "sources": ["drums", "bass", "other", "vocals"],
        "label": "htdemucs_ft · 4 stems (4-model bag)",
    },
}

IR_FILE_NAMES: tuple[str, ...] = tuple(
    name
    for spec in MODEL_SPECS.values()
    for xml in spec["irs"]
    for name in (xml, Path(xml).with_suffix(".bin").name)
)

NEAR_ZERO_STD = 1e-8  # §8.4 guard threshold (distinct from the parity path)

_DEV_FALLBACK = Path("/home/m/snc/cod/testLamaEraser")

_lock = threading.Lock()
_compiled: dict[str, Any] = {}


def artifacts_candidates() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("DEMUCS_OV_DIR", "").strip()
    if env:
        out.append(Path(env).expanduser())
    out.append(
        Path(__file__).resolve().parent.parent.parent / "junk" / "models" / "demucs_ov"
    )
    out.append(_DEV_FALLBACK)
    return out


def _model_irs(model: str) -> list[str]:
    try:
        return list(MODEL_SPECS[model]["irs"])
    except KeyError:
        raise RuntimeError(
            f"Unknown Demucs model {model!r} (expected one of {sorted(MODEL_SPECS)})"
        )


def resolve_artifacts_dir(model: str = "htdemucs") -> Path | None:
    """First candidate dir holding ALL of this model's IRs, else None."""
    need = _model_irs(model)
    for d in artifacts_candidates():
        try:
            if all((d / name).is_file() for name in need):
                return d
        except OSError:
            continue
    return None


def ir_present(model: str | None = None) -> bool:
    if model is not None:
        return resolve_artifacts_dir(model) is not None
    return any(resolve_artifacts_dir(m) is not None for m in MODEL_SPECS)


def missing_ir_files(model: str) -> list[str]:
    d = resolve_artifacts_dir(model)
    need = _model_irs(model)
    if d is None:
        # Report against the install dir so the message tells the user
        # where files must land; fall back to first missing anywhere.
        for cand in artifacts_candidates():
            missing = [n for n in need if not (cand / n).is_file()]
            if missing:
                return missing
        return list(need)
    return [n for n in need if not (d / n).is_file()]


def available_devices() -> list[str]:
    try:
        import openvino as ov

        return [str(x) for x in ov.Core().available_devices]
    except Exception:
        return []


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def check_and_guard_cache(xml_path: Path, cache_dir: Path, device: str) -> dict:
    """Invalidate the compiled-model cache when IR / OV version / device changes.

    A shared manifest would thrash on per-member IR hashes, so ensemble
    members each get their own cache subdir (caller responsibility).
    """
    import openvino as ov

    bin_path = xml_path.with_suffix(".bin")
    guard = {
        "xml_hash": _sha256(xml_path) if xml_path.is_file() else "",
        "bin_hash": _sha256(bin_path) if bin_path.is_file() else "",
        "ov_version": ov.__version__,
        "device": device,
    }
    manifest = cache_dir / "cache_manifest.json"
    valid = False
    if manifest.is_file():
        try:
            valid = json.loads(manifest.read_text(encoding="utf-8")) == guard
        except Exception:
            valid = False
    if not valid:
        import shutil

        shutil.rmtree(cache_dir, ignore_errors=True)
        cache_dir.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(guard, indent=2), encoding="utf-8")
    return guard


def _compile_one(
    xml_path: Path, device: str, cache_dir: Path, *, allow_fallback: bool = False
) -> tuple[Any, str]:
    """Compile one IR. Strict: GPU failure raises, no silent CPU fallback."""
    import openvino as ov
    import openvino.properties as props
    import openvino.properties.hint as hint

    want = (device or "GPU").upper()
    if want.startswith("GPU"):
        want = "GPU"
    elif want != "CPU":
        want = "GPU"
    candidates = [want]
    if allow_fallback and want == "GPU":
        candidates.append("CPU")
    check_and_guard_cache(xml_path, cache_dir, want)

    core = ov.Core()
    config = {
        hint.inference_precision: ov.Type.f32,
        hint.performance_mode: hint.PerformanceMode.LATENCY,
        props.cache_dir: str(cache_dir),
    }
    last_err: Exception | None = None
    for cand in candidates:
        try:
            ov_model = core.read_model(str(xml_path))
            return core.compile_model(ov_model, cand, config), cand
        except Exception as e:  # noqa: BLE001 — try next candidate / raise below
            last_err = e
    raise RuntimeError(
        f"OpenVINO {want} compile failed for {xml_path.name} "
        f"(no CPU fallback — device under test): {last_err}"
    )


def _cache_base() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "junk" / "demucs_ov_cache"


def load_ensemble(
    model: str,
    device: str,
    *,
    allow_fallback: bool = False,
    cache_base: Path | None = None,
) -> tuple[list[Any], str, Path]:
    """Compile every IR of a model (1 for single, 4 for the ft bag).

    Returns (compiled_list, settled_device, artifacts_dir). Results are
    cached per (model, device); the ft bag gets one cache subdir per member.
    """
    key = f"{model}@{device.upper()}:{allow_fallback}"
    with _lock:
        hit = _compiled.get(key)
    if hit is not None:
        return hit[0], hit[1], hit[2]
    d = resolve_artifacts_dir(model)
    if d is None:
        raise RuntimeError(
            f"Demucs IRs for {model!r} not found — run GPU Setup "
            f"(POST /ops/demucs_ov_setup) or set $DEMUCS_OV_DIR. "
            f"Missing: {', '.join(missing_ir_files(model))}."
        )
    base = cache_base or _cache_base()
    compiled: list[Any] = []
    settled = device
    for xml_name in _model_irs(model):
        member_cache = base / model / Path(xml_name).stem
        cm, settled = _compile_one(
            d / xml_name, device, member_cache, allow_fallback=allow_fallback
        )
        compiled.append(cm)
    with _lock:
        _compiled[key] = (compiled, settled, d)
    return compiled, settled, d


def unload_all() -> None:
    with _lock:
        _compiled.clear()


# ── Reference checkpoints (host side) ─────────────────────────────────────
def get_reference_members(model_name: str = "htdemucs") -> list[Any]:
    """Native PyTorch member model(s) for host STFT/ISTFT + source labels."""
    try:
        import demucs.apply
        import demucs.pretrained
    except ImportError as e:
        raise RuntimeError(
            "Demucs separation needs the `demucs` + `torch` packages in the "
            f"mtapi venv (pip install demucs torch): {e}"
        )
    bag = demucs.pretrained.get_model(model_name)
    if isinstance(bag, demucs.apply.BagOfModels):
        members = list(bag.models)
    else:
        members = [bag]
    for m in members:
        m.eval()
    expected = MODEL_SPECS[model_name]["sources"]
    for m in members:
        if type(m).__name__ != "HTDemucs":
            raise RuntimeError(
                f"Unsupported model class {type(m).__name__}; HTDemucs members only."
            )
        if list(m.sources) != expected:
            raise RuntimeError(
                f"Checkpoint sources {list(m.sources)} disagree with the "
                f"{model_name} contract {expected}; refusing to relabel stems."
            )
    return members


def chunk_samples_of(pt_model: Any) -> int:
    L = int(int(pt_model.samplerate) * float(pt_model.segment))
    if L <= 0:
        raise RuntimeError(f"Invalid chunk length derived from checkpoint: {L}")
    return L


# ── Core separation (vendored Route C2 pipeline) ──────────────────────────
def separate_audio(
    input_wav: Any,  # torch.Tensor [2, N], stereo @ model samplerate
    pt_model: Any,
    compiled_list: list[Any],
    sources: list[str],
    *,
    overlap: float = 0.25,
    transition_power: float = 1.0,
    async_mode: bool = True,
    progress_cb: Callable[[int, int], None] | None = None,
    cancel_cb: Callable[[], None] | None = None,
    verbose: bool = False,
) -> Any:  # torch.Tensor [S, 2, N]
    """Deterministic chunked inference + triangular overlap-add.

    Mirrors the proven separate.py pipeline: global Demucs normalization
    (exact reference arithmetic, no epsilon), per-chunk host _spec/_magnitude
    → OV neural core → host _mask/_ispec → weighted accumulate → denormalize.
    Ensemble members are averaged pre-mask (native bag behavior).
    """
    import torch

    sample_rate = int(pt_model.samplerate)
    L = chunk_samples_of(pt_model)
    num_channels, total_samples = input_wav.shape
    if num_channels != 2:
        raise ValueError(f"Input audio must be stereo [2, N], got {tuple(input_wav.shape)}")
    if total_samples == 0:
        raise ValueError("Input audio is empty.")
    if not (0.0 <= overlap < 1.0):
        raise ValueError(f"overlap must satisfy 0 <= overlap < 1, got {overlap}")
    stride = int((1.0 - overlap) * L)
    if stride <= 0:
        raise ValueError(f"overlap {overlap} yields a non-positive stride for L={L}")

    # Global normalization (§8.4 — exact reference arithmetic, no epsilon)
    mono_ref = input_wav.mean(dim=0)
    track_mean = mono_ref.mean()
    track_std = mono_ref.std(correction=1)
    if float(track_std.item()) < NEAR_ZERO_STD:
        if verbose:
            print("[demucs] near-zero-scale guard: emitting silence stems.")
        return torch.zeros((len(sources), 2, total_samples), dtype=torch.float32)
    normalized_wav = (input_wav - track_mean) / track_std

    starts = list(range(0, total_samples, stride))
    num_chunks = len(starts)

    left = torch.arange(1, L // 2 + 1, dtype=torch.float32)
    right = torch.arange(L - L // 2, 0, -1, dtype=torch.float32)
    weight = torch.cat([left, right])
    weight = (weight / weight.max()) ** float(transition_power)

    num_sources = len(sources)
    accum = torch.zeros((num_sources, 2, total_samples), dtype=torch.float32)
    weight_sum = torch.zeros(total_samples, dtype=torch.float32)
    chunk_buffer = torch.zeros((1, 2, L), dtype=torch.float32)

    is_ensemble = len(compiled_list) > 1

    def _host_spec(chunk: Any) -> tuple[Any, Any]:
        with torch.no_grad():
            z = pt_model._spec(chunk)
            return z, pt_model._magnitude(z)

    def _host_finish(z: Any, t_chunk: Any, f_chunk: Any) -> Any:
        with torch.no_grad():
            mask = pt_model._mask(z, f_chunk)
            return t_chunk + pt_model._ispec(mask, length=L)

    def _accumulate(idx: int, start: int, valid: int, recon: Any) -> None:
        import torch as _t

        chunk_t = _t.from_numpy(recon) if not _t.is_tensor(recon) else recon
        dst = slice(start, start + valid)
        w_valid = weight[:valid]
        accum[:, :, dst] += chunk_t[0, :, :, :valid] * w_valid
        weight_sum[dst] += w_valid
        if progress_cb is not None:
            progress_cb(idx + 1, num_chunks)
        if cancel_cb is not None:
            cancel_cb()

    if async_mode and num_chunks > 1 and not is_ensemble:
        reqs = [compiled_list[0].create_infer_request() for _ in range(2)]
        buf = 0

        def _launch(idx: int, req: Any) -> tuple[Any, int]:
            start = starts[idx]
            valid = min(L, total_samples - start)
            chunk_buffer.zero_()
            chunk_buffer[0, :, :valid] = normalized_wav[:, start : start + valid]
            z, spec = _host_spec(chunk_buffer)
            req.start_async(
                {"audio_chunk": chunk_buffer.numpy(), "spec_chunk": spec.numpy()}
            )
            return z, valid

        z_curr, valid_curr = _launch(0, reqs[0])
        for idx in range(num_chunks):
            nxt = idx + 1
            if nxt < num_chunks:
                z_next, valid_next = _launch(nxt, reqs[1 - buf])
            cur = reqs[buf]
            cur.wait()
            import torch as _t

            t_c = _t.from_numpy(cur.get_tensor("time_stems_chunk").data)
            f_c = _t.from_numpy(cur.get_tensor("freq_stems_chunk").data)
            _accumulate(idx, starts[idx], valid_curr, _host_finish(z_curr, t_c, f_c))
            if nxt < num_chunks:
                buf = 1 - buf
                z_curr, valid_curr = z_next, valid_next
    else:
        reqs = [cm.create_infer_request() for cm in compiled_list]
        nmem = len(reqs)
        for idx, start in enumerate(starts):
            valid = min(L, total_samples - start)
            chunk_buffer.zero_()
            chunk_buffer[0, :, :valid] = normalized_wav[:, start : start + valid]
            z, spec = _host_spec(chunk_buffer)
            t_sum, f_sum = None, None
            for req in reqs:
                import torch as _t

                req.infer(
                    {"audio_chunk": chunk_buffer.numpy(), "spec_chunk": spec.numpy()}
                )
                t = _t.from_numpy(req.get_tensor("time_stems_chunk").data).clone()
                f = _t.from_numpy(req.get_tensor("freq_stems_chunk").data).clone()
                t_sum = t if t_sum is None else t_sum + t
                f_sum = f if f_sum is None else f_sum + f
            _accumulate(
                idx, start, valid, _host_finish(z, t_sum / nmem, f_sum / nmem)
            )

    if not bool(__import__("torch").isfinite(weight_sum).all()) or bool(
        (weight_sum <= 0).any()
    ):
        raise RuntimeError("Overlap-add coverage failure (non-positive weights).")
    return accum / weight_sum[None, None, :] * track_std + track_mean


# ── Audio I/O ─────────────────────────────────────────────────────────────
AUDIO_EXTS = {".wav", ".flac", ".ogg", ".oga", ".mp3", ".m4a", ".aac", ".opus", ".wma"}


def read_audio_file(path: str | Path, sample_rate: int) -> Any:  # torch.Tensor [2, N]
    """Decode + validate: planar float, finite, stereo (mono duplicated)."""
    import torch
    import demucs.api

    p = Path(path).expanduser()
    if not p.is_file():
        raise RuntimeError(f"Audio input not found: {p}")
    wav = demucs.api.AudioFile(p).read(streams=0, samplerate=sample_rate, channels=2)
    if not torch.isfinite(wav).all():
        raise ValueError("Input audio contains non-finite values (NaN/Inf).")
    if wav.shape[0] != 2 or wav.shape[1] == 0:
        raise ValueError(f"Decoded audio has unexpected shape {tuple(wav.shape)}.")
    return wav


async def extract_audio_from_video(video: str | Path, sample_rate: int) -> Path:
    """ffmpeg video → 44.1k stereo WAV temp file (argv list, never shell=True)."""
    import tempfile

    from ..shell import run_command

    tmp = Path(tempfile.mkdtemp(prefix="demucs_src_")) / "source_44k_stereo.wav"
    argv = [
        "ffmpeg", "-v", "error", "-y",
        "-i", str(video),
        "-vn", "-ac", "2", "-ar", str(sample_rate),
        "-f", "wav", str(tmp),
    ]
    rc, _out, err = await run_command(argv)
    if rc != 0 or not tmp.is_file() or tmp.stat().st_size == 0:
        raise RuntimeError(f"Audio extraction from {video} failed: {err.strip()[:300]}")
    return tmp


def write_stem_wav(stem: Any, target: Path, sample_rate: int) -> None:
    """Atomic float32 WAV write via temp file + os.replace."""
    import uuid as _uuid

    import demucs.api

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".tmp_{_uuid.uuid4().hex[:8]}_{target.name}")
    try:
        demucs.api.save_audio(
            stem, tmp, samplerate=sample_rate,
            clip="none", bits_per_sample=32, as_float=True,
        )
        if not tmp.exists() or tmp.stat().st_size == 0:
            raise RuntimeError(f"Temporary stem file is empty: {tmp}")
        os.replace(tmp, target)
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise


def smoke_chunk(
    model: str, device: str, *, allow_fallback: bool = True
) -> dict[str, Any]:
    """CPU/GPU probe: compile + one real single-chunk inference on noise.

    Returns {settled, chunk_samples, sources, finite}. Raises loudly —
    callers decide whether the probe is fatal (run path) or not (setup).
    """
    import torch

    t0 = time.perf_counter()
    compiled, settled, _ = load_ensemble(
        model, device, allow_fallback=allow_fallback
    )
    members = get_reference_members(model)
    pt_model = members[0]
    L = chunk_samples_of(pt_model)
    torch.manual_seed(7)
    wav = torch.randn(2, L, dtype=torch.float32)
    stems = separate_audio(
        wav, pt_model, compiled, list(MODEL_SPECS[model]["sources"]),
        async_mode=False,
    )
    dt = time.perf_counter() - t0
    if tuple(stems.shape) != (len(MODEL_SPECS[model]["sources"]), 2, L):
        raise RuntimeError(f"Smoke output has unexpected shape {tuple(stems.shape)}.")
    if not bool(torch.isfinite(stems).all()):
        raise RuntimeError("Smoke output contains NaN/Inf.")
    return {
        "settled": settled,
        "chunk_samples": L,
        "sources": list(MODEL_SPECS[model]["sources"]),
        "seconds": round(dt, 2),
    }
