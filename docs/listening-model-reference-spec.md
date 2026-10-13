# Listening Models reference

> Status: Implemented. References → Listening Models (`refs-listening`).
> Related: [Audio Models](audio-model-reference-spec.md),
> [UI density](ui-density-standard.md), [check gate](fast-check-gate-spec.md).

## Catalog

The companion to Audio Models covers audio inputs: 47 models, model families,
toolkits, runtimes, hosted services and DSP tools across 20 task filters.
The 14-field supertable includes task, size, deployment, license/access, input,
timing, hardware/runtime, output, languages/domain, caveats, use case, primary
source URL and source-check date. Canonical JSON, CSV, Markdown and primary
source index live in `docs/reference/listening-models/`.

Primary project/model documentation was checked on 2026-10-10. This is reference
research; models have not been installed or benchmarked by this feature.
Hardware descriptions are deployment notes, not measured minimums. Toolkit and
runtime entries are labeled as such; cloud parameter counts are undisclosed;
code/weight/service license differences and legacy limitations are preserved.
No speed/quality ranking compares incompatible tasks. Checkpoint-specific
language coverage is distinguished from a project's broader research claims.

Tasks include wake words, VAD, ASR, translation, language identification,
diarization, speaker recognition, forced alignment, sound/music descriptions,
event labels, emotion labels, embeddings, audio-to-MIDI, pitch, MIR, stems,
speech enhancement, fingerprints and codecs. A collapsible glossary explains
the outputs, particularly anonymous speaker turns vs enrolled identity,
descriptions vs class scores, pitch contours vs note events, and stems vs
speaker time labels.

## UI and persistence

- Sidebar and References segment both open **Listening Models**.
- Overview: searchable complete supertable or compact cards, with multi-task
  filtering. The search, filter and view survive model navigation and reload.
- Clicking a model opens its detail subtab: purpose/deployment, input/coverage,
  runtime/outputs, license/limits, notes, file-tag editor and source/reference
  downloads. Each model has a clickable primary source and checked date.
- Cards use the existing content-height aligned horizontal grid. Text, card
  width, spacing and controls scale together at 70–160%; rows wrap naturally.
  Table horizontal scroll remains contained within the table.
- The supertable has no viewport-height cap; it grows with its content and the
  full workspace owns vertical scrolling, without a nested vertical scroll pane.
- [Shared table display](reference-table-display-spec.md): sticky horizontal
  scroll strip and optional repeat/numeric/state/warning cell shading.
- **All listening models** or re-clicking the active References segment returns
  to the overview. Global inputs, preview and Run/Queue are hidden.
- Per-model saved notes, local drafts, stale-write revision protection and
  explicit many-model file associations use the same behavior as Audio Models.
  Tagging or untagging a file changes only the association, not the file.
- The two libraries have independent browser preferences/drafts and databases.
  A file may be tagged in both; each library's tags and model IDs stay scoped.

## API / storage

The shared `create_reference_router` factory in `app/routes/audio_references.py`
registers both libraries, preserving the original `/api/audio-references` API.
The new `/api/listening-references` API has the same catalog, model note,
tag/untag and registered-file download endpoints. Four bundled source downloads
are allowlisted. Operational errors are HTTP 200 with `{ok:false,error}`.

Listening notes/tags use `mtapi-project/data/listening-references.sqlite3`,
gitignored; `MTAPI_LISTENING_REFERENCES_DB` overrides its absolute path.
Browser preferences use `mtapi.listeningReferences.v1`, with note drafts keyed
by `.draft.{model_id}`. The renderer factory gives each library its own async
state, catalog and drafts. Generic form replay excludes both reference tabs.
No media-pool/project writes, subprocesses or inference operations are added.

## Verification

Run `./check-gate.sh` before tests or Playwright. Focused API tests:
`tests/test_audio_references.py` and `tests/test_listening_references.py`.
They cover catalog/source consistency, task coverage, revision conflicts,
many-model associations, unchanged source files, scoped downloads, library
isolation and the HTTP 200 failure contract.

Real control-click proof: `junk/listening-references-prove.mjs`, with proof JSON
and screenshots under `mtapi-project/junk/`. Covers navigation, table/card views,
task/search filters, glossary, source links/downloads, note save/reload and
cross-library draft isolation, file tag/download/untag, proportional zoom and
responsive wrapping. Both generation and listening references are exercised.
