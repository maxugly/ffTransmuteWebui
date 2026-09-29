# Calendar Dart — Forgotten Global Events Finder — Spec

> Status: Proposed
> Kind: E (UI-only workspace)  stage: n/a
> Fits ffTransmute WebUI Brief v2026-08-03, Invariants #1-10

## Problem
The balanced-news research POC needs a way to pick a small, global, forgotten event without biasing toward big US headlines. Manually picking Beirut is too large and perfection-driven. Users need a "throw a dart at the calendar" mechanism that surfaces international, multilingual, short-lived events (trade pacts, border standoffs, tanker incidents) and helps them choose a completable first event.

## Goals / Non-goals

**Goals:**
- One-click random date 2015-2024 (range where multilingual digital coverage exists)
- Fetch events for that date from Wikipedia OnThisDay (client-side, no backend)
- Score each event for POC suitability: HIGH for small/international/multilingual/quickly-resolved, LOW for US domestic/big
- Show history of last 10 throws and two curated ideal examples (RCEP Nov 15 2020, Kosovo-Serbia license plate Sep 26 2021)
- Vanilla JS tab, zero npm, zero new backend deps, fits existing tab pattern
- Zero console errors, graceful failure on API hiccup

**Non-goals:**
- Full GDELT BigQuery URL dump (future op `/ops/gdelt_fetch`)
- Article downloading / trafilatura / claim clustering (future pipeline tab)
- Video/image library integration (does not need global Video or Frame range)
- Private video path field
- React/Vite/Tailwind

## User story
1. User opens ffTransmute WebUI, clicks new "Dart" tab in top bar
2. Sees big "🎯 Throw Dart" button and two curated good examples for calibration
3. Clicks Throw Dart -> date animates (e.g. Sep 26 2021), loading spinner
4. Tab fetches `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/MM/DD` client-side
5. Filters to events from thrown year if possible, sorts by POC score (high keywords: trade pact, license plate, border, gas, submarine, tanker, ASEAN, Kosovo, etc; low keywords: US election, Trump, Senate, NBA)
6. List shows: year, text, link to Wikipedia pages, score badge HIGH/MEDIUM/LOW and reasons
7. Clicking an event copies its query pack hint (e.g. "RCEP trade pact 2020-11-15") to clipboard for next step
8. History row at bottom shows last throws, click to re-load
9. User picks one event, defines params (blast week vs investigation year) and moves to next tool

## Classification
Kind E - UI-only workspace. No frame effect, no geometry, no bitstream glitch. No backend op required for v1. Future v2 could add thin op `dart_gdelt_ops.py` that returns GDELT URLs for chosen event, but v1 is frontend-only.

## Params (JSON)
v1 has no `/ops/<op_id>` call. If we add v2 backend:
```json
{
  "event_date": "2020-11-15",
  "event_query": "RCEP trade pact",
  "start_datetime": "20201115000000",
  "end_datetime": "20201122235959",
  "languages": ["en","zh","ja","vi"]
}
```
Validation: absolute paths not needed for v1; for v2 outputs use `pathutil.finalize_output_path` and absolute paths.

## Architecture (reuse bookends/filters?)
- Reuses: tab registration pattern in `index.html` + `app/static/js/tabs/<name>.js` ES module
- Reuses: shared CSS variables, global dark/light, no new framework
- Does NOT reuse video_pipeline, JobWorkspace, filters, convert_presets - it's UI-only
- Bookends intentionally NOT used - no dump/encode
- Future: could call `POST /ops/gdelt_fetch` to get URLs, but v1 avoids backend to prove value

## Files to touch
- backend: none for v1. Optional future: `mtapi-project/operations/dart_gdelt_ops.py` (thin HTTP -> GDELT BigQuery client, returns OperationResult with output_path to urls.jsonl)
- frontend:
  - `app/static/js/tabs/dart.js` — ES module, exports `initDartTab()` and `render()`, handles random date, fetch, scoring, history in localStorage
  - `app/static/css/tabs/dart.css` — minimal, reuses existing variables, no Tailwind
  - `index.html` — add `<button data-tab="dart">🎯 Dart</button>` and `<section id="tab-dart" class="tab-pane">` container
- docs: `docs/calendar-dart-spec.md` (this file)

## UI
- Tab placement: after "Notes" / before "Convert", label "🎯 Dart"
- Global bar needs: **none** - does NOT use global Video + Frame range (per Invariant #8, range tabs use global, this tab does NOT need clip)
- Empty state: shows curated examples + "Throw your first dart"
- Loading: button shows throwing animation, disables double-click
- Error: "Wikipedia API hiccup (CORS). Try again" with retry button, zero console errors
- Each event row: [HIGH/MEDIUM/LOW badge] year — text — [Wiki link] — small reasons
- History: horizontal scroll of past throws
- No private file picker

Sketch:
```
[ 🎯 Throw Dart ] [ Random date display: September 26, 2021 ]
History: [Sep 26 2021: German election...] [Feb 2 2021: Myanmar junta...]

Events (sorted HIGH first):
[HIGH] 2021 — Kosovo bans Serbian plates, Serbia retaliates... [reasons: +license plate +border]
...

Good POC examples (static cards):
- Nov 15 2020 RCEP — why small/global/forgotten
- Sep 26 2021 License Plate Crisis
```

## Edge cases
- Wikipedia API CORS fail / 429: show retry, backoff, try alternate endpoint `api.wikimedia.org/feed/v1/...`
- No events for date: show "No events returned" + suggest re-throw
- Date with only US domestic events: all scored LOW, still show, encourage re-throw
- Very large payload (e.g. 300 events on 9/11): truncate display to top 30 by score, show total count
- Offline: show cached history from localStorage
- Mixed video+image inputs: n/a - does not touch libraries, respects Invariant #7
- Cancel: n/a - fetch is <1s, abortable via AbortController

## Acceptance tests
- Backend: none for v1 (UI-only). If v2 GDELT op added, smoke with `/tmp/teste.jsonl` write and OperationResult ok:true
- WebUI:
  1. Tab "Dart" appears in tab bar, clicking shows pane
  2. Throw Dart button generates date between 2015-01-01 and 2024-12-31 inclusive, displays formatted long date
  3. Fetch completes <3s, renders >=1 event with badge and wiki link, zero JS console errors
  4. History persists after reload (localStorage) and clicking history re-loads that date
  5. Error path: block network (offline), shows friendly error, retry works after online, still zero console errors
  6. Curated examples visible on first load
  7. No private video path field added, no npm import, vanilla ES module only

## Out of scope / follow-ups
- GDELT BigQuery bulk fetch op (`dart_gdelt_ops.py`) — follow-up after POC proven
- Multilingual query pack generator
- Trafilatura download + claim extraction tab
- Project JSON persistence for dart history (only localStorage for now)
- Image Pool / Video Pool integration — explicitly out of scope per dual-library rule

## Risks / follow-ups
- Wikipedia OnThisDay API may change shape or CORS policy — mitigated by dual endpoints and abort handling
- Scoring heuristic is naive keyword based — acceptable for v1, will be replaced by LLM scoring later
- Users may confuse with video pipeline — mitigate by clear label "Research tool — no video needed" in tab header
- No backend means no progress/cancel framework needed — future GDELT op will need job_control mention
