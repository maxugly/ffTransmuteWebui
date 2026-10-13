# Audio Models reference tab

> **Status:** Implemented; browser proof and API checks recorded in STATUS.
> **Scope:** References → Audio Models (`refs-audio`).
> **Related:** `ui-density-standard.md`, `settings-card-layout-spec.md`,
> `stateful-tabs-spec.md`, `fast-check-gate-spec.md`.

## Purpose and source

The user's merged audio research becomes a reference library: 52 models,
services and pipelines, with all 12 comparison fields preserved. A model name
opens its own detail subtab. The library contains supplied claims, including
conflicting figures, rather than presenting them as freshly verified research.

Canonical bundled data and source artifacts live in `docs/reference/audio-models/`:
`audio-supertable.json`, CSV, Markdown, standalone HTML, and `source.txt`.
The model identifier is the lower-case name with punctuation normalized to
hyphens. Treat these IDs as durable keys when revising the dataset.

## Navigation and layout

- Sidebar item and References segment: **Audio Models**.
- Overview supports the complete comparison table and compact model cards.
  Search examines every supplied field; table names and card headings open a model.
- The detail subtab includes Overview, Voice & controls, Performance & hardware,
  License & evidence, My notes, Tag a file, Source & files we made, plus tagged
  file cards. Missing supplied facts are omitted from detail cards.
- **All audio models** returns to the previous search/view. Re-clicking the
  top-level Audio Models segment returns to the overview too.
- Bare workspace: global input strip, Run/Queue and preview are hidden.
- Cards use an aligned CSS grid, content-height bodies and a 28em width capped
  at the available width. Rows wrap naturally; there is no masonry layout,
  stretched card body, fixed height or transform-based scaling.
- Zoom (70–160%, reset 100%) changes the workspace font size. Card widths,
  control sizes, gaps and padding use `em`, so geometry and text scale together.
  Native browser zoom also reflows available CSS width. Default body is 0.75rem.
- Horizontal scrolling is contained within the 12-column comparison table;
  the workspace and card views do not overflow horizontally.
- The table has natural content height with no viewport-height cap or inner
  vertical scrolling. The workspace owns vertical scrolling across the full
  available app frame.
- [Shared table display](reference-table-display-spec.md) provides an accessible
  sticky horizontal scroll strip and optional data-aware cell shading.
- The shared reference segment bar wraps between buttons. New controls use the
  bottom HelpStrip attributes, never native tooltips.

## Notes and file associations

- Notes are saved per model on the server. Explicit **Save notes** uses a
  revision check, so stale browser windows cannot silently overwrite newer notes.
- Unsaved drafts survive tab switches and reloads in browser storage, keyed by
  model ID. **Load saved** explicitly replaces a draft with the server version.
- File path, label and kind drafts are also per-model; the native app file
  browser can populate the path. Paths must be absolute, existing regular files.
- **Tag file** associates an output, reference, recipe or other file with the
  active model. Retagging the same path/model updates the label and kind without
  duplicating the association. A file can have multiple model tags; each is a
  clickable link to that model's subtab.
- **Untag** removes only the active model association; the original file and
  other tags remain. Missing files remain visible with a missing-on-disk label.
- Downloads only serve a bundled source artifact or a registered association
  belonging to the requested model. They use attachment disposition and nosniff.
- The five existing merged/source documents are bundled reference links on
  every model page. They are identified as research documents, not model outputs.
- Associations are explicit. There is no inference from filenames, automatic
  generator instrumentation, disk crawler, or modification of embedded media
  tags. Tagging here does not alter media catalog analysis or provenance.

## Storage and API

`mtapi-project/data/audio-references.sqlite3` (gitignored) contains independent
`notes` and `files` tables. `MTAPI_AUDIO_REFERENCES_DB` can override the absolute
database path for tests/deployments. Source files remain versioned separately.

`/api/audio-references`:

- `GET /`: catalog and source note (served at the prefix without trailing slash).
- `GET /source/{name}`: allowlisted source download.
- `GET /model/{id}`: note/revision and file associations with all model tags.
- `POST /model/{id}/note`: `{text, revision}`.
- `POST /model/{id}/file`: `{path, label?, kind?}`.
- `POST /model/{id}/file/{file_id}/untag`: remove association only.
- `GET /model/{id}/file/{file_id}`: registered-file download.

Operational failures return HTTP 200 with `{ok:false,error}`. Source facts are
read-only; note/file writes are transactional. Notes are limited to 200,000
characters and labels to 300. No subprocesses are involved.

Overview search/view, selection, zoom and file-entry drafts are browser preferences
under `mtapi.audioReferences.v1`. Note drafts use `.draft.{model_id}` keys.
General form capture/replay excludes `refs-audio`, preventing a single tab-level
snapshot from replaying one model's fields into another model. Named projects
and the two media pools are independent.

## Verification

- Run `./check-gate.sh` before pytest or Playwright.
- `tests/test_audio_references.py`: bundled data/downloads, unique IDs, persistent
  notes, stale-write rejection, empty-note save, independent model notes,
  idempotent/multiple tags, scoped download/untag, missing files and input failures.
- Real browser proof: `mtapi-project/junk/audio-references-prove.mjs`; notes,
  downloads, tag/untag, tab switching, reload, table/card search, proportional zoom,
  zero card overflow at 1920/1280/800/480px, zero page/console errors.
- Screenshots and proof JSON live only in `mtapi-project/junk/`.
