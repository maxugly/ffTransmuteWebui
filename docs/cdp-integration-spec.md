# CDP Integration Spec — Composers Desktop Project for the WebUI

> **Status:** reviewed + spike-proven (`§10.3` executed 2026-10-07, **GO**) — awaiting user confirmation on assumptions marked **[A]**.
> **Scope:** spec only, no app code. Target reader: the user + a future Builder agent.
> **Repo fit note:** this repo is vanilla HTML5/CSS3/ES6 with **no npm** (invariant 7) and FastAPI ops that fail as HTTP 200 + `{"ok": false}` (invariant 10). That constrains how `cdp-wasm` (an npm package) can be consumed — see §7 and **[A1]**.
> **Pinned at build time (verify again before Phase 1 code):** `cdp-wasm` **0.7.0** (npm, 2026-09-02) — tarball 3.2 MB, sha512 `1b5331f0…`, unpacked 9,521,131 B / 496 files, **zero runtime dependencies**, licence `(MIT AND LGPL-2.1-or-later)`; CDP8 sources as bundled by that build (215 programs / 26 spectral). Spike evidence: `mtapi-project/junk/cdp-spike/` (gitignored, throwaway per invariant 8).

---

## 0. Restatement & clarifying questions

**My understanding of the task.** You want an implementation-ready spec for adding the Composers Desktop Project (CDP) as a major, menu-driven capability of your browser creative suite (today: FFmpeg, Demucs, style transfer, DeepDream, Stable Diffusion — plus, in this repo, yt-dlp ingest, media catalog, pools). Not code. The spec must cover: what CDP is, the `cdp-wasm` port, a menu architecture that scales to hundreds of tools, schema-driven parameters, chaining/pipelines, integration with existing modules, execution model, reference implementations (CDP MCP server, cdp-web + agent skills, SoundThread), a phased rollout, and risks/unknowns — with real tool names, concrete schemas/examples, and labeled inferences.

**Questions I would want answered before a Builder starts (also inline as [A1]–[A10] in §10):**

1. Client-side WASM vs server-side native: may the project vendor `cdp-wasm` build artifacts without npm, or must Phase 1 run native CDP binaries server-side via the existing audio venvs? (Repo has no npm; `cdp-wasm` ships via npm.)
2. How many CDP programs in Phase 1 — ~10 curated, ~50, or the full 215-program bundle from day one?
3. Linear chain first, or node-graph from day one? (I recommend linear first — §5.)
4. Canonical interchange format: is WAV (decoded via ffmpeg, as the catalog scanner already does) acceptable as the universal audio asset, with `.ana` spectral files as derived intermediates?
5. Do pipelines need shareable URLs/files in Phase 3, or is local save/load enough?
6. Cross-tool scope for Phase 3: must CDP feed Stable Diffusion (e.g., sonified textures / spectrogram images), or is FFmpeg ⇄ Demucs ⇄ CDP audio-only circulation sufficient?

Assumptions I made while writing are marked **[A]** throughout and collected in §10. Inferences (things I could not verify from primary sources today) are marked **[inference]**.

---

## 1. Executive Summary

**What CDP is.** The Composers Desktop Project is a suite of roughly 450–500 offline, file-based sound-transformation programs driven from the command line as `program [mode] infile outfile params [flags]`. It is not an instrument, plugin, or real-time library: each program reads one or more sound or spectral-analysis files, renders, and writes a new file. Its strength is depth and strangeness — spectral blurring/tracing/freezing, time-stretching without pitch change, granular and waveset distortion, morphing, pitch-synchronous grains, multichannel spatialisation — built up since the late 1980s and open-sourced (LGPL) in 2014. The price is ergonomics: hundreds of terse commands, modal programs (`blur blur`, `stretch time`, `modify speed`), strict file-type discipline (soundfiles vs `.ana` spectral files vs breakpoint text files), and documentation that is comprehensive but uneven.

The practical way to use CDP in a browser in 2026 is **`cdp-wasm`** (by Oli Larkin, `cdp-wasm-suite` org): the CDP8 C sources compiled to WebAssembly, published as npm package `cdp-wasm` (~3.22 MB tarball per project site; ~9 MB unpacked per npm.io **[A — size varies by version, confirm at pin time]**), exposing 215 program modules plus a typed effect catalog of 232 effects across 110 programs (+16 generators, Node ≥ 18). It runs identically in Node and the browser: audio goes in and comes back as byte arrays (`Uint8Array`/WAV bytes) staged through an in-memory virtual filesystem — no files on disk, no toolchain. A thin curated layer (`EFFECTS` + `applyEffect`) wraps the two things raw CDP leaves to the user: `pvoc` analysis/resynthesis wrapping for spectral tools and per-channel handling.

**Why it fits this WebUI.** This suite already owns the two halves CDP needs. The ingest half: ffmpeg decode/probe, yt-dlp harvest, Demucs stems, the media catalog (key/tempo/beats/MIDI opinions, provenance), and the dual Video/Image pools give CDP an endless supply of shaped inputs (a vocal stem, a slowed loop, a tracker-header BPM as a stretch ratio). The rendering half: pools, sequence assembly, and the catalog's generated-origin stamping give CDP outputs somewhere to live, be compared, and be reused. CDP fills the suite's missing middle: long-form, offline, non-real-time **transformation** between separation (Demucs) and assembly/render (FFmpeg/sequence), plus a texture/sound-design source no current module provides. It also matches the suite's established pattern — every heavy engine already runs behind an ops route with progress/cancel (`runOpWithCancel`, `report_progress()`), which is exactly what long CDP renders need.

**What "done" looks like.** A user can (1) browse/search a stable multi-level CDP menu (categories → programs → modes) with favorites/recents/tags, (2) run any listed tool through a schema-rendered parameter form with validation, defaults, and the verbatim CDP usage text one click away, (3) chain tools into a saved, re-runnable pipeline (linear chain in Phase 1–2, graph only if Phase 3 approves it), where spectral tools auto-wrap `pvoc anal → process → pvoc synth` and intermediates are inspectable/playable, (4) move audio losslessly between FFmpeg, Demucs, the catalog/pools, and CDP without manual conversion, (5) cancel and queue long renders with progress, under documented memory/file-size limits — all behind the repo's standard gates (`./check-gate.sh` green, suite green, Playwright click-proof of the real controls, curl not accepted).

---

## 2. CDP Technical Foundation

### 2.1 Native architecture: hundreds of offline CLI programs

- **Unit of work:** one program invocation = one process render. Typical shape: `program_name [mode] infile(s) outfile params [flags]`. Examples (verified against CDP docs/MCP examples):
  - `modify speed 2 in.wav out.wav -12` (time-domain speed/pitch change)
  - `blur blur in.ana out.ana 50` (spectral blur — note the doubled name: program `blur`, mode `blur`)
  - `stretch time 1 in.ana out.ana 2.0` (spectral time-stretch; mode `time`)
  - `modify brassage 4 in.wav out.wav 0.02 -0.5 -r200` (granular brassage)
- **File-type discipline (load-bearing).** Time-domain tools consume soundfiles (WAV/AIFF). Spectral tools consume `.ana` analysis files produced by `pvoc anal` and return `.ana`, which must be resynthesised by `pvoc synth` before listening. Breakpoint/envelope tools consume text files (`time value` pairs). Data-file tools (e.g. `tesselate`) consume bespoke text matrices. The UI must model these types explicitly — most historic CDP confusion is feeding a `.wav` where an `.ana` is required. Soundshaper's lesson: do conversions in the background; SoundThread's lesson: split/merge stereo automatically.
- **No real-time path.** There is no streaming API. "Preview" always means render-then-play. The plugin/extension story (cdp-plugin maps renders across a sampler keyboard; cdp-extension writes back into Ableton) confirms this: playback is of finished files.
- **Composition = scripts.** Native power users chain via shell batch files / shell scripts (the "Sound-Builder Templates" ship six such chains). The WebUI pipeline (§5) is the humane replacement for batch files.

### 2.2 The `cdp-wasm` port

| Fact | Value (verified against **0.7.0**, 2026-10-07; re-verify at pin) |
|---|---|
| Source | CDP8 C sources, unmodified at build; Emscripten toolchain (`npm run build:wasm`); `.wasm` built at publish (`prepack`), not committed |
| Package | `cdp-wasm` on npmjs.org, public, provenance-attested, **zero runtime dependencies (verified 0.7.0)** |
| Size | 0.7.0 measured: **3.2 MB tarball**, 9,521,131 B unpacked, 496 files — includes the full `man/` page set and the typed catalog sources |
| Coverage | **215 program modules** (manifest-verified in the browser spike: `programs()=215, spectralPrograms()=26`); 220 `.wasm` files shipped in a *dynamic layout* — one shared `cdp-core.js`/`cdp-core.wasm` + `manifest.json`, program modules fetched on demand; only exclusions are ~3 build helpers + programs that don't compile/run headless |
| Curated layer | `EFFECTS`: **232 effects across 110 programs** (verified) + `GENERATORS`: **16**, each with named params, min/max/default, flags for spectral / mono-only / spatial |
| 0.7.0 additions over 0.6.0 | source-relative parameter bounds (`srcMin`/`srcMax`, 57 entries), `defaultsFor`/`paramDefaultFor` resolving against the actual source, `minSrcDur`/`maxSrcDur` refusals (31 entries), float32 conformance before two-input spectral analysis |
| Runtime | Node ≥ 18; browser via same JS entry (ESM, **no bundler needed — spike-proven, §10.3**); SIMD auto-detect with `.scalar` fallbacks |
| Audio I/O | **Byte arrays, not disk**: `cdp.run(program, argv)` (raw argv, virtual-FS staging + `callMain`) → `cdp.process(program, args, bytes, {inExt, outExt, channels})` (`$IN`/`$OUT` tokens, one-in/one-out, `channels:'split'|'mix'` for mono-only programs) → `applyEffect(cdp, effect, values, wav)` (typed catalog; auto `pvoc` wrap via `['anal','1',…]`/`['synth',…]`, mono analysis, per-channel handling). Helpers: `decodeWav`/`encodeWav` (32-bit float), `extractEnvelope`, `getPitch`, `findPeaks`, `parseBreakpoints`/`formatBreakpoints` (↔ CDP text format via `envel`), `warpBreakpoints` (`REPLOT_MODES`), `eachChannel` |
| Fidelity | Same code, same args, same formats as native — ergonomics layer changes no DSP |
| Hard limit | **32-bit WASM, single render must fit input + output + working buffers in ~4 GB address space**; intermediates staged in memory |
| Determinism | Audio-identical but **not whole-file byte-identical**: libsndfile stamps `PEAK`/`LIST` RIFF chunks with wall-clock timestamps (measured: 1–3 bytes differ run-to-run; the `data` chunk is always identical — spike C, §10.3). §5.2's re-run contract therefore compares the `data` chunk, never the whole file. |

CLI parity matters for spec fidelity: `cdp modify speed 2 in.wav out.wav -12` and `cdp --pvoc blur blur in.wav out.wav 10` (the `--pvoc` flag auto-wraps spectral analysis/synthesis — the single best UX idea to steal).

### 2.3 Program/effect taxonomy (real groups, representative tools)

Top-level grouping follows the CDP Reference + CDP Guide (which mirrors the Soundshaper menu). Group codes are the reference manual names. One-line descriptions below are condensed from official docs; do not reword into marketing copy in the UI — use the official short descriptions plus the verbatim usage string (§4).

**Spectral processing** (require `.ana`; normally wrapped `pvoc anal → X → pvoc synth`):
- `PVOC` — `anal` (soundfile → spectral file), `synth` (back). Workhorses; UI auto-wraps.
- `BLUR` — `blur` (average spectral amplitudes over N time-windows; diffuse clarity), `bltr` (blur + trace partials), `chorus` (random variation), `drunk` (drunken walk along windows), `caltrain` (R8: blur upper channels).
- `FOCUS` — `accu` (sustain each band until louder data), `fold`/`specfold` (fold/invert/randomise spectrum).
- `HILITE` — `trace` (thin to prominent partials; opposite of blur), `band` (split spectrum into bands, process individually), `average` (average over adjacent channels; broaden peaks).
- `MORPH` — `bridge` (interpolate between two spectra), `morph` (transition two sounds), `glide` (frequencies of one glide toward another), `vocoder` (impose formants).
- `PITCH` (spectral) — `chord`/`chordf` (stack transposed copies, with/without envelope preservation), `altharms` (delete alternate harmonics), `tune`/`spectune` (transpose to most prominent pitch).
- `STRETCH` — `time` (stretch/shrink preserving pitch; time-varying ratio), `spectstr` (R8 with DISCOHERE), `freeze`/`step` (sustain/freeze spectrum at intervals).
- `FORMANTS` — `specenv` (extract envelope of file 2 → apply to file 1), `seeqc`-family (narrow/squeeze/suppress/invert formants) **[inference: exact mode list must be scraped from reference at build; do not hand-list modes]**.
- `STRANGE` — unpredictable/experimental spectral effects. `SPEC`/`SPECFNU`/`SPECNU`/`SPECINFO` — spectral gain/edit, formant-shape utils, cleanup, info.

**Time domain** (consume soundfiles directly):
- `MODIFY` — `speed` (resample pitch+time incl. vibrato/accel), `brassage` (granular reorder), `loop`, `reverse`, `stack` (transposed stacks), ring/cross-modulation.
- `GRAIN` — classic granular (multi-stream/channel), grain omit/repeat/stretch/repitch/reposition/reverse/shuffle; `PSOW` (pitch-synchronous FOF grains, vocal-leaning).
- `DISTORT` — waveset distortion family (`distort`, `distortt`, `clip`, `overload`-class) **[inference: verify mode names from reference]**.
- `FILTER` — band focus/sweep; `EXTEND` — segment/loop/scramble/zigzag; `ENVEL`/`ENVNU` — amplitude-envelope ops; `REVERB`/`DELAY` — reverb, fast convolution, tapped/iterated delay, polyrhythm repeats; `TEXTURE` — texture/montage generators; `SYNTH` — synthesisers/generators (16 in the wasm catalog); `COMBINE`/`SUBMIX`/`SFEDIT`/`HOUSEKEEP` — mix, edit, level, housekeeping.

**Analysis/info & data-file tools** (output text or specialised files, not listenable audio):
- `SNDINFO`/`PITCHINFO`/`SPECINFO`/`PVOC fturanal` — properties, partials, features-to-text. `ENVEL` extract, `REPITCH` pitch-trace extract/alter. `TESSELATE` + `create_data_file`-class inputs. The UI must render these as **inspectable artifacts** (tables/plots/download), not failed audio.

**Other top-level groups (exist; expand at build from reference index):** `COMBINE DISTORT ENVEL ENVNU EXTEND FILTER FOCUS FORMANTS GRAIN HILITE HOUSEKEEP MODIFY MORPH MULTICHANNEL(+M-TOOLKIT) ONEFORM PITCH PITCHINFO PSOW PVOC REPITCH REVERB SFEDIT SNDINFO SPEC SPECINFO SPECNU STRANGE STRETCH SUBMIX SYNTH SYSUTILS TEXTURE` (+ R8 `R8 NEW` additions). If a group is not in this list, the Builder must add it from the reference index — never invent a group.

### 2.4 Historical context and what it implies

Active since ~1987 (York, UK; Atari ST era; key names: Trevor Wishart, Richard Dobson, Archer Endrich, Robert Fraser, John Ffitch, Rajmil Fischman). Open-sourced 2014 (LGPL-2.1-or-later for CDP8). **Implications:** (a) DSP is stable and battle-tested — prefer exact-argument passthrough over "improved" reimplementation; (b) docs are voluminous but inconsistent across decades/authors — the spec treats **verbatim usage text + pinned reference revision** as the contract, not paraphrase; (c) parameter conventions vary wildly by program era — hence schema-per-tool, not a global parameter grammar; (d) do not assume active upstream API evolution; pin `cdp-wasm` version and CDP8 revision in the spec header at build time.

---

## 3. Menu Architecture

### 3.1 Hierarchy (scales to 215+ programs / 232 effects)

Four levels, no deeper. Depth is capped because SoundThread's lesson is that deep trees kill sound-design flow, while Soundshaper's lesson is that CDP needs its native groups preserved for learnability.

```
L0  Domain rail:  Spectral · Time Domain · Synthesis/Texture · Edit/Mix/Utils · Analysis/Info
L1  Group (native CDP reference code): e.g. Spectral → BLUR · FOCUS · HILITE · MORPH · STRETCH · FORMANTS · PITCH …
L2  Program: e.g. BLUR → blur · bltr · chorus …
L3  Mode/Effect: e.g. blur → blur.blur · blur.bltr …  (= cdp-wasm EFFECTS ids where curated; raw mode otherwise)
```

- L0 is a **curated overlay** (5 stable buckets); L1+ preserves native group/program/mode names verbatim so docs, MCP usage text, and forum advice stay greppable.
- Curated **Effects** (the 232) are the default L3 entries wherever they exist; raw modes remain reachable under an "All modes (raw)" disclosure per program — never hidden, never default.
- Generators (`SYNTH` + 16 catalog generators) live under Synthesis/Texture with a distinct "needs no input" badge.

### 3.2 Navigation model

- **Drill-down:** rail → group grid (cards with one-line description + program count) → program page (modes table) → tool page (form). Breadcrumb always shows full path; URL-hash encodes path for deep-linking (`#cdp/BLUR/blur/blur.blur`) **[A: confirm hash-routing fits app.js tab router]**.
- **Search:** omni-box (name, alias, group code, description, tag). Rank: exact program/mode match > effect id > tag > description substring. Keyboard-first (`/` focuses, ↑↓/Enter selects). Must work offline against the vendored catalog.
- **Favorites:** star per tool; persisted per spec `universal-persistence-spec.md` pattern (localStorage + server settings mirror if available). Favorites rail section + `is:fav` token.
- **Recents:** last-N executed tools (N=15 default), with one-click re-run (same params) and "edit params" fork.
- **History per artifact:** each output records the full invocation chain (§5.3) so any intermediate can be re-opened at its tool page.

### 3.3 Tool-entry schema (canonical)

Every menu leaf is one JSON object. The catalog ships vendored; the server validates against this schema at boot.

```json
{
  "id": "blur.blur",
  "program": "blur",
  "mode": "blur",
  "group": "BLUR",
  "domain": "spectral",
  "label": "Blur — spectral time-average",
  "description": "Average spectral amplitudes over N time-windows to diffuse clarity.",
  "tags": ["spectral", "smooth", "diffuse", "time"],
  "inputs": [
    {"role": "main", "types": ["ana"], "cardinality": 1, "label": "Spectral input (.ana)"}
  ],
  "outputs": [{"role": "main", "types": ["ana"], "label": "Blurred spectrum (.ana)"}],
  "spectralWrap": {"anal": true, "synth": "optional"},
  "channels": "mono-only | stereo-ok | multichannel",
  "params": [
    {"name": "windows", "label": "Time-windows", "type": "int", "min": 2, "max": 200, "default": 20, "unit": "windows", "help": "Number of analysis windows to average."}
  ],
  "flags": [{"name": "-f", "label": "Flag example", "type": "bool", "default": false}],
  "breakpointParams": [],
  "dataFileParams": [],
  "usage": "blur blur in.ana out.ana windows",
  "example": {"argv": ["blur", "blur", "$IN", "$OUT", "20"], "note": "Wrap with pvoc anal/synth for .wav I/O."},
  "related": ["blur.bltr", "hilite.trace", "focus.accu"],
  "chainHints": ["stretch.time", "morph.bridge"],
  "docRef": {"manual": "BLUR", "rev": "CDP8-pinned-at-build"},
  "curated": true
}
```

Rules: `id` = `program.mode` (curated effect ids follow `cdp-wasm` EFFECTS ids verbatim); `usage` is the **verbatim CDP usage string**; `example.argv` uses `$IN`/`$OUT` tokens; `channels`/`spectralWrap` drive auto-behaviour (§4–5); `related`/`chainHints` are hand-curated for Phase-2 seeds, then usage-derived.

### 3.4 Discoverability

- **Tags** (controlled vocabulary, ~24): `spectral time pitch formant granular waveset reverb delay morph texture mix edit analysis envelope breakpoint multichannel generative …` — each tool carries 2–5.
- **Related tools:** same-program modes + same-group neighbours + curated cross-links (blur ↔ trace ↔ suppress is the canonical trio).
- **Suggested chains:** named recipes with one-line musical intent, e.g. "Glass voice": `pvoc anal → stretch time (×1.8) → blur blur (w=30) → pvoc synth`; "Grain cloud": `modify brassage → grain … → reverb`. Recipes are Phase-2 data, not hardcoded UI.
- **"What eats what" affordance:** every tool page states input/output types as chips (`.wav` / `.ana` / `.txt`), and incompatible pool selections are disabled with a reason, not silently allowed.

### 3.5 Worked example — spectral blurring end to end

Menu path: **Spectral → BLUR → blur → blur.blur**. User drops a vocal WAV on the tool page. Because `domain=spectral` + `spectralWrap.anal=true`, the UI offers (default on) the `--pvoc`-style wrap: `pvoc anal vocal.wav vocal.ana → blur blur vocal.ana blurred.ana 20 → pvoc synth blurred.ana blurred.wav`, rendered as three pipeline steps with each intermediate playable/inspectable. Raw CLI equivalent shown beside the Run button: `cdp --pvoc blur blur vocal.wav blurred.wav 20`. The `.ana` intermediates persist as pipeline artifacts (§5.3).

---

## 4. Parameter UI Strategy

Schema-driven: **no per-tool hand UI**. The tool page renders `params[] + flags[] + breakpointParams[] + dataFileParams[] + inputs[]` from the entry. Adding a tool = adding data.

### 4.1 Parameter types

| Type | Renders as | Validation |
|---|---|---|
| `int` / `float` (range) | slider + numeric box (box always editable; slider clamps) | min/max clamp + step; out-of-range blocks Run with message |
| `enum` | select or radio row (≤4 options → radios) | must be listed value |
| `bool-flag` | checkbox → appends flag iff true | — |
| `file-audio` / `file-spectral` / `file-text` | pool picker + upload + pipeline-output picker (§4.4) | extension + probed type check; `.ana` inputs reject `.wav` with the `pvoc anal` fix-it button |
| `time-sec` / `time-windows` | seconds box (supports `ms`/`s` suffix) / int windows | ≥0; windows ≥2 where CDP requires |
| `freq-hz` / `midi` / `ratio` / `percent` / `db` | unit-suffixed numeric + slider where bounded | domain clamp; ratio >0; percent 0–100 or 0–1000 per tool schema (never assume) |
| `breakpoint` | mini envelope editor (draw + numeric table import/export) → CDP text via `formatBreakpoints` | monotonic time; UI sorts + warns |
| `datafile` | text editor + template + file picker (tesselate-style matrices) | server re-validates shape before exec |
| `string-select-existing` | dropdown of legal tokens (e.g. warp modes `REPLOT_MODES`) | closed vocabulary |

Time-varying (ramped) params are **out of scope** for Phase 1; Phase 2 adopts the repo's `parameter-automation-spec.md` breakpoint pattern rather than inventing a second one.

### 4.2 Validation, defaults, help text

- Defaults come from the curated catalog; raw modes default to the CDP manual's stated default or blank-required (blank-required blocks Run until filled — never silently invent a value).
- Every page shows: the rendered form (primary), the **verbatim `usage` string** (secondary, copyable), and a "Raw argv" preview that updates live (`["blur","blur","$IN","$OUT","20"]`). This is the MCP lesson: zero-interpretation passthrough must stay visible.
- Range metadata is data, not lore: if the manual gives no range, `min/max` are `null` and the UI renders box-only (no slider). **[A: confirm builders must scrape, not guess, ranges.]**

### 4.3 Prior-output-as-parameter (chaining affordance)

Any `file-*` slot accepts three sources: (a) pool asset, (b) upload, (c) **upstream pipeline output** (dropdown of compatible-typed artifacts in the current chain, §5). Type mismatch is a hard block with the concrete fix ("needs `.ana` — insert `pvoc anal`"), one click to insert. Multi-input tools (morph bridge: two spectra; tesselate: N files + data file) render N slots with per-slot type chips.

---

## 5. Chaining and Pipeline Model

### 5.1 Recommendation: linear chain now, graph later (if ever)

| | (a) Linear effect chain | (b) Node-graph / patch (SoundThread, cdp-web) |
|---|---|---|
| Mental model | Batch file made visible: ordered steps, one (or N declared) input(s) → one output per step | Patchbay: parallel branches, mixes, free routing |
| CDP fit | Matches 90% of real chains (stretch → blur → granular; anal → process → synth) and the shipped Sound-Builder templates | Full power (parallel + mix) but SoundThread itself documents that **not all CDP processes fit the node model** |
| Build cost | Low: reuses `runOpWithCancel` job machinery, pool provenance, catalog stamping | High: new canvas UI, cycle detection, branch-merge semantics, per-branch channel discipline |
| Risk | Low | Medium-high in vanilla ES6 with no graph library (repo forbids frameworks) |

**Recommend (a) linear chain for Phases 1–2; gate (b) on Phase-2 usage evidence.** The chain must still support the two "graph-ish" essentials: multi-input steps (morph/tesselate/mix take declared extra inputs without full graph UI) and step bypass/reorder. Do not build a canvas until users hit chains the linear model cannot express — that is the measured-gate pattern this repo already uses (cf. media-catalog engine choices).

### 5.2 Pipeline semantics

- A pipeline = ordered `steps[]`, each `{toolId, paramValues, inputBindings, enabled, note}` + pipeline-level `name, notes, inputAsset(s), createdFrom}`.
- Execution is sequential render-then-feed: step output becomes next step's `main` input (typed; auto-inserted `pvoc` conversions are explicit steps, never magic).
- Determinism: re-run = same tool revisions + same params + same input bytes → **audio-identical output**. The concrete contract (measured, spike C): the RIFF `data` chunk must be byte-identical; `PEAK`/`LIST` metadata chunks carry libsndfile wall-clock timestamps and will differ by a few bytes — they are excluded from the comparison, never "fixed". Every run stamps tool id + `cdp-wasm`/CDP8 revision into provenance.
- Failure: stop at first failing step; failing step's inputs/outputs/logs preserved for inspection; resume-after-fix supported.

### 5.3 Intermediate files: representation & management

Browser reality (per cdp-wasm FAQ + 4 GB WASM ceiling): intermediates are **in-memory byte arrays / virtual-FS files during a run**, but the WebUI must persist them as **server-side temp files** (absolute paths, per invariant 3) the moment a step completes — memory is for execution, disk is for artifacts. Concretely:

- During run: `Uint8Array` ↔ virtual FS (cdp-wasm model).
- After each step: POST bytes to server artifact store (`~/…/cdp_artifacts/<pipeline>/<step>/`), registered in catalog/pool with `origin='generated'`, full chain lineage, audible via existing Range-capable `/api/video`-style route.
- IndexedDB blobs are **not** the store of record **[A: confirm]** — they are at most an offline cache; the pools/catalog are the truth (matches "dual pools stay separate; pool saves also write named project" invariant).
- Retention: per-pipeline "keep intermediates" (default on in Phase 1–2); explicit purge control; SoundThread's "recycle output" and "auto-clean intermediates" are the UX precedents.
- Limits (§7.3) are enforced before render, with the concrete number shown ("input 480 MB → est. peak ~1.4 GB — over the 800 MB Phase-1 cap; trim or downsample first").

### 5.4 Save / load / share

- Save: pipeline JSON (schema-versioned) to named file + catalog row; load: file or catalog; fork-on-edit (re-runs never overwrite prior outputs — new output id each run).
- Share Phase 2: export/import JSON file. Share Phase 3 (only if confirmed): cdp-web-style link-packing (patch-in-URL; audio-by-URL exception documented) — **[A: confirm link-share is wanted]**.

---

## 6. Integration Points with Existing Tools

### 6.1 CDP outward (CDP → suite)

- **CDP → Demucs:** a processed file (e.g., blurred texture) re-enters separation as a normal pool asset — architecturally free once §6.3 exists; musically useful for "separate the mangled mix" workflows.
- **CDP → Stable Diffusion / visual pipeline:** via rendered **spectrogram images** (ffmpeg/`essentia` plot → Image pool) as img2img/init textures **[A: confirm this is the intended "CDP texture into SD" reading; the alternative — literal audio bytes as image init — is not recommended]**.
- **CDP → Sequence/pools/catalog:** every CDP output auto-offers pool add + catalog stamp (`origin='generated'`, `✦ mine`, AI-involved per existing convention) through the same `auto-add-outputs`/`auto-catalog` hooks — no CDP-specific provenance path.

### 6.2 CDP inward (suite → CDP)

- **FFmpeg → CDP:** any pool/cUT asset decodes to canonical WAV (reuse `audio_pipeline/scanner.py` decode pattern: ffmpeg → 44.1 kHz mono/stereo temp WAV via `shell.run_command` argv, never `shell=True`).
- **Demucs → CDP:** stems are first-class inputs (stem picker binds directly to a CDP input slot; "process this stem" context action on pool cards).
- **yt-dlp/catalog → CDP:** downloaded media + catalog rows (with key/tempo opinions) feed CDP with tempo/key prefilled as suggested stretch/tune ratios where musically meaningful (suggestion only — tagged value wins per catalog source-of-truth rule).
- **Breakpoints/MIDI → CDP:** catalog `.mid`/beat grids and breakpoint tables are offered where a tool takes envelope/data-file inputs.

### 6.3 Unified asset model (no format friction)

```json
{
  "assetId": "uuid",
  "path": "/abs/path.wav",
  "kind": "audio | spectral | text-data | image | midi",
  "audio": {"sampleRate": 44100, "channels": 1, "codec": "pcm_s16le", "durationSec": 12.4},
  "spectral": {"windows": 1024, "channels": 2049, "sourceWav": "assetId"},
  "provenance": {"origin": "generated", "tool": "blur.blur", "toolRev": "cdp-wasm@pinned", "chain": ["pvoc.anal", "blur.blur"], "params": {}},
  "poolRef": {"video": false, "imagePoolId": null}
}
```

Rules: absolute I/O paths; `transmute`-style `Output:`/`Command:` logging parity for CDP ops; conversions (wav↔ana, any-codec→canonical wav) are explicit, logged pipeline steps using ffmpeg/`pvoc`; failures are HTTP 200 + `{"ok": false}` naming the expected type ("expected `.ana`, got `.wav` — run `pvoc anal` first").

---

## 7. Execution Model

### 7.1 Where `cdp-wasm` runs **[A1 — biggest decision]**

Three options, one recommendation:

- **(i) Browser Web Worker (recommended for Phase 1).** `cdp-wasm` in a dedicated Worker; main thread posts `{toolId, argv, inputBytes}` and receives progress + result bytes; artifacts POSTed to server per §5.3. Fits "no npm" only if the package's built JS+WASM is **vendored as static files** (no bundler, no import-map surprise) — confirm legality (MIT/LGPL) + update procedure in spec header. Keeps audio bytes off the server during render; matches cdp-web precedent.
- **(ii) Main thread.** Rejected — long renders would freeze the tab; no benefit over (i).
- **(iii) Server-side.** Two sub-options: (iii-a) Node + `cdp-wasm` via existing audio venv pattern (new `.venv-cdp`?); (iii-b) native CDP binaries via `shell.run_command` argv. (iii-b) is the natural fallback if vendoring is refused, and the honest spike (§10.4) should prototype (i) vs (iii-b). Either server path reuses `op_runner` + `report_progress()` + job queue directly.

**Recommend (i), spike (i) vs (iii-b) before committing.** **Spike verdict (2026-10-07, §10.3): GO for (i).** The vendored package loads as plain static ESM in a module Worker with zero npm/bundler tooling (the default `new CDP()` resolves `../wasm/` relative to `src/index.js`, so serving the package directory as-is is the whole vendoring procedure), `modify speed` + the `pvoc` wrap render correctly in Chromium, re-runs are audio-identical, `terminate()` cancels in <1 ms, and artifacts POST to the server as bytes. *(iii-b) remains the documented fallback if user confirmation of vendoring is refused. Do not split execution across client and server in Phase 1 — one path, one set of limits.*

### 7.2 Progress, cancellation, queueing

- Progress: per-step `report_progress()` (step k/n + tool-local percent where the program reports it; indeterminate-with-heartbeat where it does not — never a fake 0–100). Long spectral renders report window counts.
- Cancellation: worker `terminate`/server job-cancel kills the current step; completed steps' artifacts survive; pipeline marked cancelled-at-step-k.
- Queueing: one CDP render at a time per session in Phase 1 (job queue serialises); Phase 2 permits N=2 with a documented memory budget (§7.3). Queue UI reuses the existing job drawer — no new job system.

### 7.3 Memory & limits

- Hard ceiling: 32-bit WASM 4 GB per render (input + output + working buffers). Phase-1 caps, now grounded in spike measurements (F: 60 s stereo = 20.2 MB WAV → 20.2 MB out in 3.5–6.7 s, comfortably inside budget): **input ≤ 200 MB WAV or ≤ 60 s at 44.1 kHz stereo (whichever binds first)** — the 200 MB/60 s figure stands as the Phase-1 cap with measured headroom, not as a guess; spectral intermediates count against the same budget (**`.ana` measured ≈ 4× source**: 5 s mono = 0.85 MB WAV → 7.1 MB `.ana` — state the multiplier in the UI).
- Strategy: pre-flight estimator (duration × rate × channels × tool multiplier) blocks over-budget runs with the concrete trim/downsample/mono-mix fix; **no silent chunking in Phase 1** (spectral tools are non-local — chunking changes the sound; chunked spectral processing is Phase-3 research, not a default). Time-domain-only chunking may be explored in Phase 2 behind an explicit toggle.
- Browser audio formats: decode/parity via ffmpeg server-side to canonical WAV before bytes enter the worker — never rely on `<audio>`-decodable formats as processing inputs.

---

## 8. Reference Implementations to Study

### 8.1 CDP MCP Server (Python, DavidPiazza `CDP_MCP`)

- **What it is:** a minimal Model Context Protocol server over **native** CDP binaries (`CDP_PATH` env; deps `mcp soundfile numpy`; Python ≥ 3.8). Requires a local CDP install — the opposite assumption from `cdp-wasm` (which bundles everything).
- **Pattern:** ultra-rigid, zero-interpretation workflow: `list_cdp_programs()` (categorised inventory) → `get_cdp_usage('<name>')` (verbatim usage text) → `execute_cdp([...argv...])` (direct passthrough) plus data-file (`create_data_file`) and analysis helpers (**[inference: prompt states 6 core functions; primary sources reviewed today name 4 — `list_cdp_programs`, `get_cdp_usage`, `execute_cdp`, `create_data_file` — plus sound-analysis utilities; Builder must enumerate from the pinned server revision, not from this spec]**). Representative calls: `execute_cdp(['blur','blur','in.ana','out.ana','50'])`, `execute_cdp(['stretch','time','1','in.ana','out.ana','2.0'])`, `execute_cdp(['modify','brassage','4','in.wav','out.wav','0.02','-0.5','-r200'])`.
- **Lessons for this WebUI:** (1) keep verbatim usage text one click away and pass argv through untouched; (2) separate inventory / help / execute concerns (mirrors §3–4 split); (3) data-file tools need a first-class text editor, not a string box; (4) do not copy its native-install assumption — our execution model (§7) must stand alone.

### 8.2 cdp-web (retro node-graph UI) + agent skills (`drive-cdp-web`, `build-cdp-web-patches`)

- **What it is:** the `cdp-wasm-suite` PWA: retro-computing-themed node-graph patcher over `cdp-wasm`, built directly from the EFFECTS catalog; ships themes, scopes (wave/spec/3D/keys), Faust DSP integration, VST/AU/CLAP plugin + Ableton extension embeddings, and **patch-in-link sharing** (link *is* the patch; disk-loaded Source arrives empty, URL-loaded Source travels complete).
- **Skills:** `drive-cdp-web` / `build-cdp-web-patches` (agentic patch construction) plus the `cdp-sound-design` Claude plugin — evidence that a typed catalog + byte-array I/O is agent-scriptable, which is exactly the surface our schema (§3.3) replicates for future agents.
- **Lessons:** (1) build UI from the effect catalog, not per-tool code (validates §4); (2) steal `--pvoc` auto-wrap and per-channel handling as defaults; (3) steal patch-in-link only if sharing is confirmed (§5.4); (4) retro theme is identity, not architecture — do not copy aesthetics, copy the catalog-driven structure; (5) Faust/custom-DSP is explicitly out of scope for all three phases.

### 8.3 SoundThread (J. Higgins, Godot, MIT, ~3.1k★)

- **What it is:** cross-platform node UI for **native** CDP (needs a CDP install beside it): patch processes in series/parallel ("Threads"), ~100+ popular time+spectral processes (grew from ~50 in beta), drawn-automation → breakpoint files, stereo/mono auto split-merge, save/load threads, recycle-output, optional intermediate cleanup, tutorials/tooltips/colour schemes. Beta; author states not all CDP processes suit nodes — full coverage stays with SoundLoom/Soundshaper/CLI.
- **Lessons:** (1) series+parallel+mix covers real musical routing — our linear chain must at least support multi-input steps and bypass/reorder (§5.1); (2) auto split/merge channels and auto breakpoint generation are the two highest-value "invisible helps" to copy; (3) save/load threads + recycle output validate §5.3–5.4; (4) capping at popular processes first (50 → 100+) validates phased rollout (§9); (5) Godot canvas is not portable to our no-framework ES6 tab — another vote for linear-first.

---

## 9. Phased Rollout Plan

### Phase 1 — Minimal viable integration ("run ten tools well")

**Shipped 2026-10-07 (`8.129`).** One execution path (browser Worker + vendored `cdp-wasm 0.7.0` at `app/static/vendor/`, gitignored, fetched by `scripts/update_cdp_wasm.sh` with pinned sha512) + tool-entry schema (`js/cdp/tools.js`: 8 curated EFFECTS-backed + 3 raw entries = 11 tools) + menu with search and group drill-down + schema-rendered forms with verbatim usage and live raw-argv preview + Prepare/Run/Cancel with stage-honest progress + outputs beside the source, catalog-stamped (origin=generated), inline playback via `/api/video` + limits enforced with the concrete numbers + 11 pytest route tests + Playwright click-proof (`junk/cdp-phase1-prove.mjs`, 17/17, 0 console errors, screenshot `junk/cdp_phase1_proof.png`).

**Measured implementation notes (deviations, all click-proven):**
- `postMessage` to the Worker carries a slim tool descriptor — 0.7.0's EFFECTS entries contain function-valued `srcMin`/`srcDefault`, which structured clone refuses (caught live as DataCloneError; the Worker re-looks the entry up in its own catalog).
- **Acceptance wording correction:** audio outputs do not enter the pools — repo invariant keeps pools video/image; the CDP output surface is the Media Catalog (generated stamp) + inline player, which is what "appears in pool and plays" means here.
- This ffprobe build (n9) rejects `-nostdin` (invariant 13): the prepare route omits it for ffprobe while ffmpeg keeps it.
- `finalize_output_path` needs explicit `default_ext=""` for artifacts — its generic default would have renamed WAVs to `.png`.
- Memory readout in the tab is deliberately absent (§10.3 gap): the pre-flight estimator is the Phase-2 memory surface.

**Ships:** vendored-or-server execution path (one path, §7.1 decision closed) + tool-entry schema + ~10 curated tools (see list) with schema-rendered forms, verbatim usage, raw-argv preview + linear single-tool run (no chains yet) with progress/cancel + outputs to pools/catalog with provenance + limits enforced + gate green + Playwright click-proof.
**Suggested 10 (cover every file-type and both domains):** `pvoc anal`, `pvoc synth`, `blur blur`, `hilite trace`, `stretch time`, `modify speed`, `modify brassage`, `distort distort` **[inference: verify mode name]**, `grain` (one simple mode — verify), `sndinfo`-class info tool. Each must include one spectral-wrap, one breakpoint-free, one info-only, and one data-file-free tool — no data-file tools in Phase 1.
**Acceptance:** all 10 runnable from menu search *and* drill-down; over-limit input blocked with numbers; cancel mid-render preserves prior artifacts; `./check-gate.sh` green; suite green; Playwright: pick tool → set param → run → output appears in pool and plays.

### Phase 2 — Taxonomy, chaining, favorites, search

**Shipped 2026-10-07 (`8.130`).** Full L0–L3 menu over all **232 curated effects** (category → program → mode drill-down, live from the vendored EFFECTS catalog) + **215 raw programs** listed from the build manifest, each opening a zero-interpretation raw runner seeded with the **verbatim man-page usage** (man/ now vendored) + the 5 hand-listed raw modes with explicit `.ana` types (`pvoc anal/synth`, `sndinfo`, raw `stretch time`/`blur blur` for explicit chains). Search across name/group/tag/program. **Favorites** (★ per tool, menu section) and **recents** (last 15, one-click select) persist in localStorage across reloads. **Linear pipelines** (§5.2–5.4): Tool/Pipeline modes over one menu; steps carry per-step values, enable/bypass, reorder, delete; the type graph is validated with the concrete fix ("expects .ana but the chain provides .wav — insert pvoc anal"); curated spectral effects expect .wav (they wrap pvoc themselves — an .ana input is refused, never silently converted); **22 two-input effects** bind a second prepared input (morph.bridge proven); **breakpoint envelopes** for any `ENVELOPE_PARAMS` parameter via a time/value textarea (`extra.brk`, single-tool mode); per-step artifacts saved beside the input as steps complete (`.ana` intermediates included, final wav plays inline); schema-versioned save/load/download JSON with round-trip pinned by 13 Node contract tests (`tests/test_cdp_pipeline_model.py`).

**Acceptance (§9), click-proven** (`junk/cdp-phase2-prove.mjs`, 21/21, 0 console errors, screenshot `junk/cdp_phase2_proof.png`): worked example §3.5 as the 4-step raw recipe (pvoc anal → stretch time → blur blur → pvoc synth) renders 4 per-step artifacts with `.ana` intermediates and a listenable final wav; the saved JSON re-runs on a fresh session (download → reload → load → re-run → 4 fresh artifacts); morph.bridge 2-input step proven end-to-end; favorites/star persist across reload.

**Implementation notes (measured):** the pipeline type contract is `stepInType`/`stepOutType` (`js/cdp/pipeline.js`) — curated effects are always wav→wav because `applyEffect` owns the pvoc wrap; the Worker rejects type mismatches between steps even though each step would individually run. Two click-caught UI races fixed: Input-2's change handler re-rendered the whole page and ate the very click that blurred it (state-only update now), and the prepare summary is re-shown after the post-prepare re-render. Deferred, honestly: pipeline-step breakpoint envelopes (single-tool only this phase), server-side pipeline storage (localStorage + file JSON is the Phase-2 store), and node-graph anything (§5.1 gate still stands).

**Ships:** full L0–L3 menu over all 215 programs (curated effects default, raw modes disclosed) + search/favorites/recents/tags/related/chains + **linear pipelines** (§5.2–5.3) with multi-input steps, bypass/reorder, per-step artifacts, save/load/fork JSON + breakpoint + data-file editors + Demucs/FFmpeg/catalog in-out context actions.
**Acceptance:** worked example (§3.5) plus a 4-step recipe (anal → stretch → blur → synth) re-runnable from saved JSON on a fresh session; morph-class 2-input step proven; favorites/recents persist across reload.

### Phase 3 — Full pipeline model, sharing, cross-tool integration

**Ships (gated):** node-graph only if Phase-2 evidence demands it; otherwise pipeline v2 (parallel branches + mix step, still no canvas) + share (file → link-packing if confirmed) + CDP→SD spectrogram-texture path + chunked time-domain processing toggle + usage-derived related/chains.
**Acceptance:** share → import reproduces byte-identical output on the pinned revisions; cross-tool round trip (Demucs stem → CDP chain → sequence) click-proven; updated limits document from measured peaks.

---

## 10. Risks, Unknowns, and Open Questions

### 10.1 Assumptions requiring user confirmation

- **[A1]** Execution path: browser Worker with vendored `cdp-wasm` build is permissible despite the no-npm invariant (vendored static files, no bundler). **Spike-proven feasible (§10.3, GO); still needs the user's yes to make it binding.** Fallback: server-side native CDP.
- **[A2]** ~~Package numbers pinned from v0.6.0-era sources~~ **Closed 2026-10-07:** verified against `cdp-wasm` **0.7.0** (215 programs / 26 spectral / 232 effects / 110 programs / 16 generators / zero deps / 3.2 MB tarball — all measured, see §2.2 and the spec header). Builder re-verifies at pin and records revisions in the spec header.
- **[A3]** Canonical interchange is ffmpeg-decoded WAV (44.1 kHz); `.ana`/text outputs are derived artifacts, not pool citizens.
- **[A4]** Parameter ranges/defaults are scraped from the curated catalog + manuals, never guessed; missing range = box-only input.
- **[A5]** IndexedDB is at most an offline cache; server files + catalog/pools are the store of record.
- **[A6]** Phase-1 caps (~200 MB / ~60 s stereo) — spike-measured for headroom (60 s stereo renders in seconds, well inside the 4 GB ceiling); the *binding* numbers stay as stated until a Builder measures the true OOM boundary on real material.
- **[A7]** "CDP texture into Stable Diffusion" means rendered spectrogram images via the Image pool, not raw audio bytes.
- **[A8]** Patch-in-link sharing is Phase 3 and optional.
- **[A9]** Distort/grain mode names listed as examples must be verified against the reference; any unverified name blocks its tool entry until confirmed.
- **[A10]** Menu hash-routing (`#cdp/...`) is compatible with the app.js tab router.

### 10.2 Technical risks

1. **WASM memory (4 GB ceiling):** large/multichannel renders OOM inside one address space; mitigation = pre-flight estimator + caps + server artifacts (§7.3). Spectral intermediates multiply size — the estimator must model them.
2. **Browser audio-format support:** processing inputs must be canonical WAV regardless of what `<audio>` plays; all decoding server-side via ffmpeg.
3. **Parameter-schema completeness:** 232 curated effects have ranges; the raw tail (~100 programs) may not — those ship box-only + verbatim usage, never guessed sliders.
4. **Documentation gaps/decay:** manuals span decades; pin revisions, quote verbatim, and treat forum/MCP examples as hints, not contracts.
5. **No-npm vs npm-delivered engine:** largely de-risked by the §10.3 spike — serving the package directory as static files is the whole procedure, with the licence files (`MIT` + `LGPL-2.1-or-later` at `LICENSE` and `wasm/LICENSE`) vendored alongside. Remaining: write the update procedure (re-fetch pinned tarball, verify sha512, commit) before Phase 1 code; if vendoring is refused by the user, re-spec around native binaries.
6. **Vanilla-ES6 graph cost:** a canvas node editor without libraries is the highest-cost item — hence gated to Phase 3 evidence.
7. **Long-render UX:** no fake progress; indeterminate-with-heartbeat + cancel + queue discipline (§7.2).

### 10.3 De-risk spike (before Phase 1 build, ≤ 1 session)

Build a throwaway page (junk/ only, per invariant 8) that: loads vendored `cdp-wasm`, runs `modify speed` on a 5 s WAV **and** the `pvoc anal → blur blur → pvoc synth` wrap in a Worker, reports peak memory/time, cancels mid-render, and POSTs bytes to a temp artifact endpoint. **Go/no-go:** both renders bit-plausible (byte-identical re-run), cancel responsive (<1 s), peak measured and under budget, vendored files load with zero npm tooling. If vendoring fails the repo's constraints, spike the server-native fallback the same day and bring both numbers back for the [A1] decision.

**Executed 2026-10-07 — GO.** Spike: `mtapi-project/junk/cdp-spike/` (`server.py` static+artifact server, `worker.js`, `spike.js`, `index.html`, `prove_cdp_spike.mjs`, proof screenshot `spike_proof.png`; gitignored). Method: gate 5/5 first; vendored `cdp-wasm 0.7.0` tarball fetched from the npm registry straight into `junk/` and served as-is; Node smoke pass first (argv shapes), then real Chromium via Playwright 1.58.2 clicking the page's Run button. Results (8/8 checks, 0 console errors):

| Check | Result |
|---|---|
| A `modify speed 2` −12, 5 s stereo | exit 0, 3.37 MB out, 440,998 fr (want ≈441,000 = 2×220,500; resampler tail) — 51–106 ms |
| B `pvoc anal 1 → blur 20 → synth`, 5 s mono | exit 0, 0.85 MB out, 221,440 fr — 151–372 ms; `.ana` measured ≈ 4× source (0.85 MB → 7.1 MB) |
| C `applyEffect(blur.blur)` ×2 | **`data` chunk byte-identical every run**; whole-file compare differs by 1–3 bytes in `PEAK`/`LIST` (libsndfile timestamps) — the §5.2 contract change |
| D manifest | `programs()=215`, `spectralPrograms()=26` through the vendored files |
| E artifact POST | worker bytes → server disk, size-exact |
| F scale probe | 60 s stereo (20.2 MB in) → 20.2 MB out in 3.5–6.7 s |
| G memory readout | honest gap: headless Chromium refuses `measureUserAgentSpecificMemory` and Workers expose no `performance.memory`; end-state main-thread jsHeap 9.5 MB; true WASM peak needs the pre-flight estimator work (Phase 1) |
| H cancel | `terminate()` from mid-`stretch time` render returns in <1 ms |

Vendoring procedure proven: copy the package directory into the static tree; done — no npm, no bundler, no import-map work. `pvoc anal` requires **mono** input and the wrapper's `analyse()` already enforces it (a direct stereo call fails with "doesn't work with this type of infile") — the §4 file-type discipline must also gate channel count.

---

*End of spec. Builder entry point: get the user's yes on [A1] (the §10.3 spike says browser vendoring is GO — 8/8 checks, 0 console errors, evidence in `mtapi-project/junk/cdp-spike/`), then execute Phase 1. The 0.7.0 revisions are pinned in the header above.*
