# Settings Card Layout Spec

> **Status:** **Implemented** `000.000.5.13` — as-built house style for the Settings tab.  
> **Audience:** Builders adding Settings cards or other preference chrome  
> **Pilot / source of truth:** Settings tab (`js/tabs/settings.js` + `css/settings.css`) as of `5.12`  
> **Related:** `performance-settings-spec.md` (what the knobs *do* — not how they are laid out), `universal-persistence-spec.md` (settings precedence), `style-css-map.md`  
> **Not this:** Op-tab knobs (DeepDream / Style / FastSAM). Those stay in their tool panels. Settings is global prefs only.

This spec exists so new Settings UI is born tight. Do not land a stretched card and “clean it up later.”

---

## 1. Goal

Settings is a **single scrolled page of compact cards**. Every preference group is one card. The page must stay readable at a glance without hunting, stretching, or stacking titles.

If a new setting does not fit this shell, the setting is wrong for this tab — or the card needs a tighter copy wrap, not a wider card.

---

## 2. Locked product rules

| # | Rule |
|---|------|
| 1 | **One page.** No Settings sub-tabs, accordions, or full-width dashboards. |
| 2 | **One card per group.** Group = one job (Pool & cache, Keep models warm, …). Do not dump unrelated prefs into one card. Do not give each knob its own card. |
| 3 | **Cards hug content.** `width: max-content; max-width: 100%`. Never `width: 100%` of a 900px column. Never `min-height` that leaves empty card body. |
| 4 | **Workspace is narrow.** `.settings-workspace` max-width **520px**, left-aligned, cards do not stretch to fill leftover desk. |
| 5 | **Head is one line.** Kicker + title share `.settings-card-head`. Example: `PERFORMANCE` + `Pool & cache`. Never stack kicker above title. |
| 6 | **Controls first, blurb last.** Title → control row → `.settings-card-desc`. Description never sits between title and controls. |
| 7 | **Controls pack left.** Knobs and switches sit next to each other with a small gap. No `flex: 1` / `space-between` that flings switches to the far right. |
| 8 | **Switch = label + toggle, 8px gap.** Label on the left, switch immediately after. Do not put the switch on the opposite edge of the card. |
| 9 | **No scale chrome under knobs.** Discrete knobs show the current value in the value field only (`H`, `30s`). Do not add `L M H` (or similar) tick labels under the dial. Meaning of L/M/H belongs in the blurb. |
| 10 | **Blurb is two short lines max.** Wrap on purpose with `<br>` at a natural phrase break. Do not let one long sentence force the card wider. |
| 11 | **Reuse classes.** New cards use the shell below. Do not invent a second Settings layout or paste op-tab `.form-group` stacks into Settings. |
| 12 | **Bare workspace stays.** Settings hides global inputs, Run/Queue, preview (existing `body.settings-tab-active` rules). Do not reintroduce them. |

---

## 3. Card anatomy

```text
┌─ card (max-content) ─────────────────────────────────┐
│  KICKER    Title                          ← one line │
│                                                      │
│  [knob] [knob]   Label [switch]                      │
│                  Label [switch]           ← packed   │
│                                                      │
│  Short blurb line 1                       ← last     │
│  short blurb line 2                                  │
└──────────────────────────────────────────────────────┘
```

Shipped examples:

| Card | Kicker | Title | Controls | Blurb wrap |
|------|--------|-------|----------|------------|
| Pool & cache | `PERFORMANCE` | Pool & cache | Thumbnail knob, Autosave knob, two RAM switches | after `byte-bounded` |
| Keep models warm | `NEURAL FX` | Keep models warm | DeepDream / Style Transfer / FastSAM switches in one row | after `Default is off` |
| UI tweaks | `DISPLAY` | UI tweaks | Scrollbar width knob (6–30px) | after `minimum` |

---

## 4. Markup (copy this)

```html
<section class="settings-card" aria-labelledby="settingsFooTitle">
  <div class="settings-card-head">
    <span class="settings-card-kicker">Group</span>
    <h4 class="settings-card-name" id="settingsFooTitle">Short name</h4>
  </div>
  <div class="settings-knob-row"><!-- or settings-warm-row for switch-only -->
    <!-- knobs / switchHtml(...) -->
  </div>
  <p class="settings-card-desc">Phrase that fits the card.<br>Second line if needed.</p>
</section>
```

Switch helper (already in `settings.js`):

```html
<label class="settings-switch-row" for="id">
  <span><strong>Label</strong></span>
  <input type="checkbox" id="id" role="switch">
  <span class="settings-switch" aria-hidden="true"></span>
</label>
```

| Class | Role |
|-------|------|
| `.settings-workspace` | Page column. max-width 520px. `align-items: flex-start`. No page title; sidebar already says Settings. |
| `.settings-card` | One group. `width: max-content`. |
| `.settings-card-head` | Flex baseline row for kicker + title. |
| `.settings-card-kicker` | Uppercase section word (`PERFORMANCE`, `NEURAL FX`). |
| `.settings-card-name` | Card title. Same line as kicker. `margin: 0`. |
| `.settings-knob-row` | Packed control row. Gap ≈ 10×16px. No `flex: 1` children. |
| `.settings-warm-row` | Packed switch-only row. |
| `.settings-switches` | Vertical stack of switch rows, width auto. |
| `.settings-switch-row` | `justify-content: flex-start`; gap 8px. |
| `.settings-card-desc` | Last child. Intentional `<br>`. |

Do **not** revive `.settings-scale` (the L/M/H ticks). Do **not** use `.settings-grid` for live prefs — that was placeholder chrome.

---

## 5. Spacing & width budget

Treat these as the default. Tighter is OK. Wider needs a human reason.

| Token | Value | Notes |
|-------|-------|-------|
| Workspace max-width | **520px** | Page column, not the card. |
| Card width | **max-content**, cap 100% | Typical shipped cards ~410–450px. |
| Card padding | **12px 14px** | |
| Card internal gap | **6–10px** | |
| Workspace gap (card to card) | **16px** | |
| Knob-to-knob / control gap | **10px / 16px** | Not 28px+. |
| Label → switch | **8px** | |
| Head kicker → title | **8–10px** | |

If a control row is about to exceed ~480px:

1. Shorten labels, or
2. Add a `<br>` in the blurb so the card can shrink, or
3. Wrap the *control row* (`flex-wrap`) — still packed left.

Do not solve overflow by stretching the card to the preview-less desk.

---

## 6. Copy rules

- Kicker: one or two words, uppercase via CSS, not the sentence title.
- Title: 2–4 words. Completes the kicker (`PERFORMANCE` + `Pool & cache`).
- Switch labels: the thing being toggled (`DeepDream`, `Keep thumbnails in RAM`). Not a paragraph.
- Blurb: what it costs / what L/M/H means / default. **Two lines.** Break after a complete phrase:

```text
… RAM caches are byte-bounded
and can be cleared by restarting the server.

… Default is off
to avoid VRAM pressure.
```

- Do not repeat the title in the blurb.
- Do not put “L M H” anywhere except the knob value and the blurb (`L = 120px, M = 240px, H = 480px`).

---

## 7. Adding a new Settings card (builder checklist)

1. Read this spec. Do not copy an op-tab form.
2. Add one `<section class="settings-card">` with the anatomy in §4.
3. Persist via existing `saveSettings()` / `/api/settings` / `localStorage` (`universal-persistence-spec.md`). Named projects still must not overwrite globals.
4. Use `setupContinuousKnob` for discrete prefs; use `switchHtml` for booleans.
5. Pack controls on one row (or a short wrap). Switches stay beside labels.
6. Write a two-line blurb with an explicit `<br>`.
7. Hard-refresh Settings. Confirm:
   - head is one line
   - card is only as wide as its controls
   - no empty band on the right of the card
   - switches are not at the card’s trailing edge unless the label is immediately left of them
8. Screenshot under `mtapi-project/junk/playwright/`.

---

## 8. Anti-patterns (reject in review)

- Kicker on its own line, title below.
- Full-bleed cards (`width: 100%` in a wide panel).
- `justify-content: space-between` on a switch row inside a wide card.
- `flex: 1` on `.settings-switches` “to use the space.”
- Tick labels under knobs (`L M H`).
- Description above the controls.
- One card per toggle.
- Placeholder dashed cards (`.settings-card-placeholder`) for real prefs.
- Re-introducing global Video/Image/Run chrome on Settings.

---

## 9. Files

| File | Owns |
|------|------|
| `mtapi-project/app/static/js/tabs/settings.js` | Card HTML, knobs, `saveSettings` |
| `mtapi-project/app/static/css/settings.css` | Shell, widths, switch/knob packing |
| `mtapi-project/app/static/app.js` | `state.settings` + startup precedence |
| This spec | Layout law |

`performance-settings-spec.md` remains the **behavior** draft for thumb size / RAM cache. **Layout in that file is stale** — follow this spec instead.

---

## 10. Verification

Open Settings (`data-tab="settings"`):

1. Both shipped cards: kicker and title on one line.
2. Performance: knobs adjacent; RAM switches immediately after their labels.
3. Neural FX: three switches in one packed row; blurb breaks after “Default is off”.
4. Neither card spans the empty desk. Width ≈ content (~410–450px on a 1280 desktop).
5. Adding a fake third card with the §4 markup stays inside 520px without new CSS.

Agents do not claim a Settings UI change done without a screenshot of the card(s) under `junk/`.
