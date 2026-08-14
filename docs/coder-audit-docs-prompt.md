# Prompt: Codex Documentation & Architecture Audit

**Target Agent:** codex (Builder / Reviewer)
**Goal:** Perform a comprehensive audit of the `docs/` directory against the current state of the codebase. "Metal sharpens metal"—your job is to find the gaps, contradictions, and architectural drifts between what the Spec Writers have proposed/documented and what is actually built.

## Instructions for Codex

1. **Verify `STATUS.md` & `README.md`**
   - Cross-reference the "Shipped" features in `STATUS.md` with the codebase (especially `mtapi-project/app/static/js` and `mtapi-project/app/operations/`). 
   - Are there features marked as shipped that are only partially implemented? (e.g., is the `universal-persistence-spec.md` fully wired for inactive tabs, or is it just the named-project protection?)

2. **Audit New Specs vs. Reality**
   - Read `docs/performance-settings-spec.md` and `docs/universal-persistence-spec.md`.
   - Check them against `mtapi-project/app/static/js/pool/persistence.js`, `cache.py`, and `thumbnails.py`. 
   - Are the proposed settings models feasible with the current `state` object? 
   - Will the proposed LRU cache for JPEGs and pHashes introduce any concurrency or locking issues in FastAPI?

3. **Check for Invariants & DRY Violations**
   - Review `AGENTS.md` System Invariants.
   - Ensure none of the open specs prescribe ad-hoc ffmpeg commands where the `filter-platform` (`dump → stages → encode`) should be used instead.
   - Ensure the UI states described in `docs/ui-state-map.md` match what is actually being bound to the DOM in the vanilla JS.

## Deliverable
Do not write implementation code during this pass. Your output should be a new document: `docs/codex-audit-report.md`. 
In this report, list:
- **Contradictions:** Where a spec says one thing, but the codebase does another.
- **Gaps:** Edge cases the Spec Writers missed (e.g., memory leaks with unconstrained RAM caches, cache invalidation bugs).
- **Action Items:** A prioritized list of fixes for the Spec Writer or Builder to tackle next.

Once generated, ping the Spec Writer to review your findings so you can iterate.
