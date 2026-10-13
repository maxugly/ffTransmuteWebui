# TTS and Voice Mod Reference Libraries Spec

> **Status:** Implemented; verified via unit tests, fast check gate, and Playwright browser clicks.
> **Scope:** References → TTS (`refs-tts`) & Voice Mod (`refs-voicemod`).
> **Version:** `000.000.8.150`
> **Related:** `audio-model-reference-spec.md`, `listening-model-reference-spec.md`, `ui-density-standard.md`.

## 1. Overview and Intent

The previously combined Audio Models reference library was reorganized into two dedicated, focused reference libraries based on user requirements:
1. **TTS (Text-to-Speech)**: Contains 64 models, services, and pipelines for speech synthesis, voice cloning, and dialogue generation, categorized into:
   - *High-Performance & Commercial-Safe Models* (Qwen3-TTS, Kokoro v1.0, Chatterbox, Step Audio EditX, VoxCPM2, Orpheus, Dia v2, CosyVoice2, Zonos v0.1, Maya1, NVIDIA Magpie TTS, GLM-TTS, MetaVoice v1, OpenVoice v2, etc.)
   - *Research, Non-Commercial, or Specialized Licenses* (Fish Audio S2 Pro, Voxtral TTS, Breeze TTS 2, Higgs Audio V3, XTTS v2, F5-TTS, Hume TADA, Sesame CSM, OmniVoice, OpenAudio S1-mini, VibeVoice, etc.)
   - *Legacy, Lightweight, or Niche Models* (Piper, Bark, MeloTTS, Mozilla TTS, Coqui TTS, Mimic 3, ChatTTS, StyleTTS 2, eSpeak, MaryTTS, Vosk, Moonshine, Tacotron/Tacotron2, WaveNet, FastPitch, HiFiGAN, VITS, Tortoise TTS, Parler TTS Mini, IndexTTS-2, Cartesia Sonic, LMNT, etc.)
   - *Key Considerations for Selection* embedded in reference notes and documentation covering licensing (commercial safety vs research), hardware requirements (CPU vs GPU VRAM tiers), language breadth, zero-shot voice cloning capabilities, and streaming latency.
2. **Voice Mod (Voice Modification)**: Contains 23 dedicated models and systems for singing voice conversion (SVC), audio-to-audio speech conversion, real-time voice modification, and timbre transformation (RVC v2, Applio, LHQ-SVC, So-VITS-SVC 4.x, DDSP-SVC, Everyone-Can-Sing, GPT-SoVITS, MMVC, Seed-VC, FreeVC, Voice-Fixer, OpenVoice, DiffSinger, etc.).

## 2. Navigation & UI Structure

- **Sidebar Navigation:**
  - `refs-tts`: Labeled "TTS" with the audio-waveform icon, positioned under References.
  - `refs-voicemod`: Labeled "Voice Mod" with a microphone icon, positioned directly beneath TTS.
- **Top References Subtab Strip:**
  - Includes dedicated `TTS` and `Voice Mod` buttons synchronized with sidebar selection.
- **Bare Workspace Layout:**
  - Global preview panel, Run button, and input strips are suppressed (`ref-active`, `bare-workspace`).
  - Table and Card view modes with search across all 12 comparison columns.
  - Card zoom slider (70%–160%, reset 100%) scaling typography, card metrics, and controls via `em` units.
  - Zero horizontal overflow beyond the designated table scroll region.
  - Natural table height without a `vh`/percentage cap; vertical scrolling belongs
    to the full workspace, avoiding an extra shortened scroll pane.
  - [Shared table display](reference-table-display-spec.md): sticky horizontal
    scrollbar and optional repeated-value, numeric, state and warning shading.
- **Model Detail Pages:**
  - Rendered when clicking any model name or card header.
  - Categorized attribute cards: *Overview*, *Voice & controls*, *Performance & hardware*, *License & evidence*.
  - *My notes* editor with server persistence, local draft survivability across tabs/reloads, and revision conflict detection.
  - *Tag a file* interface allowing association of local artifacts with models, many-to-many associations, and scoped downloads.
  - *Sources & reference files* providing direct downloads of bundled CSV, Markdown, JSON, HTML, and research source files.

## 3. Data & API Architecture

### Data Bundles
- `docs/reference/tts-models/`:
  - `tts-supertable.json`: 64 models, 64 unique slugified IDs, 12 comparison columns.
  - `tts-supertable.csv`: Exportable spreadsheet.
  - `tts-supertable.md`: Formatted Markdown table.
  - `tts-supertable.html`: Self-contained standalone interactive HTML table.
  - `source.txt`: Research reference notes including selection criteria.
- `docs/reference/voicemod-models/`:
  - `voicemod-supertable.json`: 23 models, 23 unique slugified IDs, 12 comparison columns.
  - `voicemod-supertable.csv`, `.md`, `.html`, `source.txt`.
- `docs/reference/audio-models/`: Maintained for backward compatibility.

### REST Endpoints
Implemented in `mtapi-project/app/routes/audio_references.py`:
- `GET /api/tts-references`: Returns 64 TTS models and catalog metadata.
- `GET /api/tts-references/source/{name}`: Serves TTS bundled reference artifacts.
- `GET /api/tts-references/model/{model_id}`: Fetches notes and associated files.
- `POST /api/tts-references/model/{model_id}/note`: Saves note with revision check.
- `POST /api/tts-references/model/{model_id}/file`: Tags absolute file path.
- `GET /api/voicemod-references`: Returns 23 Voice Mod models and metadata.
- `GET /api/voicemod-references/source/{name}`: Serves Voice Mod bundled artifacts.
- `GET /api/voicemod-references/model/{model_id}`: Fetches notes and files for Voice Mod.
- `POST /api/voicemod-references/model/{model_id}/note`: Saves note with revision check.
- `POST /api/voicemod-references/model/{model_id}/file`: Tags absolute file path.
- Backward compatibility: `/api/audio-references` remains operational, pointing to the TTS library.

Database files:
- `mtapi-project/data/audio-references.sqlite3` (`MTAPI_TTS_REFERENCES_DB`)
- `mtapi-project/data/voicemod-references.sqlite3` (`MTAPI_VOICEMOD_REFERENCES_DB`)

## 4. Verification and Invariants

1. **Gate Check:** `./check-gate.sh` passes 5/5 (100 JS ESM modules clean, HTML tag balance clean, Python syntax clean).
2. **Pytest Coverage:** `tests/test_audio_references.py` passes 15/15 tests validating catalog integrity, downloads, notes conflict management, and idempotent file associations.
3. **Playwright Real Browser Proof:** `mtapi-project/junk/tts-voicemod-prove.mjs`:
   - Navigates through live Chromium on port 24590.
   - Asserts TTS loads 64 models, search filter works, Kokoro details display correctly, notes save and persist across reloads, and notes clean up.
   - Asserts Voice Mod loads 23 models, search filter works, RVC v2 details display correctly, file tagging and untagging operate cleanly.
   - Asserts zero console errors and zero page errors throughout the session.
   - Proof screenshots: `mtapi-project/junk/tts-reference-tab.png` and `mtapi-project/junk/voicemod-reference-tab.png`.
