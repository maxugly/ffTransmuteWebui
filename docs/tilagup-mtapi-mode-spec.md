# tilagup → mtapi Mode — Spec

> **Status:** **Spec only** — not in mtapi tree; do not build without priority (`STATUS.md` §5)  
> **Source of truth (working code):** `/home/m/snc/cod/tilagup`  
> **Audience:** Spec writers & builders  
> **Related:** `STATUS.md`, `fastsdcpu-upscalers-spec.md`, `backlog/sd-tiled-upscale-spec.md` (legacy), `filter-platform-spec.md`, `tool-bottom-docs-spec.md`  
> **Not this:** A full rewrite of FastSD. Not a single fire-and-forget button with no mid-game.

---

## 1. Goal

Port the **product model** of **tilagup** (agent-driven tiled SD upscale with full run archives) into **mtapi-project** as a first-class **multi-step mode** — not a thinner CLI wrapper.

**Why move here**

| Standalone tilagup | Inside ffTransmute / mtapi |
|--------------------|----------------------------|
| Great archive + dry-run / resume | Same stages, but **WebUI + Image Pool + Convert + other ops** |
| Hard to insert “do something else” mid-run | **Pause after any stage**, hand tiles/base to other tools, come back |
| Presets are shell pairs | Presets as saved desk state + named recipes |
| FastSD subprocess is the only engine path | Engine pluggable later (FastSD worker **or** native OpenVINO img2img) |
| Zones designed, flat path shipped | Zones can land with a **zone map UI** (draw/edit bboxes) |

**User thesis (locked):** the most *complicated / awesome* outputs need **middle steps** — tweak prompts, re-prompt one bad tile, denoise a crop, swap a face region, re-run strength only — not a monolithic firehose.

---

## 2. What tilagup already is (as-built)

Do not re-invent from blog posts. Read the code.

```text
image
  → create run archive          runs/<image_key>/<run_id>/
  → stage: base_prompt          vision agent (agy / grok / stub)
  → stage: split                overlapping tile grid + crop PNGs
  → stage: tile_prompts         per-tile agent prompts (unique-first, CLIP-safe)
  → [optional dry-run stop]
  → stage: upscale              FastSD tiled SD (worker under FASTSDCPU_ROOT venv)
  → output.png + run.json stage=done
```

| Layer | State in tilagup |
|-------|------------------|
| Archives, loud CLI, dry-run / resume | **Shipped** |
| Base + **flat** tile prompts | **Shipped** |
| CLIP fit unique-first (~75 tokens) | **Shipped** |
| FastSD upscale via FastSD venv | **Shipped** |
| Texture packs (`grit` / `smooth`) | **Shipped** (upscale-time) |
| Presets (photo_soft, cartoon_ink, grit, …) | **Shipped** (shell) |
| **Semantic zones** (base → zone → tile) | **Designed** — `tilagup/design/zones.md` |

**Hierarchy (target, not fully coded):**

```text
base prompt     → soul / global style
zones[]         → coherent meaning regions (flame column, crowd, face…)
tiles[]         → execution grid; each tile owns a short local delta
FastSD stitch   → overlapping soft masks (geometry stays FastSD’s)
```

Flat grid works end-to-end today; without zones, multi-tile objects risk **quilting**. Zones are the main quality bet after migration.

---

## 3. Product shape in mtapi: a **mode**, not one op

### 3.1 Name

| Surface | Id |
|---------|-----|
| Nav / tab | **Tilagup** or **Tiled Agent Upscale** |
| Job kind | `tilagup` |
| Ops (HTTP) | staged endpoints under `/ops/tilagup/*` or one op + `action` |

Prefer **several thin ops** (clear resume) over one mega-handler with a 40-field body — same lesson as `imagesort_rank` vs `imagesort_rife`.

### 3.2 Stage machine (normative)

| Stage id | What happens | User can stop / edit after? |
|----------|--------------|-----------------------------|
| `init` | Copy source into job workspace; write `run.json` | — |
| `base_prompt` | Agent or **user-typed** base | **Yes** — edit textarea, re-run agent, or skip agent |
| `split` | Tile grid + export crops to `tiles/` | **Yes** — change tile_size/overlap → re-split (invalidates prompts) |
| `zones` *(v2)* | Discover / edit zone map; zone prompts | **Yes** — bbox editor + zone prompt list |
| `tile_prompts` | Fill missing tile prompts (agents or manual) | **Yes** — edit any `tiles/rXX_cYY.prompt.txt`; re-prompt one tile |
| `pre_process` *(new, mtapi win)* | Optional mid-pipeline ops on crops or full source | **Yes** — see §5 |
| `upscale` | Diffusion tiled upscale (FastSD worker first) | Resume on fail; re-run with new strength without re-prompting |
| `post` *(optional)* | SISR 2×, re-grain, convert | Other tabs / pipeline |
| `done` | Final still → Image Pool / path | |

**Default happy path (v1):**  
`init → base_prompt → split → tile_prompts → [user review] → upscale → done`

**Dry-run** = everything through `tile_prompts` (or `zones` when present), **no** SD. Same as tilagup `--dry-run`.

### 3.3 Why “middle is ideal”

mtapi already has the pieces tilagup lacks as a solo CLI:

| Mid-step idea | How in this workspace |
|---------------|------------------------|
| Fix one ugly tile prompt | List of tiles + text field; `POST …/reprompt_tile` |
| Soften photo preserve | Preset `photo_soft` (low variation + low strength) |
| Run **withoutBG / DeepDream / style** on a crop | Tile crop path is a normal absolute path → Image Pool / ops |
| Denoise source before split | Convert / SwinIR / future upscale tab, then set as tilagup source |
| Compare two strengths | Resume same run with new `strength`; keep prompts |
| Feed result into Sequence / video | Output PNG → Image Pool → Image Sort / zoompan / etc. |
| Long job ETA | Reuse job_control progress phases (`base`, `split`, `prompt`, `upscale`) |

**Do not** force users through every stage every time — but **always** materialize artifacts so they *can* intervene.

---

## 4. Workspace & archive (port tilagup layout)

Map tilagup `runs/` onto **JobWorkspace** (or a sibling under `~/.cache/mtapi/tilagup/`).

```text
{job_root}/
  run.json              # stage, config, agents_used, paths
  events.log            # append-only
  source.*              # copy of input
  base_prompt.txt
  tiles/
    r00_c00.png
    r00_c00.prompt.txt
    r00_c00.meta.json
    …
  zones/                # v2
  zone_map.json         # v2
  output.png
  timing.json           # optional ETA history
```

**Invariants**

1. Absolute paths in API.  
2. Atomic write of `run.json` (tilagup pattern).  
3. Resume by `job_id` / run path — never re-do completed stages unless `force`.  
4. Tile id format stay `rXX_cYY` for parity with existing runs (optional import of old tilagup archives).

---

## 5. Mid-pipeline hooks (the point of moving)

### 5.1 First-class pause points (v1 UI)

After **base**, after **tile_prompts**, before **upscale**:

- Primary button: **Continue**  
- Secondary: **Stop here** (stage frozen; user free to leave the tab)  
- **Re-run this stage** (force)

### 5.2 Optional `pre_process` stage (v1.5)

Between prompts and upscale, allow a **checklist of light ops** on either:

- full `source` (re-split if geometry changes), or  
- selected tile crops only (prompt stays; crop pixels change).

Examples (existing or backlog ops, not new engines):

| Op | Why mid-tilagup |
|----|-----------------|
| withoutBG on a subject tile | Clean plate before invent detail |
| mild SwinIR denoise | Reduce JPEG mush before SD |
| manual paint / external edit | User drops replaced `r02_c03.png` |
| strength / negative preset swap | No re-agent |

**Rule:** changing crop pixels does not clear prompts; changing **grid geometry** does.

### 5.3 Post chain

After `output.png`:

- Optional **SISR** (Real-ESRGAN from upscale backlog) for a cheap extra 2×  
- Optional **re-grain**  
- **Add to Image Pool** one-click  

This is where FastSD’s “EDSR after compose” idea lives — as a **separate** step, not baked invisible.

---

## 6. API sketch (v1)

Exact paths flexible; behavior is not.

| Endpoint | Body (core) | Result |
|----------|-------------|--------|
| `POST /ops/tilagup/init` | `image_path`, config (tile_size, overlap, agent, variation, strength, texture, preset) | `job_id`, `run_root` |
| `POST /ops/tilagup/base` | `job_id`, optional `prompt` override, `force` | base text + attribution |
| `POST /ops/tilagup/split` | `job_id`, optional new tile_size/overlap | tile list |
| `POST /ops/tilagup/tile_prompts` | `job_id`, optional `only_tile_ids[]`, `force` | progress per tile |
| `POST /ops/tilagup/set_prompt` | `job_id`, `tile_id` \| `base`, `text` | manual edit |
| `POST /ops/tilagup/upscale` | `job_id`, optional strength override | `output_path` |
| `GET /ops/tilagup/status` | `job_id` | stage, tiles statuses, ETAs |

**WebUI always owns order** after dry-run (same client-owned philosophy as Image Sort). Headless may chain with `auto_continue: true`.

Progress: `job_control.report_progress` every tile prompt and every upscale tile if the worker can report; at least phase boundaries.

---

## 7. Engine adapter

### v1 — keep what works

```text
mtapi tilagup upscale stage
  → subprocess: FASTSDCPU_ROOT/env/bin/python -m tilagup.upscale_worker
     (or vendored copy of worker + clip_fit under app/tilagup/)
```

- Reuse **CLIP unique-first** logic from `tilagup/clip_fit.py` / worker.  
- Reuse tile geometry from `tilagup/tiles.py`.  
- **Do not** install torch into mtapi’s slim venv.

### v2 — native OpenVINO path (optional)

Align with cleaned `sd-tiled-upscale` design: same tile prompts, different backend. Adapter interface:

```python
class TiledUpscaleEngine(Protocol):
    async def run(self, job: TilagupJob) -> Path: ...
```

Engines: `fastsd` | `openvino_img2img` (later).

---

## 8. Agents

Port the roster concept, not the CLI packaging forever:

| Agent | Role |
|-------|------|
| `agy` / `grok` | Vision CLIs on PATH (as today) |
| `both` | Alternate tiles (attribution variety) |
| `stub` | Offline / CI |
| `manual` | User supplies all prompts; agents never called |

**CLIP rules (non-negotiable, from tilagup rationale):**

- ≤ ~50 words / ~75 tokens target for tile prompts  
- **Unique-first** fit at upscale (strip restated base, keep local, then style tail)  
- One rewrite pass if agent essays  

---

## 9. Presets → WebUI recipes

Map shell presets to a `<select>` + defaults:

| Preset | variation | strength | texture | Notes |
|--------|-----------|----------|---------|--------|
| `default` | 0.35 | 0.28 | none | Balanced |
| `photo_soft` | 0.20 | 0.18 | none | **Best photo preserve** on this stack |
| `cartoon_ink` | 0.40 | 0.32 | none | Negatives ban photo/3d |
| `grit` | 0.35 | 0.28 | grit | Texture pack |
| `grit_hot` | 0.35 | 0.40 | grit | More rewrite |
| `smooth` | 0.35 | 0.28 | smooth | |

Negatives / texture packs live in config JSON, not magic strings in the SD call only.

---

## 10. UI sketch

```text
┌ Tilagup · Tiled agent upscale ─────────────────────┐
│ [pre-run / job summary strip]                      │
│ Source: [path] [Browse] [From Image Pool]          │
│ Preset: [photo_soft ▼]  Agent: [both ▼]            │
│ tile_size / overlap / variation / strength knobs   │
│                                                    │
│ Stage rail: Init · Base · Split · Prompts · Upscale│
│             ●──────●──────○────────○─────────○     │
│                                                    │
│ Base prompt [ textarea .............. ] [Re-agent] │
│                                                    │
│ Tile grid (select) │ Prompt editor                 │
│  [r0c0][r0c1]…     │ (selected tile text)          │
│                    │ [Re-prompt tile] [Save]       │
│                                                    │
│ [Dry-run / Generate prompts]  [Run upscale]        │
│ [Resume job…]                                      │
│ ─────────────────────────────────────────────────  │
│ .tool-docs  About · hierarchy, strength, zones…    │
└────────────────────────────────────────────────────┘
```

Bottom docs: base vs tile prompts, strength vs variation, photo_soft tip, zones roadmap, “why mid steps.”

---

## 11. Relationship to other specs

| Doc | Relationship |
|-----|----------------|
| `fastsdcpu-upscalers-spec.md` | Engine catalog; tiled SD = tilagup’s **upscale** stage only |
| `backlog/sd-tiled-upscale-spec.md` | **Superseded in spirit** by this + tilagup code; rewrite or mark “see tilagup-mtapi-mode-spec” (strip FLUX digression) |
| `backlog/upscale-spec.md` | SISR post-pass after tilagup, not a replacement |
| `filter-platform-spec.md` | Tilagup is **multi-source / multi-stage job**, not a single `per_frame` filter — but upscale worker should still emit one final still; video = later |
| Image Pool | Source pick + output land |

---

## 12. What “doesn’t do as much as it could” (gap list)

From tilagup + this host environment — **build these as mtapi stages**, not endless CLI flags:

| Gap | Why it matters | Priority |
|-----|----------------|----------|
| **Zones not coded** | Coherence across multi-tile objects | P0 after flat port |
| **No interactive prompt edit** | Dry-run is inspect-only in practice | P0 (WebUI) |
| **No single-tile re-prompt / re-upscale** | One bad face ruins a 64-tile run | P0 |
| **No mid ops on crops** | Can’t withoutBG / edit / denoise mid-flight | P1 |
| **No Image Pool handoff** | Friction copying paths | P1 |
| **Engine locked to FastSD layout** | Fine for v1; abstract for v2 | P2 |
| **No video / frame folder** | Still-first; video = dump → per-frame tilagup is insane cost | Out of scope v1 |
| **Parallel agent fan-out** | Speed only | P3 |

---

## 13. Migration plan (builder order)

### Phase A — Library extract (no UI)

1. Vendor or path-import pure modules: `tiles`, `clip_fit`, archive helpers, prompts_lib (no FastAPI).  
2. Job workspace under mtapi.  
3. Curl: init → base(stub) → split → tile_prompts(stub) → dry complete.

### Phase B — Upscale adapter

4. Wire FastSD worker with `FASTSDCPU_ROOT`.  
5. One real upscale on `/tmp/teste.png`-class image (small grid).  
6. Progress phases + cancel.

### Phase C — WebUI mode

7. Tab + stage rail + base/tile editors.  
8. Dry-run + upscale buttons.  
9. Presets.  
10. Bottom docs.  
11. Image Pool “send here” / “add output.”

### Phase D — Power

12. Zones (follow `tilagup/design/zones.md`).  
13. Single-tile re-upscale.  
14. pre_process hooks.  
15. Optional OpenVINO engine.

**Do not** delete `/home/m/snc/cod/tilagup` until Phase C is preferred daily driver; keep CLI as reference + stress harness.

---

## 14. Non-goals (v1)

- Replacing Image Sort / RIFE.  
- Full SAM masks (rect zones first).  
- Running full SD on every video frame.  
- Embedding Grok/agy API keys in mtapi (stay CLI-on-PATH).  
- Shipping FLUX/PixArt digressions inside this mode (belong elsewhere).  
- Silent long jobs (progress + stage always visible).

---

## 15. Verification

### Phase A/B

```bash
# stub dry chain (once ops exist)
curl -s -X POST localhost:24590/ops/tilagup/init -d '{"image_path":"/tmp/teste.png","agent":"stub",...}'
# … base, split, tile_prompts …
# upscale only if FASTSDCPU_ROOT set and user ok with time
```

### Phase C (WebUI)

1. Open **Tilagup** tab; load still from Image Pool or path.  
2. Dry-run → base + tiles appear; edit one prompt; save.  
3. Upscale → `ok: true`, output preview.  
4. Resume after kill mid-prompts → continues without wiping.  
5. Console clean; progress updates per tile.

**DONE for builder** = staged ops + WebUI dry-run + at least one full upscale path.  
**DONE for this spec** = accepted product shape (multi-step mode, mid hooks, port order).

---

## 16. One-line summary

**tilagup is not “another upscaler checkbox” — it is a multi-stage, archive-backed, agent-prompted tiled diffusion job.** mtapi should host it as a **mode with pause points**, so the middle of the pipeline (prompt craft, tile surgery, other tools) is where the awesome outputs get made.
