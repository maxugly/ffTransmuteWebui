# Sequence Speed Preview Spec

## Problem
When a user alters the `targetDuration` (time stretch) of a video clip in the Sequence tab, the UI shows the new duration and tint (e.g. green for faster, red for slower), but the live video preview in the player does not reflect this change. It continues to play at 1.0x speed. The user needs to see the video play back at the intended relative speed (`native / targetDuration`) when previewing a sequence clip, and the speed needs to update immediately if the duration is altered while playing.

A clip can appear multiple times in the sequence with different speeds, so the logic must resolve the speed for the specific *instance* of the clip selected (`state.pool.selectedSeqId`), not just globally by file path.

## Approach & Target Files

The sequence and preview UI need to apply the HTML5 `<video>.playbackRate` dynamically.

**1. `mtapi-project/app/static/js/preview.js`**
- **Target:** `showPreview(filePath)`
- **Change:** When instantiating the preview video, check if the UI is currently focused on a specific sequence instance (`state.pool.selectedSeqId != null`).
- If so, locate that specific entry in `state.pool.sequence` and calculate its playback rate (`nativeDuration / targetDuration`).
- Set `video.defaultPlaybackRate` and `video.playbackRate` to this speed before mounting. 
- *Constraint:* Standard pool item clicks (where `selectedSeqId` is null or doesn't match) must continue to play at 1.0x.

**2. `mtapi-project/app/static/js/pool/sequence.js`**
- **Target 1:** `seqLoadClip(index, ...)`
- **Change:** When the sequence player is automatically stepping through the sequence, grab `seqClipSpeedInfo(entry).speed` and apply it to the new `video` element's `playbackRate`.
- **Target 2:** `applySeqTokenTimeStyles()`
- **Change:** This function runs every time the duration input changes. It must be updated to push the new speed *live* to the currently playing video. 
- Check if `state.pool.playback.index === idx` (for the active sequence player) or if `state.pool.selectedSeqId === entry.id` (for the static `showPreview` player).
- If there is an active video element in the viewer matching this state, instantly update its `video.playbackRate = speedInfo.speed`.

## Pitfalls & Edge Cases
- **Multiple Instances:** Do not look up the speed by `filePath` alone. Use `state.pool.selectedSeqId` or the explicit sequence `index` to ensure you are grabbing the speed for the exact chip the user is interacting with.
- **Live Updating:** The user expects the speed to change *while* the video is playing if they edit the duration input. The `applySeqTokenTimeStyles()` hook is the correct place to intercept this since it fires on input change, but the DOM queries must safely resolve the current video element without throwing errors if the player is empty or swapped.
- **Audio Previews:** Audio files (`.m4a`, etc.) in `showPreview` also use a `<audio>` or `<video>` tag for playback. Ensure the logic doesn't crash if the preview is audio, though time-stretching audio in real-time preview is a bonus if it works easily.

## Verification Steps (For the Builder)
**Mandatory UI verification before claiming DONE:**
1. Navigate to the WebUI and add a video to the Sequence.
2. Select the sequence chip. The video should load in the preview window.
3. While the video is playing, change the target duration (e.g. cut the time in half).
4. **Assert:** The video immediately speeds up (playbackRate changes).
5. Click "Play" on the sequence transport.
6. **Assert:** The sequence plays back the clip at the correct stretched speed.
7. Click the original video in the main Video Pool.
8. **Assert:** It previews at standard 1.0x speed, ignoring the sequence settings.
