> **Archive — not law. STATUS.md is where we are now.**

### 000.000.8.115 — Sequence & Media Pool View Resizable Split Fix
- Root Cause & Layout Fix:
  - Fixed issue where media output preview was frozen and did not resize when dragging the divider in Sequence view: `.app-content.pool-workspace` in `pool.css` had `grid-template-columns: minmax(0, 1.65fr) minmax(0, 0.7fr) !important;`. The `!important` rule completely blocked inline styles from `setupPanelResize()`'s `content.style.gridTemplateColumns`, leaving the columns static at 70/30 while the divider line moved.
  - Removed `!important` from `pool.css` line 533 and moved `!important` into the `<= 1100px` media query (line 1538) where preview is collapsed.
- Independent Workspace Splits & Smooth Drag:
  - Upgraded `setupPanelResize()` and `switchTab()` in `app.js` to manage independent workspace splits:
    - Standard tool tabs use `localStorage['mtapi_panel_split']` (default ~59%/41%).
    - Pool / Sequence / Images tabs use `localStorage['mtapi_panel_split_pool']` (default ~70%/30%).
  - Updated divider drag handler to update columns smoothly in real-time, save the split per active mode on pointer up, and reposition the divider line on tab switch and window resize.
  - In `index.html`, bumped `main.js?v=5` to `?v=6`.
- Verification:
  - `./check-gate.sh` passed 5/5 green.
  - 19/19 pytest unit tests pass.
  - Playwright live verified on `:24590`: dragging divider in Sequence view smoothly resizes media preview (476px → 779px), tab switching between Datamosh and Sequence preserves each mode's custom split without drift. Proof screenshot saved in `mtapi-project/junk/sequence_resize_proof.png`.

### 000.000.8.114 — Ultra-Dense Comments Layout, Exact Dates & Chronological Sorting
- Timestamp & Date Storage:
  - Verified yt-dlp stores Unix epoch timestamps (`timestamp`, integer in seconds) in comment objects, even when relative `time_text` strings are absent.
  - Updated `routes/comments.py` to parse and serialize `timestamp` as an `int` for all parent threads and child replies.
  - Implemented `_formatCommentDateTime(timestamp, timeText)` in `js/tabs/comments.js` formatting human-readable localized dates (`Oct 5, 2026 06:00 AM`) and hover tooltips (`title` with full timestamp) on both top-level comments and replies.
  - Added true chronological sorting options `Newest (Date ↓)` and `Oldest (Date ↑)` sorting accurately down to the exact second.
- Ultra-Dense UI Redesign:
  - Addressed user feedback regarding vertical space waste and high padding/margins.
  - Redesigned `css/comments.css` with a tight, high-density layout:
    - Reduced `.comments-feed` gap from 12px down to 3px.
    - Reduced `.comment-card` padding from 12px 16px down to 4px 8px, with 2px gap (saving over 20px of vertical space per comment).
    - Reduced `.comment-reply-item` padding from 8px 12px down to 3px 6px.
    - Reduced `.comment-replies` left margin and padding to 10px / 8px with 2px gap.
    - Tightened top control bar height to 26px and voting buttons to compact 9px widgets.
  - 13–15 comments and replies now comfortably fit on screen simultaneously above the fold.
- Verification & Proof:
  - `./check-gate.sh` passes 5/5 green.
  - All 19 pytest unit tests in `test_comments_routes.py` and `test_ytdlp_ops.py` pass.
  - Playwright live verified on `:24590`: sorting by Newest/Oldest verified with exact second timestamps; collapse/expand all verified; proof screenshot saved in `mtapi-project/junk/comments_dense_dates_proof.png`.

### 000.000.8.113 — Return YouTube Dislike (RYD) & Interactive Reddit-Style Comment Voting
- Integrated Return YouTube Dislike (RYD) API:
  - Backend endpoints `GET /api/ytdlp/ryd?video_id=...` and `GET /api/comments/ryd?video_id=...` using non-blocking async `httpx` with 1-hour in-memory TTL caching and graceful fallback (Invariant 10).
  - Calculates likes, dislikes, 5-star rating, and like ratio percentage.
  - Video Stats Banner in Comments Tab: `#commentsRydBadge` displaying video likes (`👍 87.5K`), dislikes (`👎 1.5K`), like ratio (`98.3%`), and visual ratio progress bar.
  - yt-dlp Downloader Probe Card: added `.ytdlp-ryd-badge` beside video views and likes showing live dislikes and like ratio percentage upon probe.
- Built interactive Reddit-style comment voting:
  - Each comment and reply now features a voting widget: `▲` upvote button, formatted compact net score, and `▼` downvote button.
  - Session voting state: clicking upvote increments score (+1, orange `#f97316`), downvote decrements score (-1, indigo `#818cf8`), re-clicking toggles vote off back to base score.
  - Top sort dynamically factors in user votes (`effective_score = base_likes + user_vote`).
- Container fix:
  - Targeted `#actionPanelForm` in `renderCommentsForm()` so tab navigation preserves the `#actionPanel` outer shell across all tabs.
- Tests & Verification:
  - Added unit test `test_comments_ryd_route` in `tests/test_comments_routes.py`. All 19 tests passing.
  - `./check-gate.sh` passes 5/5 green.
  - Playwright verified on `:24590` with real clicks across both tabs (RYD badges displayed, interactive upvote/downvote tested on parent and reply cards, zero console errors). Proof screenshots: `junk/comments_ryd_voting_proof.png`, `junk/ytdlp_ryd_proof.png`, and `junk/comments_downvotes_verified.png`.

### 000.000.8.112 — Reddit-Style Threaded Comments Viewer Tab + Video Pool Integration
- Built dedicated "Comments" viewer tab in Library navigation section:
  - 2-level Reddit-style hierarchy: parent comment cards, vertical left rail collapse guides, indented reply trees, `📌 Pinned` and `Creator` badges, and formatted like counters.
  - Interactive thread controls: per-thread `[-]`/`[+]` toggles with collapsed summary pills (`[+] @author · N likes · N replies (click to expand)`), master "Collapse All" / "Expand All" buttons.
  - Search & Sorting: live text and author filtering; sorting by Top (Most Likes), Newest First, Oldest First.
  - Efficient rendering: 50-thread incremental pagination with "Load More Threads" button to keep UI responsive even with 8,000+ comments.
  - Auto-discovery & File picker: backend scans `~/Downloads` for `*.comments.json` and `*.info.json` files; plus manual file picker modal support.
  - Inter-tab links: "💬 View Comments" button on yt-dlp probe card and post-download cards; "💬 View Comments…" in Video Pool card right-click context menu.
  - Responsive design: zero horizontal scroll adhering to Invariant 2 and 8.109.
- Backend additions:
  - `app/routes/comments.py`: `GET /api/comments/files` and `GET /api/comments/data?path=...`.
  - Registered router in `app/main.py`.
  - Preserved `parent`, `is_pinned`, and `author_is_uploader` flags in `app/operations/ytdlp_ops.py`.
  - Whitelisted `comments_json_path` in `app/media/pool.py`.
- Tests & Verification:
  - Created `mtapi-project/tests/test_comments_routes.py` (4 unit tests, all passing).
  - All 18 pytest tests pass across `test_ytdlp_ops.py` and `test_comments_routes.py`.
  - `./check-gate.sh` 5/5 green.
  - Playwright verified live on port 24590 with real clicks across 8,188 comments (collapse/expand, search, sort, load more, source switching, zero console errors). Proof screenshots: `junk/comments_tab_proof.png` and `junk/comments_tab_collapsed.png`.

### 000.000.8.111 — yt-dlp Auto-Extracted `.comments.json` Sidecar & Comments Diagnosis
- Investigated and resolved user comments troubleshooting issue:
  - Root-caused why user's `readable_comments.json` and `.info.json` were 0 bytes: at 14:43, a shell pipeline with nonexistent input (`cat comments.json | jq '.comments' > '<title>.info.json'`) truncated the `.info.json` to 0 bytes via shell redirection `>`; also during the original media download at 14:50, the comments checkbox was left unchecked.
  - Re-fetched metadata and comments on demand for `ujkD4SxPKOI` into `~/Downloads`, populating both the full `.info.json` (689KB) and generating the user's `readable_comments.json` (21.8KB, 100 comments).
- Auto-extract clean `.comments.json` sidecar:
  - In `app/operations/ytdlp_ops.py`, whenever comments are extracted, the system now automatically parses and writes a clean, formatted companion `<title> [<id>].comments.json` containing `{author, text, like_count, time_text, timestamp, id}` directly next to the media file. Users no longer need to manually parse the giant `.info.json` using `jq`.
  - Added `comments_json_path` to `source_meta` detection and recorded it alongside `info_json_path`.
  - In `app/media/pool.py`, whitelisted `comments_json_path` in `_normalize_source_meta`.
- Gate & tests: `./check-gate.sh` 5/5 green; 14/14 unit tests pass in `tests/test_ytdlp_ops.py`.

### 000.000.8.110 — yt-dlp Subprocess Stream Buffer Fix & Invariant 10 Enforcement
- Fixed download failure `Unexpected token 'I', "Internal S"... is not valid JSON`.
- Root cause: yt-dlp streams download progress lines separated by `\r` (carriage return) rather than `\n`. Python's `asyncio.StreamReader.readline()` looks exclusively for `\n` and has a default buffer limit of 64KB (`65536` bytes). When downloading larger streams, the unconsumed `\r`-separated lines exceeded the 64KB buffer, throwing `asyncio.exceptions.LimitOverrunError: Separator is not found, and chunk exceed the limit`.
- In `app/operations/ytdlp_ops.py`:
  - Added `--newline` flag to both `build_ytdlp_argv` and `build_ytdlp_comments_argv`.
  - Replaced `_read_stream`'s `stream.readline()` with a chunked buffer reader (`await stream.read(8192)`) that splits on either `\r` or `\n` and normalizes progress lines, cleanly reporting real-time progress to `report_progress()`.
  - Set `limit=1024 * 1024 * 16` (16MB) in `asyncio.create_subprocess_exec`.
  - Wrapped `ytdlp_download` with comprehensive exception handling returning `OperationResult(ok=False, error=str(e))`.
- In `app/op_runner.py`:
  - Fixed unhandled exception branch in `run_registered_op`: replaced re-raising `raise` with `result = OperationResult(ok=False, operation=spec.id, error=str(e) or "Operation failed", dry_run=False)` to strictly enforce Invariant 10 (`failures are HTTP 200 + {"ok": false}`).
- In `app/static/js/tabs/ytdlp.js`:
  - Added defensive `res.ok` check before `res.json()` with clear error extraction, preventing unhandled HTML 500 syntax errors in the WebUI.
- In `mtapi-project/tests/test_ytdlp_ops.py`:
  - Added `test_ytdlp_carriage_return_stream_handling` unit test verifying that 150KB of carriage-return separated stream progress without newlines (4,000 updates) processes smoothly without buffer overruns. All 13 unit tests passing.
- Gate & UI proof: `./check-gate.sh` 5/5 green; Playwright-verified with live YouTube video download on :24590: media successfully downloaded, thumbnail generated, registered in Video Pool, and completed status displayed in the UI without any console or parse errors. Proof screenshot: `mtapi-project/junk/ytdlp_download_success.png`.

### 000.000.8.109 — Responsive Autowrap Tiles & Zero Horizontal Scroll
- Eliminated horizontal scrolling and fixed card autowrapping across all viewports and divider positions.
- In `layout.css`, removed hardcoded pixel minimums from `.app-content` (`minmax(560px, 1.45fr) minmax(340px, 1fr)`) that caused horizontal blowout on narrower monitors; made columns fluid with `minmax(0, 1.45fr) minmax(0, 1fr)`, `width: 100%; max-width: 100%; min-width: 0; overflow: hidden;`.
- Removed accidental 180-line duplicate block of layout CSS in `layout.css` lines 726–906 that had redundant `.app-content` and `.global-inputs-panel` declarations.
- Hardened `.action-panel` and `.action-panel-form` with `min-width: 0; max-width: 100%; overflow-x: hidden; box-sizing: border-box;`.
- Added `min-width: 0; max-width: 100%;` to `main` container in `layout.css` and `overflow: hidden; width: 100%; height: 100%;` to `html` in `base.css` to prevent root-level overflow.
- In `app.js` (`setupPanelResize`), migrated divider drag and localStorage persistence from rigid pixel strings (`${newLeftW}px ${rightW}px`) to fluid percentages (`minmax(0, ${leftPct}%) minmax(0, ${rightPct}%)`). Added auto-migration for legacy pixel values in `localStorage['mtapi_panel_split']`.
- In `ytdlp.css` and `forms.css`, applied `min-width: 0; max-width: 100%; box-sizing: border-box;` to `.ytdlp-workspace`, `.ytdlp-top-bar`, `.ytdlp-banks-grid`, `.ytdlp-bank`, `.ops-grid`, and `.card`, allowing cards to naturally reflow across 4, 3, 2, or 1 columns depending on available width.
- Gate 5/5 green; 12/12 unit tests in `test_ytdlp_ops.py` green; verified in Playwright at 1024x768 and 1400x900 viewports with preview open and collapsed, confirming `scrollWidth === clientWidth` (0px horizontal overflow) and natural 4→3→2→1 column autowrapping. Proof screenshots: `mtapi-project/junk/ytdlp-autowrap-responsive.png` and `mtapi-project/junk/ytdlp-autowrap-1024.png`.

### 000.000.8.108 — yt-dlp Comments Decoupled into Separate Post-Media Pass
- Decoupled video comments extraction from the primary media download pass per user request.
- Media pass (`build_ytdlp_argv`) omits `--write-comments` so video/audio streams, subtitles, thumbnails, description, and base metadata download and write to disk immediately without getting blocked or throttled by comment pagination.
- Follow-up comments pass (`build_ytdlp_comments_argv`) runs as a dedicated second stage after media download finishes, using `--skip-download --write-comments --write-info-json` and an optional `youtube:max_comments` ceiling (default 100) to safely populate the `.info.json` sidecar.
- If comment scraping encounters YouTube rate limits or dropped reply threads (`Incomplete data received`), it logs a warning without aborting or failing the already-saved media file.
- UI (`js/tabs/ytdlp.js`): Updated Bank 4 checkbox to `Comments (after media)` and added `#ytdlpMaxComments` input field.
- Gate 5/5; 12/12 unit tests passing in `tests/test_ytdlp_ops.py`. Playwright live-verified on port 24590 with console drawer proof of two-stage decoupled execution. Proof screenshot: `mtapi-project/junk/ytdlp-comments-separated.png`.


### 000.000.8.107 — Global 2-column card flow + full horizontal control stretch
- Responsive multi-column layout default across the entire app whenever room permits.
- Action panel workspace split default updated from cramped 1.2fr (54%) to `minmax(560px, 1.45fr)` in `layout.css`, opening ~59-60% horizontal width by default so cards naturally flow into two columns on standard desktops without requiring manual divider adjustment.
- In `ytdlp.css`, removed artificial centering (`margin: 0 auto`, `max-width: 1300px`, double-padding) that starved 156px of horizontal space; lowered grid minimum to `minmax(min(270px, 100%), 1fr)`; stretched all controls inside cards (`.ytdlp-row select`, `text-input`, `.button-group`, `.ytdlp-timerange-inputs`) to `flex: 1` / `width: 100%` so they occupy the full card width instead of sitting collapsed on the left.
- In `settings.css`, `.settings-workspace` converted to a responsive CSS grid (`minmax(min(270px, 100%), 1fr)`) with `settings-lede` spanning full width and `.settings-card` width max-content removed to fill grid tracks (reflowing into 4→3→2 columns).
- In `forms.css`, `.ops-grid` and general `.card` updated to responsive auto-fill grids with 100% width. Standardized `.dart-cards` (`dart.css`), `.cut-frames-grid` (`pool.css`), `.zp-frames-grid` (`zoompan.css`), and `.ref-music-grid`/`.ref-grid-2col`/`.ref-split` (`references.css`) to `repeat(auto-fit, minmax(min(270px, 100%), 1fr))`. Protected `.pool-workspace` grid with `!important` so divider drag styles do not interfere with pool layouts.
- Gate 5/5. Playwright-verified live on port 24590 at 1440x900: yt-dlp option cards immediately form 2 columns with controls filling horizontal card space; Settings cards flow into 4 columns; Cut, ZoomPan, Dart, and References multi-column grids confirmed clean without console errors. Screenshots `junk/ytdlp-two-cols-final.png` and `junk/settings-columns-proof.png`.


### 000.000.8.106 — yt-dlp Media Downloader Tab, Extended Metadata & Pool Sorting
- Implemented full-featured yt-dlp media downloader tab based on Seal ([junkfood02/Seal](https://github.com/junkfood02/Seal)) with time-range clipping (`--download-sections "*START-END"`), subtitles (`--write-subs`, `--write-auto-subs`, `--sub-langs`), live chat replay (`.live_chat.json`), description (`--write-description`), comments (`--write-comments` into `.info.json`), thumbnails, sponsorblock, multi-threading, aria2c, proxy, browser cookies, and IPv4 flags.
- Backend: `app/operations/ytdlp_ops.py` (`YtdlpParams`, `build_ytdlp_argv`, `ytdlp_download`, progress reporting via `report_progress()`, and `OperationSpec("ytdlp")`); `app/routes/ytdlp.py` with `GET /api/ytdlp/version` and `GET /api/ytdlp/info?url=...` with `--dump-single-json` and Node.js v22 runtime hint (`--js-runtimes node`).
- Multi-site URL watcher records extractor/site and `is_youtube` flag across 1,700+ extractors so non-YouTube platforms can still be sorted and filtered by site.
- Extended metadata: `source_meta` dictionary whitelisted and preserved in `app/media/pool.py` and `app/media/cache.py`; hydrated and displayed as author/platform badges in `pool/persistence.js`.
- Video Pool search & sorting: added `#poolSortMode` select (Added, Date ↓/↑, Author A–Z, Site A–Z, Title A–Z, Duration ↓/↑, Size ↓) and enhanced search to match against site, author, channel, title, tags, and publish date.
- Frontend: `js/tabs/ytdlp.js` and `css/ytdlp.css` providing interactive probe card with stream resolution pills, 6 categorized options banks, dry run preview, and post-download ingest wiring (`add_to_pool`, `send_to_media_in`, `add_to_sequence`).
- Test suite & gate proof: `./check-gate.sh` 5/5 green; 10/10 pytest unit tests in `mtapi-project/tests/test_ytdlp_ops.py` green; Playwright-proven on port 24590 with live clicks (tab navigation, YouTube probe with metadata/thumbnail/streams, dry run command generation with all options, and Video Pool sort dropdown repainting cleanly). Screenshots saved to `mtapi-project/junk/ytdlp-tab-proof.png` and `mtapi-project/junk/pool-sort-proof.png`.

### 000.000.8.101 — Preview send replaces the Media In box (no append)
- User's correction to `8.100`, caught by using it: clicking **→I-in** twice left the box holding *two* paths concatenated (`…_dream_0002.png` + `…_dream_0001.png`) — append-if-missing plus dedup means the first entry is never dropped and the box can never get back to a single file. Console read `Sent to Media In → …_0001.png` then `Already in Media In → …_0001.png`, which is the append behavior announcing itself.
- Semantics: the preview shows exactly **one** file, so sending it means "this is the input", not "one more of a batch". `gi.value = path` + `input` dispatch — identical to what the pool send targets have always done (`items.js` cut → global video, image-pool sends), so the preview button is finally consistent with them.
- Console honesty instead of silent clobber: `Replaced Media In (N path[s]) → <path>` when something was overwritten (count, not the whole old string — a 12-file batch would flood the terminal), `Media In already this file → <path>` on a true no-op re-click, plain `Sent to Media In → <path>` when the box was empty. Guards kept: real-preview-only, empty-path no-op.
- Help title now leads with "Replace the global Media In path with this file" instead of "Send this file to…".
- Proof: `./check-gate.sh` 5/5, then Playwright on live :24590 with real clicks — typed a 3-path batch into Media In, previewed a *different* image (Image Pool → Send to ▾ → Preview), clicked `→I-in` → box collapses to that one path, mode flips video→image (`globalInputs.video` cleared, `image` set, purple `media-mode-image` on textarea + `I` button), log `Replaced Media In (3 paths)`; re-click → `already this file`, box unchanged; then a Video Pool → Preview only → `→I-in` → flips back to orange `media-mode-video`, fresh probe overlay `[ 768x768 | 2320 frames ]`, frame-range row returns; 12 console errors, all pre-existing `/api/thumbnail` 404s. Screenshot `junk/preview-iin-replace.png`; Media In cleared back to empty.
- Operational note: `/app.js` is imported unversioned by every module and the static route sends no cache headers, so a browser that ran `8.100` keeps the append build until a hard reload (Ctrl+Shift+R). The versioned-specifier convention (`knobs.js?v=5`, `main.js?v=4`) does not cover `app.js` at all — a real gap for anyone iterating on `app.js`.
- Note for the next session: the same 8.098 id drift still lurks in 43 places across 13 files (43 `giVideo`/`giImage`/`giPathIn`/`giPathOut` references — `app.js`, `js/tabs/{deepdream,cut,zoompan,erase,watermark,scripts,qr}.js`, `js/pool/{persistence,image-pool,items}.js`, `js/frame-scrubber.js`, `js/ui/input-preview.js`; heaviest are `deepdream.js` 6, `app.js` 5, `cut.js` 4, `persistence.js` 4, `frame-scrubber.js` 4, `image-pool.js` 2). Each is dead-but-guarded, so the UI degrades quietly instead of erroring. Not fixed here — out of scope for this button.

### 000.000.8.100 — Preview send collapses to one button on the unified input
- User's call: with the input unified (`8.098`), the preview bar's **→V-in** / **→I-in** pair should be one button that just sends whatever is previewing to the input path.
- Both old buttons had been **silently dead since `8.098`**: `sendPreviewToGlobal(kind)` resolved `giVideo`/`giImage`, the two ids the recovered unified bar deleted, so both `?.`-guarded listeners fired and bailed at `if (!gi) return`. Nothing in the 8.098 port caught it because the dead references are runtime `getElementById` lookups, not imports — the gate is blind to them by design, and the button pair renders and clicks either way.
- Fix: one button `btnPreviewToInput` (**→I-in**, help title names the unified target), and `sendPreviewToGlobal()` loses its `kind` argument — append-if-missing dedup onto `giMediaIn`, `input` dispatch, console line `[PREVIEW]: Sent to Media In → <path>` (or `Already in Media In`). Extension routing is now the 8.098 mode engine's single source of truth (`globalInputs.video`/`image`/`audio`/`pathIn` + `media-mode-*` coloring), so the button has no type knowledge at all. Guards preserved: real-preview-only (`mediaInfo` hidden → no-op), empty path → no-op.
- Proof: `./check-gate.sh` 5/5, then Playwright on live :24590 with real clicks — Image Pool card → Send to ▾ → Preview → click `→I-in` → path in `giMediaIn`, `globalInputs.image` set, purple `media-mode-image` on textarea + `I` button, `populated` panel; ✕ clear → Video Pool card → Preview only → click `→I-in` → `globalInputs.video` set, orange `media-mode-video`, live overlay `[ 768x768 | 2320 frames ]`; re-click → `Already in Media In`, still 1 line; second video card → appended as line 2, both lines in `globalInputs.video`; 27 console errors, all pre-existing (26 `/api/thumbnail` 404s + favicon). Screenshot `junk/preview-single-iin-button.png`. Media In cleared back to its pre-proof empty state.
- Note for the next session: the same 8.098 id drift still lurks in 43 places across 13 files (43 `giVideo`/`giImage`/`giPathIn`/`giPathOut` references — `app.js`, `js/tabs/{deepdream,cut,zoompan,erase,watermark,scripts,qr}.js`, `js/pool/{persistence,image-pool,items}.js`, `js/frame-scrubber.js`, `js/ui/input-preview.js`; heaviest are `deepdream.js` 6, `app.js` 5, `cut.js` 4, `persistence.js` 4, `frame-scrubber.js` 4, `image-pool.js` 2). Each is dead-but-guarded, so the UI degrades quietly instead of erroring. Not fixed here — out of scope for this button.

### 000.000.8.098 — Unified Media In/Out bar: recovery + ship
- The global-inputs rework the user lived on for a full day (I/O-only header + color-coded unified media inputs + audio support) was never in git — it existed only as uncommitted working-tree code Sep 17–20 and was silently reverted at 2026-09-20 21:26 by the Hover-Help session's final patch (the one that dedicated ec9f693), so the Sep 22 sidebar fix and every commit since rode on the already-reverted 4-row file.
- Recovery path: opencode's own `opencode.db` (`part` rows of `type=patch` carry tree hashes) + the snapshot store at `/home/m/.local/share/opencode/snapshot/9907001e75832f4f3f633027d05df7fd26624cb9/` (bare git repo, one tree per patch). Six consecutive trees from Sep 20 21:16–21:25 hold the mature panel; `fbc7712498827fa02afe5ce8761db026d3cdcd6b` (21:25) is the last unified state; `c8b06725…` (21:26) is the revert. Full static harvest → `/tmp/opencode/recover/` + isolated diffs (`index.html.diff` 8 hunks, `app.js.diff` 11, `layout.css.diff` 2). Only those three files differed beyond HEAD-side `?v=` bumps / settings drift — tab files were byte-identical, confirming consumers were always guarded.
- Ported onto HEAD surgically (HEAD keeps sidebar un-nest, final help-strip CSS, settings grid): header 4 buttons → `btnQuickI`/`btnQuickO`; four rows → two-row `mediaIn`/`mediaOut` panel with hidden frames row; `updateGlobalInputs` extension routing + `updateStatusIndicators` `⚠ Type mismatch` + `syncGlobalPanelVisibility` I/O active-states + quick-button/input listeners; `globalInputs.audio`; `.media-mode-*` orange/green/purple blocks.
- Verified: `node --check` clean, gate 5/5, Playwright on live :24590 — `.mp4`→orange/`giVideo`, `.wav`→green/`giAudio`, `.png`→purple/`giImage`, dotless→`pathIn`, `.mkv` out→`pathOut`+`media-mode-video`, real `I` click opens the "Select File or Folder" picker, zero new console errors (only favicon + fake-path probe 404s).

### 000.000.8.093 — Settings tab: knob-law + knob-sensitivity engine
- Settings' own Knob Sensitivity card was the one place that broke the everything-is-a-knob rule (native selects / hand-rolled markup). Rebuilt on the standard system: `knobUnitHtml` + `setupContinuousKnob` for Bot curve / Mid setpt / Top curve / Ceiling (curves are 0/1/2 indexes with a `format` display; mid 1–500, ceiling 101–999, both ⟲-resettable and editable). Thumbnail / Autosave / Scrollbar knobs converted to `knob-unit` bricks too.
- `knobs.js` sensitivity engine is now settings-aware: `getSensX`/`getSensFromX` read `knobBotCurve/knobMidSet/knobTopCurve/knobMax` from `window.state.settings` with a `localStorage['mtapi.settings']` fallback (500 ms cache), and horizontal drag clamps at the configured ceiling (default 125%) instead of the old hardcoded 300% — the granular-drag ask.
- `setupContinuousKnob` now fires `opts.onChange` at every commit (mouseup / wheel / text-submit / ⟲ reset) alongside the `change` event; it was previously never called, which had silently broken the scrollbar-width knob's save path (onChange was the only wiring).
- Caught live: `bindSwitch` was invoked before its `const` declaration in `renderSettingsForm` — a TDZ ReferenceError that aborted the render wiring, so NONE of the Settings switches (import toggles, VFR, op outputs, warm models, restore session, Duke Nukem) ever bound. Fixed by hoisting the declaration.
- Settings workspace is a wrapping grid (`repeat(auto-fill, minmax(320px,1fr))`, lede spans full row) — cards reflow 3→2→1 columns across window widths; dead `.settings-discrete-knob` CSS removed.
- Cache-busts: all 25 importers `knobs.js?v=4`→`?v=5`; app.js settings import `?v=2` (static route sends no cache headers — stale-JS bites before).
- Playwright-proven on live :24591: knob card renders as 4 knob-units with reset buttons; Ceiling typed 200 → state+localStorage persisted; real drag shows the sens tooltip tracking the piecewise curves (15.8% far-left, 152% far-right, clamped ≤ ceiling) and commits value+persist on release; ⟲ reset round-trips 293→125; curve wheel log10→log2→log10 persisted; restore-session toggle round-trips off/on; Duke Nukem confirm → localStorage wiped → reload; grid reflow at 1600/1100/800/500px; mosh-tab knob drag regression-clean (classic `change`-listener path); zero new console errors.

### 000.000.8.069 — Watermark tab (Clean section, V1)
- New `Clean` nav section + `Watermark` tab: vendored `gemini-watermark-remover` at pinned tag `v1.0.43` (commit `e9ba84d`, `mtapi-project/tools/gemini-watermark-remover/`, npm prod-install + `sharp` for the CLI file path; `node_modules` inside the vendored dir, git-ignored). Reverse-alpha file-to-file removal (image+video), not filter-platform.
- Backend `app/operations/watermark_ops.py` (5 ops): `watermark_remove` (argv `node gwr remove --output --json` + overwrite + video bitrate/timeout flags; default `<stem>_clean`, no-clobber refusal, dry-run, exists+non-empty verify, `applied/decisionTier/skipReason` meta), `watermark_detect` (read-only readout; upstream CLI has no probeless mode so it runs `remove --json` into a temp file, parses the tier, deletes it — spec deviation documented in-module), `metadata_inspect` (ffprobe + Pillow EXIF + exiftool-if-present), `metadata_strip` (video `-map_metadata -1` remux / image Pillow re-save), `watermark_setup` (clone-or-fetch-checkout pinned tag + prod-install, cancel-safe, ends with fresh status + `recommend_restart:false`). New `GET /api/watermark/status` (`routes/watermark.py`); `shell.check_tools()` gains warn-only node/npm rows. Failures HTTP 200 + `ok:false`.
- Frontend: `js/tabs/watermark.js` (installer card with live status + Install/Update/Refresh, engine dropdown with disabled `general-ai`/`synthid-detect` placeholders, Overwrite/Dry-run knobs, bitrate 4–40 knob, timeout text, Remove/Detect/Inspect/Strip, `tool-docs` with verbatim limits); `TAB_ACCEPTS.watermark='any'`, global-Run maps to `watermark_remove`. 27 new tests (`tests/test_watermark.py`: argv/validation/dry-run/meta-parse/missing-tool hints/real inspect+strip fixtures/shell guard), 234 pytest green.
- Live-proven with real Playwright clicks on isolated :24591: Clean→Watermark renders, status `node v22.23.1 · gwr v1.0.43 @ e9ba84d · sharp ok · npm`, Detect on clean PNG → `found=false tier=insufficient (no-watermark-detected)`, Remove → real 7013-byte `*_clean.png`, Inspect → tag JSON, dry-run echoes command + writes nothing, zero console errors.

### 000.000.8.068 — Sequence Conform + copy Stitch
- Opt-in Sequence Conform cache-fill (default Off): `CONFORM_PRESETS` (`h264_avc_hq` default, `h265_hevc`, `dnxhr_hq`, `prores_hq`; WebM/AV1/FFV1/proxies excluded) in `convert_presets.py` with `ENCODE_PRESETS` still the sole codec recipe. New `conform` op (`operations/conform_ops.py`): validated `ConformParams`, absolute-path enforcement, signature-bearing sibling names beside the source, one-encode geometry+fps+baked-timing/audio via `video_pipeline.conform_clip()`, `kind="conformed"` registration, HTTP-200 `ok:false` failures.
- `video_pipeline.py`: `probe()` merges copy-gate metadata best-effort; new `probe_copy_info()`, strict `can_concat_copy()` (all §9 video/audio fields + missing/stale/signature/preset/unbaked/VFR/cut/allow-list rejections, first-failing-clip reasons), `conform_clip()`, `conform_signature()`/`is_conform_signature_valid()`, absolute escaped `write_concat_list()` + `run_concat_copy()` (no re-encode, progress `stitch copy K/N`); `_run_concat_single`/`concat_clips` take optional `encode_preset` (fallback keeps the neutral intermediate + preset transcode so DNxHD/ProRes never lands in MKV).
- `transmute_ops.py` `JoinParams` gains `conform_enabled/mode/aspect/preset/target_fps/audio_policy`; `join()` runs RIFE-first then `_join_conform_path()` (canvas from shared helpers, missing/stale conforms generated with progress, gate, copy or preset-driven re-encode with `requested==conform` eligibility, copy-failure retry via re-encode); results carry `meta.stitch_mode/copy_reason/conformed/reencoded/conformed_paths/signatures`; legacy/preset paths report `re-encode` meta.
- Frontend: Conform block in the sequence bar, `sequence-conform.js` (badges, stitch prediction, stale-invalidation, armed-gate auto-conform hook after RIFE), composer badges + adopt-on-stitch (immediate save), persistence round-trip, variant menu separation, `pool.css` teal badges; phases render through the generic job UI; Stop cancels via `check_cancelled`.
- Persistence fixes found by proof: `pool.py` keeps `conformed_path/signature/status` + conform settings; `cache.py` references conformed paths; `catalog.py` `_membership_sequence` allow-list (the file had the paths but catalog GET pruned them — adopt/save/load silently lost them).
- Tests: `test_concat_copy_gate.py` (every gate field + policy), `test_conform_ops.py` (allow-list/validation/signatures), encode conform-fragment + concat-list + preset-audio legs, join copy + mismatched-preset-fallback + dry-run legs. 207 pytest green.
- Playwright 23/23 with real clicks on isolated :24590 (`/tmp/opencode/conformproof/proof.py`): defaults off/plain stitch, controls expose, reload = no storm + disarmed, copy executes (`all streams match`), siblings created + originals kept + adopted, named save/load round-trip, duration change → re-encode with precise reason, audio-mismatch fallback with reason, Stop safe, zero page errors. Proof debugging also documented two harness ghosts (stale-union autosave races, empty-session project fallback) — solved with verified seeds + fresh browser per phase, no product change.

### 000.000.8.067 — Stateful tabs: pool/sequence/images never destroy DOM
- Phase 1 of the stateful-tabs spec: `pool`, `sequence`, `images` each mount once into a permanent `tab-root` (`tabRoot-pool` etc) child of `#actionPanelForm`. Switch = hide old + show visited; no `innerHTML=''` on cached tabs, so scroll, inputs, selection highlights, variant/RIFE badges, wall tenants and canvas/iframe instances persist exactly. Builder's calls recorded: pool root owns toolbar+grid, sequence root owns `poolVResize`+composer; sequence view shows BOTH roots stacked (pool above composer) so no id exists twice and no binder needed re-scoping; canonical DOM order (pool before sequence) enforced on every attach; uncached tabs keep the legacy destroy path but detach cached roots into a module-held Map while uncached content owns the panel (reconciles §7 “roots never detached” with §8 “uncached destroy path unchanged”).
- Form-state: `captureAllMountedFormState()` iterates `mountedTabRoots()` (attached + held, reads never measurements) with the same `FORM_STATE_SKIP`/button filter as `captureCurrentFormState`; called from `projectSave`, `savePoolStateNow`, `beforeunload` (replacing single-tab capture). Warm switches delete both the leave-capture and the `applySavedFormState` replay — the DOM is the state; cold-reload first-visit builds still replay per-tab (pool/sequence/images) with hidden-aware `applySavedFormState` (scope = `getTabRoot(tab)` + `CSS.escape` fallback). Per-tab toolbar binds are now root-scoped (`_bindPoolToolbar(root)`, `zoomBindings(root)`, image-pool `$(id)`) so shared `btnProject*` ids bind the correct root; collapse heads and drag-resize binds are mounted-guarded (`dataset.chromeBound`/`resizeBound`).
- Hidden-DOM: `renderPoolGrid`/`renderImagePoolGrid` early-return when `wrap.closest('.tab-root[hidden]')` or `!isConnected`, setting `dataset.dirtyGrid` consumed on next show; pool layout chrome is pool-root-scoped (`getTabRoot('pool')`) so the image pool's reused classes are not restyled. Lifecycle: `window.__sfTeardown` moved from unconditional `renderTabForm` wipe to leave-`stablefluids` hide path; leaving sequence while playing runs `seqPause()` (pause, keep position, never auto-resume) via dynamic `sequence.js` import. CSS: `.tab-root[hidden]{display:none!important}` (zoompan precedent) plus `.tab-root{flex:1 1 0; min-height:0; overflow:hidden}` chain so the pool grid remains a constrained scroll container (was 77kpx unscrollable before the `flex-basis:0` fix); `tab-scroll.js` fourth pane (`seq`) already shipped in 8.066, plus pool/sequence grid sync (`sib.grid = entry.grid` when sibling exists) so the shared `poolGridWrap` does not have tab-scroll clobber live preserved scroll.
- Live-proven with real Playwright clicks on the 1319-item / 354-sequence project (no stub): sequence strip 4611 → pool → sequence → jobs → sequence = 4611 exact, half-typed Time 11.09 (input only, no change) exact, pool grid 300 exact, images `imgPoolFilterInput` preserved, zero `/ops/rife`, `/api/variants/batch`, `/api/media/recover`, `/api/media_signatures` POSTs during warm switches, zero console errors (pre-existing thumb 404s excluded). Wall tenant sample preserved. Requires no backend change; 62 core pytest green (178 total without `cv2`).

### 000.000.8.066 — Sequence strip keeps its scroll across tab switches
- Every visit to Sequence reset the token strip to the top: `tab-scroll.js` tracked `#actionPanel`, `#actionPanelForm`, and the pool grid wraps, but not `#poolSequenceBox` — the real scroller on big projects (347 wrapped tokens ≈ 11kpx of rows in a 72px-tall strip), and every switch destroys it with the panel `innerHTML` rebuild. Strip `scrollTop` is now a fourth tracked pane: capture-phase scroll listener, per-tab memory + localStorage entry, restore with the existing double-rAF + 200/600ms retry passes (old stored entries without the field still load). Live-proven with real clicks on the 347-clip project: strip parked at 5000 → Video Pool → back → exactly 5000, 3/3 rounds, zero page errors. Frontend-only (no restart). Deliberately not DOM caching: the rebuild is 0.27s and destroy-then-restore is what keeps all 30 tabs' controls honest (the `applySavedFormState` machinery exists for exactly this); caching roots would trade a solved problem for staleness/teardown bugs.

### 000.000.8.065 — Stale autosave no longer reverts Time (union merge fix)
- Real data-loss bug behind the "RIFE completion reverts Time" report. Eliminated suspects live first: Time commit, token/input display, encode-completion path, server save/load round-trip, and tab switches all preserve `targetDuration` (stubbed-encode repros, entry + server GET verified; also restored a test-polluted entry 0 from the registry: Time 5.208 + ×4 variant link). The actual mechanism, proved at unit level with zero live risk: `save_pool_state`'s stale-basis union (`_union_membership_entries`) resolved row conflicts to the INCOMING row, so any session loaded before a Time commit that saved afterwards — minutes of opportunity during an encode — silently wiped `target_duration` (fresh 33.33 → stale save → key gone). Fix: conflicts resolve to CURRENT (fresher) rows, incoming adopts only brand-new paths — symmetric with the existing "stale deletes don't stick" rule; watcher-ingest protection and fresh-basis replace (explicit deletes stick) unchanged, shared by catalog + file paths. Both new tests fail on pre-fix code / pass post-fix (`StaleMergeKeepsFreshRowsTest`: keeps-fresh-Time + still-adopts-new-paths); 180 pytest green. Backend-only: live on next server restart.

### 000.000.8.064 — Sequence tab: 7.5s freeze → 0.27s (form-restore re-arm + O(n²) badges)
- Tab switch re-armed Instant with zero user gesture: `applySavedFormState` replays saved controls as `change` events on every tab render, and the Instant-toggle / RIFE-fps / Time-commit handlers had no `isApplyingFormState()` guard (watcher handlers already had it). Each switch to Sequence therefore ran a full armed scan (7 `POST /api/variants/batch` observed) and even fired `POST /ops/rife` — the stampede returning through a new door, plus the multi-second main-thread freeze. All three handlers now write state and return during restore; only real gestures arm/scan. Same pass fixed the underlying per-render O(n²): `_resolvedTargetFps()` (full-sequence mode scan + Map) and the token `getComputedStyle` ran per token (347² ≈ seconds of forced reflow) — target resolves once per render/strip paint and threads through as an optional override (`_densityInfoForEntry`/`_rifeInfoForEntry`/`_rifeBadgeForEntry`, defaults unchanged so all other callers behave identically), style read hoisted out of the token loop. Measured live on the 347-clip project: click-to-tokens 7.5s → 0.26–0.29s across 3 trials, `armed=false` after every switch, zero rife/variant POSTs, no page errors, strip still correct (`paused after load · 1 need · 326 OK`). 8.063 proofs re-run green (11/11 open, 4/4 remote-busy).

### 000.000.8.063 — Instant RIFE: open reads nothing, offline kept, Run shows server slot
- Mop-up of 8.059: encodes on open were already stopped; this extends the disarm gate to the READ path (spec §8 rules 3–5, §8 only). Restore/project-open renders badges from persisted records only: the three `attachCachedRifeVariants()` load calls in `persistence.js` (projectOpen, session restore, last-project fallback) are removed — the armed scan (`ensureSequenceMetaAndInstantScan`) is now the single hydrator; the composer render kick and the `_updateSeqVariantBadges` batch fetch require `isInstantArmed()`; `_kickInstantRifeScan` no-ops unarmed. Backend file fallbacks (catalog not ready) keep missing entries offline via `_collect_missing` (`pool.py`/`projects.py`) instead of dropping them; catalog path already kept everything. Run follows `GET /api/queue` while locally idle (3s poll in `job-control.js`, display only — never touches `clientBusyLabel`/`activeJob`) so server-side holders disable it with the owning task's label + Jobs-tab hint. `probe_fps`/`probe_fps_sync` refuse rates ≤0 or >1000 (the 16000 fps bogus probe). Proof caught a real gap: user Stop didn't disarm when the scan found 0 need (stop hook only bound on queue/drain) — `armInstantRife()` now binds it (idempotent). 5 new tests (`test_pool_offline_keep.py`: pool/project load keep missing + report + preserve cached meta/variant links; probe clamp async/sane/sync); 178 pytest green under project venv. Playwright-proven with real clicks on the live 346-clip project (`junk/instant-open-proof.py` 11/11: reload → disarmed + paused strip + 0 `/ops/rife`/variants/recover/signature requests + idle + Run enabled; toggle → armed, queue 0; Stop → disarmed, empty, idle; 12 console errors all pre-existing thumb 404s) + remote-busy wiring (`junk/remote-busy-proof.py` 4/4 via stubbed busy snapshot).

### 000.000.8.057 — Instant RIFE: batched restore scan + commit-on-Enter Time box
- Opening an old project with Instant on no longer serializes one variant lookup per clip: `_kickInstantRifeScan` (`mtapi-project/app/static/js/pool/sequence-rife.js`) keeps its sync persisted-variant fast pass, then hydrates everything still unresolved with ONE `_fetchVariantsBatch` (chunked ≤100, parallel) instead of `await _hydrateEntryFromVariants` per entry; `_hydrateEntryFromVariants` takes an optional pre-fetched map so the single-entry path is untouched. Verified live: cold re-scan after TTL expiry sends one 3-path batch, zero 1-path drips (old code: `[1,1,1]`), real need still queues. Time box (`js/pool/grid.js`) is preview-while-typing: `input` updates only the hint from raw text — no entry write, no save, no render, no RIFE kick — and commits only on change/blur/Enter/clear, so typing `20` never starts work for the intermediate `2`. Proof also caught a real pre-existing bug: `onSeqClipDurationChange` called `savePoolStateNow()` without importing it (`sequence-transport.js` import fixed). `node --check` clean on all three files; 10 RIFE/pool-save pytest green; Playwright-proven with real clicks on isolated :24592 (`junk/prove_rife_load_type.mjs`, 12/12 incl. cold re-scan + A/B vs stashed old code showing the exact reported failures), zero page errors.

### 000.000.8.056 — References: closed-model landscape merge (Runway Gen-4.5 + Pika 2.5 new rows)
- Folded the pasted 8-model competitive brief into the Big Chart (`mtapi-project/app/static/js/tabs/references.js` data only, 78→80 rows): new `Runway Gen-4.5` row (Edit/Extend, up-to-10s, GWM-1 world model + Motion Brush/keyframes, Audio No, crazy No, FL2V `?`, durMin 5 / durMax 10, unresearched cells `—`) and new `Pika 2.5` row (Stylized, up-to-10s, fast-iteration effects line, Audio `?` = limited, crazy Yes, FL2V `?`); enriched 6 existing rows — Veo 3 (reference-image control + 8s-extendable tips), Sora 2 Pro (~60s multi-shot narrative via storyboard chaining, single-pass max stays 20), Kling 3.0 Omni (per-character lip-sync + multi-shot sequencing + reference elements; kept base-3.0-4K/60 vs Omni-1080p distinction), Seedance 2.5/3.0 (9-image + 3-clip + 3-audio input structure + audio-leaderboard claim cited alongside 50-slot/30s research), Happy Horse 1.0 (Elo 1357 note + 7-lang lip-sync), Hailuo 2.3 (micro-expressions, character consistency, free tier). CONFLICTS RESOLVED: brief's "only model with synchronized dialogue" (Veo) and "unique per-character lip-sync" (Kling) both too strong vs chart's native-dialogue rows — merged without the exclusivity; Seedance 16s+ vs researched 30s single-pass kept at 30s with brief cited; Sora 60s recorded as chained narrative, not one clip. `node --check` clean (pytest blocked: env lacks `cv2`, pre-existing); Playwright-proven with real nav on :24590 (80 rows, 36 headers, all 8 names live, zero JS errors — only pre-existing favicon + pool-thumb 404s).

### 000.000.8.055 — Rifed-DNxHR wins: mezzanine Instant input + smart pick + save-merge
- Instant RIFE interpolates from the DNxHR proxy when one exists (`_mezzanineForEntry`: newest existing `dnxhr` variant, else original) and the op co-registers the output on the ultimate original (`register_rifed_output`: `source_kind`/`derived_from` detail, parent-record hash returned for recovery), so the Sequence proxy picker offers rifed-DNxHR directly with zero menu changes (menu was already kind-generic). Smart-pick (`_pickBestRifed(variants, needM)`) ranks sufficiency-for-need → dnxhr-derived → multiplier → recency at all three call sites; unmet need re-encodes from mezzanine, so the choice converges. Fixed live-found bugs: persisted `rifeNeed` trusted without recompute bricked Instant after target/meta changed (ensure scan, attach-cached, composer kick all recompute the pure math now); stale browser autosaves wiped server-ingested clips — `save_pool_state` accepts `_basis_updated_at` (tracked in `state.pool.serverUpdatedAt` on load/save) and union-merges items/sequence on stale basis, fresh/absent basis still replaces so explicit deletes stick, plus a `dropped N` audit line; DNxHR transcode failure no longer blocks the independent pool job (legacy DNxHR-only retry preserved). Watcher knob wiring hardened along the way (serialized config POSTs, in-flight-toggle immunity vs poll re-sync, detached-node + knob-epoch guards against re-render ghost toggles). 11 new tests (`test_rife_variants.py` chain/params, `test_pool_save_merge.py` stale/fresh/absent/explicit-delete/catalog branches, +1 watcher independence); 170 pytest green under project venv. Playwright-proven e2e on isolated :24592 with real clips (`junk/prove_rifednxhr.mjs`, ranking unit `junk/prove_rife_pick.mjs`): watcher ingest + DNxHR → fps 48 → Instant `from dnxhr` → adopted `*_resolve_rife.mp4` with `source_kind:dnxhr` on the original's record, zero page errors.

### 000.000.8.054 — Watcher: hot-folder → Pool + DNxHR proxy variants
- Watcher tab gains a second independent job beside legacy DNxHR (`mtapi-project/app/watcher.py`): **Pool import** (`pool_ingest` + `pool_add_sequence`) appends every stabilized arrival to the server pool file (`items[]`, optional `sequence[]`) — Thread-safe via live-catalog membership when ready, pool-file merge fallback headless — then moves the original to `dun/` (collision-safe `stem_1.ext`). Canonical pool path stays the original; DNxHR outputs register as `dnxhr` variants (`register_variant` shape: content-hash, paths remembered, 32-cap, deduped) so the Sequence proxy dropdown (already kind-generic) lists Original / dnxhr (/ rifed). RIFE deliberately not run here — Instant-RIFE + auto first/last fire through the normal funnel. `POST /api/watcher` takes the two new keys with per-job validation (pool-only needs just `in_dir`; DNxHR keeps `out_dir` + distinctness) and per-job failure (one job's refused enable never kills the other). Frontend (`js/tabs/watcher.js`): DNxHR + Pool import knobs, Also-add-to-Sequence checkbox, pool-imported counter; knob/checkbox visuals re-sync from server truth on poll (fixes reload-while-on showing Off — affected the legacy knob too); config POSTs chained to stop overlapping full-snapshot writes racing last-write-wins (caught live by proof). Desk snapshot + server `DESK_TAB_DEFAULTS` carry the new keys. 10 new tests (`tests/test_watcher_pool.py`: independence, validation, config roundtrip, dun-move + pool write + dedup, collision suffix, variant fallback + live-catalog branches); 159 pytest green under project venv (system python lacks cv2 — pre-existing env gap). Playwright-proven with real clicks, 12/12 (`mtapi-project/junk/prove_watcher_pool.mjs` + screenshots): both knobs render, Watching pill, live arrival → pool + sequence + dun drain, reload persistence, zero page errors; plus a live DNxHR run on the proof server (`dx.mp4` → `dx_resolve.mov` dnxhd/pcm_s16le, `dnxhr` row live on `/api/variants`).

### 000.000.8.053 — References: comparison-brief intake (PixVerse C1 new row)
- Folded the pasted 4-model comparison into the Big Chart (`mtapi-project/app/static/js/tabs/references.js` data only): new `PixVerse C1` row (78 total; Precision/Control, storyboard 3–9 panels, ref-locked consistency, Audio Yes, FL2V `?`, crazy Yes, durMin 1 / durMax 15, unresearched cells `—`); PixVerse V6 (+~1 ref capability, first+last keyframing + Modify tool tips); Vidu Q1 row (+7 reference images, start-end morphing, ±15ms lip-sync tips; limited-modify weakness); Ray3 (+character-ref/keyframes + reasoning strengths, 16-keyframe + Modify-Video-20s tips, durNote now SDR-extend/20s). DELIBERATE HOLD: brief claims Ray3 native audio **no** vs row badge Yes — badge untouched pending verification (one unattributed cell vs established row; standing research directive covers it). `node --check` clean, 149 pytest green; Playwright-proven with real nav (78 rows, C1/Yes/Yes cells, V6 tips tail, ±15ms present), zero console errors.

### 000.000.8.052 — References: 36-col split + full research fill
- Big Chart 14→36 columns, all 77 rows filled (`mtapi-project/app/static/js/tabs/references.js` only, zero CSS changes): Rel Date/Note, Native/Sweet/Max W+H+Note triplets (+ Max FPS), separate Upscaled column (upscaler figures carved out of Max), 480p/540p/720p/1080p/2K/4K Yes/No tier badges reusing the FL2V renderer + sort mapping, Dur Min/Max seconds + Note. Existing 14 columns byte-identical. New columns hidden by default via `DEFAULT_HIDDEN_COLS` consulted in `isColVisible` (stored prefs untouched). 9 parallel research agents supplied manufacturer + third-party gen-site refs per model; 31 relDate-vs-text conflicts, all prose-derived fills, and every landscape assumption recorded in `docs/video-split-audit.md`. `node --check` clean, 149 pytest green; Playwright-proven with real clicks (36 headers / 22 collapsed / 14 visible, Max W toggle + 512→3840 numeric sort with blanks last, eleven 4K-Yes float, zero console errors). Split spec marked shipped (`video-table-split-spec.md`); §8 research tail stays open in STATUS §5.3.

### 000.000.8.051 — Preview: →V-in / →I-in send buttons
- Two buttons in the preview `media-info` bar (`index.html` + `app.js` `sendPreviewToGlobal`, zero backend): **→V-in** appends the shown file to global Video inputs, **→I-in** to global Image inputs (append-if-missing dedup, `input` event dispatch so probe/visibility/input-preview sync via the existing `updateGlobalInputs` funnel — same pattern as pool send-targets). No type gating: both send whatever path is previewing. Guarded to real previews only (`mediaInfo` hidden → no-op). Proof script kept at `mtapi-project/junk/prove_preview_to_vin_iin.py`. Module syntax check clean; Playwright-proven with real clicks (video→V-in synced to `window.globalInputs`, re-click no-dup, image→I-in, console confirmations), zero console errors.

### 000.000.8.050 — Image Sort: Name ↑↓ + Date ↑↓ sorts
- Four new toolbar buttons on Image Sort (`mtapi-project/app/static/js/tabs/imagesort.js`, frontend-only, zero backend): **Name ↑↓** sorts the whole list by filename with natural order (`frame_2` before `frame_10`, case-insensitive); **Date ↑↓** sorts oldest→newest / newest→oldest by file mtime via the cheap stat-only `POST /api/media_signatures` batch (no ffmpeg, missing files go last). Unlike content Sort (keeps #1 pinned, re-ranks #2…N), Name/Date reorder all rows so the new first row becomes the base — made for frame-by-frame sets created in order. Selection follows its path across re-sorts; hint line + tool-docs updated. Proof script kept at `mtapi-project/junk/prove_imagesort_namedate.py`. `node --check` clean; Playwright-proven with real clicks (name asc/desc, date asc/desc, BASE follows #1), zero console errors.

### 000.000.8.049 — References: hover crosshair + click-to-copy
- Hover crosshair + click-to-copy on the Big Chart (`js/tabs/references.js` delegation + `css/references.css` visuals, video table only): hovered cell `rgba(96,165,250,0.22)`, row (pure CSS `:hover`) + full column (JS `ref-colhot` by `cellIndex`) at 0.07; `!important` is load-bearing so hover beats banding/highlights/frozen cells; `cursor:cell` affordance. Click copies trimmed cell text (badge → `Yes`, `—`/empty → no-op) with 650ms green flash + textarea fallback. Delegated on the table (survives tbody repaints), bound once. Proof caught a real ship-blocker: delegation block sat outside `if(table)` so `cfg` threw ReferenceError and killed YT-table binding — moved inside. `node --check` clean; Playwright-proven with real hover/clicks (76 column cells lit, exact text in clipboard stub, flash present, dash null), zero console errors.

### 000.000.8.048 — References: light row banding
- Zebra striping on the Big Chart (`mtapi-project/app/static/css/references.css` one appended block, zero JS): even non-highlight rows `rgba(255,255,255,0.025)`; frozen Model cells get pre-mixed `rgba(18,24,34,0.97)` so the band survives the opaque freeze. Playwright-proven on :24590: odd transparent / even 0.024 / frozen base-vs-band split / highlight tint preserved, zero console errors.

### 000.000.8.047 — References: frozen 2-line Model column
- Model column frozen + slimmed (`mtapi-project/app/static/css/references.css` one appended block, zero JS): `min-width:240px→150px`, names `line-clamp:2`, first column `position:sticky;left:0` (header corner z-index 3, body cells 2, opaque `rgba(12,18,28,0.97)` bg so scrolled columns slide under, 0.08-alpha right edge as the frozen anchor; collapsed strip keeps its look via higher-specificity rules). Playwright-proven on :24590: col exactly 150px, worst name (FLUX 3) 2 lines / 30px content height, sticky offset constant 16px across a 600px horizontal scroll (works under `border-collapse`), zero console errors.

### 000.000.8.046 — References: halved cell padding
- Body cell top/bottom padding 3px→1.5px (`mtapi-project/app/static/css/references.css` one value change, zero JS; badge pills and line-height untouched — rows size to their tallest text cell, pills only matter on all-short rows where pill (~17px) ≈ text line (~16px)). Playwright-proven on :24590: 1.5px padding live, avg row 49.1→46.1px across 77 rows, zero console errors.

### 000.000.8.045 — References: tight rows + vertical grid lines
- Tight rows + full grid (`mtapi-project/app/static/css/references.css` one appended block, zero JS): body `td` padding-top/bottom 8px→3px (horizontal 8px untouched; collapsed strips keep zero side-padding via higher specificity); `border-left: 1px solid rgba(255,255,255,0.04)` on body + header cells, `:first-child` skipped — byte-identical to the existing `tbody tr` horizontal dividers. Playwright-proven on :24590: 3px padding live, th/td/tr divider computed values identical, avg row ~49px, zero console errors (viewport screenshots keep timing out on the 77-row page — DOM measurements stand in).

### 000.000.8.044 — References: wrapping vertical header labels
- Expanded-column header labels wrap into side-by-side vertical runs (`mtapi-project/app/static/css/references.css` one appended rule, zero JS): `white-space:normal` + `overflow-wrap:break-word` + `max-width:6em` on `th:not(.ref-col-collapsed) .ref-col-label`; the existing 110px max-height stays as wrap pressure so header height never moves, and collapsed stubs keep their dimmed single-line look. Playwright-proven on :24590: 0 of 14 labels clipped (worst, 43-char Sweet Spot, fully visible in ~42px), header row still exactly 147px, zero console errors (viewport screenshots timed out twice on the 77-row page — per-label DOM overflow measurements stand in).

### 000.000.8.043 — References: full-bleed wide workspace
- `.ref-workspace-wide` un-capped (`mtapi-project/app/static/css/references.css` one rule + comment, zero JS): was `max-width:1280px` centered while the refs action panel already offers ~1597px, stranding ~300px of dead space beside a 2646px table. Now `max-width:none`, full-bleed; YT non-wide workspace keeps its 880px reading width. Playwright-proven with real clicks on :24590: workspace 1280→1569px, scroller 1272→1561px, card edge-to-edge with 7+ text columns readable, screenshot, zero console errors.

### 000.000.8.042 — References: wide columns + max-3-line rows
- Big Chart goes wide on purpose (`mtapi-project/app/static/css/references.css` appended block + one stale comment fix, zero JS changes): body cells `min-width:210px` (Model 240px, FL2V/Audio/Does-Crazy badge cols 96px); collapsed 26px strips explicitly excluded so their `display:none` (higher specificity) always wins. Rows capped by 3-line `line-clamp` on `td > *` — every body cell holds exactly one child and no rows use `warn`, so all 77 rows land at ≤3 lines. Playwright-proven with real clicks on :24590: worst row (FLUX 3) exactly 3.0 lines, table ~2650px with in-card h-scroll (2678px content in 1272px viewport), Strengths collapse→26px strip→re-expand clean, screenshot, zero console errors.

### 000.000.8.041 — References: `Does Crazy` binary column
- Big Chart 13→14 cols (`mtapi-project/app/static/js/tabs/references.js`: one `MODELS_COLS` entry after Audio, one `modelsSortValue` branch, one `modelRow` cell reusing the Yes/No badge renderer; unlisted rows render `—` and sort between Yes and No). 35 rows stamped from the human's two buckets verbatim, no reclassification, no new rows: 26 Yes (8 LTX rows, Wan 2.2 Fast/I2V-rCM/I2V-LoRA, Seedance 1.0 Lite + 1.0 Pro/Pro Fast + 1.0 Pro Fast + 1 Lite, Vidu Q1/Q3-Pro/S1, Kling 2.0/2.1/2.5-Turbo/2.6, Luma Ray3/Ray3.14, Pixverse 6.0/Motion 2.0 + V6 + V5 + V4.5 + V4, Hunyuan Video, Mochi 1, MiniMax Hailuo 2.3), 9 No (Happy Horse 1.0/1.1, Kling 3.0/O3, Runway Gen 4/Turbo/Act Two, Luma Ray2, Veo 3 row, Sora 2 Pro). Judgment calls to revisit: Kling 2.0 row spans both buckets (2.0/2.1 Yes vs 2.5 Turbo No → stamped Yes); Vidu Q1 row drags Q3-Pro/S1 along as Yes; Pixverse 6.0 row treated as V6 line; PixVerse V5.6, Sora 2 Max, Runway Gen-4S left blank. Listed-but-absent names (Veo 2, Vidu Q2 line, Pika, AnimateDiff, Deforum, etc.) need rows before they can be stamped. `node --check` clean; Playwright-proven with real clicks (header, spot cells, Yes-first sort) — zero console errors.

### 000.000.8.040 — References: FLUX 3 Video row (full brief, zero trim) + research prompt spec
- Big Chart gains the human-supplied FLUX 3 Video entry verbatim across all 13 cols (`mtapi-project/app/static/js/tabs/references.js` `MODELS_ROWS` only, no renderer/sort changes): Unified-multimodal-frontier category (Self-Flow joint image+video+audio train, FLUX-mimic robotics offshoot), 2026-07 release (announced July 23, 2026, Video + Action gated Early Access, image "coming weeks", open-weight Dev later 2026, playground trial till Aug 17), unpublished-training-res native cell (720p evals, `flux_3_video` 5–20s 720p/1080p, only native 2:1 entry, wrappers 480p/720p/1080p), 720p-Draft cheap-coherence sweet spot ($0.06/s vs $0.29/s, 6 vs 17 credits/s, $0.17/s vs $0.43/s; 5–10s single-subject slow/medium; fast combat breaks; draft-then-enhance), 20s-with-audio / 1080p max (no 4K), 5–8s test / 10s delivery duration cell (~12s drift wall without keyframes), FL2V `yes` + Audio `yes` badges, full strengths (faces/skin over FLUX.2, lip-sync winner vs Seedance/Omni Flash, weird-believable footage, typography over Veo, agentic chaining) and weaknesses (Seedance 2.5 smoking, censorship/physique/refs limits, 12–15s drift, preliminary-hype numbers flagged, gated) cells, endpoint-rich tips (`flux-3-flf-draft`, `flux-3-keyframes-draft`, `images_list`, no external audio input). Full uncut brief saved as `docs/flux_mod_ref.md`. `node --check` clean, 140 pytest green, Playwright-proven with real clicks on :24590 (row live, all 13 cells, Yes/Yes badges, zero console errors). Also adds `docs/video-model-research-prompt-spec.md`: reusable research-model prompt (one model/family per run) with the 8-field house format, 13-col mapping, and an anti-trim acceptance law.

### 000.000.8.029 — References: Video Models Big Chart data enrichment
- Enriched 25 sparse/placeholder video model rows in `MODELS_ROWS` (`mtapi-project/app/static/js/tabs/references.js`) with full taxonomy categories, release dates, native/sweet/max resolutions, accurate FL2V/Audio badges, key technical notes, strengths, weaknesses, and concrete practical prompt tips derived from research reference documents (`wan_hunyuan_mod_ref.md`, `vidu_mod_ref.md`, `minimax_ltx_mod_ref.md`, `seedance_mod_ref.md`, `kling_mod_ref.md`, `pixverse_vidu_mod_ref.md`). Verified syntax (`node --check`) and 112 pytest unit tests green.

### 000.000.8.028 — References: ShengShu Vidu AI Video Model cheat sheet (`_mod_ref`)
- Researched full 6-model ShengShu Vidu line (Vidu Q3 Pro / Q3 Flagship, Vidu Q3 Turbo, Vidu Q1 / Start-End Interpolation Endpoint, Vidu S1 Real-Time / Low Latency, Vidu Q2, Vidu 1.0 / 1.5 / 2.0) from primary API documentation, launch notes, and community benchmarks. Enforced zero marketing buzzwords, 7-value category taxonomy, concrete use cases, known failure modes, personality, 3 practical prompting tips per model, and competitor comparisons. Verified start-end 0.8–1.25 aspect ratio tolerance guard & HTTP 400 rejection, R2V 1–7 multi-image slot rules for character vs background lock, single-pass joint audio-visual lip-sync mechanics via quotation marks or WAV/MP3 uploads, and I2V/R2V benchmark positioning over text-only prompting. Created `docs/vidu_mod_ref.md`.

### 000.000.8.027 — References: Alibaba Wan & Tencent Hunyuan AI Video Model cheat sheet (`_mod_ref`)
- Researched full 8-model Alibaba Wan family (Wan 3.0 Prime, Wan 3.0 Base/Self-Host, Wan 2.2 Fast/I2V rCM/I2V LoRA, Wan 2.1 14B & 1.3B, Wan 2.6 & 2.7) and open-source video models (Tencent Hunyuan Video v1.0 & v2.0 4K, Mochi 1 Genmo, Pyramid Flow & ToonCrafter) from primary documentation and community power-user data. Enforced zero marketing buzzwords, 7-value category taxonomy, concrete use cases, known failure modes, personality, 3 practical prompting tips per model, and competitor comparisons. Verified negative prompt field handling in Wan 3.0 Prime, document reference ingestion (.pdf/.pptx), 4-step rCM execution, VRAM thresholds for Hunyuan Video and Wan models, and Mochi 1 480p resolution locking trade-offs. Created `docs/wan_hunyuan_mod_ref.md`.

### 000.000.8.026 — References: MiniMax & Lightricks LTX AI Video Model cheat sheet (`_mod_ref`)
- Researched full 11-model MiniMax (H3, H3 Max, Hailuo 2.3/2.3 Fast, Hailuo 02, Video-01 Director/Live, Video-01 Base) and Lightricks LTX line (2.5/2.5 Fast, 2.3/2.3 Fast/F2LF, 2 19B/Pro/Fast, 0.9.8 13B Distilled, 2B Q8) from community power-user data and primary documentation. Enforced zero marketing buzzwords, 7-value category taxonomy, concrete use cases, known failure modes, personality, 3 practical prompting tips per model, and competitor comparisons. Created `docs/minimax_ltx_mod_ref.md`.

### 000.000.8.023 — References: Video Models Vidu FL2V-first fix + 8.022 enrichment batch record
- Fixed FL2V / Audio badge swap on Vidu rows (`Vidu 1.0` → `fl2v: 'yes', audio: '?'`; `Vidu Q1` → `fl2v: 'yes', audio: 'yes'` per ShengShu launch docs). Every other row untouched. No sort/renderer/legend changes. Playwright-proven on :24590 with real clicks — Vidu badges now align with actual capabilities (start-end has audio toggle, Q3 renders native audio-visual in one pass), 76 rows render, all 13 columns in order, Category/Released sorts, zero console errors. Batches #1 ships at 8.022 and recorded here. Screenshots: `mtapi-project/junk/refs-models-vidu-8.023.png` + `refs-models-13col-8.022.png`.

### 000.000.8.022 — References: Video Models 13-col schema + enrichment batch #1
- Big Chart 10→13 cols (`js/tabs/references.js` `MODELS_COLS` + `modelRow` only): `Category` (human-approved 7-value taxonomy), `Released` (YYYY-MM, lexicographic sort, empties last via existing helper), `Use / Prompt Tips` before `Notes` (Notes stays last). Key-based schema = future column toggles plug in with no rework. Batch #1 (researched from vendor docs/API refs/guides, not generic LLM copy): Wan 3.0 Prime (2026-08, Precision/Control, unified T2V+I2V+R2V, doc inputs, 1080p ceiling, delivery-first prompting), Kling 3.0 Omni (2026-02, storyboard/voice-binding strengths, SCALE prompting tip, FL2V honestly `?`), Seedance 2.5 Lite (2026-07, 30s beats + reference-discipline tips, API-4K flagged unverified). Other 73 rows untouched (`—` until their batch). Playwright-proven with real clicks (13 headers, 76 rows, Category/Released sorts, no overflow, screenshot `mtapi-project/junk/refs-models-13col-8.022.png`) — zero console errors.

### 000.000.8.021 — References: Video/Image Models expansion (41 video + 27 image, real scroll fix)
- Big Chart 35→76 video rows + 24→51 image rows (`js/tabs/references.js` data only, no renderer/sort changes; video: zero dupes, zero placeholder models). **Real scroll fix** (`css/references.css`): the prior `overflow-y:auto` on `.ref-workspace` never engaged — the card shrank to 944px and clipped 5300px+ of table with no scroll container. Wide models cards are now flex columns (`flex:1/min-height:0`) with internally-scrolling bodies + sticky `thead` (headers stay pinned over ~4400px video / ~1400px image travel); YT tab untouched. Data cleanup: 7 new image rows with `-` company fixed (5 Flux → BLACK FOREST LABS, RealVisXL V3 + DreamShaper XL → SDXL COMMUNITY). Cache-busters `?v=2` on `references.css` (`index.html`) + `references.js` (`app.js`). Playwright-proven with real clicks (76/51 rows, in-card scroll travel, Model re-sort, screenshots `mtapi-project/junk/refs-models-76rows-*.png` + `refs-images-51rows-scrolled.png`) — zero console errors (only pre-existing pool-thumb 404s + favicon 404). Human approved ship; missing-data follow-up deferred to next job.

### 000.000.8.020 — References: Video Models touch-up (Omni `-` + H3 highlight)
- Big Chart stays 35 rows (`js/tabs/references.js` two rows only, no renderer/sort changes). Omni Video Custom unknown cells (`native`/`sweet`/`max`/`dur`/`audio`) → `-` per human instruction (was `Unknown - …` verbatim); FL2V stays `no` (gray), Audio `-` falls back to the amber `?` badge via the existing renderer/sort fallback. MiniMax H3 / Hailuo 03 gains `highlight:true` + notes `Top 2K/audio pick` (4th green row alongside Seedance Pro, Ray3, Real Motion 3.5 Turbo). Playwright-proven with real clicks on :24590 (Video Models nav, 35 rows, Omni `-` cells + No/? badges, H3 `ref-highlight`, Max-Output re-sort, no table overflow, screenshot `mtapi-project/junk/refs-models-8.020-proof.png`) — zero console errors.

### 000.000.8.019 — Settings: auto-add op outputs to Pool
- New `Op outputs` card under Settings (`js/tabs/settings.js`, kicker Pools, after Pool & cache): master switch `Auto-add op outputs to Pool` (default off, localStorage-authoritative + `/api/settings` mirror via `performance.py` + `app.js` precedence) with a dependent sub-block (hidden-attribute toggle, same pattern as Auto first/last) holding `Also add to Sequence` and `Auto-add image outputs to Image Pool`. Single completion funnel: `displayOpResult()` (`js/job-control.js`) calls new `js/pool/auto-add-outputs.js` `maybeAutoAddOpOutput()` on `ok && !dry_run && output_path` — videos route to `addPathsToPool` (+ optional deduped `addPathsToSequence`), stills to `addPathsToImagePool` only when the image switch is on; unknown types ignored, failures never break preview (dynamic imports, try/catch). Covers Single-Clip Ops, Cut, all Datamosh modes, Speed/RIFE, Convert, multi/advanced, and per-item batch runs. Stitch Sequence + Quick Transmute keep their explicit unconditional adds (documented in the card). New `tests/test_auto_add_outputs.py` (5 tests: defaults/normalize/independence/full-payload); full suite 112 green. Playwright-proven with real track-clicks: off→sub hidden, on→sub appears, both sub-switches persist across reload, real Cut Encode on a fixture clip → Success → Video pool +1 and Sequence +1 within 1.5s; cleanup left the user's pool/sequence/settings untouched. Zero pageerrors (one transient pre-existing thumb 404 also seen on unrelated runs).

### 000.000.8.018 — References: Video Models refresh (LTX 2.5 / Wan 2.2 / H3)
- Big Chart 30→35 rows (`js/tabs/references.js` `MODELS_ROWS` only, no renderer/sort changes). Replaced 6 stale rows (LTX-Video 2B/13B, LTX 2.0, LTX 2.3, Wan 2.1 1.3B, Wan 2.1 14B/2.2, Hailuo 2.3/02) with 11 cleaned rows from human-supplied data: LTX Video 2.5 Upsampler, LTX 2.5 Distilled, LTX 2.3 Distilled, LTX-2.3 F2LF, LTX 2 Turbo, LTX 0.9.8 13B Distilled, Wan 2.2 Fast, Wan 2.2 I2V rCM, Wan 2.2 I2V LoRA, Omni Video Custom, MiniMax H3 / Hailuo 03. Badge mapping: leading "Yes"→`yes` (green), "No"→`no` (gray), "Unknown…"→`?` (amber); cell text verbatim. Untouched: Seedance, Vidu, Kling, Luma, Veo, Pixverse, Van Gogh Relax, Real Motion rows + sort/legend/highlight machinery. Syntax-checked (`node --check` as ESM) + Playwright-proven with real clicks (Video Models nav, 35 rows, all 7 spot-check names present, stale names absent, Max-Output + Model re-sorts, F2LF Yes/Yes badges) — zero pageerrors, one transient thumb-style 404 on first load only, none on re-run.

### 000.000.8.016 — Skills tab (AI model skills)
- New top-level Workspace tab for SKILL.md skills (`docs/skills-tab-spec.md`, was Candidate). Upload single `.md`/`.txt` (file picker or paste box) or a `.zip` bundle (`SKILL.md` at root or one level down + support files); zips travel base64-inside-JSON so there is no multipart dependency and the full op/job/progress/cancel/single-flight machinery applies. `POST /ops/skills_install` (`app/operations/skills_ops.py`): model pass (Normalize default, Custom with user instruction — new `build_skill_install_messages` in `app/agents/skills.py`, text-only reuse of grok/agy/deepseek/openrouter/xai/openai/groq/stub) extracts `name`/`description` frontmatter (hand-parsed, no new deps); offline-tolerant fallback installs already-structured input as-is with a `meta.warning`; same-name collision returns `ok:false` + `meta.conflict` and the UI `confirm()`s before retrying with `overwrite:true`. Server store: `~/.cache/mtapi/skills.json` index (atomic tmp+replace, corrupt-index-tolerant reads) + `skills/{id}/` file bytes; zip traversal/absolute members reject the whole install; caps 200 skills / 200 KB per file / 5 MB + 50 files per zip. Thin `GET /api/skills`, `GET /api/skills/{id}`, `DELETE /api/skills/{id}` (`app/routes/skills.py`, registered in `main.py`). Frontend `js/tabs/skills.js` (`renderSkillsForm`, wired in `app.js` + `index.html` nav, Run/Queue + global inputs hidden like Agent/Notes): upload card, newest-first searchable list, reader with bundle file switcher, one-click Copy (clipboard + fallback), client-side Export `.md`/`.txt` (bundle `.txt` concatenates with `=== path ===` separators), per-row + reader Delete. New `tests/test_skills.py` (21 tests: frontmatter/slug/prompt-builder, store CRUD + corrupt recovery, zip root/nested/traversal/absolute rejects, op dry-run/empty/stub-fallback/garbage/conflict/zip-path). Full suite 100 green (was 79). Playwright-proven with real clicks on an isolated :24591 instance: paste install, zip-via-real-file-input install, conflict dialog → accept → overwrote, Copy status, byte-identical `.md` download, Delete, reload persistence — zero JS errors. Proof caught and fixed a real bug (Install button passed the click event object as `overwrite:true`, silently skipping the conflict guard). Follow-up: installed skills as Agent-tab context (v1.1 hook, spec §9).

---

### 000.000.8.013 — Single-Clip Zoom / Pan op
- New `zoom` entry on the Single-Clip Ops dropdown + `POST /ops/zoom` (`app/operations/zoom_ops.py`). Selecting it populates the full control set: engine toggle (Stable Pillow lerp default / Raw ffmpeg zoompan), 11 presets (zoom in/out, targeted, Ken Burns, ease in/out, punch, spiral, glitch, hue cycle, custom), timing (duration/fps/frame-d + live frame readout), output size, optics (rate/cap/direction/pre-scale), motion (pan/drift, target, oscillate), FX (rotate, easing, punch frame, glitch, hue cycle). Input auto-detects still (`-loop 1`) vs video; stable engine is stills-only in v1 (honest `ok:false` otherwise), rotate/glitch/hue are raw-only; raw expressions pass an injection guard. New `tests/test_zoom.py` (8 tests: preset map, guard, dry-run still, stable still real render, stable-video + FX-engine rejects, bad input). Full suite 79 green. Playwright-proven with real clicks (dropdown → all controls populate, readout `72 frames · @24fps · ~3.00s · stable · zoom_in`, zero new JS errors) + HTTP-proven backend (stable/raw still MP4s + raw clip MP4, ffprobe frame counts, HTTP 200 + `ok:false` failures). Spec: `docs/singleclip-zoom-spec.md`. Pan & Zoom tab untouched.

---

### 000.000.8.002 — Comma-safe join/grid
- Fixed a delimiter-collision bug where `/ops/join` and `/ops/grid` built multi-input as a single comma-joined string, and bash `transmute`/`bin/transmute` `collect_inputs()` split on `IFS=','`. A clip whose **own filename contained a comma** (`…yellow spots, camera slowly pulls b.mp4`) was silently truncated at its internal comma → `No such file or directory`. **1)** `/ops/join` target-less path now runs the pure-Python `concat_clips` (inputs as a real list, never comma-joined) and remuxes the already-H.264 intermediate to `.mp4` via stream copy (`_join_legacy`). **2)** New full pure-Python `grid_clips` helper (ffmpeg `xstack` 2×2, mirrors `transmute -g`) — `/ops/grid` routes through it, so grid is comma-safe too. **3)** Both bash `transmute` and `bin/transmute` `collect_inputs()` now detect a path truncated at an internal comma and exit loudly with a clear message instead of silently producing a bogus path. New `tests/test_join_comma.py` (6 tests: real join + grid with comma-filenames produce valid output, dry-run, bash hardening rejects comma-in-path, genuine multi-input still works). Full suite now 70 tests green.

---

### 000.000.8.001 — Final-encode fixes
- Hardened the shared final-render engine (`app/video_pipeline.py` `encode()` / `_build_encode_argv()`), fixing three "renders but makes nothing / fails depending on settings" failure modes. **1)** `encode()` now verifies ffmpeg actually wrote a non-empty output file via new `_ensure_output_file()` — a silent exit-0 that writes nothing (or a zero-byte file) is now a `RuntimeError` instead of a bogus `ok=True`. **2)** Legacy frame-op encodes (RIFE, speed, recohere, cut) auto-apply `pad=ceil(iw/2)*2:ceil(ih/2)*2` whenever the pix_fmt is chroma-subsampled (`yuv420p`/`yuv422*`), so odd native resolutions (e.g. 321×241) encode instead of crashing with "width not divisible by 2"; explicit `even_floor` still wins. **3)** `-shortest` no longer trims generated (RIFE'd / slow-mo) frames down to the source-audio length by default — that was silently discarding the whole point of interpolation; a new `clamp_to_audio` opt-in restores exact length-matched muxing for `cut` (`cut_ops.py` passes it). Full suite now 64 tests green (9 new in `tests/test_encode.py`: argv `-shortest`/pad/an behavior, `_ensure_output_file` missing/empty/non-empty, and a real-ffmpeg odd-dimension dump→encode integration test).

---

## Shipped History (from old §3)

## Shipped History (from old §3)

### 000.000.8.000 — Point release
- Everything since `7.000` merges to `main`: Flip / Rotate `7.017`, Clearable inputs `7.016`, Keep the Change `7.015`, Unified Speed & Time `7.014`, Visual Hijack + Mosh-ups `7.013`, Stable Fluids Phase 1–3 `7.011`, QR Art Illusion `7.009`, Settings chrome `7.008`, Live VERSION `7.007`, docs diet/slim `7.006`/`7.004`, FastSAM multimodel Partial `7.002`. Full suite 55 tests green.

---

### 000.000.7.017
- **Flip / Rotate** — lossless geometry in two places with one shared design. Single parameterized op `flip_rotate` (mode dropdown, 6 choices) on **Single-Clip Ops** and as a **Flip/Rotate** card in the **Image Edit** ops stack; both tabs are driven by `FLIP_ROTATE_MODES` + `flipRotateOptionsHtml` in `app/static/js/utils.js` so the vocabulary can never drift. Video path: new `-R MODE` flag on `transmute` and (parity) `bin/transmute` — `rotate_90`/`rotate_180`/`rotate_270` (`transpose` chain), `hflip`, `vflip`, diagonal `hflip+rotate_90`; composes with `-c/-b/-s/-S/-z/-x/-r`, audio stream-copy, auto-named `_r90/_r180/_r270/_hflip/_vflip/_hflip_r90` suffixes; registered as `/ops/flip_rotate`. Image path: `flip_rotate` stack op implemented on all three engines (ffmpeg `transpose`/`hflip`/`vflip`, ImageMagick `-rotate`/`-flop`/`-flip`, Pillow `Image.Transpose` with the CW/CCW correction) — a marker-image test proved pixel-identical corner orientation and dimension swap across all three. New `tests/test_fliprotate.py` (5 tests: CLI `-R` filter chain + suffix naming + real dim swap + bad-mode rejection, registry contract for `flip_rotate`, all three image engines × all six modes). Playwright-verified on the real UI for both tabs (Single-Clip: `-R hflip` → `src_hflip.mp4` 320×240; Image Edit: global image + vflip stack op → `ffmpeg -vf vflip`, ok=true, preview shown).

---

## Shipped History (from old §3)

### 000.000.7.016
- **Clearable inputs**: a red ✕ now ships with any populated text box, as a truly portable module. `js/ui/clearable.js` + `css/clearable.css`: add `data-clearable` to an `<input type="text">`/`<textarea>` → auto-wired as part of the page boot, plus a MutationObserver upgrades any dynamically rendered form (tabs re-render later and still get it with zero JS). The ✕ is red (`--error`), appears only when the field holds content, clears on click while firing `input` + `change` (so `updateGlobalInputs`, probing, and form-state capture all keep running), then restores focus. A 250 ms self-sync poller catches programmatic value writes that never dispatch events (desk-restore `applyDeskSnapshot`, file-browser picks, pool sends), so show/hide never desyncs. Wired on the four global inputs (Video file(s), Image file(s), Path in, Path out) in `index.html`; the old status ❌ “Not used by this tab” glyph (read as a dead clear button) was removed from `updateStatusIndicators`. `makeClearable`/`bindClearables` are exported from app.js for ad-hoc upgrades. Playwright-verified on the real UI: typed and picker-set values show the ✕, clicking clears the field and un-populates the panel / deactivates quick buttons; dynamic `data-clearable` injection auto-wraps. Systematic roll-out to all existing text boxes = the open follow-up.

---

## Shipped History (from old §3)

### 000.000.7.015
- **Keep the Change** (Unified Speed): RIFE **Free** overage is spendable, not just dropped. API `keep_extra`: `trim` (default; drop `G−R`, exact target), `fps` (encode all `G` inside target duration `T`, output rate rises to `G/T` — rejected by a Pydantic validator when `target_fps` is pinned), `length` (encode all `G` at the output rate, duration stretches to `G/F`, effective speed recomputed as `D/T`). Backend `resolve_speed_plan` returns `kept_mode`; the conforming encoder keeps all frames and encode-fuse re-times. Speed tab rebuilt to per-variable **Control/Auto**: Multiplier (Control) ⇄ Target Length (Control), the auto row shows the live derived value and is pointer-inert; **Keep the Change** segmented row (Trim / FPS-raise / Length-stretch) shown only with RIFE on, FPS-raise auto-disabled (and reverting to trim) while Output FPS is Auto·Match; live readout notes switch between `dropping N → target`, `encode all @ FPS`, and `encode all → duration`. Frontend `resolveUsPlan` is again a 1:1 mirror of the backend plan. New tests: 5 (keep trim / fps / length maths + validator rejection + rife-off ignore). Playwright verification on a real cut clip: 0.3× Free ⇒ 140 generated / 117 target / drop 23 → `encode all @ 28.8 FPS` (fps) → `encode all → 5.83s` (length); dry-run payload carries `keep_extra:"length"`, backend logs `0.25× → 5.83s`; clean console, no JS errors.

---

### 000.000.7.014
- **Unified Speed & Time**: one deterministic model for the Speed tab — per-frame FPS locked to source, `T = D/S`, `R = T×F`. Target Mode **Length** (exact duration) or **Multiplier** (exact factor). Optional RIFE **Snap** (speed locked to `1/M`, no extra frames) vs **Free** (next valid `M` with `G = N×M ≥ R`, extra dropped by a conforming encode). Fixes the wrong duration estimate (4s @ 0.5× reported 2.6s → now 8.00s). Backend `resolve_speed_plan` is mirrored 1:1 by the live UI readout (`app/static/js/tabs/speedchange.js`); API: `POST /ops/speedchange` with `target_mode` / `target_length` / `speed` / `rife_snap`. Fast path = pure ffmpeg; RIFE path = dump → ×M → thin G→R → encode @ F (audio atempo preserved). 13 new unit tests (`tests/test_speedchange.py`), Playwright-proofed on real `testsrc` assets (RIFE 0.5× snap → exactly 4.000s, 96 frames @ 24fps; super-simple fast 2× → 24 frames; 0.3× Free ⇒ 400/480/+80 readout).

---

## Shipped History (from old §3)

| Area | Notes | Spec / code |
|------|--------|-------------|
| **Stable Fluids Phase 2/3** | Pure WebGPU compute port (~3 passes: spray/advect, divergence+Jacobi×20, gradient-subtract) replacing the Unity iframe when native mode is on; **seed-image injection** (dedicated path → first Image Pool still → black) as the initial dye field; mode radio toggle; Record shared across both modes; tab teardown stops the sim/rAF on leave | `stablefluids-sim-spec.md` · `7.011` |
| Filter platform | dump / stages / encode | `filter-platform-spec.md` |
| Convert / Export | codecs, frames_*, GIF | `convert_ops.py`, `convert_presets.py` |
| Transmute geometry | CLI wrapper | `transmute_ops.py` |
| Datamosh | melt, classic, … | `operations/datamosh/` |
| DeepDream / withoutBG / style / facemorph | neural / multi-source | `*_ops` + filters |
| RIFE directory | RIFE tab + pipeline + Image Sort | `filters/rife.py` |
| Speed change + ramp | optional RIFE | `speedchange_ops`, `speedramp_ops` |
| Zoompan | still → video | `zoompan_ops.py` |
| Dual pools + Cut UI | encode still open | `video-image-pools-spec.md` |
| Image Sort → Video | rank, conform, RIFE, encode | `image-sort-rife-spec.md` |
| Image Sort chain | radial \| closest next | `image_sort/rank.py` |
| RIFE multiplier **2–128** | knobs + API | imagesort / rife / speed / ramp |
| Img2img OpenVINO | stage + op + tab + mark frames | `img2img-openvino-spec.md` |
| Txt2img OpenVINO | op + tab | `txt2img_ops.py` |
| Agent tab (Phase A+API) | CLI + HTTP via `~/.secrets` | `agent-vision-tab-spec.md` · `4.59` |
| **RIFE Recoherence** | 2 stills → RIFE M=2 → **img2img every mid** (keep all; no discard) → .mp4 | `rife-recoherence-spec.md` · `4.62` |
| **Upscale (NCNN)** | Real-ESRGAN / SRMD + tab + bins | `upscale_ops.py`, `filters/upscale.py` · `4.64` |
| **Cut encode** | Global range dump→encode | `cut_ops.py`, Cut tab · `4.64` |
| **Job queue (v1)** | FIFO in-memory + Jobs tab + Add to Queue | `job_queue.py`, `op_runner.py` · `4.64` |
| **QR & Illusion Art** | QR/Pattern + ControlNet + IP-Adapter | `qr_ops.py`, `qr_art_ov_worker.py`, `js/tabs/qr.js` · `5.05` |
| **Prompt Library** | Save/load ± pairs; img2img / txt2img / recohere | `prompt-library-spec.md` · `js/ui/prompt-library.js` · `4.61` |
| Job progress core | phase rate/ETA, cancel | `job_control.py` |
| RIFE dir watch | `frames_out` while binary runs | `filters/rife.py` |
| **Live preview (all ops)** | `latest_frame` on frame writers; **DeepDream mid-ascent** snapshots to `/tmp/mtapi_live/{token}.png` | `4.70`+`4.71` |
| Pre-run summary | Image Sort, RIFE, Speed, Face Morph | `ui/pre-run-summary.js` |
| Run-button elapsed | sticky `● m:ss` | `job-control.js` |
| list-keys (partial ship) | several list tabs | `ui/list-keys.js` |
| Bottom docs (partial ship) | Image Sort pilot + img2img / txt2img / agent / upscale / recohere / **deepdream** | `tool-bottom-docs-spec.md` |
| **DRY staged job** | `run_staged_job` shared bookend runner; rife / cut / upscale-video / speedramp migrated | `app/staged_job.py` · `4.65` |
| **Run/Queue collect unified** | Single `resolveActiveOpAndBody()` shared by Run + Add to Queue | `js/job-control.js` · `4.65` |
| **Bottom input preview** | Every op tab shows input thumb(s) at panel bottom (after docs); dual for style/recohere/guide | `js/ui/input-preview.js` · `4.66` |
| **DeepDream bottom docs** | Full noob-friendly story + every knob + recipes | `js/tabs/deepdream.js` · `4.67` |
| **DeepDream Evolve video** | Mid-ascent capture → Image Sort dedupe → optional RIFE → `*_evolve.mp4` (stills) | `deepdream-evolve-video-spec.md` · `4.73` |
| **Style Evolve + shared bookend** | Strength ramp (1 neural pass) → `app/evolve_video.py` RIFE/encode DRY | `styletransfer` · `4.74` |
| **Evolve DRY cleanup** | Shared `EvolveRifeParams` + `js/ui/evolve-rife.js` (DeepDream + Style tabs) | `evolve_video.py`, `evolve-rife.js` · `4.75` |
| **DeepDream dead-path scrub** | Removed unused sync `dream_video`/`dream_ouroboros`; shared RIFE model select across tabs | `dream.py`, `evolve-rife.js` · `4.76` |
| **Dead-code pass 3** | Dropped unused helpers/shims; wired `frame_range` fields across video ops | `shell`, engines, `*_ops` · `4.77` |
| **Image Compare tab** | Two stills · separate/overlay/A/B (shared module) · rate via `imagesort_rank` | `js/tabs/imgcompare.js` · `4.68` |
| **Nav category collapse** | Collapsible sidebar categories + localStorage persist + auto-expand active | `nav-collapse-spec.md` · `js/ui/nav-sections.js` · `4.69` |
| **Join codec export** | `target` preset id from `/api/presets`; Python `concat_clips` stitch → codec preset encode (DNxHR/ProRes/H.264/HEVC/AV1/FFV1) | `concat_clips` (`video_pipeline.py`), `JoinParams.target`, `/api/presets` · `4.81` |
| **RIFE in Join** | `use_rife` + `target_fps`; smallest 2^k overshoot + exact resample (no 72/96 leak); mux original audio; registers `rifed` variant | `transmute_ops._rife_preprocess`, `sequence_rife_interpolation_spec.md` · `4.81` |
| **Clip variant registry** | `register_variant` / `get_variants` + `/api/variants`; kinds original/rifed/export; association in central cache (no sidecar) | `cache.py`, `sequence_clip_variant_registry_spec.md` · `4.81` |
| **Unified Join Frontend** | Format dropdown (populated from `/api/presets`) + RIFE toggle/fps + variant nodes under pool cards | `js/pool/grid.js`, `js/pool/persistence.js`, `sequence_join_unified_frontend_spec.md` · `4.81` |
| **Simplify pass** | 3-agent review; collapsed per-clip triple-probe → single `probe()`; `asyncio.gather` on probe/hash; shared `RECENT_CAP`; dropped datamosh import | `simplify-code` skill · `4.81` |
| **/api/variants hardening** | Index-only lookup (`lookup_cached_hash`), never hashes caller input on GET (closes CPU/IO amplification) | `sequence_api_variants_security_spec.md` · `4.81` |
| **FastSAM fixes** | Accurate unpadded coordinate clicks (`cv2.pointPolygonTest` on `masks.xy`); 'Everything' mode outputs clean `_assets` directory; native system folder opener `/api/open-folder` | `fastsam_ops.py`, `fastsam.py` · `4.82` |
| **Seq Instant RIFE fix** | Correct slow-mo effective-fps (content density); Instant job progress | `sequence.js`, `transmute_ops._rife_preprocess` · `4.83` |
| **Instant RIFE queue + Stop** | FIFO client queue (no frame skip); main Run busy for whole batch; Stop cancels current + drops queue; Stitch via same path | `sequence.js`, `job-control.js`, `persistence.js` · `4.84` |
| **Instant RIFE badges/strip** | Token badges NEED/Q#/RUN/OK/FAIL + ORIG/RIFED file control; status strip above sequence | `sequence.js`, `pool.css` · `4.85` |
| **Job Stop pulse** | Main Stop pulses + shows elapsed whenever any job/Instant batch is busy | `job-control.js`, `forms.css` · `4.86` |
| **Instant RIFE auto-kick** | Meta-on-Sequence-tab, Time input debounce, post-render scan, Instant enables RIFE | `sequence.js`, `items.js`, `grid.js` · `4.87` |
| **Instant RIFE force probe** | Turning Instant ON probes all seq clips then queues densify; explicit empty-state strip | `ensureSequenceMetaAndInstantScan` · `4.88` |
| **Instant RIFE crash fix** | Fixed missing `_updateSeqVariantBadges` (broke all sequence render + Instant) | `sequence.js` · `4.89` |
| **Instant RIFE densest-wins** | Mid-flight Time/target raise soft-aborts and re-densifies; keep highest M (drop frames later) | `sequence.js`, `abortMainJob soft` · `4.90` |
| **Join preset = file→file transcode** | No dump→PNG for DNxHR/ProRes stitch; normal ffmpeg re-encode | `transcode_with_preset`, `_join_with_preset` · `5.00` |
| **Job workspace on disk** | Default `~/.cache/mtapi/jobs` (not /tmp tmpfs); override `MTAPI_JOBS_ROOT` | `job_workspace.py` · `4.99` |
| **Jobs tab live desk** | Read-only: live server ops + FIFO + Instant queue + done | `jobs.js`, `job_control.list_live_and_recent`, queue snapshot · `4.98` |
| **Sequence token size + layout** | Two-row chips; W/H ± size; min-width stops badge spill | `sequence.js`, `pool.css` · `4.97` |
| **Match click selects pool card** | Clear filter, uncollapse pool, re-render + scroll on match row/Select | `grid.js` · `4.96` |
| **Select RIFED sets multiplier** | Variant menu writes `_rifeMultiplier`; badge uses haveM so NEED does not stick after pick | `sequence.js` · `4.95` |
| **QR Art Generator** | Scannable QR + ControlNet QR Monster (OpenVINO img2img) + optional IP-Adapter (PyTorch ControlNet+IP-Adapter). Scannability badge via pyzbar. | `qr_ops.py`, `qr_art_ov_worker.py`, `js/tabs/qr.js` · **`5.04`** |
| **State tracking / popup spam** | Hydration-complete gate prevents Instant RIFE re-queue on project load; busy-block alerts replaced with logConsole | `sequence.js`, `job-control.js`, `pool/persistence.js` · **`5.02`** |
| **Sequence Audio Engines** | Rubberband DAW flags + 48kHz sample-rate fix + 10ms micro-fade; engine dropdown UI | `sequence-audio-engines-spec.md`, `video_pipeline.py`, `grid.js`, `persistence.js` · **`5.01`** |
| **Instant reuses existing densify** | Hydrate from /api/variants + persist rife_multiplier; NEED only if M insufficient | `sequence.js`, `persistence.js`, `cache.get_variants` · `4.94` |
| **Single-flight restore** | Soft-cancel must not abort fetch (orphaned server job); server rejects concurrent /ops/* | `job-control.js`, `job_queue.py`, `main.py` · `4.93` |
| **Instant re-render storm fix** | Queue no-op no longer re-renders; variants cache; failed no tight-retry; dual RIFE killed | `sequence.js`, `grid.js` · `4.92` |
| **Settings tab (blank)** | Workspace · bare chrome (no global/preview/Run); scaffold for perf prefs | `js/tabs/settings.js`, `css/settings.css` · `4.91` |
| **Universal persistence** | Full desk snapshot: metadata + signatures round-trip, `/api/media_signature`, shared lazy-loader (100px margin, max-5 fallback), settings precedence (project loads never overwrite globals), schema v2 migration, inactive-tab formState | `universal-persistence-spec.md` · **`5.06`** |
| **Settings layout polish** | Tight one-page cards hug content width; Neural FX blurb wraps after “Default is off” | `settings.js`, `settings.css` · **`5.12`** |
| **Settings card layout spec** | House style so new Settings cards ship tight (one-line head, packed controls, max-content width) | `settings-card-layout-spec.md` · **`5.13`** |
| **Catalog UX Phase 1** | Eager memory-restore of saved metadata (no network probe); `POST /api/media_signatures` + `POST /api/variants/batch` (max 100); `window.globalMediaIndex`; persisted-variant fast path (zero variant requests when dense enough); Instant RIFE COW + hash recovery + unreferenced lower-density GC | `performance-catalog-ux-spec.md` · **`5.14`** |
| **Hash-only thumbnail 500** | Hash URLs resolve a recorded source path, skip `thumb_failed` extracts, return 404 not 500; thumb `onerror` no longer POSTs `/api/media/recover` | `thumbnails.py`, `freshness.js` · **`5.15`** |
| **Thumbnail load speed** | Hash-only serve of an existing JPEG does not parse `record.json` or scan `index.json`; browser assigns at most 8 in-flight thumb `src`s | `media.py`, `lazy-loader.js` · **`5.16`** |
| **Viewport-lazy regression** | Default is strictly `viewportLazyThumbnails=true`. `preloadAllThumbnails` is a deprecated legacy alias (`preloadAllThumbnails=true` → `viewportLazyThumbnails=false`). | `lazy-loader.js` · **`5.17`** |
| **Thumb queue coverage** | Size/settings refresh and hash-upgrade src writes go through `assignThumbSrc` (max 8). | `freshness.js` · **`5.18`** |
| **Pay-once thumbs** | `GET ?hash=` is cache-only (404, no ffmpeg). `POST /api/thumbnails/ensure` fills misses in the background ONLY via idle-queue or explicit repair. | `media.py`, `lazy-loader.js` · **`5.19`** |
| **No redo** | Index lookup is path+size (not mtime). Cache-hit media open does not probe/extract/rewrite. Failed extracts stay failed until Retry. | `cache.py`, `open.py` · **`5.20`** |
| **Reload thumbs** | Hash `src` written on the card at render; 8-queue no longer withholds src; L/M serves H if needed | `grid.js`, `lazy-loader.js` · **`5.21`** |
| **Viewport-lazy default enforced** | Default is strictly viewport-lazy per `catalog-interaction-virtualization-spec.md`; settings from localStorage + `/api/settings` only | `lazy-loader.js`, `settings.js` · **`5.22`** |
| **No Instant scan on project load** | Opening a project does not re-probe / re-scan already-known clips | `sequence.js`, `persistence.js` · **`5.23`** |
| **Instant only needs density** | Instant encodes only clips that still need a higher M | `sequence.js` · **`5.24`** |
| **rifeNeed** | `rifed \| needsRife \| noRifeNeeded` on sequence entries | `sequence.js` · **`5.25`** |
| **Instant reads rifeNeed** | No sequence-wide variant scan; Instant uses in-memory rifeNeed | `sequence.js` · **`5.26`** |
| **Scroll keeps thumbs painted** | Hover/transform locked while the pool grid is scrolling; no full-grid restyle; `src` stays on the card | `layout.js`, `sequence.js`, `pool.css` · **`5.27`** |
| **Open does not re-scan thumbs** | Restore copies record meta + thumb flags; hover never calls `media_info`; failed extracts are not GET/ensured again | `pool.py`, `sequence.js`, `freshness.js` · **`5.28`** |
| **Scrollbar width setting** | Settings → UI tweaks. 6–30px. `5.30` actually changes the bar; `5.31` raises the cap to 30px | `settings.js`, `base.css` · **`5.29`–`5.31`** |
| **Preview collapse in header** | Media Output Preview toggles from ▲/▼ in the top bar after Stop. Side tab handle removed | `index.html`, `layout.css`, `app.js` · **`5.32`** |
| **Sidebar collapse is icon-wide** | Collapsed aside is 44px (icons only). Title + logo hide. Saved drag-width no longer keeps it fat | `layout.css`, `app.js` · **`5.33`** |
| **Header title gone** | No redundant tab title in the top bar. V-in/out buttons hug the left | `index.html`, `layout.css` · **`5.34`** |
| **Input preview not sidebar** | Nav `aside` is `.app-sidebar`; input preview is a `div` so collapse/resize no longer shrink it | `index.html`, `layout.css` · **`5.35`** |
| **Catalog virtualization** | Hover/scroll/select never `/api/media_info`. Path-keyed index + bounded queues. Video **and** Image Pool use `.pool-scroll-canvas`. JS scroll work p95 ~1ms. **Partial:** headless rAF p95 is not the spec’s vsync 16.6ms compositor target | `catalog-interaction-virtualization-spec.md` · **`5.37` Partial** |
| **Responsive virtualized pools** | Video and Image Pool use the bounded vanilla virtualizer: visible window + 1.5-screen overscan, recycled shells, hash-only thumbs, and explicit loading placeholders. Sequence.js and server catalog/thumbnail generation untouched. Broader catalog-virtualization performance spec remains Partial. | `grid.js`, `image-pool.js`, `virtual-grid.js`, `pool.css` · **`6.5`** |
| **Pool wall preview** | Default wall is one JPEG: first\|last side by side (120px each). Extra `wall.jpg` is first-only. Settings switch. Prepared on import from extracted first/last. Stable `<img>`; chrome-only recycle. | `pool-wall-preview-spec.md`, `wall-thumbs.js`, `thumbnails.py` · **`6.7`** |
| **Import probes metadata** | New Video/Image Pool adds queue hash+probe+thumbs immediately. Card Repair Metadata is clickable (`pointer-events`). | `items.js`, `image-pool.js`, `pool.css` · **`6.8`** |
| **Import wall not stuck** | New clips keep `path=` wall GET until first/last exist; hash URL is assigned after the combo JPEG is written. | `wall-thumbs.js`, `repair-queue.js` · **`6.9`** |
| **Pool dead-code cleanup** | Removed unused card helpers; `assignCardThumbs` skips wall tenants; viewport-lazy Settings switch gone; no FIRST/LAST labels on `.pool-wall`. | `pool-deadcode-cleanup-spec.md` · **`6.10`** |
| **7.000 release** | Wall that stays painted: one prepared JPEG (first\|last combo default), stable `<img>` tenants, chrome virtualizer, import probe + generate. | `pool-wall-preview-spec.md` · **`7.000`** |
| **Sequence total time** | Header shows sum of clip play lengths (Time override or native). | `sequence.js` · **`7.001`** |
| **Docs slim pass 1** | Archived competing TODO/ideas piles + July root STATUS/TODO/ROADMAP. Live truth is this file. | `docs-slim-plan.md` · **`7.002`** |
| **FastSAM multimodel** | Model selector on FastSAM tab: FastSAM-s (default) + FastSAM-x. Same OpenVINO export path. Phase 2 (SAM ViT-L/H) deferred: ultralytics SAM export crashes (`SAMModel` has no `args`). | `fastsam-sam-multimodel-spec.md` · **`7.002` Partial** |
| **Server-resident catalog** | CatalogIndex hydrates the full cache before serve; display paths read RAM; exclusive process lock; 64 MiB JPEG warmer; `/api/catalog/status`. §11–12 I/O, lock, warmer, restart, Video+Image+Sequence browser checks accepted | `server-memory-catalog-spec.md` · **`5.38`** |
| **Visual Hijack** | Motion-vector payload injection pipeline (`_execute_hijack_pipeline` in `common.py`). Source MVs extracted via `ffgac` → `ffedit -e` → applied to payload via `ffedit -a`. Image payload (file or extracted frame) injected at frame range, smeared by source MVs or frozen constant. Clean source bookends before/after. CLI `-H IMG:START:END[:STYLE]` in `transmute` + `bin/transmute`. `visualhijack` per_frame filter registered in `app/filters/`. 9 unit tests + 4 POC validation tests. Zero decoder errors, zero green pixels, frame count preserved, audio preserved. | `app/operations/datamosh/hijack.py`, `app/operations/datamosh/common.py`, `app/filters/visualhijack.py` · **`7.012`** |


## Recently Shipped (from old §5.2)

| Spec | Version |
|------|---------|
| [server-memory-catalog-spec.md](server-memory-catalog-spec.md) | **`000.000.5.38`** |
| [prompt-library-spec.md](prompt-library-spec.md) | **`000.000.4.61`** |
| [rife-recoherence-spec.md](rife-recoherence-spec.md) | **`000.000.4.60`** |
| [agent-vision-tab-spec.md](agent-vision-tab-spec.md) | Phase A+API **`4.59`** |
| [img2img-openvino-spec.md](img2img-openvino-spec.md) | **`4.55`** + UI tab |
| Txt2img OpenVINO | In tree (op + tab) |
| Image Sort chain, RIFE×128, progress core | ~`4.54` era |

## Fixed Bugs (from old §6)

1. **Autosave can overwrite named projects** → **fixed `4.63`** (session-only autosave; named file only on explicit Save). Full desk snapshot **`5.06`**.  
4. **Inactive tab knobs** not in project JSON → **fixed `5.06`** (formState + continuous desk bindings).  

## Other Implemented Specs (from old §5.4)

| Spec | Intent |
|------|--------|
| [image-compare-spec.md](image-compare-spec.md) | Shared module + **Compare tab `4.68`** |
| [nav-collapse-spec.md](nav-collapse-spec.md) | **Sidebar category collapse** (headers) — **Implemented `4.69`** |
| [deepdream-evolve-video-spec.md](deepdream-evolve-video-spec.md) | **DeepDream Evolve** — **Implemented `4.73`** (stills A+B); multi/video later |

### 000.000.7.013
- Datamosh: Implemented Mosh-ups (from Parker Higgins' automated datamoshing from multiple video sources technique). Added `video` and `shuffle` inject modes to Visual Hijack.
- `_resolve_payload_stills` and `_create_payload_yuv_from_stills` pipelines process multi-image/frame streams to stitch into MPEG-2 payload P-frames.

## 000.000.8.070 — Sequence clip tag + usage counter (2026-09-16)

Per-chip revisit color tag (32-grid popover + Clear, no wheel) with a `#`-sized
tag block on each sequence chip and the same control in the Selected-clip
panel; token background and Time speed colors untouched. Usage counter groups
by original path: neutral `×N` badge on chips used more than once plus an
`in sequence N× (#a, #b)` positions line in the panel. Tag persists as
`tag_color` through session autosave and named projects. Live-proven with real
clicks on an isolated server (pick/clear/independence/reload round-trip, zero
console errors); 261 pytest green (8 new `test_sequence_tags.py`). Caught live:
stray braces from the transport edit broke the module graph in-browser while
plain `node --check` stayed green — use `node --input-type=module --check`
for ESM.

---

## Media Catalog Slices 1–2 (`8.119`)

The music/media database arrives as two shipped slices against
`docs/media-catalog-spec.md` (master v2, superseding `audio-quarry-spec.md`,
`audio-analysis-spec.md`, `backlog/analyzetag-spec.md`).

**Slice 1 — schema + settings.** `app/database/audio_db.py` rewritten from
dead scaffold into the real unified catalog (`media` table over audio/video/
image, provenance + web + analysis columns, 9 indexes, parked `stems`/`slices`
DDL, new `provenance_log`). Provenance is `is_mine` plus the two orthogonal
craft bits `made_by_me` and `ai_involved` — "AI-involved", never "AI-made", so
hand-drawn-then-AI-animated keeps both facts and third-party AI downloads stay
0/0. Write-time invariant `is_mine = is_mine OR made_by_me OR ai_involved` is
enforced at the SQL boundary. Manual rows are never re-asserted by heuristics.
New owned-dirs Settings card (first card) on the in-app folder picker, through
the three-layer settings key pattern.

**Slice 2 — ingest + mine plumbing.** `routes/media_catalog.py`
(query/ingest/mark/undo/generated/status/history, failures HTTP 200 +
`ok:false`), yt-dlp `origin='web'` harvest, generator `origin='generated'` +
`✦ mine` + `AI` stamping fired before the auto-add gate, a delta-only
`auto-catalog.js` pool-import hook for both pools, `source_meta` whitelist for
`origin` + the three bits, the pool token grammar
(`is:mine` `is:hand` `is:ai` `origin:` `site:` `is:youtube` `after:` `before:`
`key:` `bpm:`), a confirm-gated provenance context menu with undo, and card
badges.

**Rev 3 safeguard** (user-requested): clearing provenance now asks first
(house `confirm()`), and every triple write appends to `provenance_log`, so a
bulk change can be undone as a batch (`POST /undo`) or per item; undo restores
the pre-batch triple and never touches analysis columns.

**Bugs found by testing, not reading:** owned-dirs list never repainted after
save (UI lied while the server had changed); `path_is_owned` matched `/music2`
against a rule for `/music`; re-upsert wiped web metadata; `undo_batch` logged
nothing (identical old/new by construction); dir-rule never applied to
existing rows; JS key table drifted from the server's (no-space `Amin`/
`Cmajor`); `/ingest` returned counts so auto-indexed files couldn't know their
own provenance.

**Also:** `main.py` migrated off deprecated `on_event` onto `lifespan`
(invariant 13); pytest warnings 5 → 1, remaining one third-party/test-only.

40 new tests (`test_media_catalog.py`, `test_media_catalog_routes.py`,
`test_media_catalog_tokens.py` — the last loads the real ESM grammar in Node so
server and UI key tables cannot drift). Gate 5/5 (88 modules), 473 suite green,
Playwright-proven on :24590 with real clicks.

---

## Media Catalog Slice 3 — scan op + key/tempo (`8.120`)

The scanner stops being a skeleton. `essentia>=2.1b6` installs on this box as a
single wheel with zero dependency churn — numpy 2.4.6, openvino 2026.3 and torch
2.13 all untouched, so the OpenVINO work carries no risk from this.

`audio_pipeline/scanner.py` is a real walker now: ffmpeg decodes any media file
to a temporary 44.1 kHz mono wav through `shell.run_command` (argv list, never
`shell=True`) — audio file or a video's audio track, one code path — then
Essentia reads key and tempo. Engines are lazily imported, so neither server boot
nor any unrelated request pays the load cost.

`POST /ops/media_catalog_scan` scans a directory: per-item progress, a dry run
that writes nothing, hash dedup so re-scanning an unchanged library is a no-op
(`reanalyze` forces it), and the long-file guard from the analyzetag spec.

**Tempo method was chosen by measurement, not taste.** On a generated C-major
fixture at exactly 120 BPM: `degara` → 120.03 (0.02% error), `multifeature` →
117.61 (~2% off) but the only one with a usable confidence. So `tempo` comes from
degara, `tempo_conf` from multifeature (raw confidence is unbounded → clamped to
0–1), with a >10% disagreement falling back to multifeature. Both raw estimates,
the chosen source and the disagreement ratio land in `raw_metadata.tempo_alternates`
and the sidecar, so disagreement stays visible rather than being averaged away.

Beats and MIDI refuse loudly (`ok:false` naming Slice 4) instead of quietly
producing nothing — a wrong beat grid is worse than no beat grid.

Analysis now reaches the pool: `pool.py` grew a float path (`tempo`,
`tempo_conf`) plus `key_name`, and the ingest hook mirrors key/tempo onto
`source_meta`, so `key:`/`bpm:` tokens and the teal `key · BPM` chip work on any
analysed file.

Two bugs caught by tests: the op indexed each file (stamping `status='scanned'`)
*before* asking whether it needed analysis, so every fresh row looked
already-analysed and nothing was analysed; and the sidecar wrote SQLite `0/1`
where it promised booleans.

18 new tests assert against real ground truth (a generated C-major 120 BPM file
must return `C major` within 1%), not mocks. Gate 5/5, 493 suite green. Live
through the real HTTP op: `indexed=3 analyzed=3 unchanged=0 no_audio=0 errors=0`,
`?key=Cmaj` returned exactly the C-major track at `tempo=120.03`, and Playwright
confirmed `key:Cmaj`, `bpm:118-122` and `is:mine key:c major bpm:120` each select
only the right card.

**Also in Slice 3:** scans now sweep rows under the target directory whose file
has vanished and mark them `status='missing'` instead of leaving them claiming
`analyzed` forever — found live, after moving a fixture folder and seeing three
ghost rows. Rows are never deleted (a mount may come back) and the sweep is
scoped to the scanned directory, with tests for both the restore path and the
cross-directory isolation. Suite now 495 green.

---

## Media Catalog Slice 5 — the Media Catalog tab (`8.121`)

The payoff slice. New Library-section **Media Catalog** tab (`data-tab="mediacatalog"`):
scan card (directory + in-app folder picker, Recursive, Re-analyze, four analysis
toggles, long-file guard, Scan/Dry Run) driven through the standard job machinery
so progress and cancel are free; an honest engine-status pill per analysis engine
with the unwired ones' toggles disabled until installed; a facet sidebar (search,
type, ✦ mine / HAND / AI / origin, 24-scale key dropdown, tempo min–max, site,
status incl. `error` and `missing`); and a **virtualized** table — pad divs plus a
windowed slice, server-side paging that loads more on scroll, per-row play/stop
through the existing Range-capable `/api/video` route, inline audio player, ✦
provenance, and `→I` send to Media In.

Three bugs caught by clicking rather than reading:

1. My own CSS wrote `.mc-dir-picker { flex: 1 1 320px }` inside a **column** flex
   container, so `flex-basis` sized the *height* — the directory input rendered
   320px tall. Measured live (input 320 / picker 320 / field 337) instead of
   guessing, then dropped the shorthand.
2. `→I` put a **directory** into the global Media In box, which then probed a
   folder as media. Root cause was Slice 2's generator stamp running before the
   media-type gates, so the scan op's directory `output_path` was stamped as a
   generated *file* (`type=unknown, origin=generated`) and won the click. The
   stamp now requires a real catalogable media path — audio extensions included,
   since Music and Stems outputs are `.wav` — with tests pinning
   guard-before-fetch and the audio list.
3. Even then the preview panel showed "File generated: scanlib". A scan generates
   nothing, so the op now returns `output_path=None` and carries the directory in
   `meta.scanned_directory`.

Gate 5/5 (89 modules), 498 suite green (3 new). Playwright-proven on :24590: a
scan run *from the tab* reported "Scan complete" with
`indexed=3 analyzed=3 unchanged=0 no_audio=0 missing=0 errors=0`; key=C major → 2
rows, +100–130 BPM bound held at 2, Clear filters → 11, ✦ Mine only → 7,
type=audio → 8; inline playback started; `→I` landed the file; re-scanning created
no directory row. Proof in `junk/mediacatalog_tab_final.png`.

---

## Media Catalog Slice 4 — beats + MIDI (`8.122`)

The last two analysis toggles went live, and **the spec's engine plan changed
because it was measured rather than assumed.** It assigned madmom + aubio +
Basic Pitch; all three were wrong for this box:

- **madmom cannot build** — undeclared Cython build dependency, and its numpy<2
  pin would fight the installed numpy 2.4.6.
- **aubio** would only duplicate what Essentia already provides.
- **basic-pitch would downgrade tensorflow 2.21 → 2.15**, breaking the
  styletransfer Magenta path from 8.074. Rejected outright.

So Essentia carries beats and onsets as well (`BeatTrackerMultiFeature` +
`OnsetRate`), and **mido** — one clean wheel — writes the `.mid`.

Beats land with a beat grid, per-beat confidence, onset list and rate, and
downbeat phase is picked from the onset-density profile across the four
candidate offsets. **Meter is assumed 4/4 and carries `meter_assumed: true`**:
this Essentia wheel has no `LoudnessBandRatio`, so its `Meter` (which needs a
band-ratio beatogram) is unavailable — and silently guessing would have been the
dishonest option.

**The MIDI is a tempo map, not transcription:** tempo meta-event, one short blip
per beat, accented (velocity 100) notes on the detected downbeats. The sidecar
says so in `midi_note: "… NOT note transcription"` — a fabricated note grid would
be worse than none. The scaffold's `_write_midi_sidecar` TODO is finished.

One source of truth for engines: `scanner.engine_status()` reports five real
roles, and both the `/status` route and the tab's gating read it — which fixed the
UI disabling the beats toggle for an engine that was never involved.

504 suite green (6 new tests), all against ground truth: the 4/4-120 fixture must
return a median beat interval of 0.45–0.55s, downbeats ~2.0s apart,
`meter_assumed` true, and a `.mid` that re-parses at ≈120 bpm with one blip per
beat and exactly the downbeats accented. Live on :24590 via the tab's own Beats +
MIDI toggles: engine row showed essentia/mido green and the three parked engines
grey; the re-parsed MIDI on disk read **120.03 bpm, 31 beat blips, 8 accented
downbeats**, with the sidecar carrying `C major / 120.03 / 4/4 / 31 beats /
25 onsets`.

---

## Media Catalog Slice 7 — isolated audio venvs + competing opinions (`8.123`)

The user asked for the audio worker to move into its own venv, for *all* the
libraries, and explicitly for **duplicates** — several engines answering, so the
user can judge them on real files before deciding whether to keep one or always
keep more opinions.

**Isolation turned out to be mandatory, not tidy.** basic-pitch wants TF 2.15
and would downgrade the app's TF 2.21, breaking the styletransfer Magenta path;
madmom needs Python ≤3.9 (`collections.MutableSequence`) plus old numpy. So
there are now two worker venvs, called as subprocesses:

- `.venv-audio` — py3.11, numpy 1.26, TF 2.15: essentia, librosa, basic-pitch, mido
- `.venv-audio-legacy` — py3.9, numpy 1.20.3: madmom

The entry point `tools/audio_worker.py` imports nothing from `app` (that is what
lets it run under an interpreter older than the app's own syntax), takes
`--wav/--want/--engines/--midi-out`, and prints one JSON object behind a
`@@MTAPI_AUDIO_JSON@@` sentinel so engine chatter can't corrupt it. A missing
engine is reported, never fatal. Rebuilt by `scripts/setup_audio_venvs.sh`, both
gitignored, paths overridable via `MTAPI_AUDIO_VENV` / `MTAPI_AUDIO_LEGACY_VENV`.

**The duplicates exist, and nothing is averaged away.** One fixture file yields
3 tempo opinions (essentia-degara 120.03, essentia-multifeature 117.61,
librosa 0.0), 3 beat trackers (essentia 31, madmom 33, librosa 0), 2 onset
detectors (essentia 25, librosa 39) and 1 key detector — all kept in the
sidecar's `engine_opinions` and `raw_metadata.opinions`. The DB columns hold a
consensus from an explicit preference order, and engines reporting 0.0 can never
win. `tempo_spread_bpm` (2.42 on the fixture) and `beat_counts_by_engine` exist
so the engines can be judged rather than trusted.

`include_extra_opinions` (default on) is the duplicate switch, with the cost
measured rather than hidden: **~16 s/file with extras vs ~3 s/file without**
(5.4×) — each extra engine is another subprocess.

Downbeat phase and the assumed 4/4 meter moved out of Essentia into the scanner,
because which beat is beat 1 depends on the recording, not the tracker.

**Two libraries could not be installed, honestly:** aubio (0.4.9's C bindings
don't compile against any modern numpy; no wheel exists; the system CLI needs
root) and keyfinder (broken sdist, missing `keyfinder/constants.h`).

Basic Pitch runs and writes valid MIDI but found **0 notes** on a synthetic sine
fixture — which is exactly why the next assignment is pointing a scan at real
material. 520 suite green (15 new tests).

---

## Media Catalog Slice 8 — tags, tracker headers, tag-vs-detection (`8.124`)

The user asked to read tags "not just tags I guess? I mean like the headers as
well, any acidized or similar stuff". The 10-FLAC library at `junk/at` turned
out to be a DJ library carrying real annotations — `key`, `initialkey`,
**`camelotkey`**, `playlistkey`, `bpm` — which is exactly the ground truth needed
to judge the detectors.

**Two sources.** ffprobe (~50 ms, every index pass) for Vorbis/ID3/iTunes/RIFF,
plus a **pure-Python tracker-header parser** for XM/IT/S3M/MOD — not audio
containers, so ffprobe reads nothing from them — capturing title, tracker,
channels/patterns, MOD sample names, initial BPM, and detecting **acidized**
modules from their credit strings.

Promoted tag columns plus the full unnormalised `tags_json`, added by explicit
`ALTER TABLE` migration with a test that upgrades a real previous-version
database **without losing rows**. Tracker headers win conflicts over container
tags (the author typed those; container tags get rewritten by transcodes).
Keys normalise for comparison (`Abm` → `G# minor`) while the raw tag is kept.

**Tag-vs-detection per row:** `tempo_vs_tag_bpm`, `tempo_agrees_with_tag` (±2%
or 1.5 BPM), `tempo_octave_equivalent`, and pitch-class key comparison that
handles enharmonics and names a relative key instead of calling it wrong.

**Two findings from the user's own files changed the code:**

1. **Octave errors dominate.** `top41` detected 82.03 against a tagged 164;
   `sylenth111` 83.01 against 160. So the fixed preference order became
   `tempo_consensus_by_vote`: tempi fold into octave groups so a majority can win
   *across* octaves, while the split is judged on the **raw** values (folding
   would hide exactly what must be seen) and reported as `tempo_octave_split`.
2. **Key detection has systematic bias.** Every `1A`/Abm track detected as
   `Eb minor` — one consistent fifth, not three separate bugs.

Measured on the library: tempo within 2% of tag **4/10**, exact key match
**3/10**, octave-equivalent misses **4/10**, and `space2.flac` returned tempo
1.0 (a detection failure now flagged as the next fix). The tab shows it inline —
`D minor · 108.0 · 7A · tag 109 (-1.0) ✓` versus
`C minor · 82.0 · 6A · tag 164 (-82.0) ×½?` — and the musical column was widened
after a live check caught it clipping.

549 suite green (26 new). Live re-scan: `indexed=10 tagged=10 analyzed=0
unchanged=10` in **1 second**, because hash dedup skips analysis while tags still
refresh.

---

## Media Catalog Slice 9 — source of truth (`8.125`)

The user set the rule precisely: *"we store everything and for each track we
can select which we want to use for anything with disagreeing numbers. We should
default to the tagged tempo … we don't do anything destructive. We keep all the
numbers. The only variable is the one we choose as the source of truth."*

Implemented literally. `tag_bpm`/`tag_initial_key` (the owner's tag) and
`tempo_detected`/`key_detected` (the engines) are both stored permanently;
`tempo`/`key_name` hold the **effective** value used for filtering and the UI,
with `tempo_source`/`key_source` saying which is in charge. **A tagged value
wins by default**, and `apply_source_defaults` only touches rows whose choice is
not manual — so an explicit selection survives later scans and even a re-tag.
Tempo and key switch independently. The Catalog tab shows a clickable
`⚡ tagged` / `⚡ detected` chip per row.

Library state after the pass: **9/10 tracks using the tagged tempo, 10/10 using
the tagged key**, with every detection preserved beside it. Live proof:
`top41.flac` switched by click from `⚡ TAGGED` (164.0) to `⚡ DETECTED` (82.0)
while its tag stayed on screen and a neighbouring track stayed tagged.

**Two bugs caught by testing:** my SQL edit added the new columns' *values*
without their placeholders (11 bindings vs 13), marking every analysed row
`status=error`; and the tag-vs-detection delta read the *effective* value, so
once the tag won it showed 0.0 everywhere and hid the very disagreements it
exists to surface.

**Honest migration note:** rows analysed before this split had their detection in
`tempo`/`key_name`; reusing those columns for the effective value left the
detection only in the sibling `.json` sidecar, so
`backfill_detected_from_sidecars()` recovers it on the next scan. Rows with no
sidecar keep NULL — nothing is invented.

563 suite green (17 new tests).

---

## Media Catalog table v2 — reference design, short keys, relatives (`8.126`)

User request: tighten the whitespace, spell keys as short as possible (`M/m`,
`#/b`), add an optional complementary-key column, faint dividers, sortable by
anything, columns on/off switches — in the language of the reference tables.

The Catalog table now uses the reference header shape (toggle-checkbox +
`⇅`/`▲`/`▼` on top, rotated labels), faint dividers, a `min-width` so wide
screens grow File instead of crushing cells, and the house collapse rule
(hidden columns shrink to a strip, never vanish) with visibility in its own
localStorage key. Sorting travels with the query (server-side, since paged):
click for `<column>_asc`, again for `_desc`, NULLs/empties last in both
directions, enforced in SQL.

Keys are stored long and displayed short (`G#m`, `CM`) — one table server-side
and one in `js/utils.js`, pinned together by the Node contract test, full form
on hover. The **Rel** column is the complementary (relative) key with its
Camelot (`Am · 8A`), computed server-side; a test asserts the fundamental
invariant that relatives share a Camelot number. Pool musical chips shrunk the
same way.

Caught by clicking: the new musical column clipped longer rows live, and the
fresh `⚡ TAGGED` chip truncated at 66px — measured per cell, then widened.
Playwright: BPM asc/desc both directions, key sort with empties last, Rel
toggle collapse + persistence, combined filtering unchanged. Gate 5/5.

---

## Media Catalog: bare workspace + content-sized table (`8.127`)

Follow-up on the v2 table. The "Media Output Preview" panel and the "Input
Preview · set a path above" strip are gone from this tab — it joined the
Dart/Notes bare-workspace pattern (`hideRun`, `noGlobalInputs`,
`mediacatalog-tab-active`, `input-preview.js` HIDE_TABS), so the table owns the
whole workspace. The `→I` send and inline audio playback are untouched.

The File column was greedy (`1fr`) and shoved the late columns off the edge, so
it is now capped with a trailing spacer column absorbing leftover space —
columns use only what they need. Tags cap at one line with the list on hover.
A duplicate-badge bug (badges in both the File cell and the Tags column) went
with the rewrite, taking rows from 59px to 42px. Virtualization measures the
real row height from the DOM instead of trusting a constant.

Playwright: both panels `display: none`, first row's action buttons fully
visible, measured rows. Gate 5/5.

---

## CDP integration spec: reviewed, pinned, spike-proven GO (`8.128`)

The as-found Composers Desktop Project proposal (`bd7a7fa`) was reviewed and
de-risked. `cdp-wasm` **0.7.0** is now pinned (zero runtime deps,
`(MIT AND LGPL-2.1-or-later)`); every 0.6.0-era catalog claim was verified
against the real package: 232 effects across 110 programs, 16 generators, 215
bundled programs (26 spectral), 3.2 MB tarball.

The §10.3 de-risk spike ran and returned GO. The tarball was fetched from the
npm registry into `junk/cdp-spike/` (gitignored) and served as plain static
ESM — no npm, no bundler. A module Worker rendered `modify speed 2` (5 s
stereo −12 → exactly 2× frames) and the `pvoc anal 1 → blur 20 → synth` wrap;
re-runs audio-identical; `terminate()` killed a mid-`stretch` render in <1 ms;
worker bytes POSTed to a server artifact endpoint size-exact; a 60 s stereo
20.2 MB probe rendered in 3.5–6.7 s. Playwright 1.58.2 clicked Run in real
Chromium: 8/8 checks, 0 console errors (`junk/cdp-spike/spike_proof.png`).

Two measured findings changed the spec. (1) Whole-file byte-comparison is the
wrong determinism bar: libsndfile stamps `PEAK`/`LIST` RIFF chunks with
wall-clock timestamps (1–3 bytes differ run to run) while the `data` chunk is
always identical — §5.2's re-run contract now compares the `data` chunk.
(2) `pvoc anal` requires mono input; the wrapper's `analyse()` already
enforces it, and §4's file-type discipline must gate channel count too.

Memory readout is an honest gap: headless Chromium refuses
`measureUserAgentSpecificMemory` and Workers expose no `performance.memory`;
the true WASM peak estimator stays Phase-1 work. [A2] closed; [A1] staged for
the user's yes before Phase 1. Gate 5/5.

---

## CDP Phase 1: "run ten tools well" ships (`8.129`)

User confirmed [A1]. The vendored `cdp-wasm` 0.7.0 runtime now lives at
`app/static/vendor/` (gitignored, fetched by
`mtapi-project/scripts/update_cdp_wasm.sh` with a pinned sha512) and is served
through a new binary-safe `/vendor` StaticFiles mount — the `/js` route
`read_text`s everything, which would have corrupted the `.wasm` binaries. The
gate's source scans now exclude vendored dirs: Emscripten's dynamic
`./this.program` imports are not repo code.

New Library tab **CDP Tools** (`js/tabs/cdp.js` + `css/cdp.css`, bare-workspace
pattern): 11 tools — 8 curated from the EFFECTS catalog (modify.speed,
modify.brassage, blur.blur, hilite.trace, stretch.time, distort.overload,
grain.omit, envel.dovetail) plus raw `pvoc anal`, `pvoc synth` and `sndinfo` —
with search, schema-rendered params, verbatim CDP usage, a live raw-argv
preview, and stage-honest progress. Execution runs in `js/cdp/worker.js`;
the server (`app/routes/cdp.py`) only validates inputs against the Phase-1
caps with real numbers, decodes canonical WAV via ffmpeg, and ingests
rendered artifacts beside the source with the Media Catalog generated stamp
(audio only — `.ana` intermediates are not catalog citizens, §6.3).

Three bugs caught in the live pass. Posting the full EFFECTS entry to the
Worker threw `DataCloneError` — 0.7.0 entries carry function-valued
`srcMin`/`srcDefault`; the Worker now gets a slim descriptor and looks the
entry up in its own catalog. `finalize_output_path`'s generic default
extension silently renamed WAV outputs to `.png` — caught by the route test,
fixed with explicit `default_ext=""`. This box's ffprobe 9 rejects
`-nostdin` (invariant 13) — the prepare route drops it for ffprobe; ffmpeg
keeps it.

Verification: gate 5/5 (91 modules), 581 suite green (11 new route tests),
Playwright 17/17 with real clicks and 0 console errors — including the
over-limit refusal with numbers, a real blur render landing on disk with the
catalog stamp and an inline player, mid-render cancel leaving no partial
file, and the last tool surviving reload.

---

## Media Catalog table: tooltips purged + column rebalance (`8.130`)

User correction: no native tooltips on this tab — the bottom help strip is the
location, and the house already audits it (`HelpStrip.audit()`). All 10 native
`title=` popups introduced with the v2 table are gone (9 catalog, 1 settings,
1 pool badge), each replaced with `data-help-title`; the tab now reports zero
audit hits. Hovering a row shows its full path in the strip.

Layout, measured at 2560px: File 180–520px, Tags capped at 140px, Src 88px,
Act 72px, spacer absorbing 787px of leftover at the end, worst row overflow 0
across 10 rows, no horizontal overflow. Every `.mc-cell` audited for
`overflow: hidden; min-width: 0`. Gate 5/5.

---

## Media Catalog table: single-line headers, tight cells (`8.131`)

Follow-up fixes, all measured live at 2560px. Sort arrows (`⇅`) render only on
the actively sorted column now — every other header is a single rotated label
line, and clicking any sortable header still sorts (the active direction moved
into the header's bottom-strip help text). Cell right padding 6px → 3px,
Act 72px → 86px so both buttons fit with room, File capped wider (180–520px),
Tags capped tighter (0–140px), spacer still absorbing leftovers at the end.
Zero `mc-sort-arrow` elements with no active sort; exactly one `▲` after
clicking BPM; every Act button and SRC chip measured fully inside its cell;
worst row overflow 0; no horizontal overflow. Gate 5/5.

---

## CDP Phase 2: full menu, favorites/recents, linear pipelines (`8.132`)

Phase-2 acceptance shipped. The CDP menu now exposes the whole vendored
catalog: all 232 curated effects drilled category → program → mode, all 215
raw programs from the build manifest (each a zero-interpretation runner
seeded with the verbatim usage text parsed from the vendored man pages —
the update script now vendors `man/`), and 5 hand-listed raw modes with
explicit `.ana` types for building explicit analysis/resynthesis chains.
Favorites (★) and last-15 recents persist across reloads.

Linear pipelines arrived (`js/cdp/pipeline.js`, schema
`mtapi-cdp-pipeline/1`): Tool/Pipeline modes over one menu, steps with
per-step values, bypass, reorder, a type-graph validator that names the fix
("expects .ana but the chain provides .wav — insert pvoc anal") and refuses
curated spectral effects fed `.ana` (applyEffect owns the pvoc wrap — never
silently converted), 22 two-input effects via a second prepared input
(morph.bridge proven), per-step artifacts saved as steps complete, and
schema-versioned save/download/load JSON. Breakpoint envelopes (any
ENVELOPE_PARAMS parameter → time/value textarea → `extra.brk`) work in
single-tool mode this phase.

13 Node contract tests pin the model in `tests/test_cdp_pipeline_model.py`
(the 4-step recipe type graph, mismatch-fix messages, bypass, info-tool
refusal, schema rejection, cloneable slim steps, man-usage extraction).
Playwright acceptance 21/21, 0 console errors: full menu counts, search, man
usage, favorites across reload, recents, the §3.5 recipe end-to-end (4
artifacts with `.ana` intermediates and a listenable final wav), save →
fresh session → load → re-run, and the morph 2-input step.

Two click-caught races fixed: the Input-2 change handler re-rendered the
pipeline page and swallowed the click that blurred the field (state-only
update now), and the post-prepare re-render overwrote the prepare summary
(persisted note). Gate 5/5 (92 modules), 594 suite green. Shipped as 8.132 —
8.130/8.131 went to the concurrent catalog-table session mid-flight.
