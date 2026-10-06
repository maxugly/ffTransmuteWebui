# Media Catalog (unified media database) — Spec

> **Status:** Proposed
> **Date:** 2026-10-05
> **Audience:** Builder agents (spec-writer output per `AGENTS.md` mission & roles; no app code here)
> **Classification:** Kind E (Catalog UI) + A (scan op `POST /ops/media_catalog_scan`)
> **Supersedes:** `audio-quarry-spec.md` · `audio-analysis-spec.md` · `backlog/analyzetag-spec.md`
> **Rev 2:** 2026-10-05 — provenance is two orthogonal bits (`made_by_me`, `ai_involved`) under the master `is_mine` flag (§6.5 resolved)
> **Rev 3:** 2026-10-05 — safeguard for provenance writes: confirm gates + append-only `provenance_log` with batch undo (§6.6)
> **Related (referenced, not re-specced):** `ytdlp-tab-spec.md` (§5–6 provenance/filtering) · `video-image-pools-spec.md` (dual-pool invariant) · `media-persistence-spec.md` · `music-tab-spec.md` (generator outputs) · `sequence-audio-engines-spec.md`

---

## 1. Problem & Context

The user's library now spans four provenances that the app cannot tell apart, let alone filter jointly:

1. **Old owned music** — decades of bounces, stems, loops on disk. No key/tempo metadata anywhere. ("All 4-bar loops at 90–95 BPM in A minor" is unanswerable today.)
2. **AI-generated + homemade clips** — what this UI started for (Music tab ACE-Step outputs, DeepDream/still outputs, Stems outputs).
3. **YouTube / web imports** — the yt-dlp tab (shipped `8.106`–`8.113`) already retains `source_meta` (`is_youtube`, site, author, tags) on Video Pool items, with pool sort/search over site/author.
4. **Manually imported images, videos, music** — file-picker pool imports with no origin recorded at all.

The ask: **one database, filterable on all of it** — "youtube, or audio, or audio I specifically made, or audio in C major." There must also be a first-class **`mine` flag across all media types** (video, image, audio), assignable three ways: owned-directory rules, manual per-item toggle, auto-derive from anything this app generates. Under `mine` sit two orthogonal craft facts preserved independently: **made-by-me** (I drew/recorded/composed it) and **AI-involved** (AI generated/animated/processed any part of it) — a piece can be either, both (drew it, then AI-animated it), or neither (a YouTube rip, a third-party file).

History the builder must know (do not rebuild, do not duplicate):

- `audio-quarry-spec.md` (Proposed, never registered in `spec_registry.json`) defined the audio-only SQLite catalog, sidecar, and 3-phase design. This spec absorbs its Phase 1 (scan + DB + query UI) and defers its Phase 2/3 (Demucs worker, auto-slicer — stems already ship as the Stems tab, `8.079`).
- `audio-analysis-spec.md` (Proposed) defined the engine stack — Basic Pitch (MIDI), Aubio (onsets), Essentia (BPM/key), Madmom (beats) — as `POST /ops/audio-analyze`. This spec absorbs the stack into the scan op. That op id is **retired**; the scan op id below replaces it.
- `backlog/analyzetag-spec.md` (DRAFT) defined key/BPM over files-or-directory with a live table and CSV/JSON report. This spec absorbs the directory-scan + per-file key/BPM behavior; the downloadable report becomes the `.json` sidecar (§8), not a separate artifact.
- Dead scaffold exists and is the starting point, not the design: `mtapi-project/app/database/audio_db.py` (real `tracks`/`stems`/`slices` schema, never initialized by any shipped code path) and `mtapi-project/app/audio_pipeline/scanner.py` (`AudioScanner` skeleton — directory walk, 1MB-hash dedup, sidecar/DB writes all present, but `_extract_features` returns dummy data and `_write_midi_sidecar` is a `pass` stub; nothing imports it). The builder **rewrites these two files**, not parallel new ones.
- Name-collision warning: `mtapi-project/app/media/catalog.py` (`CatalogIndex`, covered by `tests/test_catalog.py`) is the server-resident thumb/phash catalog — unrelated. Every new file in this spec uses the `media_catalog` / `mediacatalog` prefix (§12), never bare `catalog`.

---

## 2. Goals & Non-Goals

### Goals

- One SQLite catalog indexing **audio, video, and images** with provenance (`mine`, `origin`, web source fields) and audio analysis (tempo, key, beats, MIDI) queryable from one UI.
- A `mine` flag on **all media types**, set by directory rules, manual toggle, or generator auto-derive — visible as pool badges and filterable as `is:mine`.
- Directory scan with **per-run optional analysis** (key, tempo, beats/onsets, MIDI toggles) writing non-destructive `.json` + `.mid` sidecars.
- Auto-indexing on all four entry paths (§5) so the DB stays current without manual rescans.
- Filtering in two surfaces: the new **Media Catalog** tab (faceted, all media types) and the existing pools (search tokens + badges).

### Non-goals

- Stem separation inside the catalog (Stems tab ships; catalog rows may *reference* stem files later — parked).
- Auto-slicer / one-shot extraction (quarry Phase 3 — parked as follow-up).
- Rewriting ID3/tags in original files (sidecars only, per quarry).
- DAW integration, real-time analysis (offline indexer, per quarry).
- Restructuring the Video/Image pools (`video-image-pools-spec.md` stands; pools stay JSON-state working libraries, DB is the query index).
- Re-speccing shipped systems: yt-dlp ingest, op contract/registry, settings plumbing, auto-add/auto-firstlast hook shapes — all referenced by file:line, extended only where named.

---

## 3. Locked Decisions

| Decision | Selection | Notes |
|---|---|---|
| **Scope** | Unified media catalog (audio + video + image) | User decision 2026-10-05. One DB answers youtube/audio/mine/C-major jointly. |
| **`mine` assignment** | All three: directory rules + manual toggle + generator auto-derive | User decision. Precedence §6.4. |
| **Craft facts** | Two orthogonal bits — `made_by_me` + `ai_involved` — under master `is_mine` | User decision (Rev 2). "AI-involved", not "AI-made": AI may have touched only part. Neither bit set is valid. §6.5. |
| **Provenance safeguard** | Confirm gates on clears + append-only `provenance_log` with per-row and batch undo (A+B) | User decision (Rev 3). No whole-DB backups, no soft-delete states. §6.6. |
| **Spec shape** | This one master spec; the three predecessors marked Superseded in `spec_registry.json` | User decision. Appendix A maps absorption. |
| **Auto-index scope** | Everything that enters the app: scans + yt-dlp + generator outputs + file-picker pool imports | User decision. §5. |
| **Tab/spec name** | Media Catalog — `data-tab="mediacatalog"`, `docs/media-catalog-spec.md` | User decision; avoids `catalog.py` collision. |
| **Analysis deps** | Main venv: `essentia`, `madmom`, `aubio`, `basic-pitch`, `mido` (or `pretty_midi`) added to `requirements.txt` | User decision. Baseline already heavy: `tensorflow>=2.15` (styletransfer), torch via `demucs>=4.1`, `soundfile` all present. Basic Pitch rides the existing TF install. Lazy-import engines so server boot never pays load cost. |
| **Engine roles** | **Revised after measurement (Slice 4):** Essentia = key + BPM + beats + onsets · mido = tempo-map MIDI. madmom/aubio/basic-pick dropped with reasons (§7). | The original madmom/aubio/Basic Pitch assignment was measured against this box and changed where it would have broken it — not re-researched for its own sake. |
| **Failure contract** | HTTP 200 + `{"ok": false}` | Invariant 10. |
| **Transport** | `shell.run_command` argv lists; no `shell=True`; nothing new in `main.py` except route `register()` | Invariants 2, 11. Scan/analysis run in-process (CPU libs); no subprocess bookkeeping beyond existing job machinery. |
| **Progress** | `report_progress()` per item | Invariant 9. |
| **Help law** | Every new control carries `data-help-title` / `data-help-text` | Per `8.096`. |

---

## 4. Schema

Evolve `app/database/audio_db.py` in place (rewrite, not a second DB module). New database file `~/.ffTransmute/media_catalog.db` beside the old path — the old `audio_catalog.db` was never initialized by any shipped code path, so **no migration**.

```sql
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,          -- absolute path to the file
    file_hash TEXT,                     -- fast content hash (first 1MB; skeleton uses md5 — keep unless measured slow)
    type TEXT NOT NULL,                 -- 'audio' | 'video' | 'image'
    status TEXT DEFAULT 'pending',      -- 'pending' | 'scanned' | 'analyzed' | 'error' | 'missing'

    -- Provenance (§6): is_mine is the master filter flag; the two craft bits are independent claims about MY workflow
    is_mine INTEGER DEFAULT 0,          -- 0/1: mine (set when any mechanism below fires)
    made_by_me INTEGER DEFAULT 0,       -- 0/1: I drew/recorded/composed/filmed it (human authorship)
    ai_involved INTEGER DEFAULT 0,      -- 0/1: AI I ran generated/animated/processed any part of it (NOT "AI somewhere upstream" — a downloaded AI-slop rip is 0/0)
    mine_source TEXT,                   -- 'dir_rule' | 'manual' | 'generated' | NULL (strongest mechanism that set is_mine; manual always wins, §6.4)
    origin TEXT,                        -- 'generated' | 'web' | 'import' | NULL (how it ENTERED the app — orthogonal to who made it)
    site TEXT,                          -- e.g. 'youtube' (mirrors source_meta)
    is_youtube INTEGER,                 -- 0/1, NULL when unknown
    author TEXT,
    source_url TEXT,
    video_id TEXT,
    publish_date TEXT,                  -- YYYY-MM-DD or NULL

    -- Audio analysis, NULL unless type is audio or has_audio video AND analysis ran (§7)
    tempo REAL,                         -- BPM, e.g. 128.32
    tempo_conf REAL,
    key_name TEXT,                      -- canonical '<Tonic> <major|minor>', e.g. 'C major'
    key_strength REAL,
    duration REAL,                      -- seconds (probe for video, audio header for audio)
    midi_path TEXT,                     -- sibling .mid sidecar or NULL
    sidecar_json_path TEXT,             -- sibling .json sidecar or NULL

    raw_metadata JSON,                  -- full dump: beats/downbeats/onsets arrays, engine versions, source_meta passthrough
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_media_type   ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_mine   ON media(is_mine);
CREATE INDEX IF NOT EXISTS idx_media_hand   ON media(made_by_me);
CREATE INDEX IF NOT EXISTS idx_media_ai     ON media(ai_involved);
CREATE INDEX IF NOT EXISTS idx_media_origin ON media(origin);
CREATE INDEX IF NOT EXISTS idx_media_site   ON media(site);
CREATE INDEX IF NOT EXISTS idx_media_tempo  ON media(tempo);
CREATE INDEX IF NOT EXISTS idx_media_key    ON media(key_name);
CREATE INDEX IF NOT EXISTS idx_media_hash   ON media(file_hash);

-- Rev 3 safeguard: append-only audit of every provenance-triple write (§6.6)
CREATE TABLE IF NOT EXISTS provenance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,             -- shared per bulk op; single marks get their own uuid
    path TEXT NOT NULL,
    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    mechanism TEXT,                     -- 'manual' | 'generated' | 'dir_rule' | 'undo'
    old_is_mine INTEGER, old_made_by_me INTEGER, old_ai_involved INTEGER, old_mine_source TEXT,
    new_is_mine INTEGER, new_made_by_me INTEGER, new_ai_involved INTEGER, new_mine_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_provlog_path  ON provenance_log(path);
CREATE INDEX IF NOT EXISTS idx_provlog_batch ON provenance_log(batch_id);
```

Keep the skeleton's `stems`/`slices` tables untouched (parked). Canonical key form is `<Tonic> <major|minor>` (`'C major'`, `'A minor'`); the query layer (§9) and pool token (§11) accept `Cmaj`/`C major`/`C` case-insensitively and normalize to canonical before comparing. The `provenance_log` is append-only in normal operation; retention (default: keep everything, prune older than 12 months only on explicit user action) is a builder-set policy documented in the module.

---

## 5. Ingest Paths (all auto-index)

One shared server helper (name at builder discretion, e.g. `catalog_upsert`) performs path→hash→row upsert with provenance resolution (§6). Four call sites:

1. **Directory scan op** — `POST /ops/media_catalog_scan` (§7 params). Walks `target_directory` (recursive flag), classifies by extension (audio: `.wav .mp3 .aif .aiff .flac .m4a .ogg .opus`; video/image reuse the existing `is_video_fn`/`is_image_fn` predicates — do not redefine extensions), upserts every media file as `origin='import'` (unless a rule/generator already set it), then runs selected analyses.
2. **yt-dlp harvest hook** — in `ytdlp_ops.py` after `_construct_source_meta()` returns (`ytdlp_ops.py:565`), upsert the downloaded media path with `origin='web'` + the full web fields (site, is_youtube, author, source_url, video_id, publish_date). `is_mine` stays 0 unless an owned-dir rule matches the output dir (rules can cover a downloads folder — user's choice).
3. **Generator hook** — any op this app runs that writes a media file (Music `music_generate`, DeepDream/still outputs, etc.) upserts with `origin='generated'`, `is_mine=1`, `mine_source='generated'`. Hook point is the existing auto-add path — `js/pool/auto-add-outputs.js:maybeAutoAddOpOutput` (wired into `displayOpResult`, fire-and-forget, gated by `autoAddOpOutputs`/`autoAddOpImageOutputs`) — plus the server op success path, so rows exist even when auto-add is off. Keep the RIFE-variant guard (`opId === 'rife' && meta.variant_hash` skips) exactly as is.
4. **Pool import hook** — new `js/pool/auto-catalog.js` mirroring `js/pool/auto-firstlast.js` module shape (session `_done` set, delta-only event hook, fire-and-forget `try/catch`, must-not-break-import), called from `items.js:addPathsToPool` (`items.js:185`, beside the existing `normalizeImportsForPool` await at `:189` and `maybeAutoFLForImport` at `:233`) and from `image-pool.js:addPathsToImagePool` (`image-pool.js:248` area). POSTs new paths to a lightweight upsert endpoint (§9); server resolves rules. Never scans, never blocks.

---

## 6. The `mine` Flag

### 6.1 Owned-directory rules

New Settings card (**Media Catalog**, first card or beside Import — builder follows `settings-media-import-spec.md` card pattern). One control: owned-directories list (add via in-app folder picker like `btnQuickI`, remove per row). Plumbing follows the existing three-layer pattern exactly:

| Frontend (`state.settings`) | Server (`settings.json`) | Default | Normalize |
|---|---|---|---|
| `ownedDirs` (string[]) | `owned_dirs` | `[]` | array of absolute dir strings, deduped; relative entries resolved against home then dropped if unresolvable |

Layers: `app.js` `SETTINGS_DEFAULTS` (`app.js:306`) + server mapping (`app.js:342` area) → `settings.js` `settingsSnapshot()` (`settings.js:60`) / `saveSettings()` (`settings.js:83`) → `media/performance.py` `DEFAULT_SETTINGS` (`performance.py:13`) + `_normalize_settings()` (`performance.py:36`). Any path under an owned dir ingests with `is_mine=1, mine_source='dir_rule'`. Rules assert ownership only — they do not set the craft bits (§6.5); a folder of the user's own recordings earns HAND via the manual toggle or a bulk-mark in the Catalog tab.

### 6.2 Manual toggle

Per-item provenance editor in the Video Pool card context menu (`pool/chrome.js` menu area), the Image Pool card menu, and per-row in the Catalog tab table. Three independent controls: **Mine** (master flag), **Made by me** (craft bit), **AI involved** (craft bit). Writes through `POST /api/media-catalog/mark {path, is_mine, made_by_me, ai_involved}` → sets `mine_source='manual'`; the same call updates the pool item's `source_meta` (`is_mine`, `made_by_me`, `ai_involved`) so badges/tokens follow immediately (§11). **Unmark as mine** zeroes all three bits (`mine_source` stays `'manual'` as the record of explicit disclaimer). A rescan never touches provenance bits on a `manual` row — analysis columns still fill, but even an owned-dir rule does not re-assert `is_mine` there. The user re-marks by hand.

### 6.3 Generator auto-derive

§5 path 3. Any media file this app's ops write is the user's output: `is_mine=1, ai_involved=1, mine_source='generated'`, `origin='generated'`, with the producing op recorded in `raw_metadata` (e.g. `{"generated_by": "music_generate", "model": "acestep-v15-sft"}`). `made_by_me` stays 0 unless the user claims it manually — e.g. Music-tab **cover mode** starts from the user's own source audio, so the toggle offers HAND there, but the op itself asserts only the AI half. Rationale: the op knows AI ran; only the user knows whether a human authored the input.

### 6.4 Precedence and write-time invariant (locked)

`manual` > `generated` > `dir_rule` for the `mine_source` label. Write-time invariant enforced in `catalog_upsert` and the mark endpoint: `is_mine = is_mine OR made_by_me OR ai_involved` — if either craft bit is set, the master flag follows (if I made it or my AI touched it, it is mine for filtering). The only clear path is explicit manual unmark (§6.2), which zeroes the whole triple.

### 6.5 The two craft facts (locked, Rev 2)

Phrasing is deliberate: **"made by me"** (human authorship) and **"AI involved"** (AI touched any part) — not "AI-made", because AI may have animated something the user drew. Both bits describe the user's own workflow only: a downloaded video that happens to be AI slop is `made_by_me=0, ai_involved=0` — neither, because the user neither authored it nor ran the AI. All four combos are valid and filterable:

| made_by_me | ai_involved | Meaning | Example |
|---|---|---|---|
| 1 | 0 | Hand-only | Recorded guitar riff, bounced mix, filmed clip |
| 0 | 1 | AI-only | Pure ACE-Step text-to-music generation |
| 1 | 1 | Both | Drew frames, then AI-animated / interpolated them |
| 0 | 0 | Neither | YouTube rip, third-party file, stock |

`origin` stays orthogonal: it records how the file *entered the app* (`generated|web|import`), not who made it. Which AI tool ran lives in `raw_metadata` (`generated_by`, model, params) — tools come and go, the bit stays.

### 6.6 Safeguard: confirm gates + provenance audit log + undo (locked, Rev 3)

Accidental unmark previously had no recovery (manual rows are never re-asserted by heuristics, by design). The safeguard is two mechanisms, no whole-DB backups, no soft-delete states:

1. **Confirm gates (prevention).** House `confirm()` idiom (cf. `items.js:170`, `sequence-composer.js:191`): single unmark → "Clear mine + Made-by-me + AI involved on `<name>`?"; bulk unmark → states the item count. Clear proceeds only on accept.
2. **`provenance_log` (rollback).** Every write to the triple — mark endpoint, generator stamping, dir-rule ingest, undo itself — appends one row per path with the old→new triple, mechanism, and a `batch_id` (uuid4 per single write; shared across a bulk operation). Never pruned by normal ops.
3. **Undo.** `POST /api/media-catalog/undo {batch_id}` re-applies the pre-batch triple per row of that batch, itself logged with `mechanism='undo'` under a fresh batch_id (undo is undoable). Restores the provenance triple + `mine_source` **only** — never analysis columns (provenance and analysis are independent column groups; §13). Surfaces: per-row "Undo" (latest log entry for that path) and a recent-batches "Undo bulk change" control in the Catalog tab (§10); single-item undo in the pool card menu via the same endpoint.

Design notes: the log also answers "when did I mark this?" — provenance over time, in the catalog's spirit. Undo-after-rescan is safe: a scan may have changed analysis columns since the logged write; undo ignores them and restores only the triple.

---

## 7. Scan Op & Analysis Engines

`POST /ops/media_catalog_scan`, registered per the `OperationSpec(id=..., handler=...)` pattern (`ytdlp_ops.py:605`, import list in `operations/__init__.py:41`).

```json
{
  "op_id": "media_catalog_scan",
  "target_directory": "/absolute/path/to/music",
  "recursive": true,
  "audio_types": [".wav", ".mp3", ".aif", ".flac"],
  "analyze_key": true,
  "analyze_tempo": true,
  "analyze_beats": false,
  "analyze_midi": false,
  "long_file_guard_sec": 300,
  "dry_run": false
}
```

- Walk + classify (video/image extensions reuse existing predicates). Upsert all rows first (`status='scanned'`), then analyze only audio + has-audio video when at least one analysis toggle is on.
- **Key** (`analyze_key`): Essentia `KeyExtractor` → canonical `key_name` + `key_strength`. Essentia's standard-mode algorithms take a bare 44.1 kHz mono vector (no sample-rate argument), so the scanner always decodes through ffmpeg to exactly that.
- **Tempo** (`analyze_tempo`): Essentia `RhythmExtractor2013`. **Measured choice (Slice 3, ground-truth fixture of C major @ exactly 120 BPM):** `tempoEstimateMethod='degara'` returned 120.03 (0.02% error) while `'multifeature'` returned 117.61 (~2% off) but was the only method reporting a usable confidence. So `tempo` is taken from **degara**, `tempo_conf` from **multifeature** (Essentia's raw confidence is unbounded — clamped to 0-1), and when the two disagree by >10% the value falls back to multifeature (more robust on rubato/non-dance material). Both raw estimates, the chosen source, and the disagreement ratio are preserved in `raw_metadata.tempo_alternates` and the sidecar, so a disagreement is visible rather than averaged away. Files longer than `long_file_guard_sec` analyze the first N seconds only (carried from `analyzetag-spec.md` DJ-mix edge case).
- **Beats/onsets** (`analyze_beats`): Essentia `BeatTrackerMultiFeature` + `OnsetRate` → beat grid, downbeats, onsets into the sidecar + `raw_metadata`. **Engine change (Slice 4, measured):** the spec originally assigned madmom + aubio, but madmom **cannot build on this box** (undeclared Cython build dep, and its numpy<2 pin would fight the installed numpy 2.4.6) while Essentia already ships a beat tracker and onset detector — so madmom/aubio were dropped rather than added as dead weight. **Meter is assumed 4/4 and flagged `meter_assumed: true`**: this Essentia wheel has no `LoudnessBandRatio`, so its `Meter` (which needs a band-ratio beatogram) is unavailable. Downbeat *phase* is still derived from the onset-density profile (a heuristic, and labelled as one).
- **MIDI** (`analyze_midi`): `mido` writes a **tempo-map** `.mid` sibling (§8): tempo meta-event, one short blip per beat, accented (velocity 100) notes on the detected downbeats. **Engine change (Slice 4, measured):** Basic Pitch is **not installed** — it would downgrade tensorflow 2.21 → 2.15, breaking the styletransfer Magenta path (8.074). So the sidecar is an honest tempo map, labelled `midi_note: "… NOT note transcription"`, never a fake note grid. Note-level transcription stays parked; if it is ever wanted it needs an isolated venv, not the main one.
- Video inputs: ffmpeg-extract audio stream to a temp wav (inside the job workspace, cleaned after), never fail the row when a video has no audio track — analysis columns stay NULL, `status='scanned'`.
- Images: upsert only, never analyzed.
- Per-file failure → `status='error'` in that row, log, continue (`report_progress()` per item, invariant 9). Op-level failure → HTTP 200 + `ok:false` (invariant 10).
- Hash dedup: skip analysis when `file_hash` matches a row with `status` in (`scanned`,`analyzed`) — the skeleton's `_quick_hash` (first 1MB) is kept.
- `dry_run` lists would-be rows/commands without writing (Seal-pattern dry run, cf. ytdlp tab).

---

## 8. Sidecars (non-destructive)

Beside each analyzed file: `<base>.json` and (when `analyze_midi`) `<base>.mid`. Never touch the original. JSON schema mirrors the DB row plus arrays:

```json
{
  "path": "/abs/track.wav",
  "file_hash": "…",
  "tempo": 128.32, "tempo_conf": 0.92,
  "key": "G minor", "key_strength": 0.81,
  "duration": 214.5,
  "beats": [0.0, 0.46, …], "downbeats": [0.0, 1.85, …], "onsets": [0.02, …],
  "engines": {"key": "essentia-2.1", "tempo": "essentia-2.1", "beats": "madmom-…", "midi": "basic-pitch-…"},
  "origin": "import", "is_mine": true, "mine_source": "dir_rule",
  "made_by_me": false, "ai_involved": false, "ai_tools": []
}
```

`.mid` holds the tempo map + downbeat marker meta-events (finish the skeleton's `_write_midi_sidecar` TODO via `mido`/`pretty_midi`; Basic Pitch output is moved/renamed to the sibling path, not left in an output dir). Companion test media for the suite lives under `mtapi-project/junk/` only (invariant 8).

---

## 9. Query API

New `app/routes/media_catalog.py`, `APIRouter(prefix="/api/media-catalog")`, `register(app)` in `main.py` beside the existing route registrations (`main.py:243` pattern).

- `GET /api/media-catalog/query?type=&mine=&hand=&ai=&origin=&site=&key=&tempo_min=&tempo_max=&q=&limit=&offset=` → `{ok, rows[], total}`. `mine=1` filters `is_mine=1`; `hand=1` filters `made_by_me=1`; `ai=1` filters `ai_involved=1`; `key` normalizes (`Cmaj`→`C major`); `tempo_min/max` range on `tempo`; `q` matches path/author/title-ish substring. Pagination required (100k-scale tables are virtualized client-side; the API pages server-side).
- `POST /api/media-catalog/ingest {paths: [...]}` → lightweight upsert for the §5 path-4 pool import hook: classifies type, hashes, stamps `origin='import'`, evaluates owned-dir rules, resolves web/origin conflict per §6.4. Never blocks, never analyzes. Returns `{ok, upserted: n}`.
- `POST /api/media-catalog/mark {path, is_mine, made_by_me, ai_involved}` → §6.2; also back-writes the pool item's `source_meta` when the path is pooled. Accepts optional `batch_id` so a bulk UI flow shares one batch.
- `POST /api/media-catalog/undo {batch_id}` → §6.6: re-applies the pre-batch triple per row (mechanism='undo', fresh batch_id); never touches analysis columns.
- `GET /api/media-catalog/status` → `{db_path, counts by type/status, engines_present: {essentia, madmom, aubio, basic_pitch}}` for the tab's Setup row (Demucs/Music tab-local Setup precedent — install guidance, non-fatal probes).

---

## 10. Media Catalog Tab (UI)

Library section, `data-tab="mediacatalog"` (`js/tabs/mediacatalog.js` + `css/mediacatalog.css`, nav item in `index.html`, routing/title in `app.js` — same touch points as the ytdlp tab). Scan runs through **tab-local buttons** (Scan / Dry Run, ytdlp-tab pattern — no global-Run dependency) wired to the op via the standard job machinery (progress + cancel free).

- **Scan card:** target directory input + folder picker, recursive toggle, the four analysis checkboxes (§7), long-file guard input, Scan / Dry Run, engine-status row (`GET …/status`).
- **Facets sidebar:** type (audio/video/image), Mine only, Made by me, AI involved, origin (generated/web/import), site (youtube/…), key dropdown (24 scales + N/A — same option set as the Music tab metas, `8.088`), tempo range slider/inputs, error-only + missing-only views.
- **Table:** virtualized rows — play/stop (audio), path, badges (✦ mine · HAND · AI · GEN · YT/site · key · tempo), duration; click row → preview; double-click → reveal pool item if pooled. Inline audio player for audio rows (quarry acceptance carried over).
- Empty states name the fix ("No rows — run a Scan, import media, or download via the Downloader tab").

---

## 11. Pool Integration (mine flag in the working library)

`source_meta` is the pool-side carrier. It already round-trips: frontend passes it through (`persistence.js:96,116`), server whitelists it (`pool.py:_normalize_source_meta`, `pool.py:220`).

1. **Whitelist extension** (`pool.py:220`): `str_keys += ("origin", "key_name")`; `bool_keys += ("is_mine", "made_by_me", "ai_involved")`; new `float_keys = ("tempo", "tempo_conf")` (the normalizer previously had no float path). All other web keys (`site`, `is_youtube`, author, …) already survive. `cache.py:221` content-addressable records keep `source_meta: None` default; the existing backfill (`pool.py:705`) needs no change.
2. **Ingest stamping:** yt-dlp results set `origin='web'` (+ existing web fields) in `_construct_source_meta` (`ytdlp_ops.py:249`); `is_mine` arrives via owned-dir rule match or later manual toggle. Generator auto-add stamps `origin='generated', is_mine=1` at the §5-path-3 hook. Pool-import hook (§5 path 4) stamps `origin='import'` + rule evaluation.
3. **Search tokens** (new — note: the `is:youtube`/`author:`/`after:` grammar proposed in `ytdlp-tab-spec.md` §6.2 **never shipped**; verified absent from `grid.js:filteredPoolItems`. This spec defines the v1 grammar): `is:mine` · `is:hand` · `is:ai` · `origin:generated|web|import` · `site:<name>` · `is:youtube` · `after:<YYYY-MM-DD>` · `before:<YYYY-MM-DD>` · `key:<C major|Cmaj|C…>` · `bpm:<90-95|128|…>`. Tokens parse out of the query before fuzzy/strict matching in `filteredPoolItems()` (`grid.js:463`); remaining text still matches `poolItemSearchText()` (`grid.js:380`) — extend that function with `sm.origin`, `mine ? 'mine' : ''`, `hand ? 'handmade' : ''`, and `ai ? 'ai' : ''` so bare words also fuzzy-match.
4. **Badges** in the card meta block (`persistence.js:1250` area): `✦ mine` (accent) · `HAND` (made-by-me) · `AI` (ai-involved) · `GEN` (app-generated) · `[YouTube|site]` platform tag (already specced in ytdlp §6.4 — implement here if still absent) · a teal `key · BPM` chip on analysed rows. The chip and the `key:`/`bpm:` tokens read `source_meta.key_name` / `source_meta.tempo`, which the ingest hook mirrors from the catalog row (Slice 3): a file that was scanned **before** import badges and filters immediately; one scanned **after** import picks the values up on the next pool load/restore.
5. **Image Pool too** — cards get the same badges + context-menu toggle; image rows in the catalog query as `type=image`.
6. No new pool sort modes in v1 (existing `#poolSortMode` sort orders in `grid.js:224` stand); tokens + badges only.

---

## 12. Files to Touch

| File | Action | Role |
|---|---|---|
| `docs/media-catalog-spec.md` | **NEW** | This spec. |
| `mtapi-project/app/database/audio_db.py` | **REWRITE** | §4 schema (`media` table + indexes); keep `stems`/`slices` DDL parked; `init_db()`; shared `catalog_upsert()` helper for §5. |
| `mtapi-project/app/audio_pipeline/scanner.py` | **REWRITE** | Real `AudioScanner`: walk/classify/hash-dedup/sidecars/DB upsert calling the §7 engines (replaces dummy `_extract_features`, finishes `_write_midi_sidecar`). |
| `mtapi-project/app/operations/media_catalog_ops.py` | **NEW** | `MediaCatalogScanParams` + `media_catalog_scan` handler (`OperationSpec(id="media_catalog_scan")`); import in `operations/__init__.py` (list at `:41`). |
| `mtapi-project/app/routes/media_catalog.py` | **NEW** | `GET query` · `POST ingest` · `POST mark` · `POST undo` · `GET status`; `register(app)` in `main.py` (`:243` pattern). |
| `mtapi-project/app/operations/ytdlp_ops.py` | **MODIFY** | §5 path 2: catalog upsert after `_construct_source_meta()` (`:565`) with `origin='web'`. |
| `mtapi-project/app/static/js/pool/auto-catalog.js` | **NEW** | §5 path 4 import hook (`auto-firstlast.js` module shape). |
| `mtapi-project/app/static/js/pool/items.js` | **MODIFY** | Call the hook in `addPathsToPool` (`:185`, beside `:189`/`:233`). |
| `mtapi-project/app/static/js/pool/image-pool.js` | **MODIFY** | Same hook at image import (`:248` area) + badges/menu (§11.5). |
| `mtapi-project/app/static/js/pool/auto-add-outputs.js` | **MODIFY** | §5 path 3: stamp `origin='generated', is_mine=1` (keep the RIFE-variant guard). |
| `mtapi-project/app/media/pool.py` | **MODIFY** | Whitelist `origin` + `is_mine` in `_normalize_source_meta` (`:220`). |
| `mtapi-project/app/static/js/pool/grid.js` | **MODIFY** | Token grammar in `filteredPoolItems()` (`:463`); search-text + sort-touch in `poolItemSearchText()` (`:380`). |
| `mtapi-project/app/static/js/pool/chrome.js` + `persistence.js` | **MODIFY** | Context-menu toggle; card badges (`persistence.js:1250` area). Pass-through at `persistence.js:96,116` needs no change — assert in tests. |
| `mtapi-project/app/static/js/tabs/settings.js` + `app.js` + `app/media/performance.py` | **MODIFY** | Owned-dirs card (§6.1 three-layer keys). |
| `mtapi-project/app/static/js/tabs/mediacatalog.js` + `css/mediacatalog.css` + `index.html` + `app.js` | **NEW/EDIT** | §10 tab (Library section, `data-tab="mediacatalog"`). |
| `mtapi-project/requirements.txt` | **MODIFY** | `essentia`, `madmom`, `aubio`, `basic-pitch`, `mido` (versions pinned by builder after install-verify). |
| `mtapi-project/tests/test_media_catalog.py` | **NEW** | §14 cases. (Not `test_catalog*.py` — that name covers `media/catalog.py`.) |

---

## 13. Edge Cases

- Corrupt/unreadable file → row `status='error'`, continue (quarry carry-over).
- Re-scan of unchanged library → hash match skips analysis (fast path; report counts).
- File moved/deleted → row `status='missing'` on rescan touch or failed open; never auto-delete rows (user may restore the mount).
- Same path in both pools → one DB row keyed by path; pool item and row cross-link by absolute path.
- Video with no audio track → analysis NULL, `status='scanned'` (not error).
- 1hr+ mixes → `long_file_guard_sec` first-N-seconds analysis for tempo (analyzetag carry-over); key on the same window, noted in sidecar.
- Manual unmark zeroes the triple; a later owned-dir rescan re-asserts nothing on a `manual` row — not even `is_mine` (§6.2). The user re-marks by hand (or via §6.6 undo).
- Undo-after-rescan: a scan may have rewritten analysis columns since the logged write; undo restores only the provenance triple, leaving analysis intact (column groups are independent by design).
- Third-party AI content (downloaded AI slop, AI music from elsewhere) ingests with both craft bits 0 — the bits describe the user's workflow, not the file's history (§6.5).
- 100k+ rows → server-side pagination + client table virtualization (quarry carry-over); JSONB/`raw_metadata` never in list payloads, fetched per-row on demand.
- Concurrent scan + pool import of the same path → upsert is idempotent (INSERT … ON CONFLICT, skeleton pattern kept).

---

## 14. Verification

- `./check-gate.sh` 5/5 (gate-first per invariant 12) before pytest or any Playwright session.
- `tests/test_media_catalog.py`: schema init + indexes (media + provenance_log); upsert/dedup idempotency; `_normalize_source_meta` keeps `origin`/`is_mine` and drops unknown keys; token-grammar parse (incl. `Cmaj`→`C major`); scan op dry-run lists without writing; mark endpoint round-trip; manual-precedence + write-time invariant; `provenance_log` append-on-change (and no-op writes don't log); `undo_batch` restores the triple without touching analysis columns; `persistence.js` pass-through shape (frontend contract test where the repo already does them).
- Playwright, real clicks on a live server (curl is not UI proof, invariant 12): register owned dir → scan fixture audio in `junk/` → row appears analyzed with key/tempo; Music-tab output auto-arrives `GEN`+`AI`+mine; hand-drawn fixture clip marked HAND+AI via the toggle shows both badges and matches `is:mine is:hand is:ai`; yt-dlp download arrives `origin=web`, `is_youtube`, not-mine, neither craft bit; pool `is:mine` + `key:c major` tokens filter; manual toggle flips badges on both surfaces; reload persists. Zero new console errors.
- Ship: bump root `VERSION` far-right DD + STATUS top box (no digits copied), diary line in `docs/archive/changelog.md`, per `AGENTS.md` §3.

---

## 15. Risks / Follow-Ups

- **Dependency weight even in-venv** (Essentia/Madmom wheels + Basic Pitch TF graph): measure install + import time on the build box; engines stay lazy-imported so boot/probe paths never pay. If Essentia proves unshippable here, fallback is `keyfinder`+`aubio` per `analyzetag-spec.md` — same columns, weaker confidence.
- **Basic Pitch model load latency** on first MIDI run: warm it in the tab Setup probe, non-fatal.
- **Parked:** quarry Phase 3 slicer/one-shots; browser MIDI playback synced to slices (quarry follow-up); pool `mine`-first sort mode (tokens suffice v1); ONNX/OpenVINO Basic Pitch offload.
- **Loop detection** stays research-grade per quarry risk note — explicitly out of v1 acceptance.

---

## 17. Isolated Audio Workers (Slice 7)

The analysis engines need mutually incompatible pins, so they live in **separate venvs** and run as subprocesses:

| Venv | Python | Pins | Engines |
|---|---|---|---|
| `.venv-audio` (modern) | 3.11 | numpy 1.26, TF 2.15 | essentia, librosa, basic-pitch, mido, soundfile, scipy |
| `.venv-audio-legacy` | 3.9 | numpy 1.20.3, setuptools<81 | madmom |
| app venv (unchanged) | 3.11 | numpy 2.4.6, openvino 2026.3, torch 2.13, **TF 2.21** | — |

**Why isolation was mandatory:** basic-pitch wants TF 2.15 and would *downgrade* the app's TF 2.21, breaking the styletransfer Magenta path (`8.074`); madmom needs Python ≤3.9 (`collections.MutableSequence`) and old numpy. Neither can share the app venv.

- Entry point: `tools/audio_worker.py` — imports **nothing from `app`** (so it runs under any interpreter), takes `--wav/--want/--engines/--midi-out`, and prints one JSON object tagged `@@MTAPI_AUDIO_JSON@@` so engine chatter cannot corrupt it. A missing engine is *reported*, never fatal.
- Rebuild with `scripts/setup_audio_venvs.sh`. Venv paths overridable via `MTAPI_AUDIO_VENV` / `MTAPI_AUDIO_LEGACY_VENV` (mirrors the `MUSIC_PYTHON` precedent). Both are gitignored.
- **Not installed, deliberately:** `aubio` (0.4.9's C bindings don't compile against any modern numpy; no wheel exists for any version) and `keyfinder` (broken sdist, missing `keyfinder/constants.h`).

### 17.1 Competing opinions (the point)

Nothing is averaged away. Every engine's answer is preserved in the sidecar's `engine_opinions` and in `raw_metadata.opinions`, and the DB columns hold a *consensus* chosen by an explicit, documented preference order (tempo: `essentia-degara` → `essentia-multifeature` → `madmom-dbn-histogram` → `librosa-beat_track`; engines reporting `0.0` never win). Two extra numbers exist purely so the user can judge the engines:

- `tempo_spread_bpm` — max−min across engines that reported a pulse
- `beat_counts_by_engine` / `onset_counts_by_engine` — the per-engine split

`include_extra_opinions` (default **on**) runs librosa + the legacy madmom venv for those duplicates. Measured cost on this box: **~16 s/file with extras vs ~3 s/file without** (5.4×), because each extra engine is another subprocess. Dedup keeps re-scans free.

Downbeat phase and the (assumed) 4/4 meter are derived by the **scanner**, not any engine — which beat is beat 1 depends on the recording, so it is applied to whichever grid won.

## 18. Embedded Tags, Tracker Headers & Tag-vs-Detection (Slice 8)

A DJ library already carries the owner's own answers in its files. Slice 8 reads them, so the detectors can be **judged** instead of trusted.

**Two sources, because neither covers everything:**
1. **ffprobe** (~50 ms) — Vorbis comments (FLAC/OGG), ID3v2 (MP3), iTunes atoms (MP4/M4A), RIFF INFO (WAV). Read on **every** index pass, analysis or not.
2. **Tracker headers, parsed here** — XM / IT / S3M / MOD are *not* audio containers, so ffprobe reads nothing useful from them. Their headers carry title, tracker, channels/patterns, MOD sample names and the initial BPM; **acidized** modules are recognised by their credit strings and flagged `acidized` + `tag_acidized=1`.

**Storage.** Promoted columns (`title`, `artist`, `album`, `tag_bpm`, `tag_key`, `tag_initial_key`, `tag_camelot`, `tag_playlist_key`, `tag_mood`, `tag_genre`, `tag_comment`, `tag_encoder`, `tag_acidized`) plus the full unnormalised `tags_json`. Added by explicit `ALTER TABLE` migration (`_migrate`) with a test that upgrades a real previous-version database **without losing rows** — the catalog already holds real scans. Tracker headers win conflicts with container tags: they're what the author typed into the tracker, whereas container tags are often rewritten by later transcodes.

**Normalisation for comparison, raw kept.** `Abm` → `G# minor` (flats→sharps), `10a` → `10A` Camelot, `bpm` parsed and range-checked. Nothing is lost: `tags_json` keeps every tag exactly as written.

**Tag vs detection** (`compare_with_tags`) lands in `raw_metadata` and the query API:
- `tempo_vs_tag_bpm`, `tempo_ratio`, `tempo_agrees_with_tag` (±2% or 1.5 BPM), and **`tempo_octave_equivalent`** — tested directly over 2^k multiples, because a 2× miss is the most common detector failure and must read as "same pulse, wrong counting".
- `key_matches_tag` / `key_pitch_class_delta` / `key_relative_of_tag` on pitch class, so enharmonics don't produce false mismatches and a relative key (Δ3) is named rather than called wrong.

### 18.1 Measured on the user's own library (10 FLACs, `junk/at`)

The library's tags proved to be real DJ annotations (`key`, `initialkey`, `camelotkey`, `playlistkey`, `bpm`). Two findings drove code changes:

- **Octave errors are the dominant tempo failure.** Several files were detected at ~half the tagged tempo. That produced `tempo_consensus_by_vote`: tempi are folded into octave groups (`octave_group`) so a majority can win across octaves, **and** the split is judged on the *raw* values (folding would hide exactly what the user needs to see), reported as `tempo_octave_split` + `tempo_octave_minorities`. The fixed preference order is now only a tiebreak.
- **Key detection shows systematic bias, not per-file noise.** Every track tagged Camelot `1A` (Abm) detected as `Eb minor` — a consistent fifth, i.e. one bias to correct rather than three separate failures.

## 19. Source of Truth (Slice 9)

**Both readings are always stored; only one is in charge.** This is a choice, never a deletion.

| Column | Meaning |
|---|---|
| `tempo` / `key_name` | the **effective** value — what filtering and the UI use |
| `tag_bpm` / `tag_initial_key` | the owner's own annotation (unchanged) |
| `tempo_detected` / `key_detected` | the detector's reading (unchanged) |
| `tempo_source` / `key_source` | `tagged` or `detected` — which is in charge |
| `tempo_source_manual` / `key_source_manual` | 1 when the user chose explicitly |

**Default policy:** a tagged value wins; otherwise the detection. `apply_source_defaults` runs after tags land and after analysis, and **only touches rows whose choice is not manual** — so an explicit selection survives every later scan and every re-tag. Tempo and key are chosen **independently**.

Switching is per row and per field: `POST /api/media-catalog/source {path, field, source}`, surfaced in the Catalog tab as a clickable `⚡ tagged` / `⚡ detected` chip. Filters `source=tagged|detected` and `disagree=1` (tag and detection differ by >1.5 BPM) exist for the audit pass.

`tempo_vs_tag_bpm` and `key_*_tag` always compare **detection against tag** — never the effective value against the tag, which would read 0 the moment the tag wins.

**Migration note (honest):** rows analysed *before* this split had their detection in `tempo`/`key_name`. Reusing those columns for the effective value meant the detection survived only in the sibling `.json` sidecar, so `backfill_detected_from_sidecars()` reads it back on the next scan. Rows with no sidecar keep `NULL` — nothing is invented.

## 16. Build Slices (roadmap for the Builder assignment)

1. **Schema + settings** — `audio_db.py` rewrite, `init_db` wiring, owned-dirs card + three-layer keys. Tests: schema/upsert/dedup.
2. **Ingest + mine plumbing** — `catalog_upsert` helper, `routes/media_catalog.py` (`ingest`/`mark`/`undo`/`status`; full `query` lands with Slice 5), `auto-catalog.js` + both pool hooks, yt-dlp + generator stamping, `pool.py` whitelist, badges, `is:mine`/`origin:` tokens. Tests: whitelist, pass-through, hooks, mark/undo round-trips.
3. **Scan op + key/tempo** — `media_catalog_ops.py`, real Essentia paths in `scanner.py`, sidecar JSON. Tests: dry-run, error-row continuation.
4. **Beats + MIDI** — Madmom/Aubio arrays, Basic Pitch `.mid`. Tests: fixture loop produces finite beats + valid MIDI.
5. **Catalog tab** — facets, virtualized table, player, Setup row. Playwright proof.
7. **Isolated audio workers + competing opinions** — SHIPPED, see §17.
8. **Embedded tags + tracker headers + tag-vs-detection** — SHIPPED, see §18.
9. **Source of truth (tagged by default, per-track switch)** — SHIPPED, see §19.
6. **Full query grammar + polish** — remaining tokens (`site:`, `after:/before:`, `key:`, `bpm:`), missing/error views, docs + VERSION bump.

---

## Appendix A — Supersession Map

| Predecessor | Absorbed into |
|---|---|
| `audio-quarry-spec.md` Phase 1 (scanner, `audio_catalog.db`, `.json`/`.mid` sidecars, hash dedup, faceted UI, 100k/virtualization/error-row edge cases) | §4, §5.1, §7, §8, §10, §13 |
| `audio-quarry-spec.md` Phases 2–3 (Demucs worker, slicer) | Parked (§2 non-goals; Stems tab ships) |
| `audio-analysis-spec.md` (engine stack, parallel detectors, `/ops/audio-analyze`, MIDI + transients JSON) | §3 engine table, §7 toggles, §8 sidecars. Op id `audio-analyze` retired in favor of `media_catalog_scan`. |
| `backlog/analyzetag-spec.md` (file-or-directory key/BPM, live table, report, long-file + video-container edge cases) | §7 params/guard, §10 table, §8 (sidecar replaces report), §13 |
| `ytdlp-tab-spec.md` §6.2 token grammar | Noted as never-shipped; v1 grammar redefined in §11.3 |

(End of spec)
