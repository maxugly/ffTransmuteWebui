# Review: TODO-agy.md

> tom.714 · 2026-07-27

---

## Verdict: Has gaps. Right vision, wrong order, stale state.

Agy's plan tells a clean architectural story — Phase 0 fixes through Phase 5 new features.
The vision is correct. The VideoPipeline, Ops-as-Filters, centralized Model Manager —
that's exactly where ROADMAP.md says we're headed.

But the plan has three problems that would cause real issues if followed as written.

---

## Problem 1: Stale State — Contradicts Reality

The "Done" section at the top and the "Housekeeping" section at the bottom
contradict each other AND contradict what's actually committed:

| item | agy says | reality |
|------|----------|---------|
| pool routes (state, save, load, last, match, scan) | ❌ in Housekeeping | ✅ done — routes/pool.py exists (commit f778e94) |
| watcher routes | ❌ in Housekeeping | ✅ done — routes/meta.py line 594 |
| jobs, health routes | ❌ in Housekeeping | ✅ done — routes/meta.py lines 617-681 |
| global inputs status indicators | ❌ in Housekeeping | ✅ done (commit 6bd727f) |
| global inputs multi-file sequential processing | ✅ in Done | partially done — parse_path_list exists but facemorph/styletransfer not wired |
| global inputs bar 4-input UI | ✅ in Done | ✅ done |
| main.py route split | "browse, media, picker" in Done | ALL 6 modules done — main.py is 299 lines |

The Done list is incomplete. The Housekeeping list is mostly things already done.
If codewhale followed this plan, he'd spend hours rediscovering work that's
already committed and pushed.

**Fix:** delete the Housekeeping section entirely. Update the Done section from
the git log — every item that has commits against it. Check git log before listing.

---

## Problem 2: Phase 0 References a Review That Doesn't Exist

Phase 0 is titled "Addressing Grok's Review." Grok hasn't reviewed anything yet.
His prompt was just sent. This section is hallucinated.

The items IN Phase 0 are mostly correct in concept — but they're already in our
master plan (TODO.md) as Phases 3 and 4. They don't need their own "Phase 0"
named after a review that hasn't happened.

**Fix:** remove the Grok reference. If this becomes a real review response, cite
specific review findings with quotes.

---

## Problem 3: Wrong Order for the Current State

Agy's plan puts VideoPipeline and Ops-as-Filters (Phase 2) BEFORE frontend
modularization. This violates our rule: "don't touch engines until the
infrastructure around them is clean."

The VideoPipeline changes how every neural op works. If app.js is still a
7,620-line monolith and media_store is still 1,324 lines of tangled concerns,
building the VideoPipeline means refactoring engine code that sits on top of
unstable infrastructure.

The correct order (from our master plan):
1. Dead code cleanup
2. Frontend modularization (style.css → app.js)
3. Backend modularization (datamosh_ops → media_store)
4. THEN VideoPipeline + Ops-as-Filters
5. THEN dynamic mixing

Agy's order (Phase 0 → Phase 1 → Phase 2) jumps to backend refactoring before
the frontend is clean. This isn't wrong architecturally — it's wrong
chronologically given where the project actually is.

---

## What Agy Got Right

1. **Media Store Facade pattern.** Split internally but maintain a unified
   `media/__init__.py` so routes don't break. Our plan says "split into
   cache/thumbnails/pool/projects" but doesn't mention the facade — routes
   currently import `media_store.load_pool_state()` directly. The facade
   pattern preserves that interface while splitting the implementation.
   This should be added to our Phase 5.

2. **Static assets routing awareness.** When we split CSS into `/css/*.css`
   and JS into `/js/*.js`, the current `routes/static.py` only serves /
   /style.css, and /app.js. It needs to serve nested paths. This should be
   added to our Phase 3 as a prerequisite step.

3. **`:root` CSS variables first.** Extract CSS custom properties to
   `base.css` before splitting layout/components. This preserves the cascade
   and prevents visual breaks. This should be Phase 3.1 in our plan.

4. **JobWorkspace concept.** Standardized temp directory structure with
   frames_in/frames_out/audio separation. Right idea, wrong time — belongs
   in Phase 6 (alongside VideoPipeline), not Phase 1.

---

## Specific Recommended Changes

| priority | change |
|----------|--------|
| P0 | Delete Housekeeping section — everything listed is already done |
| P0 | Update Done section from git log — list everything with commits |
| P1 | Remove "Addressing Grok's Review" from Phase 0 — review hasn't happened |
| P1 | Reorder phases: frontend split BEFORE VideoPipeline |
| P2 | Add Media Store Facade note to our Phase 5 |
| P2 | Add static assets routing prerequisite to our Phase 3 |
| P2 | Add CSS :root extraction as Phase 3 step 1 |
| P3 | Move JobWorkspace to Phase 6 (alongside VideoPipeline) |

---

## Bottom Line

Agy's architectural vision is solid — VideoPipeline, Ops-as-Filters, Model Manager,
dynamic mixing. That's the destination. But the plan has stale state (things listed
as not done that are done), a hallucinated review reference, and the wrong attack
order for where the project actually is.

Merge the good ideas (Media Store Facade, static assets routing, CSS :root first)
into our master plan. Keep our attack order. Grok validates the combined plan.
