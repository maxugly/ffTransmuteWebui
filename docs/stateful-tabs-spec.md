# Stateful Tabs Spec — tab switches never destroy DOM

> **Status:** Spec (docs-only, no app code).
> **Hat:** Spec writer.
> **Goal:** tab switches never destroy DOM. Each tab mounts once into a permanent
> child root of the form host, hidden/shown on switch. Scroll, inputs, selection,
> badges persist exactly. Reference behavior: desktop DAW/NLE.
> **Non-goals:** no backend change, no new dump/encode stack, no framework, no
> eviction policy, no redesign of the existing same-tab fast path.

## 0. Verified ground truth (re-checked against the tree — symbols, not line numbers)

All references below were re-verified by grep/read of the current tree. Line
numbers are deliberately omitted (prior drafts' line numbers drift); the
file + symbol is the contract. Anything not verified is marked
**NOT VERIFIED** — do not assert it.

- `app/static/app.js` — `switchTab(tab)`, `renderTabForm(tab)`,
  `_syncTabInputFromGlobal()`, `updateStatusIndicators()`,
  `refreshInputPreview` (imported from `js/ui/input-preview.js`),
  `setupEventListeners()` (delegated `input`/`change` on `elements.actionPanel`),
  `stopJobsPoll` (imported from `js/tabs/jobs.js`),
  `applyPendingToImg2Img` / `applyPendingToTxt2Img` (imported from `js/tabs/agent.js`),
  `window.__sfTeardown`, `state.watcher.pollTimer`, `tabUsesFrameRange` /
  `FRAME_RANGE_TABS`, `TAB_ACCEPTS`, `beforeunload` handler
  (`captureCurrentFormState()` + `buildPoolStatePayload()` + `sendBeacon`),
  `elements.actionPanel` = `#actionPanelForm` (fallback `#actionPanel`),
  `elements.actionPanelRoot` = `#actionPanel`.
- `app/static/index.html` — `#actionPanel > #actionPanelForm` (form host) +
  `#toolInputPreview[hidden]` (sibling, survives form renders) +
  `#mediaViewerStage > #mediaViewer` + `#mediaInfo` + `#giFramesRow`
  (`display:none` inline default) + `#tabTitle`.
- `app/static/js/pool/persistence.js` — `captureCurrentFormState()`,
  `applySavedFormState(tab)`, `_applyingFormState` / `isApplyingFormState()`,
  `FORM_STATE_SKIP`, `buildDeskSnapshot()` (`form_state: state.formState`),
  `applyDeskSnapshot()`, `buildPoolStatePayload()` (`desk: buildDeskSnapshot()`),
  `projectSave()` (calls `captureCurrentFormState()`), `savePoolStateNow()`
  (calls `captureCurrentFormState()`), `restorePoolState()`.
- `app/static/js/ui/tab-scroll.js` — `saveTabScroll(tab)`,
  `restoreTabScroll(tab)` (double-rAF + 200/600 ms retries, `pool.gridScrollTop`
  first-visit fallback), `initTabScroll(getActiveTab)` (capture-phase document
  `scroll` listener for `actionPanel|actionPanelForm|poolGridWrap|
  imgPoolGridWrap|poolSequenceBox`, `pagehide` + `visibilitychange` flush,
  400 ms persist throttle, `localStorage mtapi_tab_scroll`).
- `app/static/js/pool/grid.js` — `renderPoolForm()` same-tab fast path
  (`#poolGrid` contained + no `#poolCompose` → `applyPoolZoom()` +
  `renderPoolGrid()` + `updateSelectionHighlights()` + `updateCatalogStatus()` +
  return), `renderSequenceForm()` same-tab fast path (`#poolGrid` + `#poolCompose`
  contained → same refresh + return), `_bindPoolToolbar()`,
  `_bindSequencePanel()`, `_bindTileInfoMenu()`, `_bindGridKeyboard(wrap)`,
  `renderPoolGrid()`, `renderSequenceBox` (in `sequence-composer.js`).
- `app/static/js/pool/image-pool.js` — `renderImagePoolForm()` same-tab fast path
  (`#imgPoolGrid` contained → `renderImagePoolGrid()` + return).
- `app/static/js/tabs/jobs.js` — `renderJobsForm()` (writes
  `#jobsPanel` + `refreshJobsPanel()` + `setInterval(1200)` with a
  `document.getElementById('jobsPanel')` existence check inside the tick),
  `refreshJobsPanel()` (early-returns when `#jobsPanel` missing), `stopJobsPoll()`.
- `app/static/js/tabs/watcher.js` — `renderWatcherForm()` (writes panel HTML,
  `setupBinaryKnob` ×2, browse/change/field binds, `fetchWatcherStatus()` initial
  + `setInterval(2000)` stored on `state.watcher.pollTimer` with an
  `state.activeTab !== 'watcher'` return inside the tick),
  `updateWatcherLiveUI(st)` (early-returns when `state.activeTab !== 'watcher'`),
  `isApplyingFormState()` guards on all three control `change` handlers,
  `isConnected` stale-render guards on all control handlers, chained
  `watcherPostChain` POST serialization, `watcherPendingToggles` poll-immunity.
- `app/static/js/tabs/stablefluids.js` — `renderStableFluidsForm()`,
  `teardown()` (stops `stopNativeSim`, clears `canvasRef`, stops
  `mediaRecorder`), `window.__sfTeardown = teardown` installed once behind
  `teardownHookInstalled`, `renderStage(mode)`, `initWebGpuStage()`
  (`stageToken` epoch guard), `renderIframeStage()` (`#sfIframe src=/stablefluids/`),
  `checkStableFluidsBuild()`, `waitForCanvas()`. There is **no `__sfSetup`**
  today — the spec names it as new work (§2).
- `app/static/js/tabs/agent.js` — `applyPendingToImg2Img()` (applies + deletes
  `state.agent._pendingI2iPrompt/_pendingI2iImage`), `applyPendingToTxt2Img()`
  (applies + deletes `state.agent._pendingT2iPrompt`), both called from
  `renderTabForm` immediately after their renderer mounts.
- `app/static/js/pool/sequence-transport.js` — `seqPause()` (`video.pause()`),
  `seqStop()` (`_detachPlaybackVideo()` + index reset + UI sync),
  `_detachPlaybackVideo()` (`pause()` + nulls handlers), `seqLoadClip()` (rebuilds
  `#mediaViewer` + `clearPreviewAspect()`), `savePoolStateNow()` call on
  transport commit.
- `app/static/js/preview.js` / `js/job-control.js` / `sequence-transport.js` —
  `#mediaViewer.innerHTML = ''` rebuild sites (viewer is **outside** the tab roots;
  preview-stop on hide pauses media, it does not wipe the viewer).
- `app/static/js/tabs/scripts.js` — `renderScriptsForm()` rebuilds panel HTML;
  `_hookGlobalInputs()` is once-guarded (`_giHooked`) and binds `giVideo`/
  `giImage` `input` listeners on `document.getElementById` nodes (global-chrome
  nodes outside the panel — survives tab switches already).
- CSS verified by grep:
  - **No `#actionPanel` child `display:` rules exist today.** The only
    `#actionPanel`/`actionPanel`-matching selectors are layout/width rules
    (`.action-panel` flex column in `css/layout.css`; `.action-panel-form` flex
    column in `css/forms.css`; `.action-panel.pool-active`,
    `body.notes-tab-active/settings-tab-active/sf-sim-tab-active/
    references-tab-active .action-panel[.xxx-active]` workspace overrides).
    None sets `display` on a per-tab child root (no such roots exist yet).
  - `[hidden]` handling precedent: `css/zoompan.css` documents that author
    `display: block|flex` beats the UA `[hidden]` rule and forces
    `display:none !important` for hidden zoompan layers. `css/forms.css`,
    `css/pool.css`, `css/image-compare.css` also carry scoped `[hidden]` rules.
    No global `[hidden]{display:none!important}` reset was found
    (**NOT VERIFIED exhaustively** — audit was grep-scoped to
    `#actionPanel|actionPanelForm|\[hidden\]|action-panel-child|tab-root`;
    a full-stylesheet read was not done).

### Context rows that constrain this spec (STATUS top box)

- **8.066 (strip scroll):** `#poolSequenceBox` scrollTop is a fourth tracked pane
  (save on scroll, restore with retries). Stateful roots make this free (the strip
  node survives), but the spec keeps the tab-scroll store as the cold-reload path.
- **8.064 (7.5 s freeze → 0.27 s):** `applySavedFormState` replay dispatches
  `change` events; three handlers (Instant-toggle / RIFE-fps / Time-commit)
  lacked `isApplyingFormState()` guards and ran an armed scan + encode on every
  switch. Fix = guards + hoisted per-token `getComputedStyle`/mode-fps work.
  This spec deletes warm-switch replay (§4), which removes the whole hazard class
  on warm switches — but the guards stay (cold reload still replays).
- **8.063 + sequence spec §8 (Instant RIFE rules):** open performs no media reads
  (badges from persisted records only); queue/drain require explicit arming;
  missing media stays offline, never dropped; Run follows `GET /api/queue`.
  Stateful tabs must not reintroduce open-time reads: first-visit build renders
  from state/records exactly like today; `onShow` never hydrates, probes, or
  fetches (§2, §6).

---

## 1. Target architecture

### 1.1 Per-tab permanent roots

- `renderTabForm(tab)` stops writing `elements.actionPanel.innerHTML` directly.
  On first visit to a tab it creates exactly one permanent child root:
  `<div class="tab-root" data-tab="<id>" id="tabRoot-<id>">`, appends it to
  `elements.actionPanel` (`#actionPanelForm`), and runs that tab's existing
  renderer **with its output directed into the root** (renderers keep building
  the same HTML; only the mount point changes from panel to root).
- Every other root present in the panel gets the `hidden` attribute; the visited
  root has it removed. Switch = hide old + show visited. No node is ever removed
  (`innerHTML=''` destroy path is deleted for cached tabs — §3), so scroll
  positions, input values, checkbox/radio state, focus, selection highlights,
  variant/RIFE badges, knob positions, log lines, and canvas/iframe instances
  persist exactly as left.
- Tab id namespace = today's `switchTab` ids, including the four refs ids
  (`refs`, `refs-models`, `refs-images`, `refs-code`), `pool`, `sequence`,
  `images`. One root per id (refs sub-tabs keep one root each, as today they
  re-render per id).
- `hidden`-vs-display resolution (§6): add one global rule
  `.tab-root[hidden]{display:none!important}` (mirrors the verified zoompan
  precedent). Verified that no conflicting `#actionPanel` child `display:` rule
  exists today, so the `!important` is belt-and-braces against future author
  rules, not a fix for a live conflict.

### 1.2 First-visit build path

1. Create root, append to panel.
2. Run the tab's existing renderer into the root (same HTML, same bind calls).
3. Run the tab's `onShow` hook if it has one (§2) — e.g. jobs re-arms its poll,
   watcher (re)starts its poll, fluids runs the new `__sfSetup`.
4. Cold-reload visits additionally run `applySavedFormState(tab)` + scroll restore
   (§4); warm first-visits in a live session need neither (fresh DOM, no saved
   scroll) but must run the same renderer + binds so behavior is identical.

### 1.3 Warm-switch show path

1. `hidden` off on the visited root, `hidden` on for the previously visible root.
2. Run chrome updates that today live after `renderTabForm(tab)` in `switchTab`
   (titles, Run/Queue visibility, body classes, frames row, status indicators,
   input preview, `_syncTabInputFromGlobal`, scroll restore — full list §3).
3. Run the visited tab's `onShow` (poll re-arm, fluids setup, pending-prompt
   apply). Never re-render, never replay form state, never re-probe.
4. Reuse the existing same-tab fast-path pattern: `grid.js renderPoolForm /
   renderSequenceForm` and `image-pool.js renderImagePoolForm` already
   early-return when their grid node is contained in the panel. Under permanent
   roots that containment check means "already mounted" — keep the pattern and
   extend it: every cached tab's mount function starts with
   "if my root exists and is contained → show path, not build path". Do not
   redesign what exists; generalize the guard.

### 1.4 Hide path

1. Run the leaving tab's `onHide` (poll stop, fluids teardown, preview-stop).
2. Set `hidden` on the leaving root. Nothing else touches its DOM.
3. `saveTabScroll` behavior is unchanged in Phase 1 (harmless under persistent
   DOM — positions barely change); cold-reload restore stays as the reload path
   until scroll memory is proven redundant, then it may be demoted to a
   reload-only mechanism. Do not delete tab-scroll in this spec.

---

## 2. onShow/onHide lifecycle contract

Rule: a tab needs hooks iff it owns something that outlives a paint —
polls/intervals, sims (rAF/WebGPU), media playback/recording, measurements, or
deferred cross-tab applies. Static form tabs need none.

| Tab | onShow owns | onHide owns |
|-----|-------------|-------------|
| `jobs` | **Poll re-arm** (new `startJobsPoll()` companion to the verified `stopJobsPoll()`): `clearInterval` any stale `_poll`, immediate `refreshJobsPanel()`, then `setInterval(1200)` with the tick guarded by root-connected + active-tab (§7). | `stopJobsPoll()` (the existing `switchTab` leave-stop call stays; it now keys off the cached flag / active tab rather than DOM existence). |
| `watcher` | **Poll (re)start**: `clearInterval(state.watcher.pollTimer)`, `fetchWatcherStatus()` initial, `setInterval(2000)` tick that returns unless this tab is active and its root is connected. Re-sync knob visuals from server truth via the existing `updateWatcherLiveUI` (it already early-returns off-tab; extend the guard to hidden-root). | **Poll stop**: `clearInterval(state.watcher.pollTimer); state.watcher.pollTimer = null` (the existing `switchTab` leave-stop block stays verbatim, §3). In-flight POST chain and `watcherPendingToggles` are left alone — they resolve against state, and the `isConnected` guards already prevent ghost writes. |
| `stablefluids` | **New `window.__sfSetup`** (does not exist today — new work): re-run `renderStage(currentMode())` semantics against the *surviving* root — re-acquire `#sfStage`, re-init the WebGPU sim (or re-assert the iframe `src` only if the frame is gone; never detach a live iframe — §7), rebind the Record/mode/seed buttons if the renderer is not re-run. Companion to the verified `window.__sfTeardown`. | `window.__sfTeardown()` (existing `renderTabForm` unconditional call moves here: run **only** when leaving `stablefluids`, not on every switch — §3). GPU/rAF/Recorder must drop on hide. |
| `sequence` (and any tab that starts preview playback) | Nothing extra unless playing: if `state.pool.playback.playing`, `onHide` runs **preview-stop** (`seqPause()` semantics — `video.pause()`, never teardown the element). **Never auto-resume** on next show; the user presses play. If idle, no hook action. | `seqPause()` when playing. `seqStop()` (index reset) is NOT required on hide — pause only, position kept. |
| `img2img`, `txt2img` | Promote the verified `applyPendingToImg2Img()` / `applyPendingToTxt2Img()` calls from `renderTabForm` post-render positions to `onShow`: pending Agent prompts/images apply on every show (including warm shows where no render happens), still consume-once (delete after apply). | Nothing. |
| `pool`, `images` | Show path reuses the existing fast-path refresh (`renderPoolGrid()` / `renderImagePoolGrid()` + selection/catalog sync). No poll, no media hook. | Nothing (no teardown; wall node survives — that is the point). |
| All other op tabs (cut/convert/rife/speedchange/transmute/…) | No hooks in Phase 1 (static forms; delegated panel listeners + `isApplyingFormState` guards already cover them). Phase 2 may add `onShow` only for tabs proven to own timers/media/measurements. | Nothing. |

`onShow`/`onHide` run **after** the hide/show attribute flip and **before**
scroll restore, so any hook that writes layout sees a visible root and hidden
roots are never measured (§6).

---

## 3. switchTab surgery rule

Carve out **only** these two destroy statements; everything else stays exactly
where it is:

- **DELETE** `elements.actionPanel.innerHTML = ''` in `renderTabForm`
  (the panel wipe). Replaced by per-tab root hide/show (§1).
- **DELETE** the unconditional `window.__sfTeardown?.()` + null-out at the top
  of `renderTabForm`. Replaced by leave-`stablefluids` teardown in the hide path
  (§2). The `teardownHookInstalled` once-install inside
  `renderStableFluidsForm` stays.

**PRESERVED — every other line stays exactly where it is** (verified by
read; file + symbol):

1. `switchTab` same-tab fast path (`tab === state.activeTab` +
   `#poolGrid`/`#imgPoolGrid`/`#poolCompose` containment → nav-active sync +
   `renderPoolGrid()`/`renderImagePoolGrid()` + return).
2. `captureCurrentFormState()` leave-capture in `switchTab` — **but see §4**:
   deleted from the *switch path* and replaced by capture-all-mounted-roots;
   the call sites in `projectSave`, `savePoolStateNow`, `beforeunload` stay.
3. `saveTabScroll(state.activeTab)` leave-save + `restoreTabScroll(tab)`
   enter-restore in `switchTab`.
4. `state.activeTab = tab` assignment position (before chrome updates; polls and
   `_syncTabInputFromGlobal` read it).
5. Nav `.nav-item` active-class sync loop.
6. `ensureNavSectionForTab(tab)` expansion.
7. Full page-title chain (`mosh`…`stablefluids`, refs `''`, pool/sequence/images
   `''`) + `elements.tabTitle.textContent = title`.
8. `hideRun` computation + `elements.btnRun.style.display` + `#btnQueue`
   `style.display` toggles.
9. Watcher leave-stop (`tab !== 'watcher' && state.watcher.pollTimer →
   clearInterval + null`).
10. Jobs leave-stop (`tab !== 'jobs'` → `stopJobsPoll()`).
11. `.app-content.pool-workspace` toggle for pool/sequence/images.
12. `document.body` class toggles: `notes-tab-active`, `settings-tab-active`,
    `no-global-inputs`, `sf-sim-tab-active`, `references-tab-active`.
13. `renderTabForm(tab)` call position (now root show/build + `onShow`).
14. `updateStatusIndicators()` post-render call.
15. `#giFramesRow` show/hide via `tabUsesFrameRange(tab)` (both in `switchTab`
    and inside `_syncTabInputFromGlobal`).
16. `_syncTabInputFromGlobal()` re-sync call (probe + per-tab local-field sync).
17. `refreshInputPreview()` bottom-preview call at the end of `renderTabForm`.
18. Lazy-loader unobserve of `.pool-card, .img-pool-card` at the top of
    `renderTabForm` (keep — roots persist, cards still recycle).
19. `pool-active` / `notes-active` / `settings-active` class removal on the panel
    root (keep; per-tab renderers re-add their own, e.g. verified
    `renderPoolForm`/`renderSequenceForm`/`renderImagePoolForm`/
    `renderNotesForm` add-backs).
20. `applyPendingToImg2Img()` / `applyPendingToTxt2Img()` post-render calls —
    promoted to `onShow` (§2), not deleted.

---

## 4. Form-state rules

Problem (verified): `captureCurrentFormState()` reads **only**
`state.activeTab`'s controls from the live panel, and `applySavedFormState(tab)`
replays one tab's saved controls as `change` events. Under destroy-tabs this
was load-bearing. Under permanent roots the DOM *is* the state, and replaying
saved values over live inputs on every warm switch would clobber exactly what
persistence is meant to protect (cf. 8.064: replay dispatched armed scans).

- **DELETE** `applySavedFormState` replay for warm switches. Warm show touches
  no input values, dispatches no events. The `_applyingFormState` guards and
  all `isApplyingFormState()` handler checks stay (cold reload still replays).
- **DELETE** `captureCurrentFormState` from the switch path (the leave-capture
  in `switchTab`, §3 item 2). Capturing only the leaving tab while background
  roots hold newer user edits is both useless (their DOM already holds values)
  and harmful (it stamps `state.formState` with a partial snapshot that later
  saves treat as truth).
- **ADD** capture-all-mounted-roots on explicit save and `beforeunload`. Today
  capture is active-tab-only — without this change, saves persist stale values
  for background tabs (their roots hold edits the saver never reads). New
  helper (name TBD by builder, e.g. `captureAllMountedFormState()`) iterates
  every mounted `.tab-root` (including hidden ones — reads, never measurements)
  with the same `input[id], select[id], textarea[id]` + `FORM_STATE_SKIP` +
  button/submit filter as today, and writes `state.formState[tabId]` per root.
  Call it from `projectSave()`, `savePoolStateNow()`, and the `beforeunload`
  handler (replacing their single-tab captures). `buildDeskSnapshot()` and the
  payload shape are unchanged (`form_state` keyed by tab id).
- **Cold reload keeps capture + replay + scroll restore.** `restorePoolState` →
  `applyDeskSnapshot` (restores `state.formState`) → first-visit builds →
  `applySavedFormState(tab)` per tab as its root mounts → `restoreTabScroll`.
  The 8.064 `isApplyingFormState()` guards must remain on every replay-driven
  handler (Instant-toggle / RIFE-fps / Time-commit verified; watcher handlers
  verified; all other handlers **NOT VERIFIED** — builder re-checks each
  `change` handler that can queue work or POST before closing).

---

## 5. Binding rules

Constraint: no blanket "no double-bind" claims. Every per-render binder needs a
disposition. Verified dispositions:

- **Once-safe today (keep as-is, do not touch):**
  - `setupEventListeners()` delegated `input`/`change` on `elements.actionPanel`
    (the panel node itself persists — delegation survives roots; comment already
    says "mount/unmount during navigation" — still true for first-visit mounts).
  - `initTabScroll` capture-phase document `scroll` listener + `pagehide` /
    `visibilitychange` flush (survives everything by design).
  - `scripts.js _hookGlobalInputs()` (`_giHooked` once-guard; binds global-chrome
    nodes outside the panel).
  - `lazy-loader.js` img `load`/`error` with `{ once: true }`.
  - `references.js` table `mouseover`/`mouseout`/`click` **delegated** binds
    (repaint-safe by construction).
  - Watcher `isConnected` stale-render guards + `isApplyingFormState` guards
    (verified on all control handlers) — under permanent roots these become
    no-ops rather than live guards; keep both.
- **Per-render binds that MUST become mounted-guarded** (they run inside
  renderers that will now run once, but any future re-render or Phase-2 port
  must not double-bind): every `document.getElementById(...)?.
  addEventListener(...)` inside a tab renderer. Verified instances in this
  class: watcher (browse/knob/checkbox/field binds), jobs
  (`.jobs-rm`/`.jobs-stop`/`#btnJobsClear` per refresh — note: these re-bind on
  every `refreshJobsPanel()`, which is *correct* today because `innerHTML` is
  rebuilt each refresh; under cached roots the refresh rebuilds only `#jobsPanel`
  inner content, so the per-refresh bind-after-render pattern stays correct and
  needs no guard — but the *poll* needs lifecycle keying, §7), stablefluids
  (mode radios, seed browse/change/input, record, iframe-fallback switch),
  scripts (`#scriptSelect`, `#btnScriptRun`, preset/extra binds), agent (all
  `#ag*`/`#btnAg*` binds), convert/rife/browse buttons, datamosh knob/pad drag
  binds **including `window mousemove/mouseup` pairs added per drag session**,
  cut `document mtapi:frame-range/mtapi:video-probed` listeners + `giVideo`
  input/change hooks, rife `document mtapi:video-probed/frame-range` listeners,
  deepdream `#dream*` binds + `giVideo` hook, references per-`th`/`cb` binds
  inside table painters, stablefluids-webgpu canvas pointer binds.
- **Audit requirement:** all ~30 renderers (every `render*Form` in `js/tabs/`
  plus `grid.js`/`image-pool.js` binders `_bindPoolToolbar`,
  `_bindSequencePanel`, `_bindTileInfoMenu`, `_bindGridKeyboard`,
  `zoomBindings`, `installPoolScrollPaint`, `setupSequenceDropZone`,
  `setupPoolLayoutChrome`, sequence-rife `_bindInstantRifeStopHook`, chrome
  `setupTileInfoMenu`, wall `wall-thumbs _bindTenantEvents`) each get one
  disposition row in the builder's PR: `once` (module once-guard) /
  `delegated` (binds an ancestor that persists) / `per-render-safe` (binds nodes
  freshly created by that render and never re-bound without re-creation) /
  `needs-guard` (binds a surviving node — must add `dataset.bound` /
  `__bound` / `isConnected` / clone-replace before this spec closes).
  Per-renderer dispositions beyond the verified instances above are
  **NOT VERIFIED** in this spec — the table the builder fills in is the proof.
- **Single-fire acceptance** (§8) covers rebound buttons: click a bound button
  twice across a hide/show cycle, assert exactly one handler execution per click
  (no stacked binds).

---

## 6. Hidden-DOM rules

- **Background renders may write but never measure hidden roots.** Any code that
  reads layout (`offsetParent`, `offsetWidth/Height`, `getBoundingClientRect`,
  `scrollHeight/clientHeight`, `getComputedStyle`) must early-return when its
  root is hidden, and set a `dataset.dirty` (or equivalent) flag consumed on
  next `onShow`/show path (re-measure + re-layout then). Verified write-safe
  today: jobs `innerHTML` refresh, watcher `updateWatcherLiveUI` text writes
  (already off-tab-guarded — extend to hidden-root), sequence badge/token
  writes. Measurement sites are **NOT VERIFIED** exhaustively — builder greps
  `offsetParent|getBoundingClientRect|scrollHeight|getComputedStyle|
  offsetWidth|clientHeight` across `js/` and guards each.
- **`[hidden]` vs author `display:` resolution: add the `!important` hide rule.**
  Verified: no `#actionPanel` child `display:` rule exists today, so plain
  `hidden` would work now — but the zoompan file proves author `display`
  beats UA `[hidden]` elsewhere in this codebase, and per-tab CSS
  (pool/refs/notes/settings/forms/layout) already sets `display` on
  descendants. One global rule removes the whole class:
  `.tab-root[hidden]{display:none!important}`. State this choice explicitly so
  no future `.tab-root{display:flex}` reintroduces the zoompan bug.
- **Scroll memory stays** through Phase 1 (§1.4). Persistent DOM makes
  save/restore near-no-ops; `tab-scroll.js` remains the cold-reload mechanism
  (localStorage `mtapi_tab_scroll`, `pool.gridScrollTop` fallback).
- **Lazy thumbs / virtual grid:** `__mtapiLazyLoader.unobserve` keep (§3 item
  18); add hidden-root guard to any paint-on-scroll callback so background tabs
  never force image loads while hidden (writes allowed, network + measure
  deferred to show). Exact callback set **NOT VERIFIED** — builder lists it.

---

## 7. Poll / media / iframe rules

- **Lifecycle-keyed polls.** Polls run only while their tab is the active tab
  AND its root is connected/visible; every tick re-checks both; every
  (re)start clears the previous interval first.
  - Jobs fix (verified gap): today's tick checks
    `document.getElementById('jobsPanel')` existence — under permanent roots the
    node always exists, so a stale interval would fetch `/api/queue` + per-run
    `/api/job/<id>` forever on background tabs. New `startJobsPoll()` +
    existing `stopJobsPoll()` keyed to show/hide; tick additionally requires
    `state.activeTab === 'jobs'`. Hidden jobs tab performs **zero** refreshes.
  - Watcher keeps its `state.activeTab !== 'watcher'` tick guard and
    `updateWatcherLiveUI` off-tab return; extend both to hidden-root; leave-stop
    (`clearInterval` + null) unchanged (§3 item 9).
- **Preview-stop on hide, never auto-resume.** If sequence (or any) playback is
  active when its tab hides, `onHide` pauses (`seqPause()` semantics). Next show
  does not resume; position is kept. Media elements are never destroyed by tab
  logic; `#mediaViewer` (outside the tab roots, §0) is untouched by show/hide.
- **Roots never detached.** No `removeChild`, no `innerHTML=''` on a mounted
  root, no `img.src` clearing on shell reuse (wall invariant holds). Iframe
  state (stablefluids WebGL build) is therefore preserved across switches;
  `__sfSetup` re-inits only the native WebGPU sim (GPU context may be lost on
  hide — teardown drops it per §2) and must not reload a live iframe.
- **Instant RIFE (§8 of the sequence spec) unchanged:** armed-gesture gating,
  no open-time reads, offline-missing kept, Run follows server queue. `onShow`
  for sequence performs no hydrate/scan/fetch — the armed scan stays the single
  place that may touch the registry.

---

## 8. Phasing

- **Phase 1:** `pool`, `sequence`, `images` (the wall + strip + composer — the
  tabs whose destroy cost the 8.064/8.066 pain). Both paths coexist via a
  per-tab cached flag (e.g. `CACHED_TABS = new Set(['pool','sequence','images'])`
  — name TBD by builder): cached tabs take root hide/show; **uncached tabs keep
  the destroy path** (`innerHTML=''` + `applySavedFormState` replay + full
  `renderTabForm` dispatch) unchanged during Phase 1.
- **Phase 2:** remaining op tabs, one tab or tab-family per PR, each with its
  binder-disposition row (§5) and its `onShow`/`onHide` row (§2, `none` is a
  valid row). Refs sub-tabs ride together (shared renderer).
- **No eviction policy.** Roots are small DOM (media lives outside them);
  fluids GPU state is dropped by teardown while its DOM persists. If memory
  pressure ever forces eviction, that is a separate spec — not this one.

---

## 9. Acceptance (all must pass; frontend-only; full pytest green)

1. **Strip-at-token-200 + half-typed-Time round-trip:** on `sequence` with a
   large project, scroll `#poolSequenceBox` to token 200, half-type a Time value
   (no commit), switch pool → sequence → jobs → sequence. Assert: strip scroll
   exact, Time box content exact, **zero** dispatched-`change` side effects
   (no armed scan, no `/ops/rife`, variant, recover, or signature requests —
   the 8.064 proof, re-run).
2. **Preview stops on hide / never resumes:** playing sequence clip → switch to
   jobs → assert paused + position kept; switch back → assert still paused.
3. **Hidden jobs tab performs zero refreshes** (network-count `/api/queue` and
   `/api/job/*` while on another tab) **and resumes within one poll interval**
   (first refresh ≤ ~1.2 s after show).
4. **Fluids GPU drops on hide and resumes without DOM rebuild:** leave
   `stablefluids` → assert rAF/WebGPU stopped + Recorder stopped; return →
   assert sim running again with the same root node (`#sfStage` identity kept
   or explicitly re-created by `__sfSetup` — spec the builder's choice in the
   PR; no silent third behavior).
5. **Single-fire check on rebound buttons:** double-click a per-render-bound
   button across a hide/show cycle → exactly one action per click.
6. **Cold-reload proofs keep passing:** capture/restore round-trip
   (form values + active tab + desk snapshot) and scroll restore
   (outer/form/grid/strip, incl. reload) — the 8.063/8.066 Playwright proofs,
   re-run unmodified.
7. **Full pytest green** (backend untouched — guards against accidental
   backend edits; spec is frontend-only).
8. **Playwright, real clicks** for 1–6 (per AGENTS.md WebUI proof: curl is not
   UI proof). Zero new console errors (pre-existing thumb 404s excluded, as in
   8.063/8.064 proofs).
9. **VERSION + STATUS per AGENTS.md:** bump root `VERSION` (far-right DD) and
   the STATUS top box (what shipped / next); diary to
   `docs/archive/changelog.md`. No app code in the spec PR.

---

## 10. What this spec deliberately does not decide (builder's call, recorded in PR)

- Exact root id/class names and the `CACHED_TABS` flag name/location.
- Whether `__sfSetup` reuses `renderStage` verbatim or gains a
  reconnect-if-live fast path (either is conformant if §9.4 passes).
- Whether tab-scroll save/restore is demoted to reload-only after Phase 1
  proves DOM persistence (keep it fully live until then).
- `captureAllMountedFormState()` helper name (contract: iterate all mounted
  roots incl. hidden, same filters as today, called from `projectSave`,
  `savePoolStateNow`, `beforeunload`).

## 11. Points not verified (do not treat as fact)

- Exhaustive per-renderer binder dispositions beyond §5's verified instances.
- Exhaustive measurement-site list beyond the §6 grep pattern.
- Exhaustive `[hidden]`-conflict audit beyond the scoped CSS grep (§0).
- Exact count of renderers ("~30" in the goal is taken as given, not verified).
- `updateSeqTransportUI` / `fitPreviewViewer` behavior under hidden roots
  (covered by the §6 dirty-flag rule, not individually verified).
