# Playbook — How We Modularized ffTransmuteWebui

> A record of what we did, how we did it, what broke, and what we learned.
>
> Written: 2026-07-27. **Updated: 2026-07-31** (filter platform + PngFramePipeline removal).

---

## The Approach: Elephant Buffet

We don't eat the whole elephant at once. We slice off one bite, verify it
works, commit, push, then take the next bite. This is the opposite of the
failed first attempt where codewhale tried to split app.js all at once and
hit a wall of line numbers.

**The rule:** after every single change — one commit. If something breaks,
you roll back one commit, not an entire afternoon's work.

**The difference from last time:** browser verification. Codewhale now
has Playwright + Chrome. Every frontend change gets browser_navigate →
browser_console (ZERO errors) → click affected tabs before claiming done.

---

## The Verification System

Three layers, built incrementally:

1. **Test assets:** `/tmp/teste.mp4` (2s video) and `/tmp/teste.png` (still).
   Every backend change: curl the affected op with the test clip, check
   `ok: True`.

2. **Browser:** `start_mcp_server with @playwright/mcp` → browser_navigate
   → browser_console → click every affected tab. ZERO JS errors.

3. **Server terminal:** `shell.py:run_command` streams ffmpeg stderr in
   real-time. No more 30-second black hole while ffmpeg runs.

---

## The Role System (AGENTS.md §C)

One file, clear lanes. Every agent reads the same AGENTS.md but follows
only their section:

| role | does | never |
|------|------|-------|
| Spec Writer | research, write specs to `docs/` | touches code |
| Builder | implement specs, WebUI verify, commit | writes specs |
| Reviewer | check diffs, edge cases, conventions | fixes things |
| Human | decides what to build | |

No protocol. No AIIM. No formal handoff. Just "find your lane and stay in it."

---

## The TODO System

`TODO.md` — flat markdown checklist in the repo root. Three sections:
`now`, `next`, `someday`. Codewhale reads it automatically. The human opens
it and picks what to work on. No login, no API, no ceremony.

---

## What We Accomplished (2026-07-25 to 2026-07-27)

### Infrastructure Cleanup

| item | what | commits |
|------|------|---------|
| ffprobe consolidation | 7 dupes → `app/probe.py` (4 functions) | 5 |
| datamosh twins | deleted bin/ copy, API uses root | 1 |
| static route extraction | 3 endpoints → `app/routes/static.py` | 1 |

### Pipeline consolidation (historical → current)

| era | approach |
|-----|----------|
| 2026-07 | `PngFramePipeline` shared dump/encode for some neural ops |
| 2026-07 late | `JobWorkspace` + `video_pipeline` async dump/process/encode |
| 2026-07-31 | **Filter platform**: stages in `app/filters/*`; `PngFramePipeline` **removed** (raises). Sync helpers: `dump_frames_sync` / `encode_frames_sync` on `video_pipeline` |

| op | current shape |
|----|----------------|
| rife | directory stage `filters/rife.py` + thin op |
| deepdream video | per_frame `filters/deepdream.py` + thin op |
| withoutbg video | per_frame `filters/withoutbg.py` |
| styletransfer video | per_frame `filters/styletransfer.py` |
| convert | bookends only (`convert_presets`) |
| pipeline | `POST /ops/pipeline` + PipelineChain |
| facemorph | multi-source morph → workspace frames → encode; dream_after → filters.deepdream |

### Later features (selected)

| item | status |
|------|--------|
| RIFE / DeepDream / Convert tabs | ✅ |
| Filter platform + pipeline backend | ✅ |
| Multi-Pass UI queue | ⏳ open |
| Model Manager | ⏳ deferred |
| CivitAI etc. | backlog specs |

---

## The Consolidation Pattern

When you find duplicated code, don't write a spec. Follow this checklist:

1. Create one shared module with clean functions — no state, just I/O
2. Update one caller at a time. Swap the import, verify, commit.
3. Mark old implementations with `# TODO: migrate to app.<module>`
4. Delete old implementations only after all callers migrated.
5. One commit per caller. Bisectable history beats one big commit.

**When NOT to consolidate:**
- If the code hasn't stabilized (flags still changing)
- If callers have genuinely different needs (facemorph's scale filter, deepdream's audio muxing)
- If consolidating would change behavior

---

## The Route Extraction Pattern

main.py has 19 hardcoded endpoints. Extract them one module at a time:

1. Create `app/routes/<name>.py` with a `register(app)` function
2. Move the exact route code into it — zero changes
3. In main.py: `from .routes import <name>; <name>.register(app)`
4. Verify: browser → affected tab → zero console errors

Order: easiest first. `/api/browse` (one endpoint, zero shared state) → 
`/api/video` + `/api/image` + `/api/probe` + `/api/media_info` + 
`/api/thumbnail` + `/api/media/{hash}` + `/api/export_frame` (media routes) → 
`/api/pool/*` (shared state) → `/api/picker` (weirdest, 178 lines) → 
`/api/watcher` → `/api/job/*` → `/api/health`.

---

## What Broke (And What We Learned)

1. **Subagents don't get AGENTS.md.** `delegate_task` has `skip_context_files=True`
   hardcoded. Builders won't see project rules unless you put them in the
   `context` field. Fixed: bootstrap template now mandates browser verification
   in the context field.

2. **"I tested it" means nothing without browser verification.** Codewhale wrote
   frontend code, claimed it worked, and it didn't. Cause: no browser access.
   Fix: Playwright MCP + AGENTS.md §D (Part 2) mandating browser verification.

3. **90% of bugs are ffmpeg, not JS.** The verification system now tests ops
   with `/tmp/teste.mp4` before browser checks. Backend first, browser second.

4. **Commas in filenames.** Comma-separated path lists break on `my video, final.mp4`.
   Fix: newline-separated paths in textareas. Newlines never appear in filenames.

5. **Specs for refactoring are wrong.** Consolidation work (ffprobe, datamosh twins,
   PNG pipeline) doesn't need a 10-section spec. It needs a checklist: build
   shared module → migrate one caller → verify → commit → repeat.

6. **The conductor gate is unnecessary.** AGENTS.md §D originally had a
   "conductor independently verifies" rule. Removed when we dropped AIIM.
   Each agent self-verifies with the test clip and browser. Simpler, faster.

---

## Rules We Live By

- One commit per change. Bisectable history.
- Browser verify after every frontend change. Zero console errors.
- Test clip verify after every backend change. `ok: True`.
- Newlines, not commas, for multi-file inputs.
- Role lanes in AGENTS.md §C — find yours, stay in it.
- TODO.md is the single source of truth for what's being worked on.
- No AIIM. No protocol. Direct communication.
- Ghosts don't write themselves into md files.
