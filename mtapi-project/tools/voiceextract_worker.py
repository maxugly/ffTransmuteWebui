#!/usr/bin/env python3
"""Voice Extract worker: diarize a long recording, then keep one speaker.

Runs under a dedicated interpreter (the audio venv, PyTorch 2.5.x), never
inside the web server. pyannote 3.x and SpeechBrain load their checkpoints
with torch.load(), and PyTorch 2.6+ flipped that default to weights_only=True,
which refuses them — so the only reliable fix is to keep the old torch in an
environment of its own instead of monkeypatching the server.

Protocol: progress lines are appended to --progress-file as JSON objects
({"pct": int, "msg": str}) so the server can poll while we work; the result is
a single JSON object printed on stdout.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional


class Progress:
    def __init__(self, path: Optional[Path]):
        self.path = path

    def __call__(self, msg: str, pct: Optional[int] = None) -> None:
        print(msg, file=sys.stderr, flush=True)
        if self.path is None:
            return
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"pct": pct, "msg": msg}) + "\n")
            handle.flush()


OPUS_RATES = (8000, 12000, 16000, 24000, 48000)


def pick_output_rate(source_rate: int) -> int:
    """Opus encoders only accept a handful of rates (libsndfile enforces this),
    so a 44.1 kHz episode has to be resampled before it can be written."""
    if source_rate in OPUS_RATES:
        return source_rate
    return 48000


def resample(audio, source_rate: int, target_rate: int):
    if source_rate == target_rate:
        return audio
    from fractions import Fraction

    from scipy.signal import resample_poly

    ratio = Fraction(target_rate, source_rate)
    out = resample_poly(audio, ratio.numerator, ratio.denominator, axis=0)
    return out.astype("float32", copy=False)


def load_models(hf_token: Optional[str], progress: Progress):
    progress("Loading pyannote diarization pipeline…", 2)
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=hf_token,
    )
    if pipeline is None:
        raise RuntimeError(
            "pyannote/speaker-diarization-3.1 needs gated access on Hugging Face: "
            "accept the model terms and set HF_TOKEN."
        )

    progress("Loading SpeechBrain ECAPA-TDNN embedder…", 8)
    from speechbrain.inference.speaker import EncoderClassifier

    embedder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=str(Path.home() / ".cache" / "speechbrain" / "spkrec-ecapa-voxceleb"),
    )
    return pipeline, embedder


def run(args: argparse.Namespace, progress: Progress) -> dict:
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
    audio_path = args.audio
    ref_path = args.ref
    if not Path(audio_path).exists():
        raise FileNotFoundError(f"Audio not found: {audio_path}")
    if not Path(ref_path).exists():
        raise FileNotFoundError(f"Ref clip not found: {ref_path}")

    out_dir = args.out_dir or str(Path(audio_path).parent / (Path(audio_path).stem + "_voiceparts"))
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    hf_token = args.hf_token or os.environ.get("HF_TOKEN")
    pipeline, embedder = load_models(hf_token, progress)

    # ── reference embedding ───────────────────────────────────────────────────
    progress("Computing reference speaker embedding…", 12)
    ref_data, ref_sr = sf.read(ref_path)
    if ref_data.ndim > 1:
        ref_data = ref_data.mean(axis=1)
    ref_t = torch.from_numpy(ref_data.astype("float32")).unsqueeze(0)
    if ref_sr != 16000:
        ref_t = torchaudio.functional.resample(ref_t, ref_sr, 16000)
    with torch.no_grad():
        ref_emb = embedder.encode_batch(ref_t).squeeze()
        ref_emb = ref_emb / torch.norm(ref_emb)

    # ── diarization ───────────────────────────────────────────────────────────
    progress("Running speaker diarization (this takes a few minutes)…", 15)
    started = time.monotonic()
    diars = pipeline(audio_path)
    n_speakers = len(set(label for _, _, label in diars.itertracks(yield_label=True)))
    progress(
        f"Diarization done — {n_speakers} speakers detected in {time.monotonic() - started:.0f}s.",
        45,
    )

    # ── per-speaker embeddings ────────────────────────────────────────────────
    progress("Computing per-speaker embeddings…", 47)
    orig_sr = sf.info(audio_path).samplerate
    full_data, _ = sf.read(audio_path)
    if full_data.ndim > 1:
        full_data_stereo = full_data
        full_mono = full_data.mean(axis=1)
    else:
        full_data_stereo = full_data[:, None]
        full_mono = full_data

    full_t = torch.from_numpy(full_mono.astype("float32")).unsqueeze(0)
    if orig_sr != 16000:
        full_16k = torchaudio.functional.resample(full_t, orig_sr, 16000).squeeze(0)
    else:
        full_16k = full_t.squeeze(0)

    label_embs: dict[str, list] = {}
    label_segs: dict[str, list] = {}

    all_turns = list(diars.itertracks(yield_label=True))
    for i, (turn, _, label) in enumerate(all_turns):
        s16 = int(turn.start * 16000)
        e16 = int(turn.end * 16000)
        chunk = full_16k[s16:e16]
        if chunk.shape[0] < 1600:  # < 0.1 s → skip
            continue
        with torch.no_grad():
            emb = embedder.encode_batch(chunk.unsqueeze(0)).squeeze()
            emb = emb / torch.norm(emb)
        label_embs.setdefault(label, []).append(emb)
        label_segs.setdefault(label, []).append((turn.start, turn.end))
        if i % 20 == 0:
            pct = 47 + int(33 * i / max(len(all_turns), 1))
            progress(f"Embedding segments {i}/{len(all_turns)}…", pct)

    centroids = {}
    for label, embs in label_embs.items():
        cent = torch.stack(embs).mean(dim=0)
        centroids[label] = cent / torch.norm(cent)

    sim_map = {label: torch.dot(ref_emb, cent).item() for label, cent in centroids.items()}
    if not sim_map:
        raise RuntimeError("No usable speech segments found in the reference or the audio.")
    selected = max(sim_map, key=sim_map.get)
    best_sim = sim_map[selected]
    progress(f"Selected speaker '{selected}' (sim={best_sim:.3f}). Extracting…", 82)

    if best_sim < args.threshold:
        raise ValueError(
            f"Best match similarity ({best_sim:.3f}) is below threshold "
            f"({args.threshold}). Try a cleaner or longer reference clip."
        )

    # ── extract and write ─────────────────────────────────────────────────────
    out_sr = pick_output_rate(orig_sr)
    if out_sr != orig_sr:
        progress(f"Re-encoding output at {out_sr} Hz (source is {orig_sr} Hz)…", 84)

    segments = []
    combined_chunks = []
    silence_samples = int(round(0.25 * out_sr))

    for idx, (s_sec, e_sec) in enumerate(label_segs[selected], 1):
        seg = full_data_stereo[int(round(s_sec * orig_sr)):min(int(round(e_sec * orig_sr)), len(full_data_stereo))]
        seg = resample(seg, orig_sr, out_sr)
        fname = f"part_{idx:04d}_{s_sec:07.2f}s-{e_sec:07.2f}s.opus"
        fpath = str(Path(out_dir) / fname)
        if seg.shape[1] == 1:
            sf.write(fpath, seg[:, 0], out_sr, format="OGG", subtype="OPUS")
        else:
            sf.write(fpath, seg, out_sr, format="OGG", subtype="OPUS")

        combined_chunks.append(seg)
        combined_chunks.append(np.zeros((silence_samples, seg.shape[1]), dtype=seg.dtype))
        segments.append({
            "index": idx,
            "filename": fname,
            "path": fpath,
            "start_s": round(s_sec, 3),
            "end_s": round(e_sec, 3),
            "duration_s": round(e_sec - s_sec, 3),
        })

    combined_path = None
    if combined_chunks:
        combined = np.concatenate(combined_chunks, axis=0)
        combined_path = str(Path(out_dir) / "combined.opus")
        if combined.shape[1] == 1:
            sf.write(combined_path, combined[:, 0], out_sr, format="OGG", subtype="OPUS")
        else:
            sf.write(combined_path, combined, out_sr, format="OGG", subtype="OPUS")

    total_dur = round(sum(seg["duration_s"] for seg in segments), 2)
    manifest_path = str(Path(out_dir) / "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump({
            "audio_path": audio_path,
            "ref_clip_path": ref_path,
            "selected_speaker": selected,
            "similarity": round(best_sim, 4),
            "all_similarities": {k: round(v, 4) for k, v in sim_map.items()},
            "source_sample_rate": orig_sr,
            "output_sample_rate": out_sr,
            "total_segments": len(segments),
            "total_duration_s": total_dur,
            "combined_path": combined_path,
            "segments": segments,
        }, handle, indent=2)

    progress(
        f"Done! {len(segments)} segments · {total_dur / 60:.1f} min total · "
        f"combined → {combined_path}",
        100,
    )
    return {
        "ok": True,
        "combined_path": combined_path,
        "manifest_path": manifest_path,
        "out_dir": out_dir,
        "total_segments": len(segments),
        "total_duration_s": total_dur,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument("--progress-file", default=None)
    args = parser.parse_args()

    progress = Progress(Path(args.progress_file) if args.progress_file else None)
    try:
        result = run(args, progress)
    except Exception as exc:  # surfaced to the UI as a plain job error
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
