# Session stopping state — handoff

> **Date:** 2026-08-01  
> **VERSION:** `000.000.4.51` (tree at commit time)  
> **Branch:** `main`  
> **Purpose:** Clean stop for human + next agent (OpenCode). What shipped, what’s partial, what to do next.

---

## 1. Shipped (stable enough to leave alone unless bugs)

| Area | Notes | Spec / registry |
|------|--------|-----------------|
| **Image Sort → Video** | List, rank, shared order bar, folder via `/api/images/list`, optional RIFE, encode | `docs/image-sort-rife-spec.md` (**Implemented**) · ops `imagesort_rank`, `imagesort_rife` |
| **Speed Change** | Uniform speed, target FPS, frame budget warn, optional RIFE | Backend + Speed tab · old `speedchange-spec.md` is **stale pure-ffmpeg**; code has RIFE path too |
| **Speed Ramp + RIFE** | Single-Clip → speed ramp; RIFE knobs before remap | `speedramp_ops.py` |
| **Dense tool UI** | Compact buttons/forms across tabs | `forms.css` / `layout.css` |
| **Run-button elapsed timer** | Sticky `● m:ss` on Process while jobs run — **keep this** | `job-control.js` `paintStickyJobUi` |
| **list-keys (partial)** | Image Sort / Face Morph / withoutBG / Style Transfer registered; arrows/Ctrl+arrows | `ui/list-keys.js` — **not** sequence/pool polish yet |
| **Universal persistence** | Spec + agy prompt only — **not implemented** | `docs/universal-persistence-spec.md`, `docs/coder-agy-universal-persistence-prompt.md` |

Root `AGENTS.md` op table includes speed change + image sort.

---

## 2. In tree / partial (this commit if uncommitted)

| Area | Status |
|------|--------|
| **Pre-run summary helper** | `js/ui/pre-run-summary.js` + `.pre-run-summary` CSS |
| **Wired tabs** | Image Sort, RIFE, Speed Change, Face Morph (top strip / budget) |
| **Cut densify** | Removed redundant “clip from global video” row (global bar is source of truth) |

**Not done yet** (still in OpenCode UX spec):

- Sequence **Left/Right** keyboard + scroll retention on reorder  
- List scroll-into-view after ↑↓ (jump-to-top bug)  
- Stronger list-keys capture (prevent page scroll everywhere)  
- Pre-run strip on Convert / Datamosh / DeepDream / transmute ramp (optional stretch)  
- Harden timer if any edge case still fails  
- **Full desk persistence** (named project vs session autosave isolation)

---

## 3. Next agent: OpenCode

**Prompt:** `docs/coder-opencode-list-nav-timer-prompt.md`  
**Spec:** `docs/ui-list-nav-timer-spec.md`

Do in order:

1. Confirm Run-button timer still good (do not remove).  
2. Finish **pre-run** on remaining high-value tabs if easy.  
3. **Keyboard + scroll** for lists + **sequence horizontal**.  
4. Playwright checks in the UX spec.  
5. VERSION DD bump per change.

**Persistence (separate track / agy → builder later):**  
`docs/universal-persistence-spec.md` — autosave must never clobber named project files.

---

## 4. Doc index (current)

| Doc | Role |
|------|------|
| `SESSION-STOPPING-STATE.md` | **This file** — stop handoff |
| `image-sort-rife-spec.md` | As-built Image Sort |
| `ui-list-nav-timer-spec.md` | OpenCode: timer, keys, scroll, pre-run |
| `coder-opencode-list-nav-timer-prompt.md` | Short OpenCode prompt |
| `universal-persistence-spec.md` | Full desk save redesign (spec) |
| `coder-agy-universal-persistence-prompt.md` | Agy prompt that produced persistence spec |
| `persistence-inventory.md` | What is saved today (session/project) |
| `ui-state-map.md` | UI variables inventory |
| `filter-platform-spec.md` | Frame pipeline law |
| `video-image-pools-spec.md` | Dual pools + sequence |

---

## 5. Known product bugs (do not forget)

1. **Autosave can overwrite named projects** when clearing sequence / Save As — see universal persistence.  
2. **List reorder** often scrolls list to top.  
3. **Arrows** often scroll the page instead of list selection outside well-wired tabs.  
4. **Inactive tab knobs** are not in project JSON (DOM destroyed on tab switch) — persistence spec.

---

## 6. How to resume

```bash
cd /home/m/snc/cod/ffTransmuteWebui
git pull
cat VERSION
# OpenCode:
#   read docs/coder-opencode-list-nav-timer-prompt.md
#   read docs/ui-list-nav-timer-spec.md
# Persistence builder (later):
#   read docs/universal-persistence-spec.md
```

Server: `cd mtapi-project && .venv/bin/python run.py` · UI `http://localhost:24590/`
