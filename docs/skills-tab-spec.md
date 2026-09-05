# Skills Tab — Spec

> **Status:** Implemented `000.000.8.016`.
> **Hat**: Spec writer. This document only — no app code.
> **Drives**: `VERSION` bump on ship (far-right DD) + STATUS top box + changelog entry.
> **Related**: `docs/agent-vision-tab-spec.md` (LLM backends), `docs/prompt-library-spec.md` (list idioms), `docs/universal-persistence-spec.md` (project isolation), `docs/model-manager-spec.md` (NOT this — that spec is about neural-model VRAM pooling; name collision is intentional to flag, not to merge).

---

## 1. Problem

There is nowhere in the WebUI to keep AI-model skills (Agent Skills / `SKILL.md` idiom: a markdown skill plus optional bundled scripts/references). Users collect skills as loose files across machines, with no way to normalize them, find them, copy them into a prompt, or export them. The Agent tab has hardcoded skills (`chat`, `sd15_prompt`, `caption` in `app/agents/skills.py`) with no user-extensible store.

**Goal**: a top-level **Skills** tab (Workspace section, next to Agent/Notes) that:

1. **Uploads** a skill — single `.md`/`.txt` file, pasted text, or a `.zip` bundle containing `SKILL.md` + support files.
2. **Model-installs** it — an LLM normalizes the text, extracts `name`/`description` frontmatter, validates structure, then the server saves it and registers it in the skills DB. A Custom mode accepts a user prompt for the model to do more (summarize, rewrite, translate, …).
3. Makes each skill **trivial to select, read, copy, and export as .md/.txt**.

## 2. Scope

**In (v1)**:

- Upload single `.md`/`.txt` (file picker or paste) + `.zip` bundles.
- `POST /ops/skills_install` (JSON: single-file/paste path via `content_text`,
  zip path via `content_b64` base64 — **no multipart endpoint**, so no
  `python-multipart` dependency and the zip path reuses the full job/progress/
  cancel/single-flight machinery) and `mode: normalize | custom` model modes.
- Server store: `~/.cache/mtapi/skills.json` index + `~/.cache/mtapi/skills/{id}/` file bytes. Shared across browsers; orthogonal to named projects (never written into `*.ffproject.json`, like Prompt Library).
- List (newest first, search filter) + reader pane (`SKILL.md` default, file switcher for bundles) + one-click **Copy** + **Export .md/.txt** + **Delete**.
- Reuse of existing `app/agents/` LLM backends (deepseek/openrouter/xai/openai/groq/agy). Text-only; no vision needed.

**Out (v1, follow-ups)**:

- Wiring installed skills into the Agent tab's skill dropdown as usable context — the obvious v1.1. Hook point only (§9).
- Versioning, ratings, tags/folders, marketplace sync.
- Markdown rendering in the reader (plain `<pre>` text is v1).
- `state.skills.selectedId` in the desk snapshot (selection is session-only in v1).

## 3. Locked decisions

| Decision | Selection | Notes |
|----------|-----------|-------|
| Skill format | **Both**: single `.md`/`.txt` AND `.zip` bundles with `SKILL.md` | Zip: `SKILL.md` at root or one level down, else reject |
| Model role | **Normalize + metadata by default**; optional custom prompt for more | Never silent full-rewrite without the user choosing Custom |
| Storage | **Server JSON file** (`~/.cache/mtapi/skills.json` + `skills/` dir) | Shared, survives F5, any browser — unlike `localStorage` |
| Placement | **Top-level tab**, Workspace section | Own `nav-item[data-tab="skills"]`, next to Agent/Notes |
| Limits | 200 skills · single file ≤ 200 KB · zip ≤ 5 MB / 50 files | Reject with `ok:false` message on exceed |
| Copy scope (bundle) | Copy shows **currently viewed file** (`SKILL.md` by default) | Per-file copy falls out of the file switcher for free |
| Export implementation | **Client-side first** (from already-fetched content, `Blob` + `a[download]`) | `GET /api/skills/{id}/export` only if builder finds a reason; do not build both |
| Tab chrome | Hide Run/Queue + hide global Video/Image Path inputs | Same as Agent/Notes (`hideRun`, `noGlobalInputs` in `app.js`) |

## 4. Data model

Server holds the truth; browser renders it.

### 4.1 Index — `~/.cache/mtapi/skills.json`

```json
{
  "version": 1,
  "skills": [
    {
      "id": "e4b3c2a1-1234-5678-9abc-def012345678",
      "name": "video-caption-pro",
      "description": "Short-video caption style for img2img prompts",
      "source": "upload-single",
      "files": {"SKILL.md": "SKILL.md", "scripts/run.py": "scripts/run.py"},
      "entry": "SKILL.md",
      "created_at": "2026-09-05T00:00:00.000Z",
      "updated_at": "2026-09-05T00:00:00.000Z"
    }
  ]
}
```

| Field | Rule |
|-------|------|
| `id` | Stable string; `uuid4` hex |
| `name` | kebab-case, 1–64 chars; from frontmatter or model; case-insensitive collision → `confirm()` overwrite, keep `id`, bump `updated_at` |
| `description` | One line, ≤ 160 chars; from frontmatter or model |
| `source` | `upload-single` \| `upload-zip` \| `pasted` |
| `files` | Map of display path → relative path under `skills/{id}/`; keys sorted, `entry` first |
| `entry` | Always `SKILL.md` after install (single-file uploads are stored as `SKILL.md`) |
| `created_at` / `updated_at` | ISO-8601 |

- Atomic writes: write `skills.json.tmp` + `os.replace` (catalog idiom, cf. `media/catalog.py`, `media/projects.py:62-64`).
- Corrupt index → `ok:false` on write ops, list returns `[]` with a console warning; never silently re-seed or wipe (Prompt Library §4 idiom).
- File bytes: `~/.cache/mtapi/skills/{id}/...`. Zip members resolved against the skill dir; any member escaping the dir (`../`, absolute) rejects the whole install.

### 4.2 Frontmatter contract (model output)

```markdown
---
name: my-skill
description: One line saying what and why.
---

<body…>
```

Hand-parse (no new PyYAML dep — two keys): server takes the first `---`-fenced block, reads `name:`/`description:` lines, trims quotes/whitespace. Precedence: model output frontmatter wins; if the model output has no usable name (or the backend failed, e.g. offline `stub`), the server falls back to the input text as-is when IT parses — flagged in `meta.warning`. If neither parses → install fails with `ok:false` and the raw model output attached in `meta.model_output` so the user can retry with a Custom prompt. Nothing is written on failure.

## 5. Backend API

Conventions (non-negotiable): argv lists via `shell.run_command`, never `shell=True` (no subprocess needed here at all); failures are HTTP 200 + `{"ok": false}`; long model calls report via `job_control.report_progress()`; `dry_run` early-ok per `agent_ops.py:69-80`.

New file `app/operations/skills_ops.py` + one import in `operations/__init__.py` (never touch `main.py` — routes auto-build from the registry; no `from __future__ import annotations` in `main.py`).

| Op / route | Input | Behavior |
|------------|-------|----------|
| `POST /ops/skills_install` | `{ backend, mode, custom_prompt?, filename?, content_text?, content_b64?, source?, overwrite? }` (JSON; exactly one of `content_text`/`content_b64`) | Model pass over entry text → parse frontmatter → write `skills/{id}/SKILL.md` (+ bundle extras) → upsert index → return entry. Zip bytes arrive base64 in `content_b64`. Same-name collision without `overwrite:true` → `ok:false` + `meta.conflict` so the UI can `confirm()` and retry. |
| `GET /api/skills` | — | Index entries (metadata only, no bodies). Thin route, not an op (read-only, no job) — follow the catalog/settings GET pattern |
| `GET /api/skills/{id}` | — | Entry + `{ path: content }` for all files (cap total 500 KB, else `ok:false`) |
| `DELETE /api/skills/{id}` | — | Remove `skills/{id}/` + index row; return `{ ok:true }` |

### 5.1 Model-install prompts (`app/agents/skills.py`, additive only)

New builder next to `build_messages`, e.g. `build_skill_install_messages(mode, custom, text) -> (system, user)`:

- **normalize** system: *"You are a skill packager. Given raw skill text, return: (1) YAML frontmatter with `name` (kebab-case, ≤64 chars) and `description` (one line, ≤160 chars), then (2) the cleaned body. Fix headings, remove redundancy, do NOT change semantics or drop sections. Output the full SKILL.md only, no preamble."*
- **custom** system: same output contract + *"Additionally follow this user direction: {custom_prompt}"*. Empty `custom_prompt` in custom mode → reject client-side (disable Install) — do not send an empty direction.
- Reuses `run_backend()` plumbing, backend dropdown values, and `~/.secrets` keys already in tree. Text-only: no `require_vision` gate involved.

## 6. UX

Single panel, two columns (list | reader) under one upload card. All vanilla; reuse `.btn`, `.card`, `forms.css`. One `.skills-*` block only if needed.

```text
[ Upload card ]
  file input (.md/.txt/.zip) + paste <textarea> + backend <select>
  Mode: (○ Normalize  ○ Custom) + custom instruction <textbox, Custom only>
  [ Install skill ]  status line (progress / ok / ok:false message)

[ search box                                          ]
+---------------------+----------------------------------+
| Skill list          | Reader pane                    |
| • name + desc       |  name, description, source,    |
| • N files · updated |  updated                       |
| • [Delete] per row  |  file switcher (bundles)       |
| newest first        |  <pre> file text </pre>        |
|                     |  [Copy] [Export .md]           |
|                     |  [Export .txt] [Delete]        |
+---------------------+----------------------------------+
```

**Interactions**:

| Action | Behavior |
|--------|----------|
| Install | Validate (content present; custom_prompt present iff Custom) → `runOpWithCancel('skills_install', …)` → status line → refresh list, select new skill. On `meta.conflict` → `confirm()` → retry with `overwrite:true` |
| Select | Click row → `state.skills.selectedId`, fetch `GET /api/skills/{id}`, render reader (`entry` file default) |
| Search | Substring filter on name+description, client-side, no re-fetch |
| Copy | `navigator.clipboard.writeText(currentFileText)` with `textarea`+`execCommand` fallback; status "Copied N chars" |
| Export .md | Download current file (bundles: viewed file) as `{name}.md` via `Blob` |
| Export .txt | Single: same bytes as `{name}.txt`. Bundle: all files concatenated with `\n\n=== path ===\n` separators |
| Delete | `confirm()` → `DELETE /api/skills/{id}` → refresh list, clear reader if it was selected |
| Overwrite | Install with colliding name → `confirm()` → same `id`, new content, bumped `updated_at` |

Single-file uploads: `FileReader.readAsText` → JSON op (no multipart). Zip: `FileReader.readAsDataURL` → strip prefix → `content_b64` in the same JSON op (NOT a separate endpoint).

## 7. Tab wiring (exact steps)

1. `mtapi-project/app/static/index.html`: `<div class="nav-item" data-tab="skills">…</div>` in `nav-section[data-section="workspace"]`.
2. New `mtapi-project/app/static/js/tabs/skills.js`: `export function renderSkillsForm()` — sets `elements.actionPanel.innerHTML`, `GET /api/skills`, renders upload card + list + reader, wires all actions. Re-render-safe (tab switch destroys panel).
3. `mtapi-project/app/static/app.js`: import; `state.skills = { selectedId: null }` default; title-map line; `else if (tab === 'skills')` in `renderTabForm`; add `'skills'` to `hideRun` and `noGlobalInputs` lists. Scroll memory automatic via `js/ui/tab-scroll.js`.
4. Backend: `app/operations/skills_ops.py` (+ `operations/__init__.py` import), install-prompt builder in `app/agents/skills.py`, thin `GET/DELETE /api/skills*` routes.
5. Ship: bump root `VERSION` (far-right DD) + STATUS top box + changelog entry (AGENTS.md §3).

## 8. Edge cases

| Case | Behavior |
|------|----------|
| Zip with no `SKILL.md` | `ok:false` "No SKILL.md at root or one level down"; nothing written |
| Zip path traversal / absolute members | Reject whole install, `ok:false`; nothing written outside `skills/` |
| Zip over limits (>5 MB, >50 files) | Reject before extract, `ok:false` |
| Single file over 200 KB | Reject client-side with message before calling the op |
| Model output unparseable | `ok:false`, raw output in `meta.model_output`, nothing written |
| Backend key missing / backend error | Surface existing `provider_available` / backend error text, `ok:false` |
| Empty paste + no file chosen | Install disabled |
| 200-skill cap | Block new names; overwrite of existing name still OK |
| Index corrupt on disk | Reads return `[]` + warn; writes return `ok:false` (never auto-wipe) |
| Non-UTF8 file bytes | Decode `utf-8` with `errors="replace"`; note `meta.encoding_lossy:true` |

## 9. v1.1 hook (explicitly out of v1)

Installed skills SHOULD become usable context in the Agent tab (extend the skill `<select>` in `js/tabs/agent.js`, send installed `SKILL.md` body as system context through `agent_chat`). v1 only guarantees the store + reader; the Agent tab stays untouched.

## 10. Verification (builder: WebUI proof required, curl is not proof)

1. Upload single `.md` → Normalize → appears in list → select → Copy → paste elsewhere matches → Export `.md` downloads identical bytes. Zero JS errors.
2. Upload `.zip` bundle → installs; file switcher lists all files; Export `.txt` concatenates with `=== path ===` separators.
3. Same input via Custom ("summarize aggressively") visibly differs from Normalize output.
4. Malicious zip (`../evil.sh`, absolute `/tmp/x`) → rejected; nothing outside `skills/`; index unchanged.
5. Name collision → `confirm()` → same entry updated, `updated_at` bumped.
6. F5 in a fresh browser profile → list persists (server store).
7. **Playwright real-click pass** over 1–6 before claiming DONE (AGENTS.md §12).

## 11. Files to touch

| Path | Action |
|------|--------|
| `docs/skills-tab-spec.md` | THIS FILE (spec only) |
| `mtapi-project/app/operations/skills_ops.py` | NEW — `skills_install` (text + b64-zip, + `operations/__init__.py` import) |
| `mtapi-project/app/agents/skills.py` | ADDITIVE — install-prompt builder; existing skills untouched |
| `mtapi-project/app/static/js/tabs/skills.js` | NEW — `renderSkillsForm()` |
| `mtapi-project/app/static/index.html` | ADD nav item |
| `mtapi-project/app/static/app.js` | ADD import, state, title, dispatch, hideRun/noGlobalInputs |
| `mtapi-project/app/static/css/forms.css` | Optional `.skills-*` block |
| `docs/STATUS.md` | Top box + §5 queue on ship |
| Root `VERSION` | Bump DD on ship |

No changes to: `main.py`, Agent tab, Prompt Library, pools, projects, autosave, wall, filter platform.
