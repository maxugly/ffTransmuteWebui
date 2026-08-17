# Coder / reviewer prompt — Docs constitution slim

> **Branch:** `wip` (not `main`)  
> **Base:** `cf182f6` or later (`000.000.7.002`)  
> **Kind:** Multi-agent **review then execute**. Pass this file around. Do not invent a new docs system.  
> **Live plan notes:** [docs-slim-plan.md](docs-slim-plan.md)  
> **Archive (not law):** [archive/README.md](archive/README.md)

---

## What we want to end up with

A repo an agent can enter and **not get lost**:

| Layer | File | Size target | Job |
|-------|------|-------------|-----|
| **Law** | root `AGENTS.md` | **~80–120 lines** | Invariants only. Roles. “Read STATUS first.” Pointers. |
| **Map** | `docs/STATUS.md` | keep roughly current | **Only** shipped / partial / don’t-build list + VERSION. |
| **Index** | `docs/README.md` | one screen | Links to STATUS + as-built specs. No history essays. |
| **As-built** | `docs/<feature>-spec.md` | one live file per subsystem | Matches **code**. Banner Implemented / Partial. |
| **Assignment** | `docs/coder-<job>-prompt.md` | **only open jobs** | Locked one-shots (e.g. FastSAM multimodel). |
| **Backlog** | `docs/backlog/` | stay | Draft ops. Do not build unless STATUS §5 says so. |
| **Graveyard** | `docs/archive/` | grow only | Lost TODO/ideas/old law. Not in default context. |

**There is no second STATUS.** No TODO-agy. No ideasV3. No PLAYBOOK competing with AGENTS.

Agent default context = **AGENTS.md + STATUS.md**. Everything else is on-demand.

---

## Pass 1 — already done (`7.002` / `cf182f6`)

Archived (git history intact):

- All `TODO-agy*` / `TODO-grok*` / `TODO-claude*` / `TODO-tom*` / `todo-review*`
- `ideas.md` / `ideasV2` / `ideasV3` / `questions-for-tom` / `mtapi_spec_ideas.html`
- One-off audits/debug: `codex-audit-report`, `speed-ramp-debug`, `setpts-cli-failure-report`
- Root July `STATUS.md` `TODO.md` `ROADMAP.md` `AUDIT.md` `PLAYBOOK.md`
- Duplicate root CLI readmes (canonical copies remain in `docs/`)
- Root `sequence_tab_overview.png`

**Do not restore these** unless the human names the file and why.

---

## End-state rules (locked)

1. **STATUS wins.** If a spec or archive disagrees with `docs/STATUS.md`, STATUS is right.  
2. **Do not build** Implemented features again. Do not implement `backlog/` unless STATUS §5 lists it as next.  
3. **As-built specs stay** when they match code (filter platform, wall, pools, FastSAM OpenVINO, etc.). Slim them later; do not delete this pass.  
4. **Wall / filter platform / dual pools / junk/ / no shell=True / VERSION ritual** stay in AGENTS even when AGENTS is shortened.  
5. **`docs/archive/` is not context.** Do not `read` it unless restoring a named file.  
6. **Branch is `wip`.** Do not merge to `main`.  
7. **Restore = `git mv` back + one sentence in STATUS.** Never copy-paste archive into a new spec.

---

## Remaining work (execute only what the human assigns)

### Pass 2 — constitution (needs human OK)

- Slim root `AGENTS.md` to ~80–120 lines: mission, tree, **invariants**, roles, “read STATUS,” VERSION bump list. Drop duplicated op registry tables (STATUS has them).  
- Keep `mtapi-project/AGENTS.md` as **package-local** (filters/ops/static) or fold one paragraph into root and delete if redundant — reviewer call, don’t guess.  
- Fold `SESSION-STOPPING-STATE.md` into a **short** “Shipped this stretch / next assignment” box at the top of STATUS. Then delete SESSION **only if** every AGENTS / README pointer is updated.  
- Pick **one** `docs-automation-lanes.md` (root vs `docs/` differ). Archive the loser.

### Pass 3 — prompts and leftover specs (needs human OK)

- Archive `coder-*-prompt.md` for **already shipped** work (nav, recohere, dry-platform, …). Keep **open** prompts: FastSAM multimodel, this slim prompt.  
- Mark **Legacy** (do not delete yet) on superseded catalog/virt writeups if STATUS already has a newer as-built. List names in the commit.  
- `mtapi-project/sequence_*_spec.md` at package root: move under `docs/` **or** leave if still the Join as-built. Do not delete without reading.

### Pass 4 — optional later

- Shorten individual as-built specs that ramble. One file, one subsystem.  
- `spec_registry.json`: drop archived filenames or mark `"status": "Archived"`.

---

## Do not touch

| Keep | Why |
|------|-----|
| `docs/filter-platform-spec.md` | Law for frame effects |
| `docs/pool-wall-preview-spec.md` | Wall contract |
| `docs/video-image-pools-spec.md` | Dual pools |
| `docs/fastsam-sam-multimodel-spec.md` §0 + `coder-fastsam-multimodel-prompt.md` | Open assignment |
| `docs/backlog/*` | Drafts; STATUS gates them |
| App code | This is a **docs** job unless a pointer in AGENTS/README is wrong |

---

## How to pass this around

1. Reviewer reads this file + `docs-slim-plan.md`. Objects **by filename**.  
2. Human says which pass (2 / 3 / 4).  
3. Builder executes **only that pass**. Commit on `wip`. VERSION DD if STATUS header changes.  
4. Next reviewer diffs the commit against this prompt’s end-state table.

If you would delete an as-built spec or rewrite the wall, **stop**.

---

## Done (whole program)

- New agent: AGENTS + STATUS is enough to not invent a second dump/encode or a recycle protocol.  
- `docs/` listing is specs + STATUS + README + archive + backlog + **open** coder prompts.  
- No second STATUS/TODO/ROADMAP at repo root.  
- SESSION gone **or** reduced to a pointer, with AGENTS updated.  
- Human has not been surprised by a deleted live spec.
