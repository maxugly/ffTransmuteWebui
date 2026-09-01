# Docs slim — pass-around plan

> **Date:** 2026-08-17  
> **Authoritative prompt:** [coder-docs-slim-prompt.md](coder-docs-slim-prompt.md)  
> **Pass 1 (committed `7.002`):** archive only what is *competing or junk*.  
> **Later passes:** only after human assigns them. Do not rewrite AGENTS or merge SESSION until then.

Reviewers: object to a restore by name. Do not put archived files back “just in case.”

---

## Pass 1 — done (archived)

Moved to `docs/archive/` (still in git history):

- All `TODO-agy*` / `TODO-grok*` / `TODO-claude*` / `TODO-tom*` / `todo-review*`
- `ideas.md`, `ideasV2.md`, `ideasV3.md`, `questions-for-tom.md`, `mtapi_spec_ideas.html`
- `codex-audit-report.md`, `speed-ramp-debug.md`, `setpts-cli-failure-report.md`
- Root `STATUS.md`, `TODO.md`, `ROADMAP.md`, `AUDIT.md`, `PLAYBOOK.md` (July 2026 sprint; **lost to `docs/STATUS.md`**)
- Duplicate root `docs-datamosh-README.md` / `docs-transmute-README.md` (identical copies live in `docs/`)
- Root `sequence_tab_overview.png`

**Still live on purpose:** `docs/STATUS.md`, `SESSION-STOPPING-STATE.md`, as-built specs, `docs/backlog/`, active builder prompts (FastSAM multimodel, pool cleanup).

---

## Pass 2+ — reviewer tweaks **accepted** (locked in the prompt)

- Invariants keep bite (shell=True, junk/, pipeline). Tables go, rules stay.
- Fold unique `mtapi-project/AGENTS.md` into root, then delete that file. Nested filters/static AGENTS only with a root pointer.
- SESSION → short box at top of STATUS; delete SESSION after `rg` is clean.
- Every move: `rg` for dead links.
- Legacy specs: WARNING banner first; `-legacy` rename only after grep.

Human still names which pass to run.

---

## Do not archive

Filter platform, wall preview, dual pools, FastSAM multimodel (locked §0), VERSION ritual, junk/ rule, backlog ops until STATUS says drop them.
