# Music Tab — Stable Audio 3 Family (quick spec)

> **Status:** Specification, quick-and-dirty (unbuilt, unresearched on-box)
> **Date:** 2026-09-18
> **Parent:** `music-tab-spec.md` (tab conventions, honesty rules, proof gates all inherit)

## 1. Why this model

User workflow = short, legally-clean, sampleable clips. Stable Audio 3 (released
2026-05-20, open weights, trained on licensed UMG/Warner/CC data) matches that
workflow better than anything else on the radar: outputs are clean to chop and
recontextualize with nothing to clear. The Small SFX variant is a one-shot/sample
generator ("120 BPM distorted 808 hit, gritty, short decay" → sampler-ready hit).

## 2. Family table (from the brief — verify on-box before building)

| Variant | Params | Max length | Best for | Box fit (i5-1335U / Iris Xe / 16 GB) |
|---|---|---|---|---|
| Small SFX | 459M | 2 min | drum hits, textures, foley, one-shots | CPU, no GPU needed — easiest thing on this tab |
| Small | 459M | 2 min | short musical clips, loops, riffs | CPU / modest GPU |
| Medium | 1.4B | 6 min 20s | longer beds, complex arrangements | Modest GPU / CPU slower — needs validation |
| Large | 2.7B | 6 min 20s | API-only, not downloadable | **Excluded** (same treatment as XL: listed, parked) |

License: Stability AI Community License — free commercial use under $1M revenue.
Fits the sampling workflow legally and financially.

## 3. Tab design: second dropdown, same tab

Not new entries in the ACE-Step dropdown — a **separate family dropdown**
(`ACE-Step …` / `Stable Audio 3 …`), each driving its own knob set. Rationale:
different backends, different knobs (inpainting region, LoRA select, one-shot vs
clip mode), different setup manifests. Shared chrome only: out dir, format,
overwrite, dry run, Setup card pattern, progress, never-overwrite naming.

Proposed `SA3_MODELS` entries (all `enabled:false` until proven):
- `sa3-small-sfx` — knobs: prompt, duration/one-shot-length, seed, device, outdir,
  format, overwrite, dryrun. First to wire (CPU-only = simplest proof on this box).
- `sa3-small` — same knobs as SFX (clip mode).
- `sa3-medium` — same + device HETERO/CPU question resolved by validation.
- `sa3-large` — disabled, reason "API-only".

Future knobs (hidden until a variant exposes them): inpaint section (in/out points),
LoRA select, stems toggle (experimental upstream).

## 4. Backend sketch (for the Builder)

- New engine `stableaudio_engine.py` + ops `stableaudio_ops.py`
  (`sa3_generate`, `sa3_setup`) + route — mirrored on `music_ov_*`, separate
  registry ids so ACE-Step work is never disturbed.
- Runner: upstream is diffusers-shaped (`StableAudioPipeline` family);
  transport TBD at build time (subprocess-per-job if the footprint is ≥1 GB,
  in-process if Small/SFX proves light — decide by measurement, not hope).
- Setup manifest: variant weight files + tokenizer/vae pieces; CPU smoke (one-shot
  at 0.5 s) + GPU probe where applicable.
- Progress: diffusion-step ticks like ACE-Step; one-shots are seconds-long — still
  report, still cancellable.

## 5. Order of attack (when it starts)

1. `sa3-small-sfx` on CPU first (no GPU fusion risk class, fastest proof).
2. Ear-check one-shots; if musical → `sa3-small` clips.
3. `sa3-medium` only after Small sings (needs the HETERO question answered again —
   different architecture, no free rides from the ACE-Step pin).
4. LoRA/inpaint/stems only after a singing base variant.

## 6. Acceptance (same gate as parent spec)

Dropdown renders both families; ACE-Step side byte-unchanged; SA3 side follows the
§11 gate of `music-tab-spec.md` (Playwright clicks, pytest file, VERSION bump).
No shared-code regressions: full suite green.
