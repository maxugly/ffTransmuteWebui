# Music Tab (text-to-music) — Spec

> **Status:** Specification (unbuilt)
> **Date:** 2026-09-18
> **Audience:** Builders (hat: Builder per `AGENTS.md`; this doc is Spec-writer output — no app code here)
> **Provenance:** ACE-Step 1.5-turbo → OpenVINO HETERO pipeline, ear-verified musical
> (`t2m_gpu_hetero_projout_f32.wav` 12 s, `t2m_40s_hetero_projout_f32.wav` 40 s).
> Full diagnosis log lives outside this repo (see §10).

---

## 1. Problem

Text-to-music on the iGPU works (proven), but only as a shell script with env vars
(`T2M_PROMPT`, `T2M_SEED`, …) in another repo. There is no tab, no model picker, no knobs,
no setup/install story, no job progress, no output management. Goal: a **Music** tab under
Neural FX (next to Stems) that exposes generation through the standard tab → op → engine
stack, with the house rule applied strictly: **no non-functioning UI — knobs appear only
when the selected model can actually use them** (same honesty bar as the Zoom `8.060` pass).

---

## 2. Goals / non-goals

**Goals (v1)**
- Music tab with a **Model dropdown**; first and only enabled entry: `acestep-v15-turbo`.
- Knobs rendered **per selected model** from a capability table (§4). Turbo exposes:
  prompt, lyrics, seed (+ dice), duration, device, out dir, format, overwrite, dry run.
  Everything turbo cannot use (guidance, negative prompt, steps, shift) is **absent**, not disabled.
- Future models (`sft`, `base`, `turbo-shift1`, fine-tunes, XL) appear as **disabled
  placeholder entries** with a one-line "needs export" note (watermark-tab precedent) —
  their knob sets are specified now (§4) so enabling one later is data-only.
- Tab-local Setup card (Demucs precedent): `GET /api/music_ov/status` +
  `POST /ops/music_ov_setup` — IR install + CPU smoke + GPU probe, all non-fatal except
  where noted.
- Strict device contract (styletransfer/deepdream precedent): failures raise loudly as
  HTTP 200 + `{"ok": false}`; **no silent fallback**. GPU-only is NOT offered for turbo
  (measured broken: single-step cosine 0.106) — see §5.
- Progress per diffusion step + decode chunk via `report_progress()`; cooperative Stop.
- Never-overwrite outputs: `batch_<slug>_s<seed>.wav` (+ `.latents.npy` sidecar kept).

**Non-goals (v1)**
- Batch/queue factory (prompt × seed grids) → **v1.1** (batch logic already exists as a
  standalone script; v1.1 ports it to a queue op — see §9).
- New exports, INT8 tuning, sampler surgery, LM models, XL 4B (needs ≥12 GB VRAM —
  explicitly out for 16 GB shared-RAM boxes).
- Editing/re-mixing generated clips (that is Demucs/sequence territory).

---

## 3. Locked decisions

| Decision | Selection | Notes |
|---|---|---|
| Tab location | Neural FX, after Stems | Audio family adjacency |
| Engine transport | **Subprocess per job** via `shell.run_command` + argv (invariant 2), params passed as `T2M_*` env | The env interface already exists and is proven; a 6 GB DiT must never live in the server process (OOM takes the server, not the job) |
| Runner | Vendor the proven `generate_t2m.py` as the engine entry (plus its exact IR set) | No rewrite; params→env map in §6 |
| Model store | `junk/models/music_ov/` reserved; v1 verifies the 6 GB DiT **in place** (no copy — doubling it on disk buys nothing single-box) | Source path is a server-side setting (`MUSIC_SOURCE_DIR`), never a per-run knob |
| Runner interpreter | `MUSIC_PYTHON` (default: the ACE env that produced every ear-verified wav — torch 2.4 + OV 2024.4), NOT the server venv | Server OV 2026.3 mis-routes empty tensors into HETERO CPU-subgraph inputs on this dynamic-shape graph (measured); server venv keeps only `soundfile` (WAV peak read) |
| Device options (turbo) | `HETERO:GPU,CPU` (default, proven) · `CPU` (explicit slow path) | GPU-only absent by design (§5) |
| Precision (turbo) | f32, **locked** (no knob — f16 NaNs at step 3, measured) | If a knob exists it must do something; this one can't, so it doesn't exist |
| Steps (turbo) | Fixed 8, no knob (guidance-distilled) | Steps knob appears only for `sft`/`base` entries |
| Prompt persistence | Prompt box participates in tab state like other tabs; **prompt-library pair integration deferred to v1.1** (library stores positive+negative; turbo has no negative — wiring it now would show a dead field) | |
| Output format | `wav-f32` default, `wav-pcm24` alt (Demucs wording + clipping report) | |
| Proof gate | Playwright real clicks on isolated server (invariant 12) + pytest file `tests/test_music_ov.py` + VERSION bump per `AGENTS.md` §3 | Builder's job; spec states the gate |

---

## 4. Model catalog & capability-driven knobs (the core of this spec)

One table drives the dropdown AND knob visibility. `knobs` lists exactly what renders
for that entry; anything else is absent.

```js
MUSIC_MODELS = {
  'acestep-v15-turbo': {
    label: 'ACE-Step 1.5 turbo · 2B (proven)',
    enabled: true,
    knobs: ['prompt', 'lyrics', 'seed', 'duration', 'device', 'outdir',
            'format', 'overwrite', 'dryrun'],
    notes: 'Guidance-distilled: 8 Euler steps, shift 3.0, no CFG. f32 locked. '
         + 'proj_out runs on CPU via HETERO pin (measured fix, not a tunable).',
  },
  // ── Disabled placeholders (data-only enable later) ──
  'acestep-v15-sft': {
    label: 'ACE-Step 1.5 sft · 2B (needs export)',
    enabled: false, disabledReason: 'IR not exported — see §8',
    knobs: ['prompt', 'negative', 'lyrics', 'seed', 'duration', 'steps',
            'guidance', 'device', 'outdir', 'format', 'overwrite', 'dryrun'],
    notes: 'CFG ✓ (APG, null_condition_emb). Steps 8–60 (30–60 recommended).',
  },
  'acestep-v15-base': {
    label: 'ACE-Step 1.5 base · 2B (needs export)',
    enabled: false, disabledReason: 'IR not exported — see §8',
    knobs: ['prompt', 'negative', 'lyrics', 'seed', 'duration', 'steps',
            'guidance', 'device', 'outdir', 'format', 'overwrite', 'dryrun'],
    notes: 'CFG ✓, highest diversity. Same step range as sft.',
  },
  'acestep-v15-turbo-shift1': {
    label: 'turbo shift-1.0 recipe (needs export)',
    enabled: false, disabledReason: 'IR not exported — see §8',
    knobs: ['prompt', 'lyrics', 'seed', 'duration', 'device', 'outdir',
            'format', 'overwrite', 'dryrun'],
    notes: 'Same turbo weights, shift=1.0 sampling recipe.',
  },
  'acestep-v15-xl-turbo': {
    label: 'XL turbo · 4B (too heavy for this box)',
    enabled: false, disabledReason: '~9 GB weights need ≥12 GB VRAM',
    knobs: [],  // never renders knobs; entry documents the ceiling
    notes: 'Parked until bigger hardware. Listed so nobody re-researches this.',
  },
}
```

**Knob definitions (turbo v1)**

| Knob | Control | Range / default | Backend param |
|---|---|---|---|
| Prompt | textarea | default `A fast synthwave track with heavy bass` | `T2M_PROMPT` |
| Lyrics | text (SFT lyric block content) | default `[Instrumental]` | `T2M_LYRICS` |
| Seed | number + 🎲 dice button | int ≥ 0, default 42; same prompt+seed = bit-identical clip | `T2M_SEED` |
| Duration | number (s) | 10–60, default 12 (40 proven; <10 below model floor — clamp, don't allow) | `T2M_DURATION_SEC` |
| Device | select | `HETERO` (default) · `CPU` | `T2M_DIT_DEVICE` + `T2M_HETERO_PIN=proj_out` when HETERO |
| Hetero pin | **not a knob** — baked `proj_out` with a one-line legend | — | `T2M_HETERO_PIN` |
| Out dir | text + Folder | blank = next to CWD music outbox (server default) | `T2M_OUT` dir part |
| Format | select | `wav-f32` · `wav-pcm24` | post-convert after runner emits f32 |
| Overwrite | binary knob | Keep / Over (default Keep → `_0001…` suffix) | filename policy, not runner |
| Dry run | binary knob | Run / Dry (default Run) | validate + echo command, no job |

**Future knobs (rendered only for entries whose `knobs` list them):** `negative`
(textarea; pairs with prompt via the prompt-library component in v1.1), `steps`
(8–60), `guidance` (1.0–15.0, APG note).

---

## 5. Why the device list has no GPU-only (do not "fix" this)

Measured on the final IR: torch-vs-OVCPU cosine 0.999981 (graph exact) vs
torch-vs-OVGPU cosine **0.106**. Tap bisection (`add_outputs` per block, then per head
op) isolated it to the `proj_out` transposed-conv + bias-Add fusion (0.006 in → 7.29
out; 5D/RoPE/Power theories ruled out by measurement). The HETERO pin (8 nodes →
CPU, rest GPU) restores cosine **0.999998** and ear-verified music. Offering GPU-only
would be a knob that produces soup — banned by §1. If a future export heals the fusion,
that model's entry may list GPU; turbo's may not.

---

## 6. Backend contract

**Ops** (in `app/operations/music_ops.py`, registered per `operations/__init__.py` pattern):
- `music_generate(p: MusicGenerateParams) -> OperationResult` — builds env from params
  (§4 table, right column), runs the vendored runner via `shell.run_command` argv in a
  **serial per-host queue slot** (one 6 GB model job at a time — the OOM lesson),
  `report_progress()` per diffusion step + per 200-frame decode chunk, atomic WAV write,
  never-overwrite naming. Cooperative cancel between steps.
- `music_ov_setup(action=install|status, dry_run) -> OperationResult` — copies the §7
  manifest into `junk/models/music_ov/`, runs CPU single-step smoke, runs GPU probe
  (non-fatal, reported), all as HTTP 200 with `ok:false` + reason on failure.

**Params** (`MusicGenerateParams`, pydantic — mirror Demucs style with `Literal`s):
`prompt, lyrics, seed, duration_sec (10–60), model (Literal, default
"acestep-v15-turbo"), device (Literal["HETERO","CPU"]), output_dir|None,
output_format (Literal["wav-f32","wav-pcm24"]), overwrite, dry_run`.
Unknown model / out-of-range duration / unwritable out dir fail loudly pre-run.

**Routes**: `app/routes/music.py` with `register(app)` exposing
`GET /api/music_ov/status` (read-only: per-model `ir_present`, files, devices —
Demucs `get_demucs_ov_status` shape).

**Status payload** must include, per model entry: `enabled`, `ir_present`,
`artifacts_dir`, `files{}` presence map, `knobs[]` (so the frontend renders from
server truth, not a forked JS copy — single source of truth lives backend).

---

## 7. IR / artifact manifest (turbo v1)

Per-model file list the Setup op installs and the status op checks (names pinned;
sizes approximate, for the missing-file error text):

| File | Role | ~Size |
|---|---|---|
| `dit/openvino_model_f32_grok_fixed.xml` (+`.bin`) | DiT, f32 ports (the HETERO target) | 4 MB + 6 GB |
| `text_encoder/openvino_model.xml` (+`.bin`) | Qwen3-Embedding 0.6B OV | small |
| `decoder/openvino_model.xml` (+`.bin`) | Oobleck VAE FP32 OV | medium |
| Qwen embed layer + condition-encoder weights (torch) | lyric lookup + `AceStepConditionEncoder` (torch CPU) | from checkpoint dir |
| `silence_latent.pt` | timbre/src reference slices | small |
| runner script (vendored `generate_t2m.py` + version pin) | the engine entry | KB |

Setup also asserts: checkpoint dir present (torch weights), `junk/models/music_ov/` writable,
RAM headroom note (16 GB box: close browsers — learned the hard way).

---

## 8. Enabling a future model entry (checklist, not code)

1. Export IR (bf16 trace → f32-port surgery; 45+ min, 10 GB free, box to itself).
2. Run the tap-bidi validation (block taps → head taps; bar: final cosine ≥ 0.999,
   diffmax ~0.01) and record numbers in the entry's `notes`.
3. If a new fusion is guilty: new pin or new entry in the pin map (pin is per-model data).
4. Flip `enabled: true`, extend `knobs` per §4, extend `MusicGenerateParams` Literal +
   runner env map, add status manifest rows, pytest + Playwright proof.

---

## 9. v1.1 (explicitly out of v1): batch factory + prompt library

- Queue op: prompt list × seed list → serial `music_generate` calls, resume-safe
  skip-if-exists, per-clip metrics jsonl, **no auto-judge** (metrics misjudge bass;
  ears decide). Standalone script already implements this logic — port, don't redesign.
- Prompt box joins the shared prompt-library component **only when the selected model
  exposes `negative`**; turbo's single prompt field stays library-free (a pair component
  with one dead side is banned by §1).
- INT8 variant entry (speed) once an INT8-HETERO ear-check passes.

---

## 10. References (outside this repo)

Full session log: cause table, tap-bisection scripts (`bisect_blocks.py`,
`bisect_head.py`), probes (`probe_gpu_sweep.py`, `probe_1000.py`, `hetero_only.py`),
surgery scripts (`replace_pow2*.py`), merged LLM analysis. The spec above encodes the
conclusions; the evidence stays where it was gathered.

---

## 11. Acceptance (Builder's gate, stated here for the record)

1. Nav → Music tab renders; Model dropdown shows turbo enabled + 4 disabled placeholders
   with reasons; selecting turbo shows exactly the §4 knob set (prompt/lyrics/seed/
   duration/device/outdir/format/overwrite/dryrun) and **no** guidance/negative/steps/shift.
2. Setup installs manifest → status all-present → dry run echoes command, writes nothing.
3. Real 12 s HETERO run: progress ticks per step, WAV finite + healthy stats, zero new JS errors.
4. Failure honesty: unknown model / bad duration / missing IRs → HTTP 200 `ok:false`
   with plain reason; GPU failure never silently becomes CPU.
5. `tests/test_music_ov.py` green (params, catalog/knob matrix, setup dry-run, status shape).
6. VERSION bump + STATUS top-box per `AGENTS.md` §3.
