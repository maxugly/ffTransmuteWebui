# Reference table scrolling and cell shading

> Shared scrolling for reference tables; cell shading for TTS, Voice Mod and Listening Models.
> Related: [UI density](ui-density-standard.md),
> [TTS / Voice Mod](tts-voicemod-reference-spec.md),
> [Listening Models](listening-model-reference-spec.md).

## Available space and horizontal scrolling

Tables keep natural content height. The full action-panel workspace remains the
sole vertical scroll owner; no fixed, percentage or viewport-height cap is added.
A native horizontal scroll strip sits underneath the table and sticks to the bottom of
the workspace during vertical scrolling. It hides when all columns fit. It synchronizes both ways with the
table's horizontal scrollbar and supports native dragging and arrow keys.
The model-name column remains pinned with an opaque background so text from
other columns does not bleed through. Wide content stays within the table.

Compact column titles float at the top of the workspace while their table is in view.
Their measured widths and horizontal offset match the original columns. Sorting and
column-toggle controls forward to the original table. Audio titles use .2em/.3em
padding; other titles use 2px/4px padding, with horizontal labels and small gaps.
Video, Image, Coding, APIs, Key Signatures, Music and YT tables use the same helper;
tables retain natural height, including the formerly 60vh-capped Music list.

ResizeObserver updates the strip width when the table, workspace or zoom changes.
Old observations disconnect when the table is replaced. Horizontal position and
the shading toggle are saved separately in each library's existing preferences.

## Shading rules

**Shade cells** defaults on; the toggle and legend appear in the overview. Text
values remain unchanged. HelpStrip descriptions identify the shading reason.
Classification and numeric scales use the complete library, so colors do not
change when search/task filters narrow the rows.

Precedence:

1. Model names and missing values (`-`, en/em dash, N/A, Not supplied,
   Not disclosed, Not published, Unknown, Unspecified) stay neutral.
2. Explicit warning/limitation columns and detected warning phrases are red.
   Phrases include non-commercial restrictions, unverified claims, conflicts,
   deprecated/unsupported/experimental status, bugs and incompatibility.
3. Yes / supported / checkmark states are green; no / unsupported / cross states
   are red; partial/mixed states are blue; conditional/depends states are yellow.
   A warning overrides a positive or conditional state in the same cell.
4. Comparable numeric cells use a linear blue-low → yellow-high spectrum within
   each column and unit group. Larger means larger, not better.
5. Repeated normalized text gets a stable deterministic tint. Matching text has
   the same tint across the full library. Other unique text remains neutral.

Numeric parsing accepts scalars and single ranges with known units. Parameter
suffixes K/M/B/T, byte units, seconds/milliseconds/minutes, frequency units,
percentages, language counts and voice counts are normalized into separate
comparable groups. Ranges use their midpoint. Numbers embedded in prose, model
names, URLs or ISO dates are not extracted for a numeric scale. A constant
numeric group has no invented gradient and may receive a repeated-value tint.
The renderer does not change source records or exports and adds no backend writes.

## Verification

- `./check-gate.sh` before browser checks.
- `node mtapi-project/tests/test_reference_cell_shading.mjs`: actual unit
  conversion, ranges/negative values, incidental-number rejection, state
  interpretation, repetition and warning precedence.
- `mtapi-project/junk/reference-bottom-prove.mjs`: real navigation across nine
  reference tabs, keyboard strip synchronization, bottom/top sticky geometry,
  compact aligned titles, sorting through floating headers and responsive frame
  containment at 480–1920px; zero console/page errors.
- Original shading proof `mtapi-project/junk/reference-shading-prove.mjs`: real navigation, search,
  shading toggle/reload, keyboard horizontal scrolling, sticky strip during
  vertical scrolling, stable filter colors, natural table height, all three
  libraries and no outer overflow from 480–1920px; zero console/page errors.

## Compact model names

All model/provider overview tables use tight first-column padding and two-line
name space. Audio names use a 12em column (144px at 100%), .15em/.2em
cell padding and .1em/.15em borderless button padding, with 1.15 line height.
Parenthetical subtitles start on a second line; full names remain in HelpStrip
attributes. Cards and model detail headings are unchanged. Legacy model columns
are 140px with 1px/3px padding; Image model names receive the same treatment.
API provider names keep 160px so their existing single-line rows do not grow.

`junk/reference-name-density-prove.mjs` compares before/after geometry across
seven model references: every name column is narrower and no row is taller.
Backer renders as “Backer” then “(iZotope Nectar 4)” with the row still 47.8px.
Actual Backer detail click passes; before/after screenshots were inspected.
