# Sprint Status — ffTransmuteWebui

> Updated: 2026-07-25 18:40 UTC · Two-track system: F = fundamentals, M = features
> **Rule: fundamentals before features. No new M-tasks until F-track is clear.**

## FUNDAMENTALS (F-track) — top priority

| # | What | Status | Who | Note |
|---|------|--------|-----|------|
| F1 | style.css split | ✅ done | codewhale | 6 files, all 10 tabs verified |
| F2 | pool.js split | ✅ done | codewhale | 3 files, pool tab verified |
| F3 | delete app.js | ✅ done | codewhale | app.js.bak, module-only runtime |
| M9 | codecview op | ✅ done | codewhale | Vectors tab, 143+111 lines, 0 errors |
| M10 | post-sprint audit | 🔧 in progress | tom | |
## FEATURES (M-track) — blocked until F-track clear

| # | What | Status | Who | Note |
|---|------|--------|-----|------|
| M2b | RIFE interpolation | ✅ done | codewhale | rife_ops.py shipped |
| M2c | withoutbg video | ✅ done | codewhale | completed |
| M3 | curve math verified | ✅ done | agy | confirmed |
| M4 | spin-down end-to-end | ⏳ pending | codewhale | blocked by M2 |
| M5 | QA review | ⏳ pending | grit | offline til Monday |
| M6 | rubberband spec | ⏳ pending | bones | offline til Monday |
| M7 | grok pipeline auto | 📋 planned | tom | cron job for spec pipeline |
| M9 | codecview op | 🚫 blocked | codewhale | blocked until F1+F2 done |
| M10 | post-sprint audit | 📋 queued | tom | after fundamentals clear |

## DEAD / PAUSED

| # | What | Status | Note |
|---|------|--------|------|
| M1 | setpts curve | ☠️ dead | abandoned |
| M2 | PNG frame-remap | ⏸️ paused | returns with optical-flow |
| M8 | JS switchover | ✅ done | index.html → modules, all tabs verified |

## Queue

| # | What | Type | After | Who |
|---|------|------|-------|-----|
| F1 | style.css split | fundamental | now | codewhale |
| F2 | pool.js split | fundamental | F1 done | codewhale |
| M9 | codecview op | feature | F2 done | codewhale |
| M10 | post-sprint audit | audit | M9 done | tom |

## Crew

| Agent | Role | Status | Doing |
|-------|------|--------|-------|
| tom.714 | conductor | 🔧 active | running the board |
| max | decider | 👤 active | human |
| codewhale | builder | 🔧 active | F1 — style.css split |
| agy | researcher | 💤 idle | waiting for grok's research |
| grok | researcher | 🔍 active | R&D — temporal functions, ideasV3 |
| codex | searcher | 💤 standby | don't poke |
| bones | spec-writer | 🌙 offline | back Monday |
| grit | QA | 🌙 offline | back Monday |

## Key Files

| File | What |
|------|------|
| `.coms.md` | war room — status, ACKs, assignments, READY notices |
| `.artifacts.md` | spec workshop — grok + agy research & reviews |
| `.presence.json` | machine-readable state — agents, milestones, pending pokes |
| `STATUS.md` | this file — human-readable sprint dashboard |
| `docs/` | grok's spec drop zone |

## Pipeline

```
max → grok (/docs + .artifacts.md) → agy (review) → tom (assign)
→ codewhale (build) → agy (review) → grit (QA) → tom (merge)
```

**Current rule:** F-track before M-track. No features until fundamentals clear.
