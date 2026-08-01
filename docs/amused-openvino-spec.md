# Amused (aMUSEd) Text-to-Image via OpenVINO — Spec

> **Status:** Proposed
> **Kind:** G (new — see §4, does not fit existing A–F cleanly)
> **Target hardware:** Intel i5-1335U, Iris Xe iGPU, 16GB RAM (no CUDA) — CachyOS/KDE primary dev machine
> **Precisions in scope:** FP16 (baseline), INT8, INT4 — see §8 for why "INT16" is not the right third option
> **Reuse-first mandate:** Do NOT reimplement Amused's sampling loop from scratch. Port diffusers' own orchestration logic almost verbatim and swap only the three neural network calls for OpenVINO inference. See §9.

---

## 1. Problem

The creative toolbox (mtapi-project / ffTransmute WebUI) currently has no local **text-to-image generation** capability — every existing op transforms pixels/bitstream/container that already exist on disk. Amused (aMUSEd) is a small (~800M param), non-diffusion, masked-image-model text-to-image generator from Hugging Face that's cheap enough to run without a GPU. The owner wants it wired in as a niche/weird generation tool feeding the Image Pool, running on OpenVINO so it uses the CPU (and optionally the Iris Xe iGPU) instead of requiring CUDA — and wants to compare FP16 vs INT8 vs INT4 output quality/speed directly, quality loss included, in service of creative variety rather than production fidelity.

## 2. Goals / Non-goals

**Goals**

- Add a local, offline, CUDA-free text-to-image generation op that writes into the Image Pool.
- Support both native Amused checkpoints: `amused-256` (256×256) and `amused-512` (512×512).
- Prepare three precision tiers offline (FP16, INT8, INT4) via a one-time conversion/quantization script; make precision a per-request param.
- Support device selection (`CPU` / `GPU`) so the Iris Xe iGPU can be tried via OpenVINO's GPU plugin.
- Follow every invariant in the design brief: absolute paths, no `shell=True`, `OperationResult` shape, unique output paths, vanilla JS frontend.
- Reuse diffusers' existing Python sampling/scheduling logic instead of hand-rolling the MaskGIT-style parallel decoding loop.

**Non-goals**

- Real-time or interactive-speed generation — CPU/iGPU inference will be slow (seconds to low minutes per image depending on precision/device); that's accepted, this is a "weird tool," not a production generator.
- img2img, inpainting, or StyleDrop LoRA support for Amused — diffusers supports these via `AmusedImg2ImgPipeline` / `AmusedInpaintPipeline`, but they're follow-ups (§16), not this spec.
- Arbitrary output resolution — locked to whichever native checkpoint resolution (256 or 512) is selected.
- Automated image-quality regression scoring across precision tiers — quality comparison is manual/subjective by design (owner explicitly does not care how degraded INT4 looks).
- Multi-GPU or distributed serving — single local device only.

## 3. User story

1. User opens the **Generate** tab (new, lives near/under Image Pool tooling).
2. User types a prompt (and optionally a negative prompt).
3. User picks model variant (256 / 512), precision (fp16 / int8 / int4), device (CPU / GPU), step count, and optionally a seed.
4. User clicks **Generate**.
5. Backend runs the Amused pipeline against the pre-converted OpenVINO IR for the chosen (variant, precision) pair, on the chosen device.
6. On success, the resulting PNG is written to a unique absolute path and added to the Image Pool; the UI shows a thumbnail.
7. On failure (e.g. that precision/variant hasn't been converted yet), the UI shows a clear `ok: false` error with the reason, no stack trace soup, no silent overwrite.
8. User can re-run the same prompt+seed at a different precision to compare output directly (same image slot pattern, different files — never overwritten).

## 4. Classification

None of taxonomy buckets A–F in the design brief fit cleanly:

| Bucket | Why it doesn't fit |
|---|---|
| A. Frame effect | No input frames exist yet — this creates pixels from text, it doesn't transform existing ones. |
| B. Bookend/codec | Not a container/codec operation. |
| C. Geometry/CLI | Not a `transmute` geometry op. |
| D. File-level glitch | Doesn't mutate a compressed bitstream. |
| E. UI-only workspace | Requires real backend inference, not just frontend state. |
| F. Still → video utility | Closest analogue (produces a still), but F implies an existing still going *into* a video, not text going *into* a still. |

**Proposal:** treat this as a new bucket, **G. Generation** — a feature that creates new pool content from a non-media input (text prompt) rather than transforming existing media. Recommend flagging this to whoever owns `external-design-brief.md` for a taxonomy update; this spec proceeds pragmatically under the same architectural invariants regardless of bucket letter.

One useful simplification: **invariant #2 (no `shell=True` / argv-only subprocesses) is automatically satisfied** because there is no subprocess at all here — generation is in-process Python calling OpenVINO's Python API directly. No `ffmpeg`, no CLI shell-out.

## 5. Background — what's being ported and why it's tractable

Amused (HF: `huggingface/amused`, diffusers pipeline `AmusedPipeline`) is a Masked Image Model (MUSE-style), not a latent diffusion model. It has three trainable components:

1. **Text encoder** — CLIP (`text_encoder` + `tokenizer` in the diffusers pipeline).
2. **Transformer** — a `UVit2DModel` that predicts token logits for currently-masked image tokens, conditioned on the text embeddings. This is the only component that runs iteratively (default ~12 steps).
3. **VQ-VAE decoder** (`vqvae.decode`) — converts the final grid of discrete image tokens into pixels. Runs once, at the end.

Generation is **parallel decoding**: start with every image token masked, and at each step predict logits for all masked positions, sample tokens, then keep only the most-confident predictions as "unmasked" (a cosine schedule controls how many tokens get committed per step) — the rest stay masked for the next round. After the final step, the fully-unmasked token grid is decoded to pixels by the VQ-VAE decoder.

OpenVINO already has prior art here: a dedicated notebook, *"Lightweight image generation with aMUSEd and OpenVINO"* (`docs.openvino.ai/2023.3/notebooks/277-amused-lightweight-text-to-image-with-output.html`), predating the version of OpenVINO's docs currently indexed at the top level. **Treat this notebook as the primary reference to adapt from** — but note it may need to be pulled from an archived doc version or old commit history of `openvinotoolkit/openvino_notebooks`, since it didn't surface in current top-level notebook listings during research for this spec. Verify its existence/contents before leaning on it for exact code; if it's gone, the conversion recipe in §10 below is self-contained and doesn't depend on it.

Nothing about this architecture requires CUDA-specific ops, dynamic control flow inside the neural nets, or anything exotic — the three components are a CLIP encoder, a ViT-style transformer, and a convolutional VQ-VAE decoder, all bog-standard OpenVINO conversion targets. The *sampling loop* (which token to unmask, cosine schedule math, CFG combination) is plain Python/PyTorch tensor arithmetic that runs fine on CPU regardless of OpenVINO — it never needs converting, only the three `nn.Module` calls inside it do.

## 6. Core architecture decision (read this before writing any code)

**Do not reimplement `AmusedPipeline.__call__` or `AmusedScheduler.step` from scratch or from memory.** Both exist in the installed `diffusers` package (`diffusers/pipelines/amused/pipeline_amused.py` and `diffusers/schedulers/scheduling_amused.py`). The implementation plan is:

1. Open those two files in the actual installed environment.
2. Copy the orchestration logic (the loop over `num_inference_steps`, the CFG combination, the token sampling, the confidence-based re-masking) into a new engine class, essentially verbatim.
3. Perform exactly **three surgical replacements**:
   - `self.text_encoder(...)` → OpenVINO compiled-model inference call for the text encoder IR.
   - `self.transformer(...)` → OpenVINO compiled-model inference call for the transformer IR.
   - `self.vqvae.decode(...)` → OpenVINO compiled-model inference call for the VQ-VAE decoder IR.
4. Every OpenVINO inference call returns NumPy arrays — wrap the output(s) in `torch.from_numpy(...)` immediately so the surrounding tensor math (softmax, top-k, gumbel noise, etc., all plain PyTorch on CPU) keeps working unmodified.

This is the single most important decision in this spec: it turns "port a nontrivial generative sampling algorithm" into "swap three function calls inside code that already works," which is a much smaller and much safer task than re-deriving MaskGIT-style masking math from a natural-language description (mine or anyone else's).

## 7. Precision strategy — FP16 / INT8 / INT4 (and why not "INT16")

OpenVINO / NNCF's standard weight precisions for CPU/iGPU inference are **FP32, FP16, INT8, and INT4** (NF4 also exists but is aimed at LLM linear layers, not relevant here). There is no standard "INT16" weight-compression tier in this stack — it's not a guessing gap, it's just not one of the available options. **Substitute FP16 as the baseline/reference tier** (this is also simply the normal default precision OpenVINO IR is saved at) and treat INT8/INT4 as the two compressed tiers. So the three-way comparison the owner asked for becomes:

| Tier | What it is | Expected tradeoff |
|---|---|---|
| **FP16** | Default IR precision, effectively "full quality" for this pipeline | Baseline quality, slowest of the three, largest files |
| **INT8** | NNCF weight-only compression, `INT8_ASYM` (or `INT8_SYM`) | Small-to-moderate quality loss, faster, ~2x smaller weights |
| **INT4** | NNCF weight-only compression, `INT4_ASYM` (or `INT4_SYM`) with a `group_size` and `ratio` param | Real quality loss expected and accepted by design, fastest, ~4x smaller weights — this is the "I don't care how bad, give me something unique" tier |

Yes — **INT4 is a real, supported thing** here via NNCF's `compress_weights()` API (weight-only compression; it does not require a calibration dataset the way full activation quantization does, which keeps this simple). All three tiers get produced by the same offline conversion script (§10) and are selected per-request at runtime (§12), never chosen at request time by re-quantizing on the fly.

## 8. Directory & file layout

```
scripts/
  convert_amused_openvino.py        # one-time offline conversion + quantization (§10)

app/
  generation/
    __init__.py
    amused_engine.py                # AmusedOpenVINOEngine — model loading + generation (§9, §11)
    amused_ops.py                   # thin HTTP ops layer, registers with contract.REGISTRY (§12)

  models_openvino/                  # generated artifacts — NOT hand-written, NOT committed if repo policy excludes binaries
    amused-256/
      fp16/  text_encoder.xml .bin   transformer.xml .bin   vqvae_decoder.xml .bin
      int8/  text_encoder.xml .bin   transformer.xml .bin   vqvae_decoder.xml .bin
      int4/  text_encoder.xml .bin   transformer.xml .bin   vqvae_decoder.xml .bin
    amused-512/
      fp16/ ...
      int8/ ...
      int4/ ...

  static/js/tabs/
    generate.js                     # new vanilla JS tab (§13) — confirm no name collision in index.html first

index.html                           # add <Generate> tab entry

docs/
  amused-openvino-spec.md            # this file, once approved, lives here per brief §7/§12 convention
```

**VERIFY before implementing:** confirm the text encoder is actually a bare CLIP text model wrapping the tokenizer's output, and confirm the exact attribute names (`pipe.text_encoder`, `pipe.transformer`, `pipe.vqvae`, `pipe.tokenizer`, `pipe.scheduler`) against the installed diffusers version — these are the standard `AmusedPipeline` component names per the Hugging Face blog example, but pin them by running `print(pipe.config)` / `dir(pipe)` once rather than trusting this document blindly.

## 9. Conversion methodology — capture real inputs, don't guess signatures

The biggest risk in this whole port is guessing the exact `forward()` argument names/shapes for `UVit2DModel` (Amused's transformer) — it very likely takes several conditioning tensors beyond just token ids (text embeddings, pooled text embedding, and possibly resolution/micro-conditioning vectors similar to SDXL-style conditioning), and getting the tracing example wrong silently produces a broken or subtly wrong OpenVINO graph. **Do not hardcode a guessed signature.** Instead, capture real call arguments with PyTorch forward hooks during one normal PyTorch generation run, then use those *real* captured tensors as the tracing example for `ov.convert_model`. This sidesteps needing to know the signature at all:

```python
import torch
import inspect
from diffusers import AmusedPipeline

pipe = AmusedPipeline.from_pretrained("amused/amused-256", torch_dtype=torch.float32)
pipe.to("cpu")

captured = {}

def make_hook(name):
    def hook(module, args, kwargs):
        captured[name] = {"args": args, "kwargs": kwargs}
    return hook

h_text = pipe.text_encoder.register_forward_pre_hook(make_hook("text_encoder"), with_kwargs=True)
h_xfmr = pipe.transformer.register_forward_pre_hook(make_hook("transformer"), with_kwargs=True)

# vqvae.decode is a plain method, not an nn.Module.__call__, so it needs a manual wrap:
orig_decode = pipe.vqvae.decode
def decode_capture(*args, **kwargs):
    captured["vqvae_decode"] = {"args": args, "kwargs": kwargs}
    return orig_decode(*args, **kwargs)
pipe.vqvae.decode = decode_capture

with torch.no_grad():
    _ = pipe("a red bicycle in a garden", num_inference_steps=2, output_type="pil")

h_text.remove()
h_xfmr.remove()
pipe.vqvae.decode = orig_decode

# Normalize each capture into a clean ordered dict of real example tensors:
def normalize(module_or_fn, capture, is_module=True):
    fwd = module_or_fn.forward if is_module else module_or_fn
    sig = inspect.signature(fwd)
    bound = sig.bind(*capture["args"], **capture["kwargs"])
    bound.apply_defaults()
    return dict(bound.arguments)

text_encoder_example = normalize(pipe.text_encoder, captured["text_encoder"])
transformer_example  = normalize(pipe.transformer, captured["transformer"])
vqvae_decode_example = normalize(orig_decode, captured["vqvae_decode"], is_module=False)
```

`captured[...]` now holds **real, correctly-shaped tensors** for all three components — pulled straight from an actual pipeline run, not guessed. Use these directly as `example_input` to `ov.convert_model` in §10.

For the VQ-VAE decoder specifically, since `vqvae.decode` is a method rather than `nn.Module.__call__`, wrap it in a tiny module before tracing:

```python
class VQVAEDecoderWrapper(torch.nn.Module):
    def __init__(self, vqvae):
        super().__init__()
        self.vqvae = vqvae
    def forward(self, *args, **kwargs):
        return self.vqvae.decode(*args, **kwargs)

decoder_wrapper = VQVAEDecoderWrapper(pipe.vqvae)
```

## 10. Offline conversion + quantization script

```python
# scripts/convert_amused_openvino.py
"""
One-time offline script. Run once per model variant (amused-256, amused-512).
Produces app/models_openvino/<variant>/{fp16,int8,int4}/{text_encoder,transformer,vqvae_decoder}.{xml,bin}
"""
import argparse
from pathlib import Path

import torch
import openvino as ov
import nncf
from diffusers import AmusedPipeline

# ... [capture-hook block from §9 goes here, producing:
#      text_encoder_example, transformer_example, vqvae_decode_example, decoder_wrapper] ...

def convert_and_save(module, example_input, out_dir: Path, name: str):
    out_dir.mkdir(parents=True, exist_ok=True)

    ov_model = ov.convert_model(module, example_input=example_input)

    # FP16 tier — default/reference precision
    ov.save_model(ov_model, out_dir.parent / "fp16" / f"{name}.xml", compress_to_fp16=True)

    # INT8 tier — weight-only compression, no calibration dataset needed
    int8_model = nncf.compress_weights(ov_model, mode=nncf.CompressWeightsMode.INT8_ASYM)
    ov.save_model(int8_model, out_dir.parent / "int8" / f"{name}.xml")

    # INT4 tier — weight-only compression, more aggressive
    int4_model = nncf.compress_weights(
        ov_model,
        mode=nncf.CompressWeightsMode.INT4_ASYM,
        group_size=64,
        ratio=1.0,   # 1.0 = compress everything to int4; lower ratio mixes in some int8 layers for stability
    )
    ov.save_model(int4_model, out_dir.parent / "int4" / f"{name}.xml")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=["amused-256", "amused-512"], required=True)
    args = parser.parse_args()

    model_id = f"amused/{args.variant}"
    out_root = Path("app/models_openvino") / args.variant

    # ... load pipe, run capture-hook block from §9 against model_id ...

    convert_and_save(pipe.text_encoder, text_encoder_example, out_root / "_placeholder", "text_encoder")
    convert_and_save(pipe.transformer, transformer_example, out_root / "_placeholder", "transformer")
    convert_and_save(decoder_wrapper, vqvae_decode_example, out_root / "_placeholder", "vqvae_decoder")

    print(f"Done. IR written under {out_root}/{{fp16,int8,int4}}/")
```

**VERIFY before implementing:**
- Exact `nncf.CompressWeightsMode` enum member names (`INT8_ASYM`/`INT8_SYM`/`INT4_ASYM`/`INT4_SYM`) and the `compress_weights()` keyword arguments (`group_size`, `ratio`) against the installed `nncf` version — run `import nncf; print(list(nncf.CompressWeightsMode))` and `help(nncf.compress_weights)` first. These names have moved before across NNCF releases.
- Whether weight compression should be applied to the FP32 `ov_model` before FP16 saving, or to the FP16-saved model. Compressing from the higher-precision in-memory model (as written above) is the safer default to avoid compounding precision loss, but confirm current NNCF guidance.

Run once per variant:
```bash
python scripts/convert_amused_openvino.py --variant amused-256
python scripts/convert_amused_openvino.py --variant amused-512
```

Required packages beyond the existing project deps: `openvino`, `nncf`, `diffusers`, `torch` (CPU wheel is sufficient — conversion runs once, offline, doesn't need to be fast). **`optimum-intel` is not required** — Amused isn't part of its natively-supported diffusion pipeline family as of this writing, which is exactly why manual per-component conversion (this section) is the reliable path rather than `OVDiffusionPipeline.from_pretrained(...)`.

## 11. Runtime inference engine (`app/generation/amused_engine.py`)

```python
class AmusedOpenVINOEngine:
    """
    Loads and caches compiled OpenVINO models per (variant, precision, device).
    Reuses diffusers' AmusedScheduler stepping logic; only the three neural
    forward calls are redirected to OpenVINO InferRequests (see §6).
    """

    def __init__(self, models_root: Path):
        self.models_root = models_root
        self._compiled_cache: dict[tuple[str, str, str], dict] = {}
        self.core = ov.Core()

    def _get_compiled(self, variant: str, precision: str, device: str) -> dict:
        key = (variant, precision, device)
        if key not in self._compiled_cache:
            base = self.models_root / variant / precision
            if not base.exists():
                raise FileNotFoundError(
                    f"No converted models at {base} — run "
                    f"scripts/convert_amused_openvino.py --variant {variant} first."
                )
            self._compiled_cache[key] = {
                "text_encoder": self.core.compile_model(str(base / "text_encoder.xml"), device),
                "transformer": self.core.compile_model(str(base / "transformer.xml"), device),
                "vqvae_decoder": self.core.compile_model(str(base / "vqvae_decoder.xml"), device),
            }
        return self._compiled_cache[key]

    def generate(
        self,
        prompt: str,
        negative_prompt: str,
        variant: str,
        precision: str,
        device: str,
        num_inference_steps: int,
        guidance_scale: float | None,
        seed: int | None,
        tokenizer,           # plain HF tokenizer, CPU, not converted — cheap, no need to touch
        scheduler,           # diffusers AmusedScheduler instance, reused as-is (§6)
    ) -> "PIL.Image.Image":
        compiled = self._get_compiled(variant, precision, device)

        # --- Port the body of AmusedPipeline.__call__ here near-verbatim (§6). ---
        # Replace exactly these three call sites with OpenVINO InferRequest calls,
        # wrapping outputs in torch.from_numpy(...) immediately:
        #
        #   text_embeds  = compiled["text_encoder"](tokenized_inputs)
        #   logits       = compiled["transformer"]({name: tensor.numpy() for name, tensor in step_inputs.items()})
        #   pixels       = compiled["vqvae_decoder"](final_token_grid.numpy())
        #
        # All masking/confidence/CFG/re-masking math stays exactly as diffusers wrote it,
        # unmodified, running on CPU as plain torch ops regardless of `device`.
        ...
```

Memory note: with 16GB total RAM, do **not** eagerly compile all 18 model files (2 variants × 3 precisions × 3 components) at server startup. Compile lazily on first request per `(variant, precision, device)` key and keep the cache small (e.g. LRU-evict beyond 2–3 cached combinations) — OpenVINO compiled models are not huge for this model size, but there's no reason to hold combinations nobody's requested.

Threading note: `CompiledModel`/`InferRequest` calls are blocking, CPU-bound work — do not call `engine.generate(...)` directly inside an `async def` FastAPI route handler. Route it through the existing `job_control` worker system (per brief §8 building blocks table) so it doesn't block the event loop, and so cancel/progress semantics stay consistent with the rest of the app.

## 12. API / ops layer (`app/generation/amused_ops.py`)

Route: **`POST /ops/amused_generate`**

### Request body

| Field | Type | Default | Validation |
|---|---|---|---|
| `prompt` | string | — (required) | non-empty, trimmed; CLIP truncates at 77 tokens — long prompts silently truncate, document this in UI copy |
| `negative_prompt` | string | `""` | optional |
| `model_variant` | `"amused-256"` \| `"amused-512"` | `"amused-256"` | enum |
| `precision` | `"fp16"` \| `"int8"` \| `"int4"` | `"int8"` | enum; must have a converted IR present (§10) or op returns `ok: false` with a clear "not converted yet" message |
| `device` | `"CPU"` \| `"GPU"` | `"CPU"` | enum; `"GPU"` targets the Iris Xe iGPU via OpenVINO's GPU plugin — see §15 risk re: driver packages |
| `num_inference_steps` | int | `12` | range 1–24 (12 is Amused's documented default from the HF blog) |
| `guidance_scale` | float \| null | **VERIFY** | confirm `AmusedPipeline.__call__`'s actual default via `inspect.signature(...)`; expose the param only if it exists on the installed pipeline version |
| `seed` | int \| null | `null` (random) | if provided, use `torch.manual_seed(seed)` for reproducibility |
| `num_images` | int | `1` | range 1–4; generating >1 loops the pipeline call, does not batch inside one OpenVINO call unless profiling later shows batching is worth the complexity |
| `output_dir` | absolute path | Image Pool ingest directory | must be absolute per invariant #1 |

### Response — `OperationResult`

Standard fields (`ok`, `operation`, `output_path`, `error`, `command`, `stdout`, `stderr`, `dry_run`) apply, with two notes:

- `command` — since there's no subprocess, populate with a human-readable description of the call (e.g. `"amused_generate(variant=amused-256, precision=int8, device=CPU, steps=12)"`) rather than leaving it as if a shell command ran.
- `num_images > 1` — `output_path` holds the first generated image; add an **additive, optional** `output_paths: [...]` field for the rest. This is a documented, non-breaking extension to the existing shape — confirm no existing op already has a multi-output convention to align with before inventing this field.

Output paths go through `pathutil.finalize_output_path` (brief §8) — never overwrite silently, matches invariant #10. Naming pattern: `amused_<variant>_<precision>_<timestamp-or-seed>_0001.png` style, consistent with existing unique-path conventions elsewhere in the project.

Errors that must produce `ok: false` (HTTP 200), not a 500:
- Requested `(variant, precision)` combination hasn't been converted (§10 not yet run for it).
- `device="GPU"` requested but OpenVINO can't see a GPU device (`ov.Core().available_devices` doesn't include `"GPU"`).
- Empty/whitespace-only prompt.
- `num_inference_steps` or `num_images` out of the documented range.

## 13. WebUI (`app/static/js/tabs/generate.js`)

- New tab, vanilla JS module + its own CSS, no framework — per invariant #3.
- **Does not** use the global Video bar or Frame range row — this feature has no video/frame context (unlike Cut-style workspaces per invariant #8, which explicitly *do* need those). It's the odd one out: pure text-in, image-out.
- Form fields: prompt (textarea), negative prompt (textarea, collapsible/optional), model variant (dropdown: 256 / 512), precision (dropdown: fp16 / int8 / int4), device (dropdown: CPU / GPU), steps (slider, 1–24, default 12), seed (optional numeric input + "randomize" button), num_images (stepper, 1–4).
- **Generate** button → `POST /ops/amused_generate` → on `ok: true`, render thumbnail(s) inline and add to Image Pool (`images[]`) per invariant #7 (stills stay in the Image Pool, never mixed into `items[]`/video pool).
- On `ok: false`, show the `error` string plainly — no raw stack traces in the UI.
- Zero JS console errors on render or on submit, per brief's acceptance-test bar.
- Confirm no filename collision with an existing tab before landing `generate.js`/`generate.css` — the Image Pool section may already have generation-adjacent tooling (referenced generically in brief §6 as "refs for Cut / style / zoompan, etc.") that this should sit alongside, not duplicate.

## 14. Edge cases

- Precision/variant combo not yet converted → clear `ok: false`, actionable message pointing at the conversion script.
- `device="GPU"` requested on a machine/session where the iGPU isn't exposed to OpenVINO → clear `ok: false`, do not silently fall back to CPU (silent fallback would make "I picked GPU to compare speed" tests misleading).
- Prompt longer than CLIP's 77-token limit → truncation happens inside the tokenizer silently; surface a UI warning ("prompt truncated to N tokens") rather than letting it pass invisibly.
- `num_images > 1` mid-batch failure (e.g. image 2 of 4 throws) → return what succeeded with `ok: true` and a `partial: true`-style note, or fail the whole batch — pick one and document it; recommend fail-whole-batch for a first cut, simpler to reason about.
- Concurrent generate requests from the UI → route through `job_control` (§11) so they queue rather than fight over the same `InferRequest` object; OpenVINO `InferRequest` objects are not thread-safe for concurrent `.infer()` calls without care.
- Seed reproducibility across precision tiers is **not** guaranteed to produce visually similar images — INT4 quantization changes the actual computation, not just noise; document this so "same seed, different precision" isn't mistaken for a bug when the outputs diverge.

## 15. Acceptance tests

Unlike frame-effect ops, there's no `/tmp/teste.mp4` or `/tmp/teste.png` *input* to consume — this op is generative. Adapted smoke tests:

**Prerequisite (one-time, not part of per-PR CI):**
```bash
python scripts/convert_amused_openvino.py --variant amused-256
```

**Backend smoke:**
```bash
curl -s -X POST http://localhost:24590/ops/amused_generate \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "a red bicycle in a garden, expressionist style",
    "model_variant": "amused-256",
    "precision": "int8",
    "device": "CPU",
    "num_inference_steps": 12,
    "seed": 42
  }'
# Expect: HTTP 200, ok:true, output_path is an absolute path,
# file exists on disk, is a valid 256x256 PNG.
```

**Cross-precision sanity (manual, not asserted automatically):**
Run the identical request body above with `precision` set to `fp16`, `int8`, and `int4` in turn. All three must return `ok: true` with a valid, non-corrupt PNG — actual visual quality comparison is left to the human, by design (§2 non-goals).

**Failure-path smoke:**
```bash
curl -s -X POST http://localhost:24590/ops/amused_generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "", "model_variant": "amused-256", "precision": "int8"}'
# Expect: HTTP 200, ok:false, clear error message, no 500.
```

**WebUI:**
- Generate tab renders, all fields present, no JS console errors on load.
- Submitting a valid prompt shows a thumbnail on `ok:true`.
- Submitting an empty prompt shows a clear inline error on `ok:false`, no console errors.
- Generated image appears in the Image Pool (`images[]`) after success.

## 16. Out of scope / follow-ups

- `AmusedImg2ImgPipeline` / `AmusedInpaintPipeline` support (would reuse most of this same conversion + engine plumbing, plus a mask/init-image input — natural next feature once this lands).
- StyleDrop-style LoRA fine-tunes (Amused's training script supports LoRA; loading a fine-tuned adapter into the OpenVINO-converted transformer is a separate, nontrivial spec).
- Batched multi-image generation inside a single OpenVINO inference call (currently loops `num_images` requests one at a time; revisit if throughput becomes a real complaint).
- Automated perceptual-quality comparison across precision tiers (CLIP-score or similar) if the owner later wants something more rigorous than eyeballing it.

## 17. Risks

- **INT4 quality**: expected and accepted (owner explicitly wants "unique, don't care how bad") — not a blocker, just documented so nobody "fixes" it later by assuming it's a bug.
- **GPU (Iris Xe) driver stack on CachyOS/KDE**: OpenVINO's GPU plugin needs Intel's compute runtime + Level Zero loader present on the system (typically packages along the lines of `intel-compute-runtime` and `level-zero-loader` on Arch-based distros). Verify exact package names via `pacman -Ss level-zero` / `pacman -Ss intel-compute-runtime` at implementation time rather than assuming they're already installed — if they're missing, `device="GPU"` requests should fail cleanly per §14, not hang or crash.
- **NNCF API surface drift**: `CompressWeightsMode` enum members and `compress_weights()` kwargs have changed across NNCF releases — pin and verify against the installed version before trusting §10's exact code (flagged inline there too).
- **`UVit2DModel` forward signature unknowns**: mitigated entirely by the hook-capture technique in §9 — this is the whole point of that section, so this risk should be close to zero if §9 is followed rather than skipped.
- **Memory pressure at 16GB**: don't eagerly load all 18 converted model files; lazy-compile + small cache per §11.
- **Old OpenVINO notebook reference may be stale/removed**: §5's linked notebook may not resolve on current docs; this spec doesn't depend on it existing, but it's worth a five-minute check before starting, since a working reference implementation (if still findable) beats re-deriving everything from this document alone.
