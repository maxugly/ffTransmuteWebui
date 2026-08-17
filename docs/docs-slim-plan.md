# Docs slim — pass-around plan

> **Date:** 2026-08-17  
> **Pass 1 (this commit):** archive only what is *competing or junk*.  
> **Not this pass:** rewrite AGENTS.md, merge SESSION into STATUS, delete backlog specs, delete shipped as-built specs.

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

## Pass 2 — propose (do not do until human says)

| Action | Why wait |
|--------|----------|
| Merge SESSION into a short STATUS “handoff” box | AGENTS.md still names SESSION |
| Slim root `AGENTS.md` to ~80 lines | Needs a dedicated review pass |
| Archive *shipped* `coder-*-prompt.md` (nav, recohere, …) | Historical; as-built spec is enough |
| `docs/docs-automation-lanes.md` vs root copy | They **differ** — pick one |
| Mark Legacy on superseded catalog/virt specs | Easy to delete the wrong “as-built” |
| `mtapi-project/sequence_*_spec.md` at package root | May still be as-built for Join |

---

## Do not archive

Filter platform, wall preview, dual pools, FastSAM multimodel (locked §0), VERSION ritual, junk/ rule, backlog ops until STATUS says drop them.
