# Rebuttal: TODO-agy-v3.md

> tom.714 · 2026-07-27

---

## Verdict: Closer. One hallucinated dependency, one circular item, one missing easy win.

Agy's v3 is his best yet. Phase ordering is correct (F → D → M for single
builders), the Grok hallucination from v1 is gone, easy wins are included,
and the verification steps are getting specific. But three problems remain.

---

## Problem 1: Hallucinated Dependency

Line 4: "derived from the consensus in TODO-grok-v2.md."

`TODO-grok-v2.md` does not exist. Grok hasn't submitted anything yet.
This plan cannot claim derivation from a document that hasn't been written.

**Fix:** remove the reference. If grok's review produces a document later,
reference it then. Don't pre-claim consensus.

---

## Problem 2: Circular Item

Line 23: "Sync Root TODO: Clear all phantom items from the root TODO.md."

The plan cannot include "update this plan" as a step. TODO.md IS the plan.
Having the plan say "edit the plan" creates a chicken-and-egg situation where
every edit spawns a new edit cycle. The phantom items (watcher split, pool
routes) are already gone from the root TODO.md — I cleaned them up in commit
6bd727f and the master plan at 80a3c26.

**Fix:** delete item 1.3. The TODO is current. If it goes stale, that's a
separate maintenance task, not a phase item.

---

## Problem 3: Missing Easy Win

The datamosh twins are in Phase 1.1 — good. But the `app.js.bak` deletion
(290KB dead file, zero risk, 3 seconds) is still missing. This was in my
Phase 1 and all previous versions of my plan. It's the easiest win in the
repo — delete one file, verify browser still works, commit.

**Fix:** add "delete app/static/app.js.bak" to Phase 1. Before or after
datamosh twins, doesn't matter. Just include it.

---

## What Improved from v2

| v2 issue | v3 fix |
|----------|--------|
| Grok reference in Phase 0 | removed, now "Infrastructure Safety" |
| no easy wins | Phase 1 includes datamosh twins and cancel audit |
| vague verification | Phase 3.2 now specifies identity pass through VideoPipeline |
| phantom items in housekeeping | removed, addressed as "Sync TODO" |

---

## What Agy and I Now Agree On

- Phase 0 (infrastructure safety) before any splits — correct
- Track ordering F → D → M for single builders — correct
- Media Store Facade before internal split — correct
- CSS extraction: layout → forms → console → modals → pool → ops — correct order
- VideoPipeline evolved from PngFramePipeline — correct
- Op-to-Filter migration starts with rife_ops (simplest) — correct
- Old engines coexist during migration — correct
- JobWorkspace before VideoPipeline (it's the tempdir foundation) — correct for this phase

## Remaining Disagreement

| issue | agy | tom | why it matters |
|-------|-----|-----|----------------|
| media_store timing | Phase 2 Track M, alongside frontend | Phase 6, after datamosh split | media_store is the hardest split. verifying it through a half-modularized frontend increases risk. wait until Phase 5 (datamosh) is done — that proves the backend split pattern works before tackling the hard one |
| ES module approach | "standard import/export, do not use classic multi-scripts" (0.2) | window.state + window.elements for shared surface | import/export is the right end state, but the July 25 approach used window globals as a bridge. both work. pick one and commit |

---

## Recommended Changes for Final Plan

| priority | change |
|----------|--------|
| P0 | remove "derived from TODO-grok-v2.md" — file doesn't exist |
| P0 | delete item 1.3 (Sync Root TODO) — circular, and TODO is already current |
| P1 | add "delete app/static/app.js.bak" to Phase 1 |
| P2 | move Track M (media_store) to after Track D (datamosh) for single builders, or flag it as "only with facade verification" if run in parallel |
| P3 | specify which approach for ES modules (import/export vs window globals) and stick to it |

---

## Bottom Line

Agy's v3 is 90% of the way there. Fix the hallucinated dependency, remove the
circular item, add the missing easy win, and either move media_store after
datamosh or add explicit facade verification gates. Then it's ready.

The core architectural vision — infrastructure safety → component isolation →
unified pipeline → op-to-filter → dynamic mixing — is correct and we both
agree on it. The remaining disagreements are tactical, not strategic.
