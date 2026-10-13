# External research in Media Catalog

Implemented: supplemental research storage and comparison. Existing scanning,
analysis, tag selection, and sidecars remain independent.

Open **Media Catalog → External research** to import an absolute JSON/CSV path,
search or browse evidence, and edit the original research fields. Click **Ref**
on an audio row to compare model detections and file duration with every
matching research opinion. Model values come from `tempo_detected` and
`key_detected`; effective catalog values and their selected sources are labeled
separately. Half/double model tempo is derived only when detection exists.

## Storage and identity

The existing SQLite database contains three additional tables:

- `research_reference`: one original JSON object per evidence record, its source
  catalog, content hash, and searchable artist/title/release identity.
- `research_link`: manual inclusion/exclusion per media ID and evidence ID.
- `research_revision`: previous JSON values before explicit research edits.

Imports are additive. Identical JSON objects are deduplicated by content hash.
Changed imported objects become additional evidence; imports never replace or
remove earlier opinions. Explicit **Save research only** updates the chosen
reference ID and retains its prior object in the revision log. No research
operation writes `media`, file tags, analysis sidecars, or local audio files.
All original fields, source values, notes, uncertainty, and producer asterisks
are retained; no mode is inferred from a bare key.

Automatic association requires artist, title, and release tags, with no competing
recording descriptions for that release. ICP and Insane Clown Posse are aliases;
matching otherwise normalizes Unicode, punctuation, case, and whitespace, and
keeps version/remix text. Associations are evaluated when comparison opens, so
future scans can use existing research without a new analysis pipeline.
Automatic association is labeled **recording unverified**, not ground truth.
Other releases/versions are labeled candidates. Missing tags are never guessed
from filenames. Search while comparing a file to locate additional candidates,
then confirm a link or exclude it. Explicit decisions survive subsequent scans.

## HTTP surface

All failures use HTTP 200 and `{"ok": false, "error": "…"}`.

- `GET /api/media-catalog/references?path=…&q=…`: model comparison and research
  candidates; without `path`, paginated research browsing (`offset`, 50/page).
- `POST /api/media-catalog/references/import`: `{"path": "/absolute/catalog.json"}`.
  JSON must be an array of objects; CSV uses its header names. Entries require
  `artist` and `track_title` (or `title`). Validation precedes database writes.
- `POST /api/media-catalog/references/update`: `{"id": 1, "metadata": {...}}`.
- `POST /api/media-catalog/references/link`:
  `{"id": 1, "path": "/absolute/song.flac", "included": true}`.

The supplied `junk/icp_psychopathic_full_chart.json` contains 148 records.
Initial import retained all 73 existing scanned rows unchanged, with a SQLite
backup at `mtapi-project/junk/catalog_before_icp_import.db`. Those scanned rows
had no ICP artist tags, so no automatic ICP associations were available at
import time. Browse research now; later scan tags or manual links supply identity.

## Validation

Run `./check-gate.sh` first. Tests use the project venv. Install test dependencies
with `uv pip install --python mtapi-project/.venv/bin/python -r
mtapi-project/requirements-test.txt` (Starlette now uses `httpx2`).

`tests/test_catalog_references.py` covers the entire supplied catalog, repeated
imports, conflicts, releases/recordings, uncertainty, CSV, invalid import
atomicity, HTTP errors, independent edits, revision preservation, and unchanged
scanned records. Browser proof lives in `mtapi-project/junk/prove_catalog_references.py`
and uses an isolated database with synthetic scanned values, clicking real
import, comparison, link/exclusion, editor, search, and pagination controls.

The usual WebUI at `http://localhost:24590/` was restarted after confirming no
active/queued jobs. Live Playwright browsing/search proof verified 148 records,
separate source links, zero page errors, and all 73 scanned rows still identical
to the backup. Live proof: `mtapi-project/junk/prove_live_research.py`.
