"""
Music tab backend: ACE-Step text-to-music on the Intel iGPU via HETERO.

Provenance: single-step torch-vs-OVCPU cosine 0.999981 (graph exact) vs
torch-vs-OVGPU 0.106. Tap bisection isolated it to the `proj_out`
transposed-conv + bias-Add fusion (0.006 in -> 7.29 out). Pinning those 8 nodes
to CPU (rest GPU) restores cosine 0.999998 and ear-verified music. GPU-only is
therefore NOT offered (a knob that produces soup is banned); HETERO default,
CPU explicit fallback.

Transport: each job runs the vendored-proven runner (`generate_t2m.py`) as a
subprocess with `T2M_*` env — a 6 GB DiT never lives in the server process.
One generation at a time is enforced by the caller (serial queue slot).
"""
from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

from .. import job_control

# Absolute: the proven ACE-Step workspace on this box. Overridable for tests /
# future installs via MUSIC_SOURCE_DIR. The runner resolves everything else
# (IRs, HF cache snapshot, silence_latent.pt) relative to this dir.
SOURCE_DIR = Path(os.environ.get(
    "MUSIC_SOURCE_DIR", "/home/m/snc/cod/testLamaEraser"))

# Runner interpreter: the ACE env (torch 2.4 + OV 2024.4) that produced every
# ear-verified wav. NOT the server venv: its OV 2026.3 mis-routes empty tensors
# into HETERO CPU-subgraph inputs on this dynamic-shape graph (measured
# 2026-09-18: [?,1..,2048] vs (0.0.2048)). Override via MUSIC_PYTHON.
RUNNER_PYTHON = os.environ.get(
    "MUSIC_PYTHON",
    "/home/m/snc/cod/testLamaEraser/ace_ov_env_host/bin/python")

RUNNER = "scripts/generate_t2m.py"
CACHE_SUBDIR = Path("junk/models/music_ov")

# Single source of truth for dropdown + knob visibility (frontend renders from
# the status payload, never a forked JS copy).
MUSIC_MODELS: dict[str, dict] = {
    "acestep-v15-turbo": {
        "label": "ACE-Step 1.5 turbo · 2B (proven)",
        "enabled": True,
        "knobs": ["prompt", "lyrics", "seed", "duration", "bpm", "key", "timesig", "device", "outdir",
                  "format", "overwrite", "dryrun"],
        "dit_dir": "models/dit",
        "dit_file": "openvino_model_f32_grok_fixed.xml",
        "hetero_pin": "proj_out",
        "runner": "scripts/generate_t2m.py",
        "ckpt": "models--ACE-Step--Ace-Step1.5",
        "notes": "Guidance-distilled: 8 Euler steps, shift 3.0, no CFG. f32 locked. "
                 "proj_out runs on CPU via HETERO pin (measured fix).",
    },
    "acestep-v15-base": {
        "label": "ACE-Step 1.5 base · 2B (CFG, ear-verified)",
        "enabled": True,
        "knobs": ["prompt", "negative", "lyrics", "seed", "duration", "bpm", "key", "timesig", "steps",
                  "guidance", "device", "outdir", "format", "overwrite", "dryrun"],
        "dit_dir": "models/dit_base",
        "dit_file": "openvino_model_base_f32.xml",
        "hetero_pin": "proj_out",
        "runner": "scripts/generate_t2m_base.py",
        "ckpt": "models--ACE-Step--acestep-v15-base",
        "notes": "CFG (APG, null_condition_emb). Steps 8-60 (30-50 recommended).",
    },
    "acestep-v15-sft": {
        "label": "ACE-Step 1.5 sft · 2B (CFG, ear-verified)",
        "enabled": True,
        "knobs": ["prompt", "negative", "lyrics", "seed", "duration", "bpm", "key", "timesig", "steps",
                  "guidance", "device", "outdir", "format", "overwrite", "dryrun"],
        "dit_dir": "models/dit_sft",
        "dit_file": "openvino_model_sft_f32.xml",
        "hetero_pin": "proj_out",
        "runner": "scripts/generate_t2m_base.py",
        "ckpt": "models--ACE-Step--acestep-v15-sft",
        "notes": "CFG (APG). Same runner as base + T2M_CKPT switch.",
    },
    "acestep-v15-turbo-shift1": {
        "label": "turbo shift-1.0 recipe (needs export)",
        "enabled": False,
        "disabled_reason": "IR not exported",
        "knobs": ["prompt", "lyrics", "seed", "duration", "bpm", "key", "timesig", "device", "outdir",
                  "format", "overwrite", "dryrun"],
        "notes": "Same turbo weights, shift=1.0 sampling recipe.",
    },
    "acestep-v15-xl-turbo": {
        "label": "XL turbo · 4B (too heavy for this box)",
        "enabled": False,
        "disabled_reason": "~9 GB weights need >=12 GB VRAM",
        "knobs": [],
        "notes": "Parked until bigger hardware.",
    },
}

# LoRA pairs: baked checkpoint+adapter merges. One entry per validated IR —
# strength is merge-time (static OV graphs can't do runtime strength).
# verdict: GOOD (ear-verified) | untested | BAD (kept, flagged, runnable).
# New merges land here as "untested" once IR + probe pass; ears flip the badge.
LORA_PAIRS: dict[str, dict] = {
    "turbo+rap_s08_short": {
        "label": "rap '88 v1 (turbo)",
        "model": "acestep-v15-turbo",
        "dit_dir": "models/dit",
        "dit_file": "openvino_model_rap_s08_short_f32.xml",
        "hetero_pin": "proj_out",
        "trigger": "",
        "verdict": "BAD",
        "notes": "Plain LoRA r64, alpha assumed 64, strength 0.8. Ear: BAD (cause unknown, parked).",
    },
    "base+rap_s08_base": {
        "label": "rap '88 v1 (base)",
        "model": "acestep-v15-base",
        "dit_dir": "models/dit_lora/rap_s08_base",
        "dit_file": "openvino_model_f32.xml",
        "hetero_pin": "proj_out",
        "trigger": "roti-r4pz",
        "verdict": "BAD",
        "notes": "Documented alpha 128, strength 0.8, trigger in prompt. Ear: BAD (parked).",
    },
    "turbo+psychrock_v1": {
        "label": "psych-rock v1 (turbo)",
        "model": "acestep-v15-turbo",
        "dit_dir": "models/dit",
        "dit_file": "openvino_model_lora_psychrock_v1_f32.xml",
        "hetero_pin": "proj_out",
        "trigger": "",
        "verdict": "untested",
        "notes": "Queue-built. Wav exists, ear check pending.",
    },
}

# Files the setup op verifies (relative to SOURCE_DIR). DiT .bins are ~6 GB
# each — verified in place, never copied. Shared pieces (text encoder, decoder,
# runner entry is per-model) are listed once.
SHARED_MANIFEST = [
    "models/text_encoder/openvino_model.xml",
    "models/text_encoder/openvino_model.bin",
    "models/decoder/openvino_model.xml",
    "models/decoder/openvino_model.bin",
]
# Back-compat alias (turbo manifest).
MANIFEST = [
    "models/dit/openvino_model_f32_grok_fixed.xml",
    "models/dit/openvino_model_f32_grok_fixed.bin",
    *SHARED_MANIFEST,
    RUNNER,
]


def manifest_for(model: str) -> list[str]:
    spec = MUSIC_MODELS[model]
    return [
        f"{spec['dit_dir']}/{spec['dit_file']}",
        f"{spec['dit_dir']}/{spec['dit_file'].replace('.xml', '.bin')}",
        *SHARED_MANIFEST,
        spec["runner"],
    ]

_DURATION_RE = re.compile(r"T2M_DURATION_SEC=(\S+)")


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())[:24]


def available_devices() -> list[str]:
    try:
        import openvino as ov
        return list(ov.Core().available_devices)
    except Exception:
        return []


def manifest_state() -> dict[str, bool]:
    return {n: (SOURCE_DIR / n).is_file() for n in MANIFEST}


def get_music_ov_status() -> dict:
    models: dict[str, dict] = {}
    for name, spec in MUSIC_MODELS.items():
        entry = {
            "label": spec["label"],
            "enabled": spec["enabled"],
            "knobs": list(spec["knobs"]),
            "notes": spec.get("notes", ""),
        }
        if not spec["enabled"]:
            entry["disabled_reason"] = spec.get("disabled_reason", "")
            entry["ir_present"] = False
        else:
            files = {n: (SOURCE_DIR / n).is_file() for n in manifest_for(name)}
            entry["ir_present"] = all(files.values())
            entry["files"] = files
        models[name] = entry
    return {
        "ok": True,
        "models": models,
        "loras": [
            {"id": pid, "label": p["label"], "model": p["model"],
             "verdict": p["verdict"], "trigger": p.get("trigger", ""),
             "notes": p.get("notes", ""),
             "ir_present": all(
                 ((SOURCE_DIR / p["dit_dir"] / p["dit_file"]).is_file(),
                  (SOURCE_DIR / p["dit_dir"] / p["dit_file"].replace(".xml", ".bin")).is_file()))}
            for pid, p in LORA_PAIRS.items()
        ],
        "source_dir": str(SOURCE_DIR),
        "devices": available_devices(),
    }


def manifest_state() -> dict[str, bool]:
    """Turbo manifest (default model). Per-model: manifest_for(name)."""
    return {n: (SOURCE_DIR / n).is_file() for n in MANIFEST}


def build_env(*, prompt: str, lyrics: str, seed: int, duration_sec: float,
              model: str, device: str, out_path: str, negative: str = "",
              steps: int = 0, guidance: float = 0.0, bpm: str = "",
              key: str = "", timesig: str = "", lora: str = "") -> dict[str, str]:
    """Params -> T2M_* env for the runner subprocess. No other channel exists."""
    spec = MUSIC_MODELS[model]
    dit_dir, dit_file, hetero_pin = spec["dit_dir"], spec["dit_file"], spec["hetero_pin"]
    if lora:
        pair = LORA_PAIRS.get(lora)
        if pair is None:
            raise ValueError(f"Unknown LoRA pair {lora!r}")
        if pair["model"] != model:
            raise ValueError(f"LoRA pair {lora!r} belongs to {pair['model']}, not {model}")
        dit_dir, dit_file, hetero_pin = pair["dit_dir"], pair["dit_file"], pair["hetero_pin"]
    env = dict(os.environ)
    env.update({
        "T2M_PROMPT": prompt,
        "T2M_LYRICS": lyrics,
        "T2M_SEED": str(seed),
        "T2M_DURATION_SEC": str(duration_sec),
        "T2M_PREC_HINT": "f32",  # locked: f16 NaNs at step 3 (measured)
        "T2M_DIT_DIR": dit_dir,
        "T2M_DIT": dit_file,
        "T2M_CKPT": spec.get("ckpt", ""),
        "T2M_BPM": bpm,
        "T2M_KEY": key,
        "T2M_TIMESIG": timesig,
        "T2M_TRIM_COND": "1",
        "T2M_MAX_STEPS": "0",
        "T2M_OUT": out_path,
    })
    if steps > 0:
        env["T2M_STEPS"] = str(steps)
    if negative:
        env["T2M_NEGATIVE"] = negative
    if guidance > 0:
        env["T2M_GUIDANCE"] = str(guidance)
    if device == "HETERO":
        env["T2M_DIT_DEVICE"] = "GPU"
        env["T2M_HETERO_PIN"] = hetero_pin
    else:  # CPU explicit fallback — no pin, whole DiT on CPU
        env["T2M_DIT_DEVICE"] = "CPU"
        env["T2M_HETERO_PIN"] = ""
    return env


async def run_generation(env: dict[str, str], token: str | None,
                         total_steps: int = 8, runner: str = RUNNER,
                         ) -> tuple[int, str, Path | None]:
    """Run the runner, streaming stdout for per-step progress + cancel.

    Returns (exit_code, full_stdout, wav_path|None). Raises on cancel.
    """
    out_path = Path(env["T2M_OUT"])
    proc = await asyncio.create_subprocess_exec(
        RUNNER_PYTHON, runner,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(SOURCE_DIR),
        env=env,
    )
    lines: list[str] = []
    step_re = re.compile(r"step (\d+)/(\d+)")
    assert proc.stdout is not None
    while True:
        raw = await proc.stdout.readline()
        if not raw:
            break
        line = raw.decode("utf-8", "replace").rstrip()
        lines.append(line)
        m = step_re.search(line)
        if m and token:
            done = int(m.group(1))
            job_control.report_progress(
                f"diffusion step {done}/{total_steps}", phase="diffuse",
                current=done, total=total_steps, unit="steps", token=token)
        if token and job_control.is_cancelled(token):
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            raise job_control.JobCancelled(f"music_generate cancelled at: {line}")
    rc = await proc.wait()
    text = "\n".join(lines)
    wav: Path | None = None
    for line in lines:
        if line.startswith("Saved ") and line.endswith(".wav"):
            wav = Path(line[len("Saved "):].strip())
    if wav is None and out_path.is_file():
        wav = out_path
    return rc, text, wav
