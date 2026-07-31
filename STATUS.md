# Sprint Status — ffTransmuteWebui

> Updated: 2026-07-31 · Filter platform era

## Architecture (done)

| What | Status | Note |
|------|--------|------|
| JobWorkspace + video_pipeline | ✅ | bookends |
| app/filters stages | ✅ | rife, deepdream, withoutbg, styletransfer |
| POST /ops/pipeline | ✅ | disk cascade |
| Convert / Export | ✅ | codecs + frames_* + GIF |
| PngFramePipeline removed | ✅ | stub raises |
| AGENTS.md tree aligned | ✅ | root → filters |

## Frontend modularization (earlier)

| What | Status |
|------|--------|
| CSS / JS modules, pool split | ✅ largely |
| Convert tab | ✅ |
| Multi-Pass pipeline UI | ⏳ pending |

## Open / next

| What | Status | Note |
|------|--------|------|
| Multi-Pass UI | ⏳ | backend ready |
| Model Manager | ⏳ | when chaining heavy nets |
| Facemorph multi-source registry kind | ⏳ optional | |
| Backlog ops (ASCII, CivitAI, …) | backlog | on filter platform |
| Speed ramp E2E | ⚠️ in progress | product |

## Dead / archived ideas

| What | Note |
|------|------|
| setpts curve ramp | abandoned (see speed-ramp-debug) |
| Keep evolving PngFramePipeline | **do not** — removed |

Canonical: `docs/filter-platform-spec.md`, `ROADMAP.md`, `TODO.md` (current status banner).
