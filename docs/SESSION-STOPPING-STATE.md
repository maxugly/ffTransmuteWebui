# Session stopping state — handoff

> **Date:** 2026-08-04  
> **VERSION:** `000.000.4.62`  
> **Branch:** `main`  
> **Authoritative live status / roadmap:** [STATUS.md](STATUS.md)  
> **Purpose:** Human + next-agent handoff — what shipped, what is open, how to resume.

---

## 1. Shipped this stretch (through 4.62)

| Area | Notes | Spec / code |
|------|--------|-------------|
| **RIFE Recohere (all mids)** | Keep every RIFE mid; img2img each (no discard) | `rife_recohere_ops.py` · **`4.62`** |
| **Prompt Library** | Global save/load positive+negative; localStorage | `js/ui/prompt-library.js` · **`4.61`** |
| **RIFE Recoherence** | 2 stills → RIFE M=2 → recohere mids → .mp4 + tab | `rife_recohere_ops.py`, `riferecohere.js` · **`4.60`+** |
| **Agent tab + HTTP APIs** | CLI + DeepSeek/OpenRouter/xAI/… via `~/.secrets` | `agent_ops.py`, `agents/*` · **`4.59`** |
| **Txt2img / Img2img OpenVINO** | Ops + WebUI tabs; mark frames on img2img | **`4.55`+** |
| Image Sort chain + bottom docs pilot | radial \| chain; `.tool-docs` spreading | ~`4.54` |
| RIFE ×2–128 + progress core | dir watch on RIFE | **progress still partial** |

Earlier stable: filter platform, dual pools, Convert, neural ops, pre-run strips, Run timer, partial list-keys.

---

## 2. Partial / open (do not claim done)

| Area | Next |
|------|------|
| Workspace progress | `workspace-progress-spec.md` — dump watch, multi-phase ETA |
| Tool bottom docs | Roll out remaining tabs |
| List / sequence keys | `ui-list-nav-timer-spec.md` |
| NCNN Upscale | Code in tree — verify WebUI → ship or fix |
| Universal persistence | `universal-persistence-spec.md` |
| Cut encode | dump+encode bookends |
| Job queue | `job-queue-spec.md` |
| Tilagup mode | `tilagup-mtapi-mode-spec.md` |
| Quality rating | `image-quality-rating-spec.md` (+ pool normalize) |
| Full backlog | STATUS §5.5 — human priority only |

---

## 3. Known bugs

1. Autosave can overwrite named projects.  
2. List reorder jumps to top.  
3. Arrows scroll page outside wired lists.  
4. Inactive tab knobs not persisted.  
5. Pool normalize drops extra fields.  
6. Extreme RIFE M × large K (no soft warn).

---

## 4. Doc map

| Doc | Role |
|------|------|
| **[STATUS.md](STATUS.md)** | Canonical roadmap: shipped / partial / remaining |
| [README.md](README.md) | Doc index + at-a-glance |
| This file | Handoff narrative |
| `prompt-library-spec.md` | Prompt library as-built (`4.61`) |
| `rife-recoherence-spec.md` | Recohere as-built (`4.60`) |
| `agent-vision-tab-spec.md` | Agent Phase A+API |
| `img2img-openvino-spec.md` | Img2img |
| `job-queue-spec.md` / `universal-persistence-spec.md` / `tilagup-mtapi-mode-spec.md` / `image-quality-rating-spec.md` | Next cleaned specs |
| `filter-platform-spec.md` / `video-image-pools-spec.md` | Core law |

Sibling: `/home/m/snc/cod/tilagup`.

---

## 5. Uncommitted risk

```bash
cd /home/m/snc/cod/ffTransmuteWebui
git status
git diff --stat
cat VERSION   # expect 000.000.4.61
```

Commit/push only when human asks. Tree often includes recohere, prompt library, upscale bins, docs.

---

## 6. How to resume

```bash
cat docs/STATUS.md                 # roadmap
cat docs/SESSION-STOPPING-STATE.md
cd mtapi-project && .venv/bin/python run.py   # :24590
```

| Role | First read | Then |
|------|------------|------|
| Spec writer | STATUS §5 | Docs only |
| Builder (UX) | `ui-list-nav-timer-spec.md` | Keys / scroll |
| Builder (progress) | `workspace-progress-spec.md` | Close checklist |
| Builder (upscale) | in-tree ops + backlog upscale | Verify → ship |
| Builder (queue / persistence / tilagup) | matching cleaned spec | When prioritized |

**STATUS §8** = suggested build order. No random backlog without human priority.
