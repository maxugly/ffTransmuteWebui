# AI Rapper tab — spec

> **Status:** Spec — implementation landing in this stretch.
> **Scope:** One new desk tab (`airapper`), one saved-track library, one agent
> surface. Reuses the existing ops `agent_chat` and `music_generate`; invents no
> new dump/encode stack (invariant 1), no frontend framework (invariant 7), no
> native tooltips (house help law), and no new form-state endpoint (§4 Layer A).

---

## 1. What this tab is

A writing and production workspace for AI-assisted rap:

1. **Write** — a lyrics/output textarea plus title, description, tags.
2. **Direct** — a chat sidebar that sends the marked tiles as context to
   `agent_chat` and writes back only the tiles it was permitted to write.
3. **Set the pocket** — tempo / key / swing / meter. These are not decoration:
   they feed the ACE-Step SFT metadata on `music_generate` (§6).
4. **Produce** — "Make Hot Fire" calls `music_generate`, and the returned WAV
   lands in the media pool like any other tab's output.
5. **Keep** — saved tracks go to a real library (§4 Layer B), not to desk state.

### 1.1 Grounded ops (verified in-repo, not assumed)

| Op | Source | Params this tab uses |
|----|--------|------------------------|
| `agent_chat` | `app/operations/agent_ops.py` | `backend` (`grok\|agy\|stub\|deepseek\|openrouter\|xai\|openai\|groq`), `skill: 'chat'`, `message`, `history`, `timeout_s` (10–900) |
| `music_generate` | `app/operations/music_ops.py` | `prompt`, `lyrics`, `seed`, `duration_sec` (10–60), `model` (`acestep-v15-turbo\|acestep-v15-base\|acestep-v15-sft`), `negative`, `steps`, `guidance`, `shift`, **`bpm`, `key`, `timesig`** |

> **Note.** The Music Theory tile rides `music_generate`'s own `bpm` / `key` /
> `timesig` fields — they exist in the real params model and are documented as
> "Tempo for the SFT metas", "Key/scale for the SFT metas", "Time signature for
> the SFT metas". An earlier draft of this spec omitted them; they are wired.

There is **no** "Antigravity" agent backend in this repo. The string
`antigravity` appears only inside a FastSD-CPU path. Agent calls go to
`agent_chat`.

---

## 2. Layout

Flexbox, dense, 1080p-first.

```
┌──────────────────────────────────────────────────────────────────┐
│ #arWorkspace  (flex row, 4px gap, 8px padding)                   │
├────────────┬─────────────────────────────────────────────────────┤
│ Sidebar    │ Tiles (CSS grid, 4px gap)                          │
│ 40px ⇄     │  ┌─────────┬─────────┬──────────┐                  │
│ 300px      │  │ Meta    │ Theory  │ Tags     │                  │
│            │  ├─────────┴─────────┴──────────┤                  │
│  chat log  │  │ Lyrics / Output              │                  │
│  backend   │  │  + "Make Hot Fire"           │                  │
│  composer  │  └──────────────────────────────┘                  │
│            │  ┌──────────────────────────────┐                  │
│            │  │ Saved Songs (4 × 220px cols) │                  │
│            │  └──────────────────────────────┘                  │
└────────────┴─────────────────────────────────────────────────────┘
```

The tab joins the **bare-workspace** set: preview panel, input-preview strip and
global inputs are hidden via the `hideRun` + `noGlobalInputs` lists in `app.js`
(§7 steps 7–8), so the workspace owns the full content width.

### 2.1 Mount point

The workspace container is created **by the render function**, exactly like
`mediacatalog` and `cdp`:

```js
elements.actionPanel.innerHTML = '<div class="ar-workspace" id="arWorkspace">…</div>';
```

**Why not a static container in `index.html`.** `elements.actionPanel` resolves
to `#actionPanelForm` (`app.js:450`), and `renderTabForm` wipes
`elements.actionPanel.innerHTML` for every non-cached tab (`app.js:1270`).
`airapper` is not in `CACHED_TABS` (`js/pool/tab-roots.js:22` — `pool`,
`sequence`, `images` only, Phase 1 scope). A container declared in `index.html`
inside `#actionPanelForm` would therefore be destroyed on first render and
never come back. The static markup that *is* required in `index.html` is the
stylesheet link and the nav item (§7 steps 1–2).

---

## 3. Tiles

Every tile header carries three checkboxes:

| Control | Meaning |
|---------|---------|
| **Hide Tile** | Collapses the tile body. UI preference only. |
| **In** | The agent **reads** this tile as context. |
| **Out** | The agent may **overwrite** it. |

`In` alone → context only. `Out` alone → write only. `In`+`Out` → read,
process, write back. Neither → the agent never sees the tile.

### 3.1 Meta
Title (auto: first line of lyrics → description → `track-00000X`) + description.

### 3.2 Music Theory
Tempo knob (40–200 BPM, default 95), Swing knob (0–100%), Key Signature select
(C♯ … B, major + minor, FL-Studio ordering), Time Signature select (4/4, 3/4, 6/8).

### 3.3 Tags
Clickable chips with `data-help-title` / `data-help-text` explaining the
mechanic each tag invokes (e.g. `PERLP_V1`).

### 3.4 Lyrics / Output
The main `<textarea>` plus **Make Hot Fire**.

### 3.5 The id rule

> **Every control carries a stable, unique `id`.** That id *is* the persistence
> mechanism (§4 Layer A). A control without an id silently does not survive a
> tab switch, and nothing will warn you.

---

## 4. State & persistence — two layers, not merged

### 4.1 Layer A — workspace / tab state: no new endpoint, no new JSON file

`app.js` delegates `input` and `change` on `#actionPanel` to
`captureCurrentFormState()` + `scheduleSavePoolState()`. Every
`input[id]` / `select[id]` / `textarea[id]` under the panel is snapshotted into
`state.formState[tab]` and replayed by `applySavedFormState(tab)`. That snapshot
rides `pool_state.json` (session autosave) and `*.ffproject.json` (explicit
Save / Save As).

→ Give every control an id and persistence is free. **Write no fetch code for it.**

- An `airapper` entry in `DESK_TAB_DEFAULTS` (`js/pool/persistence.js:29`) makes
  first-run defaults explicit.
- There is deliberately **no** `/api/airapper/state` route. It would duplicate
  the desk snapshot, and the named-project copy omits it — projects would lose
  the tab's state.

### 4.2 Layer B — the saved-track library: a real store

A user's saved songs are a **library**, not desk state.

- `app/airapper_store.py` — pure storage helpers. **No FastAPI, no subprocess.**
  Root `~/.cache/mtapi/airapper/`, honoring `MTAPI_AIRAPPER_ROOT`. One
  `<id>.json` per track, atomic tmp-then-`os.replace` writes, a
  `threading.Lock`, size caps, an index version field. Modelled on
  `app/skills_store.py`.
- `app/routes/airapper.py` → `register(app)`:
  - `GET /api/airapper/tracks`
  - `GET /api/airapper/tracks/{id}`
  - `POST /api/airapper/tracks`
  - `DELETE /api/airapper/tracks/{id}`

  Every failure returns **HTTP 200 + `{"ok": false, "error": …}`** (invariant 10).
- Wired into `main.py` after `cdp.register(app)`.

> **Orthogonality.** This library is **never** written into `*.ffproject.json`.
> Same class as the skills library: user-authored documents, not project state.

### 4.3 UI preferences

`localStorage` key `mtapi.airapper.ui_prefs`: sidebar collapsed state, tile
visibility, In/Out defaults. **UI preferences only** — never lyrics, never
tracks, never media.

---

## 5. Agent interaction

1. Collect every tile with `In=true` into a compact context block.
2. `runOpWithCancel('agent_chat', { backend, skill: 'chat', message, history })`
   — never a raw `fetch()` to `/ops/*`.
3. Instruct the model: *"return only the tiles you were permitted to write, as a
   JSON object keyed by control id."*
4. Parse the reply; apply **only** keys whose tile has `Out=true`. Ignore
   everything else.
5. After applying a delta, **do nothing** — the normal form-state capture fires
   on the resulting `input`/`change` events. No manual save.

---

## 6. Lyric generation directive — `[PERLP_V1]`

**Phonetic Elasticity & Rhythmic Lock Protocol.** When generating or editing
lyrics the agent must hold to:

- **Orthography is Null** — rhyme validity is decided by phonetic output (IPA),
  never by spelling.
- **Consonant Cluster Assimilation** — merge/swap adjacent consonants across
  word boundaries ("Tight word" → /taɪtwɜrd/).
- **Schwa Injection** — insert /ə/ to expand disyllabic tokens into
  trisyllabic pockets ("Slight urge" → "Slight-uh-urge").
- **R-Colored Vowel Compression** — delete medial vowels in R-controlled
  syllables, letting /r/ act as the nucleus ("Bird" → /brd/).
- **Semantic Subordination** — meaning is secondary to the phonetic lock. A
  semantically perfect word that breaks the grid is discarded for a
  phonetically compliant synonym.

---

## 7. Registration — a tab is not done until all of these land

| # | File | Change |
|---|------|--------|
| 1 | `app/static/index.html` | `<link rel="stylesheet" href="/css/airapper.css?v=1">` |
| 2 | `app/static/index.html` | nav item `data-tab="airapper"` with `data-help-*` |
| 3 | `app/static/index.html` | *(container created at render time — see §2.1)* |
| 4 | `app/static/app.js` | `import { renderAirapperForm } from '/js/tabs/airapper.js';` |
| 5 | `app/static/app.js` | `else if (tab === 'airapper') { renderAirapperForm(); }` in `renderTabForm` |
| 6 | `app/static/app.js` | `TAB_ACCEPTS` → `airapper: 'none'` |
| 7 | `app/static/app.js` | `hideRun` list → `\|\| tab === 'airapper'` |
| 8 | `app/static/app.js` | `noGlobalInputs` list → `\|\| tab === 'airapper'` |
| 9 | `app/static/app.js` | title line → `AI Rapper · write, direct, produce` |
| 10 | `app/static/js/pool/persistence.js` | `DESK_TAB_DEFAULTS.airapper` |
| 11 | `docs/knob-configs.md` | tempo + swing rows |
| 12 | `docs/spec_registry.json` | register this spec |

---

## 8. Track list (Saved Songs)

- Container: `columns: 4 220px; column-gap: 4px; column-fill: balance;`
- Cards: `break-inside: avoid;` with a fixed min-height.
- **Do not sort by `title.length` ascending.** CSS columns balance by *column
  height* — title length never widens a column, and equal-length titles
  reshuffle on every save. Sort by `created_at` descending, or keep insertion
  order.
- Clicking a card loads that track's title, description, lyrics, tags, tempo,
  key, swing and meter into the workspace tiles.