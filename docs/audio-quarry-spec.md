# Audio Quarry (Catalog & Auto-Slicer) — Spec

> Status: Proposed
> Kind: E (Catalog UI) + A (Batch Audio Processor)
> Stage: directory / background_worker

## Problem
Users have decades of bounced ideas, stems, and audio assets, but no structured way to query, extract, or repurpose them at scale. Finding "every kick I've ever used" or "all 4-bar loops at 90-95 BPM in A minor" is impossible because the data is trapped inside unanalyzed, un-separated audio files.

## Goals / Non-goals
**Goals:**
- Build a fast, offline metadata scanner (Phase 1) extracting BPM, key, beats, and onsets.
- Create an asynchronous background worker for heavy GPU separation (Phase 2 - Demucs).
- Implement an auto-slicer (Phase 3) to extract loops, one-shots, and MIDI conversions.
- Decouple metadata from audio files using lightweight `.json` and `.mid` sidecars.
- Provide a queryable SQLite database and WebUI tab to filter and browse the extracted catalog.

**Non-goals:**
- Replacing traditional ID3 tags in the original files (we use non-destructive sidecars).
- Real-time DAW integration (this is an offline indexer and extractor).
- Re-architecting the existing Video/Image pools (this focuses on a new Audio domain).

## User story
1. User navigates to the new "Audio Quarry" tab and selects an absolute folder path containing years of bounces.
2. User clicks "Phase 1: Fast Scan". The backend processes the folder using Essentia/Madmom, writing `track123.json` and `track123.mid` sidecars, and logging them in a local SQLite DB.
3. User selects a subset of tracks (e.g., "all tracks > 2 mins") and queues them for "Phase 2: Overnight Stems".
4. A background job processes them sequentially with `htdemucs`, writing `/stems/{track_id}/` outputs.
5. User runs "Phase 3: Slicer" on the stems to detect kicks/snares and extract them into a `/samples/` directory as normalized one-shots.
6. User uses the UI table to filter `WHERE type='kick' AND bpm=90` and drags the resulting files into their DAW or the Video Pool.

## Params (JSON)
```json
{
  "op_id": "audio_quarry_scan",
  "target_directory": "/absolute/path/to/music",
  "run_phase_1_scan": true,
  "run_phase_2_demucs": false,
  "run_phase_3_slice": false,
  "audio_types": [".wav", ".mp3", ".aif", ".flac"],
  "normalize_target_lufs": -14
}
```

## Architecture (reuse bookends/filters?)
- **Heavy ML Dependencies:** Introduces Essentia, Madmom, Librosa, Aubio, Demucs, Basic Pitch. This requires a dedicated ML backend environment or heavy additions to `mtapi-project` requirements.
- **Database:** Introduces a local SQLite DB (`audio_catalog.db`) with JSONB support to mirror the `.json` sidecars for fast querying.
- **Job Control:** Heavily reuses the existing `job_control` and `JobWorkspace` for overnight queues, but extends it to support a "continuous worker" pattern that survives beyond single HTTP requests.
- **Sidecar Paradigm:** Original files are never modified. `track123.json` stores analytical metadata, and `track123.mid` stores the tempo map and marker meta-events for engine consumption.

## Files to touch
- **Backend:** 
  - `mtapi-project/app/operations/audio_quarry_ops.py` (HTTP endpoints)
  - `mtapi-project/app/audio_pipeline/scanner.py` (Essentia/Madmom wrappers)
  - `mtapi-project/app/audio_pipeline/demucs_worker.py` (Stem separation queue)
  - `mtapi-project/app/audio_pipeline/slicer.py` (Aubio onsets -> pydub slice -> pyloudnorm)
  - `mtapi-project/app/database/audio_db.py` (SQLite interface)
- **Frontend:** 
  - `app/static/js/tabs/audio-quarry.js` (UI logic, data table, query builder)
  - `app/index.html` (New tab layout)
- **Docs:** `docs/audio-quarry-spec.md` (This document)

## UI
- **Tab Name:** Audio Quarry
- **Layout:**
  - **Left Sidebar:** Faceted search filters (BPM slider, Key dropdown, Type checkboxes: Loop/Kick/Snare/Full).
  - **Top Bar:** Target Directory input, "Run Pipeline" buttons (Phase 1, 2, 3 checkboxes).
  - **Main Area:** A massive data table (`js/ui/data-table.js`) displaying the SQLite results.
  - **Rows:** Play/Stop toggle, File Path, BPM, Key, Extracted Stems badges (D, B, O, V).

## Edge cases
- **Corrupt/Unreadable Audio:** Fails gracefully, marks DB entry as `status='error'`, moves to next track.
- **Missing GPU:** Demucs CPU fallback is 10-50x slower. The worker must calculate estimated time and warn the user before starting Phase 2.
- **Duplicate Scans:** File hashing (blake3 or fast xxhash on first 1MB) to skip re-processing.
- **Massive Collections (100k+):** UI table virtualization needed to prevent DOM locking. SQLite handles 100k fine, but JSONB queries must be indexed.

## Acceptance tests
- **Backend Smoke Test:** Provide `/tmp/test_audio.wav` (2s drum loop). Run Phase 1-3. Verify `test_audio.json`, `test_audio.mid`, `/stems/test_audio/drums.wav`, and `/samples/test_audio_kick_1.wav` are created.
- **DB State:** Verify DB contains the new track with `bpm` and `key` populated.
- **WebUI:** Form renders, SQL query returns the test asset, inline audio player plays it, zero JS console errors.

## Risks / follow-ups
- **Dependency Bloat Risk:** Essentia, Madmom, Demucs, and PyTorch add gigabytes to the environment footprint. *Mitigation:* Consider isolating the audio worker into a separate virtualenv or a standalone local microservice to avoid polluting the core video environment.
- **Phase 3 Complexity:** Automatic loop detection (self-similarity) is research-level audio processing and may yield high false positives initially.
- **Follow-up:** Real-time MIDI playback in the browser synced with the audio slice.
