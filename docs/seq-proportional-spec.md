# Proportional Sequence Tokens

> **Status:** Specification Phase
> **Category:** Frontend

## 1. Overview
Sequence tokens in the Media Pool ("Drop videos here to build a stitch sequence") are currently rendered with uniform widths. This means a 2-second clip and a 30-second clip look identical on the timeline, preventing the composer from visually confirming actual clip durations. This specification introduces proportional sequence tokens where longer clips are allocated wider tokens, giving the user a true sense of the final sequence timing.

## 2. Frontend Implementation

### A. JavaScript (`app/static/js/pool/sequence.js`)
The `renderSequenceBox` function builds the tokens. Currently, tokens (`<span class="seq-token">`) use default flexbox stretching behavior. 

**Logic Updates:**
1. **Pre-computation:** Before rendering, calculate the `total_duration` by summing up the durations of all clips in the sequence. 
   - Clip duration information is already exposed via `seqClipSpeedInfo()`.
   - **Crucial:** Use the *target* duration of the clip (after time-stretching), not the original duration. The token represents the output sequence length.
   - If a clip has an unknown duration (no metadata), fallback to `1.0s` for the math.
2. **Token Resizing:** 
   - For each token, calculate its proportional share: `flex_basis = (clip_duration / total_duration) * 100`.
   - Inject the calculation into the token: `token.style.flexBasis = flex_basis + "%"`.
   - Explicitly set `token.style.minWidth = '60px'` (via JS or CSS) to guarantee the index number remains readable on very short clips.
   - If total duration is unknown/zero, fallback to equal-width splitting.

### B. CSS (`app/static/css/pool.css`)
To ensure smooth UX and handle text wrapping gracefully on tiny tokens:
- Add a transition to `.seq-token`: `transition: flex-basis 0.2s ease-out;`. This ensures that deleting or reordering a clip smoothly rescales the remaining clips.
- Ensure `.seq-token .name` (or the label wrapper) has `overflow: hidden`, `white-space: nowrap`, and `text-overflow: ellipsis` so that narrow tokens neatly crop long filenames.

## 3. Edge Cases & Constraints
- **Single Clip:** Takes up 100% of the sequence box width.
- **Identical Durations:** If 10 clips have equal lengths, they naturally render as equal widths (matching current behavior).
- **Very Short Clips:** A 0.5s clip in a 5-minute sequence would mathematically shrink to almost nothing. The `min-width: 60px` forces it to stay tappable. The text will truncate to `...`, but the index number remains visible, and the hover tooltip still shows full information.
- **Time-Stretched Clips:** If a 10-second clip is speed-ramped to 5 seconds, it must visually occupy a 5-second proportional footprint. 

## 4. Files to Touch
- **NEW:** `docs/seq-proportional-spec.md` (This file)
- **TOUCH:** `app/static/js/pool/sequence.js` (Calculate and apply flex-basis in `renderSequenceBox`)
- **TOUCH:** `app/static/css/pool.css` (Animations, min-widths, and ellipsis rules)

## 5. Acceptance Criteria
- **AC-1:** Given a sequence of 3 clips (2s, 5s, 3s), When rendered, Then token widths are proportionally distributed (~20%, 50%, 30%).
- **AC-2:** Given 10 clips of equal length, When rendered, Then all tokens are equal width.
- **AC-3:** Given a very short clip (0.5s) among long clips, When rendered, Then the token stops shrinking at 60px wide, the index remains visible, and the name truncates with an ellipsis.
- **AC-4:** Given a time-stretched clip, When calculating proportional width, Then the sequence uses the new target duration, not the original.
- **AC-5:** Given an active sequence, When a clip is removed, Then the remaining tokens smoothly rescale over 0.2 seconds.
- **AC-6:** Given the completion of all UI actions, When checking the browser console, Then zero errors are logged.
