# Spec: Unified Speed & Time Tab (Amended v2)

> **Status:** Draft (UI Overhaul)
> **Goal:** Consolidate "Speed" and "RIFE Slo-Mo" tabs into a single, deterministic source of truth for time/speed manipulation.

## 1. The Problem
Currently, "Speed" and "RIFE Slo-Mo" exist as separate tabs or overlap confusingly. Users can set independent variables (FPS, RIFE multiplier, Speed factor) that mathematically conflict. Furthermore, the reporting bar often outputs incorrect final durations (e.g., estimating 2.6s for a 4s video at 0.5x speed). 

## 2. Core Concept: The Target Mode
The tab is anchored by a single primary selector: **Target Mode**. This dictates what drives the underlying math and determines which controls are visible.

### Mode A: Target Length (Duration)
The user defines exactly how long the output video should be (e.g., `10.0` seconds).
- **Inputs shown:** Target Length (seconds).
- **Hidden:** Manual Speed Multiplier knob.
- **Math:** Speed factor is automatically calculated as `Input Duration / Target Length`.

### Mode B: Target Multiplier (Speed Factor)
The user defines the exact speed multiplier (e.g., `0.5x` for half speed).
- **Inputs shown:** Speed Multiplier (0.1x - 10.0x).
- **Hidden:** Target Length input.
- **Math:** Target length is automatically calculated as `Input Duration / Speed Multiplier`.

## 3. RIFE (Interpolation) Integration
RIFE can be toggled **ON** or **OFF** in either Target Mode. 
- **If OFF:** No RIFE-related controls are shown. The speed change relies purely on FFmpeg `setpts`/`atempo` (dropping or duplicating frames).
- **If ON:** RIFE is used to generate intermediate frames for smooth slow-motion.

### The "Snap vs. Free (Extra)" Toggle
When **Target Mode = Multiplier** AND **RIFE = ON**, a secondary toggle appears:
- **Snap (Default):** The Speed Multiplier knob locks into exact valid RIFE multipliers (e.g., 2x, 4x, 8x).
- **Free (Extra):** The user can set an arbitrary speed multiplier (e.g., 0.3x). The system calculates the next highest valid RIFE multiplier (e.g., 4x) to ensure enough frames are generated to cover the mathematical target without duplicating frames.

### The "Keep the Change" Policy (Free Mode Only)
When using "Free (Extra)" mode, RIFE often generates more frames than strictly necessary for the target duration at the native framerate. A new knob determines how to handle these extra frames:
- **Off (Trim to fit):** The default. FFmpeg drops the "extra" interpolated frames to perfectly hit the requested speed/length while maintaining the original video's FPS.
- **FPS (Encode all frames):** Do not drop any generated frames. Maintain the exact requested Target Length, but increase the Final FPS of the output file to squeeze all generated frames into that duration.
- **Length (Encode all frames):** Do not drop any generated frames. Maintain the original video's FPS, but extend the Final Duration (which ultimately alters the exact speed multiplier) to play out all the generated frames smoothly.

*Tooltip for Keep the Change:* "When RIFE generates more frames than needed for your exact speed, choose whether to throw the extra frames away (Off), boost the video's framerate to include them (FPS), or extend the video's duration to play them all (Length)."

## 4. The Real-Time Readout (Source of Truth)
A constantly updating panel below the controls provides the hard math for the final output. It must update strictly on user input change and accurately reflect the calculations, including any ripples caused by the "Keep the Change" setting.

**Always Displayed:**
- **Original Properties:** `Duration: [X]s | FPS: [Y] | Total Frames: [Z]`
- **Target Properties:** `Final Duration: [X]s | Final FPS: [Y]` *(These will dynamically adjust if 'Keep the Change' is set to FPS or Length).*
- **Exact Multiplier:** The precise calculated speed multiplier (whether set manually, derived from Target Length, or altered by Keep the Change: Length). Example: `Exact Speed: 0.5x`
- **Target Total Frames:** Exactly how many frames will be encoded into the final file.

**Displayed ONLY when RIFE is ON:**
- **Required RIFE Multiplier:** The native RIFE multiplier chosen by the system (rounded up to the next valid step if necessary). Example: `RIFE Multiplier: 4x`
- **Generated Total Frames:** The actual number of frames the RIFE pass will physically create. Example: `Generated Frames: 480`
- **Extra Frames Action:** A brief readout confirming what happens to the overage (e.g., `(Dropping 80 extra frames)` or `(Encoding all 480 frames)`).

## 5. UI Layout Example
```text
[ Speed & Time Tab ]

Target Mode: ( ) Length   (*) Multiplier
Speed Multiplier: [===========O======] 0.3x

RIFE Interpolation: [ ON ]
Mode: ( ) Snap to RIFE multipliers   (*) Free (Extra frames)
Keep the Change: (*) Off   ( ) FPS   ( ) Length
RIFE Model: [ rife-v4.6 ]

------------------------------------------------
REAL-TIME OUTPUT READOUT
Original: 4.00s @ 30 FPS (120 frames)

Exact Speed: 0.3x
Final Duration: 13.33s
Final FPS: 30 FPS
Target Total Frames: 400 frames

Required RIFE Multiplier: 4x
Generated Total Frames: 480 frames
(Dropping 80 extra frames)
------------------------------------------------
```
