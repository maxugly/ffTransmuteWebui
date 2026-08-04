# Coder Prompt — DRY Platform Pass (`run_staged_job` + glue)

> **Target:** ffTransmuteWebui / mtapi-project  
> **Role:** Builder (codewhale / codex / opencode)  
> **Kind:** **One-shot assignment** — all product choices locked below; implement without re-opening design.  
> **Related:** `docs/filter-platform-spec.md`, root `AGENTS.md` § filter platform, conversation handoff on DRY pain points  
> **Verification:** You **must** WebUI-smoke every op you touch (root `AGENTS.md` §D). Spec writer cannot claim DONE.

---

## What “one-shot” means (read this)

**One-shot** = the human (or spec writer) gives you **one complete assignment** with:

| Locked | Meaning |
|--------|---------|
| **Scope** | What to build / migrate / leave alone |
| **Non-goals** | What not to touch |
| **Defaults** | Naming, VERSION, commit policy |
| **Done criteria** | How you prove it |

You do **not** ping for “should we migrate deepdream?” mid-flight. If something is ambiguous, **prefer the locked defaults** and note the choice in the commit / STATUS.

This is **not** “one giant commit with no checkpoints.” You still:

1. Implement in **phased commits** (helper → pilots → collect unify → STATUS).  
2. **WebUI-verify** each phase that touches UI or a named op.  
3. Stop only if a **system invariant** is at risk (shell=True, second dump stack, secret leakage).

**Why one-shot now:** the prior agent can design DRY and write this prompt, but **cannot** run mandatory WebUI verification. **You** own implementation + browser smoke + DONE.

---

## MISSION

Remove repeated dump→stage→encode glue and dual form-collection without changing product behavior.

1. Add **`run_staged_job`** (or equivalent name) — shared bookend runner.  
2. **Migrate clean pilots** onto it.  
3. Unify **Run + Queue** form collect into **one** function.  
4. Optional: shared **maybe_rife** helper for optional-RIFE ops.  
5. **Do not** rewrite neural engines this pass.

---

## LOCKED DECISIONS (do not re-ask)

| # | Decision | Lock |
|---|----------|------|
| 1 | Scope | Helper + migrate **clean** ops; fat engines later |
| 2 | Public API | **No breaks** — same op ids, same JSON fields, same UI labels |
| 3 | Engines | **Leave alone:** `deepdream_engine`, `styletransfer_engine`, `withoutbg_engine`, `facemorph_engine` (and their special still paths) |
| 4 | Run/Queue | **One** `resolveActiveOpAndBody()` (name flexible); both Run and Queue call it |
| 5 | Optional RIFE | Shared helper **encouraged** for speed / ramp / imagesort; recohere may stay custom (img2img mids) but should call shared RIFE + conform where easy |
| 6 | OpenVINO form chrome | **Optional / skip if time** — backend + collect first |
| 7 | VERSION | Bump far-right **DD** once per logical ship (or once at end of pass if one ship) |
| 8 | Git | **Commit** after working sub-steps; **push only if human asked** |
| 9 | Secrets | Never commit keys; `~/.secrets` only |

### Migrate these ops onto `run_staged_job` (pilots — required)

| Op | Why clean |
|----|-----------|
| `rife` | Classic dump → directory stage → encode |
| `cut` | dump range → encode only |
| `upscale` (video path) | dump → directory → encode; image path may stay direct CLI |
| `speedramp` | dump → stage(s) → encode |
| `convert` path C (video→video) | if it fits without breaking dump-only / frames paths |

### Do **not** force-migrate this pass (unless trivial)

| Op | Why |
|----|-----|
| deepdream / style / withoutbg video | Still intertwined with engines / process() |
| facemorph | Multi-source generator |
| imagesort | Multi-source + rank; use maybe_rife only |
| rife_recohere | Custom mid img2img; optional partial use of helper |
| txt2img / agent / transmute / datamosh | Not filter-platform bookends |

---

## PHASE 0 — SCOUT

| File | Why |
|------|-----|
| `docs/filter-platform-spec.md` | Law |
| `docs/STATUS.md` | Where we are |
| `app/video_pipeline.py` | dump / encode / process |
| `app/job_workspace.py` | workspace |
| `app/op_runner.py` | job token lifecycle (already shared) |
| `app/operations/rife_ops.py` | best pilot shape |
| `app/operations/cut_ops.py` | thin bookends pilot |
| `app/operations/upscale_ops.py` | directory stage + image special case |
| `app/static/js/job-control.js` | Run vs Queue dual collect (**pain**) |
| Root `AGENTS.md` §D | WebUI verification mandatory |

---

## PHASE 1 — `run_staged_job` helper

### Suggested location

`mtapi-project/app/staged_job.py` (or `app/pipeline_run.py` — one module, clear name).

### Suggested shape (adjust names; keep semantics)

```python
async def run_staged_job(
    *,
    op_id: str,
    prefix: str,
    input_path: Path | None = None,       # for dump
    output_path: Path,
    fps: float | None = None,             # encode; may come from dump
    dump_kwargs: dict | None = None,      # start_frame, end_frame, image_format, …
    stages: list[StageSpec],              # ordered; empty = dump+encode only
    encode_kwargs: dict | None = None,
    mux_audio: bool = True,
    skip_dump: bool = False,              # frames already in workspace
    frames_already: Path | None = None,   # pre-filled dir
) -> OperationResult:
    ...
```

**StageSpec** (concept): either

- `{ "kind": "directory", "fn": async (src, dst) -> meta }`  
- `{ "kind": "per_frame", "fn": FilterFn }` via existing `process()`  
- or callables that already have `.kind`

**Must:**

- `JobWorkspace` create/cleanup (`keep_on_failure=not success`)  
- `job_control.check_cancelled` / progress phases: `dump` / stage name / `encode`  
- Reuse **existing** dump dir-watch (already in `video_pipeline.dump`)  
- Return `OperationResult` with logs joined  
- **No** second ffmpeg stack  

**Must not:**

- Force every op through pipeline HTTP  
- Change mid-chain naming (`frame_%06d.png`, start 0)

### Pilots

Rewrite pilots to call the helper; behavior identical (same outputs for `/tmp/teste.mp4` / `.png`).

---

## PHASE 2 — Optional RIFE helper (if time after pilots)

```python
# e.g. in filters/rife.py or staged_job.py
async def maybe_rife_directory(src, dst, *, use_rife, multiplier, model, tta, uhd) -> dict:
    if not use_rife:
        # copy or no-op policy: document (copy frames src→dst OR encode from src)
        ...
    return await run_rife_directory(...)
```

Wire **speedchange** (RIFE path) and **speedramp** first; **imagesort** if low risk.

---

## PHASE 3 — Frontend: one collect path

In `job-control.js` (or small `js/ops/resolve-active-op.js`):

```js
export function resolveActiveOpAndBody() {
  // returns { opId, body } or null (alerts already shown)
}
```

- `runActiveOperation` → resolve → `runOpWithCancel`  
- `enqueueActiveOperation` → resolve → `POST /api/queue`  
- **Delete** the parallel `_collectForQueue` switch  
- Every tab that Run supports must resolve (including `cut`, `riferecohere`, etc.)

---

## PHASE 4 — Docs / VERSION

1. Bump root `VERSION` DD.  
2. `docs/STATUS.md` — note DRY partial/shipped; what migrated.  
3. Short note in `filter-platform-spec.md` or new `docs/staged-job-spec.md` **as-built** (optional if STATUS is enough).  
4. Root `AGENTS.md` — if new helper is law for new ops, one sentence under filter platform.

---

## PHASE 5 — VERIFY (mandatory — you are the builder)

Assets: `/tmp/teste.mp4`, `/tmp/teste.png` (create if missing per root AGENTS).

For **each** migrated op:

1. Server on `:24590`  
2. WebUI form → Run → `ok` / no JS console errors  
3. At least one **Queue** path: Add to Queue → Jobs tab shows pending/running/done  

Minimum set:

| Op | Input |
|----|--------|
| cut | video + short frame range |
| rife | video, M=2, short range if possible |
| upscale | still PNG |
| convert or speedramp | one smoke |
| Queue | enqueue cut or rife while idle |

**You may not claim DONE without WebUI** for touched UI + migrated ops.

---

## ANTI-PATTERNS

- Reimplement dump/encode inside the helper with shell=True  
- “Big bang” migrate deepdream/style/facemorph engines  
- Change op JSON field names  
- Leave Run/Queue dual switches “for later” after starting Phase 3  
- Commit secrets  
- Push without human ask  

---

## DONE means

- [ ] `run_staged_job` (or named equivalent) exists and is used by required pilots  
- [ ] Pilot ops behavior unchanged under smoke  
- [ ] Run + Queue share one resolve function  
- [ ] VERSION + STATUS updated  
- [ ] WebUI verification green for pilots + queue  
- [ ] Commits with clear messages  

---

## Handoff note for the human (morning)

Builder should leave in STATUS or SESSION-STOPPING-STATE:

- Which ops migrated  
- Which intentionally skipped  
- Any behavior surprises  
- VERSION  

**Spec writer / prior agent does not claim this DONE.** This prompt is the assignment.
