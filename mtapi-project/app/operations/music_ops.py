"""
Music tab ops: ACE-Step text-to-music file-to-file generation (no video frames —
invariant 1 untouched, there is nothing to dump/encode) plus a tab-local setup op.

Two registered ops:
  music_generate  — prompt/lyrics/seed/duration -> WAV out (HETERO default)
  music_ov_setup  — verify manifest in place + CPU smoke + GPU probe

Device is strict: HETERO or CPU only. GPU-only is not offered (measured broken).
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .. import job_control
from ..contract import OperationResult, OperationSpec, register
from ..pathutil import unique_output_path
from . import music_ov_engine as ove


class MusicGenerateParams(BaseModel):
    prompt: str = Field("wu-tang, hip hop, boom bap, gritty instrumental, 95bpm, sampled guitar riff, sampled woodwinds, tight snare, dirty kick",
                        description="Caption text (goes through the SFT template)")
    lyrics: str = Field("[Instrumental]", description="Lyric block content")
    seed: int = Field(42, ge=0, description="Initial-noise seed (same prompt+seed = bit-identical clip)")
    duration_sec: float = Field(12, ge=10, le=60,
                               description="Clip length in seconds (below 10 is under the model floor)")
    model: Literal["acestep-v15-turbo", "acestep-v15-base", "acestep-v15-sft"] = Field(
        "acestep-v15-turbo", description="Music checkpoint")
    negative: str = Field("", description="Negative prompt (CFG models only; ignored by turbo)")
    steps: int = Field(0, ge=0, le=60,
                       description="Denoising steps for CFG models (0 = model default; turbo ignores)")
    guidance: float = Field(0.0, ge=0.0, le=15.0,
                            description="Guidance scale for CFG models (0 = model default; turbo ignores)")
    device: Literal["HETERO", "CPU"] = Field(
        "HETERO",
        description="HETERO = iGPU with proj_out CPU pin (proven); CPU = explicit slow path",
    )
    output_dir: str | None = Field(None, description="Folder for the WAV (default: next to CWD outbox)")
    output_format: Literal["wav-f32", "wav-pcm24"] = Field(
        "wav-f32", description="WAV encoding (runner emits f32; pcm24 converts + reports clipping)")
    overwrite: bool = Field(False, description="Overwrite an existing file (default: never, _0001…)")
    dry_run: bool = False


class MusicSetupParams(BaseModel):
    action: Literal["install"] = Field("install", description="Verify manifest + smokes")
    dry_run: bool = Field(False, description="List what would be checked, run nothing")
    deep: bool = Field(True, description="Run CPU smoke + GPU probe (slow, one-time)")


def _out_wav_path(prompt: str, seed: int, output_dir: str | None,
                  overwrite: bool) -> Path:
    base = ove.slug(prompt) or "clip"
    if output_dir:
        d = Path(output_dir).expanduser()
    else:
        d = ove.SOURCE_DIR
    candidate = d / f"music_{base}_s{seed}.wav"
    if overwrite:
        return candidate
    return unique_output_path(candidate)


async def music_generate(p: MusicGenerateParams) -> OperationResult:
    op = "music_generate"
    token = job_control.current_token()
    spec = ove.MUSIC_MODELS.get(p.model)
    if spec is None or not spec.get("enabled"):
        return OperationResult(ok=False, operation=op,
                               error=f"Unknown or disabled model {p.model!r}")
    missing = [n for n, ok in
               ((n, (ove.SOURCE_DIR / n).is_file()) for n in ove.manifest_for(p.model))
               if not ok]
    if missing:
        return OperationResult(
            ok=False, operation=op,
            error=f"Music artifacts missing ({len(missing)}): {', '.join(missing)}. "
                  f"Run music_ov_setup first (source: {ove.SOURCE_DIR}).")

    out_wav = _out_wav_path(p.prompt, p.seed, p.output_dir, p.overwrite)
    if p.output_dir:
        out_wav.parent.mkdir(parents=True, exist_ok=True)
    env = ove.build_env(prompt=p.prompt, lyrics=p.lyrics, seed=p.seed,
                        duration_sec=p.duration_sec, model=p.model,
                        device=p.device, out_path=str(out_wav),
                        negative=p.negative, steps=p.steps, guidance=p.guidance)
    total_steps = p.steps if p.steps > 0 else 8
    if p.dry_run:
        cmd = " ".join(["python", spec["runner"],
                        f"T2M_PROMPT={p.prompt!r}", f"T2M_SEED={p.seed}",
                        f"T2M_DURATION_SEC={p.duration_sec}",
                        f"device={p.device}", f"out={out_wav}"])
        return OperationResult(ok=True, operation=op, dry_run=True,
                               output_path=str(out_wav), command=cmd,
                               stdout="dry run — nothing generated")

    logs: list[str] = []
    logs.append(f"music_generate model={p.model} device={p.device} "
                f"seed={p.seed} dur={p.duration_sec}s out={out_wav}")
    try:
        if token:
            job_control.report_progress("loading models…", phase="load",
                                        current=0, total=total_steps, unit="steps", token=token)
        rc, text, wav = await ove.run_generation(env, token,
                                                 total_steps=total_steps,
                                                 runner=spec["runner"])
    except job_control.JobCancelled as e:
        return OperationResult(ok=False, operation=op, error=str(e))
    if rc != 0 or wav is None or not wav.is_file():
        tail = "\n".join(text.splitlines()[-15:])
        return OperationResult(ok=False, operation=op,
                               error=f"Runner failed (rc={rc}). Last lines:\n{tail}",
                               stdout=text)

    final = wav
    if p.output_format == "wav-pcm24":
        conv = wav.with_name(wav.stem + "_pcm24.wav")
        if not p.overwrite:
            conv = unique_output_path(conv)
        code, out, err = await _ffmpeg_to_pcm24(wav, conv)
        if code != 0:
            return OperationResult(ok=False, operation=op,
                                   error=f"pcm24 convert failed: {err[-500:]}",
                                   stdout=text)
        peak = _peak_of(conv)
        if peak >= 1.0:
            logs.append(f"WARNING: pcm24 output clips (peak {peak:.3f})")
        final = conv

    return OperationResult(ok=True, operation=op, output_path=str(final),
                           stdout=text + "\n" + "\n".join(logs))


async def _ffmpeg_to_pcm24(src: Path, dst: Path) -> tuple[int, str, str]:
    from ..shell import run_command
    return await run_command(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                              "-c:a", "pcm_s24le", str(dst)])


def _peak_of(wav: Path) -> float:
    try:
        import soundfile as sf
        a, _ = sf.read(str(wav))
        return float(abs(a).max())
    except Exception:
        return 0.0


async def music_ov_setup(p: MusicSetupParams) -> OperationResult:
    op = "music_ov_setup"
    token = job_control.current_token()
    files = ove.manifest_state()
    missing = [n for n, ok in files.items() if not ok]
    if p.dry_run:
        return OperationResult(
            ok=True, operation=op, dry_run=True,
            stdout="would verify in place (no copy — 6 GB DiT stays put):\n"
                   + "\n".join(f"  [{'ok' if ok else 'MISSING'}] {n}"
                               for n, ok in files.items())
                   + (f"\nwould run CPU smoke + GPU probe (deep={p.deep})" if p.deep else ""))

    if missing:
        return OperationResult(
            ok=False, operation=op,
            error=f"Missing artifacts ({len(missing)}): {', '.join(missing)}. "
                  f"Source dir: {ove.SOURCE_DIR} (override via MUSIC_SOURCE_DIR).")
    if not p.deep:
        return OperationResult(ok=True, operation=op,
                               stdout="manifest all present (deep smokes skipped)")

    from ..shell import run_command
    logs: list[str] = [f"manifest ok ({len(files)} files), source {ove.SOURCE_DIR}"]
    # CPU smoke: read every IR (parse-level) — fast, catches corruption.
    if token:
        job_control.report_progress("CPU smoke: parsing IRs…", phase="setup",
                                    current=1, total=3, unit="checks", token=token)
    probe_py = (
        "import openvino as ov;"
        "c=ov.Core();"
        "ms=["
        "'models/dit/openvino_model_f32_grok_fixed.xml',"
        "'models/text_encoder/openvino_model.xml',"
        "'models/decoder/openvino_model.xml'];"
        "[c.read_model(m) for m in ms];"
        "print('IR_PARSE_OK', c.available_devices)"
    )
    code, out, err = await run_command(
        [ove.RUNNER_PYTHON, "-c", probe_py], cwd=str(ove.SOURCE_DIR))
    if code != 0 or "IR_PARSE_OK" not in out:
        return OperationResult(ok=False, operation=op,
                               error=f"CPU IR parse failed: {(err or out)[-800:]}")
    logs.append("cpu IR parse ok; " + out.strip().splitlines()[-1])
    # GPU probe: single-step HETERO infer on random feeds (the proven path).
    if token:
        job_control.report_progress("GPU probe: single HETERO step…", phase="setup",
                                    current=2, total=3, unit="checks", token=token)
    probe2 = (
        "import numpy as np,openvino as ov;"
        "c=ov.Core();m=c.read_model('models/dit/openvino_model_f32_grok_fixed.xml');"
        "[n.get_rt_info().__setitem__('affinity','CPU' if 'proj_out' in n.get_friendly_name() else 'GPU') for n in m.get_ordered_ops()];"
        "h=c.compile_model(m,'HETERO:GPU,CPU',{'INFERENCE_PRECISION_HINT':'f32'});"
        "import numpy as _np;"
        "f={'hidden_states':_np.zeros((1,16,64),dtype=_np.float32),"
        "'timestep':_np.array([1.0],dtype=_np.float32),'timestep_r':_np.array([1.0],dtype=_np.float32),"
        "'attention_mask':_np.ones((1,16),dtype=bool),"
        "'encoder_hidden_states':_np.zeros((1,8,2048),dtype=_np.float32),"
        "'encoder_attention_mask':_np.ones((1,8),dtype=bool),"
        "'context_latents':_np.zeros((1,16,128),dtype=_np.float32)};"
        "v=_np.asarray(h(f)[h.outputs[0]],dtype=_np.float32);"
        "print('GPU_PROBE_OK', float(v.mean()), float(v.std()))"
    )
    code, out, err = await run_command(
        [ove.RUNNER_PYTHON, "-c", probe2], cwd=str(ove.SOURCE_DIR))
    if code != 0 or "GPU_PROBE_OK" not in out:
        # Non-fatal: report loudly, setup still ok (CPU path verified).
        logs.append(f"GPU probe FAILED (non-fatal): {(err or out)[-500:]}")
    else:
        logs.append("gpu probe ok; " + out.strip().splitlines()[-1])
    if token:
        job_control.report_progress("setup complete", phase="setup",
                                    current=3, total=3, unit="checks", token=token)
    return OperationResult(ok=True, operation=op, stdout="\n".join(logs))


register(OperationSpec(
    id="music_generate",
    summary="ACE-Step text-to-music (HETERO iGPU)",
    description="Prompt/lyrics/seed/duration to WAV via the proven HETERO pipeline.",
    params_model=MusicGenerateParams,
    handler=music_generate,
    tags=["audio", "music", "openvino"],
))
register(OperationSpec(
    id="music_ov_setup",
    summary="Music one-time setup (verify + smokes)",
    description="Verifies the IR manifest in place, CPU IR parse, GPU HETERO probe.",
    params_model=MusicSetupParams,
    handler=music_ov_setup,
    tags=["audio", "music", "setup"],
))
