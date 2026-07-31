# Sequencer MVP (Grid-Synced Video Playlist) — Spec

> **Status:** Proposed
> **Audience:** Builder agents (codewhale, codex)
> **Related:** `video-image-pools-spec.md`, `audio-analysis-spec.md`

---

## 1. Purpose

Provide a simplified, linear video sequencer that syncs video clips to a Master Audio track based on a Global BPM. 

Instead of a complex, free-dragging DAW timeline, this MVP is a **block-based sequence**. Each block represents a video clip set to a specific musical duration (e.g., 4 beats). The backend will automatically time-stretch (speed up or slow down) the video clip to perfectly fit its musical duration.

---

## 2. Frontend UI / Workspace

### 2.1 Tab & Layout

- **Tab ID:** `sequencer` (Label: "Sequencer")
- **Global Controls:**
  - **Master Audio Path:** Input field for the backing track (wav/mp3).
  - **Global BPM:** Number input (e.g., 120).
- **Track Layout:**
  - A single horizontal flow of **Video Blocks**.
  - A visual representation (or simple label) underneath for the Master Audio track.

### 2.2 Video Block UI

Each video block in the sequence represents a clip. 
- **Visuals:** Displays two thumbnails side-by-side inside the block: the **First Frame** and the **Last Frame** of the video.
- **Metadata Displayed:** 
  - Source filename.
  - Duration in Beats (e.g., "4 Beats").
- **Selection & Controls:**
  - Clicking a block selects it (highlight border).
  - A shared toolbar (or floating toolbar on the selected block) with the following controls:
    - `[play] [pause]` — Preview the source video.
    - `[<<]` — Move block to the very beginning of the sequence.
    - `[<]` — Move block one slot to the left.
    - `[>]` — Move block one slot to the right.
    - `[>>]` — Move block to the very end.
    - `[-]` — Remove the block from the sequence.
    - `[+]` — Add a new block / duplicate current.
    - **Beats Input:** Adjust how many beats this block spans (e.g., change from 4 to 2 beats).

---

## 3. Data Structure (State)

The frontend `state.sequencer` should look like this:

```js
state.sequencer = {
  masterAudioPath: null,
  bpm: 120,
  blocks: [
    {
      id: "uuid-1",
      path: "/tmp/clip1.mp4",
      beats: 4
    },
    {
      id: "uuid-2",
      path: "/tmp/clip2.mp4",
      beats: 2
    }
  ],
  selectedBlockId: null
};
```

---

## 4. Backend Implementation

### 4.1 Time-Stretching Math

When the user clicks **Render Sequence**, the backend must calculate the absolute time for each block and time-stretch the video to fit.

1. **Beat Duration:** `seconds_per_beat = 60.0 / BPM`
2. **Target Duration (sec):** `target_sec = block.beats * seconds_per_beat`
3. **Source Duration (sec):** Obtained via `ffprobe`.
4. **Stretch Ratio:** `ratio = target_sec / source_duration`

### 4.2 FFMPEG Assembly Pipeline

- **Step 1: Prep clips (Video Only).** 
  Strip the native audio from the video clips to keep it simple (TEMPORARY). Apply the speed change using `setpts`.
  *Expression:* `setpts=(1/ratio)*PTS`
  *Example:* `ffmpeg -i clip1.mp4 -an -filter:v "setpts=(1/ratio)*PTS" -y /tmp/prep_clip1.mp4`
  
- **Step 2: Concatenate.** 
  Use the ffmpeg `concat` demuxer to stitch all the prepped, stretched video clips together into one silent master video.

- **Step 3: Multiplex Audio.** 
  Take the concatenated silent video and combine it with the `masterAudioPath`.
  *Example:* `ffmpeg -i silent_master.mp4 -i master_audio.wav -c:v copy -c:a aac -shortest final_output.mp4`

### 4.3 API Endpoint

**Route:** `POST /ops/sequence-render`

**Payload:**
```json
{
  "master_audio": "/path/to/song.wav",
  "bpm": 120.0,
  "blocks": [
    {"path": "/tmp/clip1.mp4", "beats": 4},
    {"path": "/tmp/clip2.mp4", "beats": 2}
  ]
}
```
*Returns an `OperationResult` with the path to the final assembled mp4.*

---

## 5. Invariants & Rules

- **No Wavesurfer Yet:** Keep the UI strictly DOM-based blocks with HTML/CSS. No canvas waveforms for this MVP.
- **First/Last Thumbs:** Use the existing `/api/thumbnail?which=first|last` endpoint to render the block images (as defined in `video-image-pools-spec.md`).
- **No Native Audio:** Explicitly drop video audio (`-an`) during the render phase to prevent weird pitch-shifting artifacts and simplify the ffmpeg pipeline.

---

## 6. Verification Steps

1. Create a 120 BPM sequence in the UI.
2. Add a video block and set it to 4 beats. (This should equal exactly 2.0 seconds).
3. Add a second video block and set it to 2 beats. (This should equal exactly 1.0 second).
4. Run the sequence render.
5. Verify via `ffprobe` that the final video is exactly 3.0 seconds long and contains the master audio track.
