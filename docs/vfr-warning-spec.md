# VFR Warning — builder prompt & spec

> **Status:** Spec ready, not started
> **Category:** Frontend / Media integrity
> **Origin:** discussion after `8.104`. Follows `frame-scrubber-spec.md` (Frame Peek).

---

## 0. Builder prompt (copy-paste this)

> You are working in `/home/m/snc/cod/ffTransmuteWebui-wip` (branch `wip`). Read
> `AGENTS.md` and `docs/STATUS.md` first — they are law, not suggestions.
>
> **Mission.** The user has decided: *we should never work with VFR media.* VFR
> (variable frame rate — uneven frame timing) breaks every place the app turns a
> frame number into a timestamp, and it already produces silently wrong output
> (see §1). Detection already exists; the data is already computed. What is
> missing is that the app never *tells* you, and throws away the signal on
> session reload.
>
> Build, in this order, and stop at the end of **Slice A** for review:
>
> - **Slice A — make the signal survive, and show it.**
>   1. Persist `fps_avg` (and `is_vfr_guess`) through the two allowlists that
>      currently drop them, so a VFR verdict survives a session reload.
>   2. One shared client helper `isVfrClip(meta)` mirroring the server rule
>      exactly. Zero extra network calls.
>   3. A `VFR` badge in the pool card row that already displays fps — and fix
>      the wrong number while you are there (the card shows the *nominal* rate).
>   4. A `VFR → Normalize` affordance that calls the **existing, already
>      proven** `batchNormalizePool()`. Do not write new conversion code.
>
> - **Slice B — separate ticket, not in this build.** The before-Run guard
>   (§4) has an open design question and needs its own assignment. The A/V
>   desync fix (§5) is a one-line change that rides along with it.
>
> **Hard constraints.**
> - Gate first: `./check-gate.sh` must be 5/5 before pytest and before any
>   Playwright session. `./check-gate.sh --selftest` re-proves the gate.
> - Playwright, real clicks. Curl is not UI proof.
> - Browser-clicked before you claim DONE.
> - No frontend framework. Vanilla HTML5/CSS3/ES6.
> - Bump the `?v=` cache-bust on every module you change, and on every module
>   that imports one you changed. A stale cached copy shipping without your
>   feature is a known failure mode in this repo — `js/tabs/settings.js` was
>   imported unversioned and did exactly that.
> - Do not touch the ~40 remaining dead `#giVideo`/`#giImage` sites. Out of
>   scope; logged separately.
> - Never `shell=True`. No subprocess in `main.py`. `report_progress()` on
>   every item.
>
> **Definition of done for Slice A:** a VFR clip imported today still shows its
> badge after restarting the app, the card no longer lies about its frame rate,
> and one click replaces it with a CFR sibling. Gate 5/5, full pytest at the
> known baseline, Playwright-proven with real clicks, screenshot to
> `mtapi-project/junk/`.

---

## 1. Why this is not cosmetic — the confirmed bug

This is the strongest argument for the whole feature, and the builder should
verify it before writing any UI.

In `app/video_pipeline.py`, a range-trimmed clip gets:

- **video** trimmed frame-exact, `video_pipeline.py:296-301`:
  ```python
  argv.extend([
      "-vf", f"select='between(n\\,{n0}\\,{n1})',setpts=PTS-STARTPTS",
      "-fps_mode", "vfr",
  ])
  ```
  `select=between(n,…)` counts frames. It is frame-rate independent — correct
  on VFR by construction.

- **audio** trimmed by wall-clock, `video_pipeline.py:357-368`:
  ```python
  start_t = n0 / fps
  end_t = (n1 + 1) / fps
  a_argv = [..., "-ss", f"{start_t:.6f}", "-to", f"{end_t:.6f}", ...]
  ```
  where `fps` is the **nominal** `r_frame_rate`.

On a VFR clip those two disagree. Measured on the repo's own test fixture
`mtapi-project/junk/cutShortInCutTab.mp4` (577 frames, `r_frame_rate=60`,
`avg_frame_rate=24.025`): cutting at frame 240, the video is correct while the
audio is trimmed from `240/60 = 4.00s` — but the picture is actually at
`240/24.025 = 9.99s`. **A ~6 second A/V offset, silently, on every VFR cut
that has sound.** That is the bug the badge exists to prevent.

## 2. What already exists (do not rebuild it)

| Thing | Where | Note |
|---|---|---|
| VFR detection | `app/video_pipeline.py:86-91` | 1% rule, see §3 |
| Scan endpoint | `POST /api/vfr_scan` → `app/routes/media.py:54-63` | only route exposing `is_vfr_guess` |
| Scan client | `js/pool/auto-vfrcfr.js:84-104` `scanCurrentMedia()` | **computes the right answer and discards it into the console** |
| Convert op | `POST /ops/cfr` → `app/operations/cfr_ops.py` | Path A (`use_rife:false`) is one fast ffmpeg pass |
| Batch convert | `auto-vfrcfr.js:62-82` `batchNormalizePool()` / `:106-146` `batchNormalizeSequence()` | proven; Settings calls them |
| Settings UI | `js/tabs/settings.js:169-177` + `:339-371` | "Auto-reencode VFR to CFR", CFR FPS, "Scan VFR", "Normalize pool + Sequence" |
| Client rule | `js/media-urls.js:61-83` `globalFps()` | already the exact twin of the server rule |
| Average rate on the wire | `GET /api/probe` and `GET /api/media_info` both return `fps_avg` | added for the frame peek |

**The client's `/api/media_info` probe already returns `fps` and `fps_avg` for
every probed clip.** So a badge needs **zero extra network calls** — derive it.

## 3. The detection rule — match it exactly

`app/video_pipeline.py:85-91`, verbatim:

```python
    # VFR guess: r and avg disagree beyond 1% relative (both must be sane).
    is_vfr_guess = False
    try:
        if fps > 0 and fps_avg > 0:
            is_vfr_guess = abs(fps_avg - fps) / max(fps, 1e-9) > 0.01
    except Exception:
        is_vfr_guess = False
```

- strictly `> 0.01` relative, normalised by the **nominal** rate;
- **both** rates must be `> 0`. An `avg_frame_rate` of `0/0` yields
  `fps_avg == 0`, which is *not* a VFR verdict — it is *unknown*. Preserve
  that distinction in the UI (see §4.3).
- Note `fps` and `fps_r` in the probe result are the same number
  (`video_pipeline.py:109-110`); `fps` = nominal `r_frame_rate`.

The client twin already lives at `js/media-urls.js:72`. Extract it rather than
writing a third copy.

## 4. Slice A — the build

### 4.1 Make the verdict survive a reload (do this FIRST)

Today the signal is computed, handed to the client, and then **thrown away on
save by two independent allowlists**:

- `js/pool/persistence.js:26`
  ```javascript
  const META_KEYS = ['duration', 'fps', 'width', 'height', 'video_codec', 'audio_codec', 'frames', 'has_audio'];
  ```
  consumed by `serializeMeta()` (`:64-71`), which is called from both
  `serializePoolItem()` (`:95`) and `hydratePoolItem()` (`:114`) — so it strips
  on save *and* on load.
- `app/media/pool.py:28-31`:
  ```python
  _META_FLOAT_KEYS = ("duration", "fps")
  _META_INT_KEYS = ("width", "height", "frames")
  _META_STR_KEYS = ("video_codec", "audio_codec")
  _META_BOOL_KEYS = ("has_audio",)
  ```
  applied by `_normalize_meta()` (`:174-197`).

And restore is **cache-first** — `persistence.js:625-626` and
`repair-queue.js:145` both skip re-probing an item whose meta is already known.
So a badge built without this fix lights up on a fresh import and silently
vanishes after every restart.

**Do:** add `fps_avg` to both float lists, `is_vfr_guess` to the bool list, and
the matching entries in `META_KEYS`. Consider also having `_probe_media_full`
(`app/main.py:158-174`) compute and return `is_vfr_guess` so the server and
client can never disagree — today `_probe_media_full` returns `fps_avg` but
**not** `is_vfr_guess`, so `open.py:172`'s `is_vfr_guess` allowlist entry is
dead code on that path.

**Re-verify:** the builder must re-read both files before editing. Treat the
line numbers above as a starting point, not gospel.

### 4.2 One shared helper

`isVfrClip(meta)` returning `'vfr' | 'cfr' | 'unknown'` (three states, because
`fps_avg === 0` means unknown, not cfr — §3). Put it next to `globalFps()` in
`js/media-urls.js` so the two 1% rules cannot drift, and have `globalFps()`
consume it.

**Never call `/api/vfr_scan` per card.** `scan_vfr_paths`
(`video_pipeline.py:128-163`) is uncached, serial, and spawns **2 ffprobes per
file** — a 200-clip pool is 400 subprocesses. It is for the Scan button and
backfill only.

### 4.3 Where the badge goes

Ranked. All four are cheap; do the first two, the rest if the card still reads
cleanly.

1. **Pool card, in the row that already shows fps.** `buildPoolMetaHtml()`
   (`js/pool/persistence.js:1220-1270`); `row2` at `:1256-260` is
   `duration · {fps} fps · {frames} frames`. All three paint sites already
   funnel through this function (`grid.js:81-86`, `chrome.js:130-167`,
   `items.js:49-50`). The badge is therefore a one-place change.

   **Fix the lie at the same time.** That row prints `m.fps`, the *nominal*
   rate — a VFR clip is labelled "60 fps" while playing at 24. Show both:
   `24.02 avg (60 nominal)`. Also in the ⓘ clip-info panel (`grid.js:975-989`)
   and the focus panel (`js/pool/sequence-select.js:156-179`).

2. **Media preview info bar** — a sibling of `#mediaArBadge`, which is the exact
   precedent: a `span` set from JS, hidden when empty
   (`js/preview.js:16-28`, CSS `css/console.css:33-46`, incl. the `:empty`
   rule). ~10 lines. **Reset it in both places that write that bar**:
   `showPreview()` (`preview.js:119-121`) *and* `seqLoadClip()`
   (`js/pool/sequence-transport.js:418-424`) — the sequence player writes it
   directly and will otherwise leave a stale badge.

3. **Sequence token** — `.seq-token-rife-host`
   (`js/pool/sequence-composer.js:334`) is the designated badge host; the RIFE
   badge lands at `:357-370` and the conform badge at `:371-378`, with
   lifecycle classes in `css/pool.css:1123-1178`. **Trap:** the click guard at
   `sequence-composer.js:421` filters known badge classes — a new class must be
   added there or the badge swallows clicks on the token.

4. **Global Media In overlay** — `#globalProbeOverlay` (`index.html:495`),
   rendered in `app.js:649-668`, already prints bracket-delimited probe facts
   (`[ 1120x832 | 577 frames ]`). Appending a `VFR` chip is a one-liner and it
   is the last place you look before pressing Run. Two traps: `/api/probe` does
   **not** return `is_vfr_guess` (derive client-side from `fps`/`fps_avg`), and
   this block re-fetches on **every** `updateGlobalInputs()` call, i.e. every
   keystroke in the box (`app.js:921`) — so do not add a second round-trip here.

### 4.4 Make the badge actionable

A red dot tells you something is wrong; a button fixes it. Reuse the proven
conversion path — `js/pool/auto-vfrcfr.js` `batchNormalizePool()` (`:62-82`) —
which already removes the VFR item and re-adds the `_cfr` sibling. Mirror the
RIFE badge's lifecycle vocabulary (`is-need` / `is-queued` / `is-running` /
`is-done` / `is-failed`) so the two read as one system.

**Do not** write new ffmpeg argv, a new op, or a new detection rule.

## 5. Slice B — separate ticket

### 5.1 A/V desync (one line, highest value per line in the whole plan)

`app/video_pipeline.py:357-358` should derive the audio trim from real frame
timestamps, not `n0 / fps`. `video_pipeline.pts_map()`
(`app/video_pipeline.py:176`) already returns exact per-frame PTS
(`{"pts": [...], "unit": "s", "count": N}`) and is currently used only by the
PTS-aware RIFE path in `cfr_ops.py`. Until this lands, every VFR cut with audio
is wrong — see §1.

### 5.2 The before-Run guard — needs a decision, not a ticket

**Open question the builder must answer with the user first:** where is "the op
boundary"? VFR only hurts where frame numbers are arithmetic, so the guard
belongs on the frame-range ops, not on the pool. But "warn before every frame-
range run" is noisy, and "warn on import" fires before you have the file in
your hands and is therefore useless.

Recommended resolution: **import-time badge (non-blocking) + use-time guard
(blocking, with a Convert / Run anyway choice, once per clip per session).**
Do not build this until that is agreed.

## 6. Deliberately deferred

**Do not change `probe_fps` (`app/probe.py:29-51`) to prefer `avg_frame_rate`
in this build.** 21 Python sites and several JS sites consume the nominal rate;
it is a real surgery with a wide blast radius, and it is exactly the kind of
change that should be driven by data rather than suspicion. Converting media to
CFR makes `r_frame_rate == avg_frame_rate`, so the whole set goes quiet for
converted clips. Badge first, measure how many VFR clips actually reach the
pool over a few weeks, then decide.

For reference, the sites that are **already** VFR-correct and need no change:
`js/media-urls.js:61-83` + its consumer `js/frame-peek.js:101`, and
`app/operations/datamosh/common.py:512-517` (the only Python frame→time site
that uses the average). Plus the frame-index-exact decodes
(`thumbnails.py:792`, `datamosh/common.py:125,900`), which need no rate at all.

## 7. Acceptance criteria

- **AC-1** A VFR clip shows the badge on import, and **still shows it after an
  app restart**. (This is the regression that makes the naive version useless.)
- **AC-2** The pool card no longer displays a nominal rate without qualification
  for a VFR clip; it shows both rates.
- **AC-3** A clip whose `avg_frame_rate` is `0/0` renders as *unknown*, not as
  CFR. (Distinguishing those is a correctness requirement, not polish.)
- **AC-4** A CFR clip is visually unchanged — no badge, no extra requests.
- **AC-5** One click on the badge produces a `_cfr` sibling in the pool, via
  the existing `cfr` op. No new conversion code path.
- **AC-6** The client verdict and `POST /api/vfr_scan` agree on every clip in a
  test set, including the 577-frame `r_frame_rate=60` fixture.
- **AC-7** Importing 200 clips triggers **no** additional network requests
  versus before this change.
- **AC-8** Gate 5/5. Full pytest at the known baseline: **404 passed, 10
  failed** (`test_hijack` ×7, `test_join_comma` ×3 — pre-existing ffmpeg
  capability, reproduce identically on a clean tree). Any other failure is yours.
- **AC-9** Playwright, real clicks, zero new console errors, screenshot to
  `mtapi-project/junk/`.

## 8. Files expected to change

```
app/media/pool.py                              _META_FLOAT_KEYS / _META_BOOL_KEYS
app/main.py                                    _probe_media_full: emit is_vfr_guess
app/static/js/media-urls.js                    shared isVfrClip() helper
app/static/js/pool/persistence.js              META_KEYS + buildPoolMetaHtml
app/static/js/pool/sequence-composer.js        token badge + click-guard class
app/static/js/pool/sequence-transport.js       reset the preview badge
app/static/js/preview.js                       set/reset the preview badge
app/static/js/tabs/settings.js                 relabel the Scan button if it now backfills
app/static/index.html                          badge element(s)
app/static/css/{pool,console}.css              badge styles
app/static/js/pool/{grid,sequence-select}.js   fps display in ⓘ / focus panels
tests/                                         new test for the shared rule
docs/STATUS.md, docs/spec_registry.json        ship ritual
```

## 9. Ship ritual

- Bump root `VERSION` far-right DD (`000.000.8.104` → `.105`).
- Add a `docs/STATUS.md` top-box row: what shipped, what was proven, what did
  not. Do **not** copy version digits into STATUS.
- Diary goes in `docs/archive/changelog.md`.
- Update this file's `Status:` line and `docs/spec_registry.json`.
- Commit only your own files. See §10.

## 10. Working in a shared tree

This repo has had two agents editing the same working tree simultaneously, and
one of them ran `git stash` mid-run and briefly swallowed the other's
uncommitted work. Before you start and before you commit:

1. `git status --short` and `git log --oneline -3` — learn what is already
   committed, and whether anything is dirty that is not yours.
2. If the tree is dirty with work that is not yours, **do not commit it** and do
   not revert it. Say so and ask.
3. Stage by explicit path. Never `git add -A`.
4. Do not use `git stash`. If you need a clean baseline, use
   `git checkout-index -a --prefix=/tmp/whatever/` to export the index, or a
   `git worktree` — the gate accepts `STATIC_ROOT` / `APP_ROOT` / `HTML_FILE`
   overrides for exactly this.
5. Note that `./check-gate.sh`'s import stage only proves that specifier
   *files* resolve. It does **not** verify named exports. A tree can be gate-
   green and still fail to boot. When you change an import or an export, check
   it by hand or in the browser.
