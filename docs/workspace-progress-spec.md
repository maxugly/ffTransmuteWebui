# Workspace Progress & Smart ETA — Spec

> **Status:** **Partial** — phase-local rate/ETA + `start_dir_watch`; RIFE + **dump** wired (`4.64`); multi-phase remaining ETA polish open  
> **VERSION note:** progress core landed with ~`000.000.4.54` tree  
> **Audience:** Builders  
> **Problem:** Long ops materialize work under `/tmp/mtapi_jobs/{id}/frames_*`; UI must climb `current` while binaries run.  
> **Related:** `STATUS.md`, `app/job_control.py`, `app/filters/rife.py`, root `AGENTS.md` § Progress, `ui-list-nav-timer-spec.md`  
> **Pilot ops:** RIFE / Image Sort RIFE (watch on `frames_out`); extend to dump etc.

---

## 1. Observation (what we already know)

Example live job:

```text
/tmp/mtapi_jobs/imagesort_17a22515edd9/
  frames_in/    # e.g. 350 keyframes after conform
  frames_out/   # grows during RIFE: 0 → … → ~K×M
```

| Fact | Available without asking the binary |
|------|-------------------------------------|
| Job root | `JobWorkspace.root` |
| Input frame count after conform/dump | `len(frames_in/*.png)` or known `K` |
| Output target for RIFE | `K * multiplier` (or dump frame count for encode) |
| Output so far | **count files in `frames_out/`** (or whichever dir the stage writes) |
| Wall clock | `job_control` `started_at` + local Run-button timer |
| Recent rate | Δfiles / Δseconds over a short window |

**We act dumber than the filesystem.** Especially for `rife-ncnn-vulkan`, which is one long `communicate()` with no mid-progress — but the destination directory fills the whole time.

### Current gaps

| Layer | Today | Problem |
|-------|-------|---------|
| `report_progress` | Has `current`/`total`/`pct`/`eta_s` | ETA uses **whole-job** `cur/elapsed` — wrong after phase change (conform 30s + rife starts at 0 → ETA nonsense) |
| RIFE filter | Progress **before** (0) and **after** (done) only | Minutes of silence while `frames_out` grows |
| Dump (ffmpeg) | Often phase-only | `frames_in` grows the same way |
| Image Sort conform | Reports every frame | Good — keep as reference |
| UI poll | Shows phase, `current/total`, pct, ETA when set | Starved of updates during binary stages |
| Console | Phase-change lines only | Fine — don’t spam every frame |

---

## 2. Goals

1. **Directory-backed progress** for any stage that writes a known sequence of PNGs into a folder.  
2. **Phase-local ETA** — rate from samples *in this phase*, not from job start.  
3. **Smarter rate** — short sliding window (e.g. last 10–20s) so ramp-up / GPU settle doesn’t poison the estimate forever.  
4. **Numbers the user can trust enough** — `frames 412/1400 · ~18/s · ETA 55s · phase rife` — not fake precision to the millisecond.  
5. **Zero change to RIFE binary** — observe the workspace.  
6. Keep AGENTS rule: still call `report_progress` from Python loops when we *own* the loop; directory watch is for **opaque subprocesses**.

### Non-goals

- Parsing RIFE/ffmpeg stdout for % (brittle, optional later).  
- Replacing the Run-button elapsed clock.  
- Perfect ETA across multi-phase jobs as one number (optional weighted remaining phases later).  
- Polling so hard we thrash disk on 50k frames (cheap `scandir` / name count is enough).

---

## 3. Design

### 3.1 Mental model

```text
                    report_progress (loops we own)
                              │
job token ──► progress snap ◄─┤
                              │
                    DirWatcher (opaque writers)
                         │
              count PNG in watch_dir every ~0.5–1s
                         │
              current = count, total = known target
              rate / eta from phase samples
```

### 3.2 Progress snapshot extensions

Extend `_progress[token]` (backward compatible):

| Field | Type | Meaning |
|-------|------|---------|
| `phase` | str | existing |
| `current` / `total` / `unit` | int / int / str | existing — prefer `unit="frames"` |
| `pct` | float | existing |
| `eta_s` | float \| null | **recompute with phase-local rate** |
| `rate` | float \| null | **new** — units per second (e.g. frames/s) |
| `rate_h` | str \| null | **new** — e.g. `"18/s"` for UI |
| `phase_started_at` | float | **new** — wall time when phase last changed |
| `workspace` | str \| null | **new** — job root path (debug / optional UI) |
| `watch_dir` | str \| null | **new** — dir being observed |
| `watch_count` | int \| null | last counted files |
| `samples` | list (internal) | ring buffer of `{t, current}` — **not** required in API response (strip on `get_progress`) |

API `GET /api/job/{token}` should expose: phase, current, total, unit, pct, eta_s, eta_h, rate, rate_h, elapsed_s, message, status, workspace (optional).

### 3.3 Phase-local ETA (fix `report_progress`)

Today (simplified):

```text
rate = current / (now - job_started_at)   # BAD after phase switch
eta  = (total - current) / rate
```

Target:

```text
on phase change:
  phase_started_at = now
  clear samples for this phase
  current may reset to 0 for the new phase total

on each update (report or watch):
  append sample (now, current)
  drop samples older than WINDOW_S (e.g. 15s) or keep last N (e.g. 30)
  if ≥2 samples and Δt ≥ 1s and Δcurrent > 0:
    rate = Δcurrent / Δt     # over window, not from t=0
    eta  = (total - current) / rate
  elif current > 0 and phase_elapsed > 2s:
    rate = current / phase_elapsed   # fallback
    eta  = (total - current) / rate
  else:
    rate = null; eta = null   # "warming up"
```

When `current >= total > 0`: `eta_s = 0`, `pct = 100`.

**Phase change detection:** if `phase` argument differs from snap’s phase, reset phase clock + samples; do **not** carry conform’s rate into rife.

### 3.4 Directory watcher

New helper (suggested home: `app/job_control.py` or `app/progress_watch.py`):

```python
async def watch_frame_dir(
    directory: Path | str,
    *,
    total: int,
    phase: str,
    unit: str = "frames",
    token: str | None = None,
    interval_s: float = 0.75,
    glob: str = "*.png",  # or "frame_*.png"
    message: str | None = None,
) -> None:
    """Until cancelled or stop event: count files → report_progress."""
```

**Lifecycle API (sync-friendly):**

```python
# start background task tied to job token
handle = job_control.start_dir_watch(
    token,
    directory=ws.frames_out,
    total=K * M,
    phase="rife",
    unit="frames",
    message="RIFE writing frames…",
)
# ... await subprocess ...
job_control.stop_dir_watch(handle)  # final count + report current=total if done
```

Implementation notes:

- Use `asyncio.create_task` if already in async handler; else a daemon thread with the same interval (RIFE is async today → prefer asyncio).  
- Count with `os.scandir` + suffix filter — **O(n)** per tick is fine for thousands of frames; if n > 20k, optional cache by mtime of dir only (if dir mtime unchanged, skip recount — Linux updates mtime on create).  
- Call `check_cancelled()` each tick; if cancelled, stop watch and let the op kill the process (existing cancel path).  
- **Do not** hold the job_control lock across scandir.

### 3.5 Wire points (pilot)

#### A. `run_rife_directory` (`filters/rife.py`)

```text
before create_subprocess_exec:
  start_dir_watch(dst, total=out_target, phase="rife")
await proc  # existing; ideally wait with cancel polling, not only communicate()
stop_dir_watch → report final out_count
```

**Improve cancel:** prefer `asyncio.wait` loop that also `check_cancelled` and kills proc, instead of one blocking `communicate()` for the whole run — so Stop works mid-RIFE. Spec as must-have with watch.

#### B. Image Sort (`imagesort_rife_ops.py`)

- Conform: keep per-frame `report_progress` (already good).  
- RIFE: rely on watch inside `run_rife_directory` (don’t double-report conflicting totals).  
- Encode: optional watch of nothing; encode is often one ffmpeg — either parse ffmpeg progress later or report `phase=encode current=0 total=1` then done (honest “one pass”).

#### C. Video dump (`video_pipeline.dump`)

If dump is a long ffmpeg to `frames_in`:

- Know approximate total from probe (`true_frames` / range).  
- `start_dir_watch(frames_in, total=N, phase="dump")` for the duration of the dump process.

#### D. `pipeline_chain` directory stages

Any `kind=directory` stage with a known `total` estimate should start a watch on the stage’s `dst_dir` when total is known; if unknown, watch with `total=0` still shows **count + rate** (“342 frames · 12/s · phase rife”) without pct.

### 3.6 When total is unknown

Still report:

```text
current = count
total = 0
pct = null
rate from window
eta = null
message = "RIFE writing frames… (342 so far, ~12/s)"
```

UI already handles `total > 0` for fraction; extend sticky line to show `current` + rate when total is 0.

---

## 4. UI (minimal)

### 4.1 Sticky status (existing `paintStickyJobUi`)

Extend bits when snap has data:

```text
Running · 1:42 · rife · 412/1400 frames · 29% · ~18/s · ETA 0:55
```

| Piece | Source |
|-------|--------|
| elapsed | local clock (keep) |
| phase | `p.phase` |
| n/N unit | `current/total` + unit |
| % | `p.pct` |
| rate | `p.rate_h` **new** |
| ETA | `p.eta_h` |

Run button can stay `● 1:42` only (user likes it); status bar carries the smart numbers.

### 4.2 Console

Keep **phase-change** lines only. Optional: log one line every **N%** (10, 25, 50, 75) or every 30s of same phase — not every poll.

```text
[PROGRESS] [rife] 0/1400 frames | elapsed 0:32
[PROGRESS] [rife] 700/1400 frames (50%) | ~17/s | ETA 0:41 | elapsed 1:14
[PROGRESS] [encode] …
```

### 4.3 Pre-run summary (already exists)

Unchanged — that’s *before* Run. This spec is *during* Run.

---

## 5. Message quality (examples)

| Phase | Good live message |
|-------|-------------------|
| conform | `conformed 48/350` |
| rife | `RIFE 412/1400 frames (~18/s)` |
| dump | `dumped 1200/4320 frames` |
| encode | `encoding…` (or ffmpeg time if we add parser later) |

`report_progress` message can be rebuilt by the watcher:

```python
msg = f"{phase} {current}/{total} {unit}" + (f" (~{rate:.0f}/s)" if rate else "")
```

---

## 6. Implementation checklist

### Core

- [x] Phase-local samples + rate + ETA in `report_progress`  
- [x] `start_dir_watch` / `stop_dir_watch`  
- [x] Strip internal samples from `get_progress`; expose `rate` / `rate_h`  
- [x] `format_duration` for human ETA  

### Pilot wire

- [x] `run_rife_directory`: watch `dst` for `out_target` frames; cancel-friendly wait  
- [ ] Confirm Image Sort RIFE phase climbs on a real long job (manual/WebUI)  
- [ ] Optional: `video_pipeline.dump` watch `frames_in` when total known  

### UI

- [ ] `paintStickyJobUi` show rate + n/N (verify rate_h visible)  
- [ ] Optional milestone console lines  

### Docs / invariants

- [x] AGENTS.md progress bullet + STATUS  
- [x] VERSION / STATUS refresh (docs pass 2026-08-03)  

---

## 7. Edge cases

| Case | Behavior |
|------|----------|
| Writer renames at end (RIFE 1-based → normalize) | Count may jump; final normalize after process; watch total still `out_target` |
| Temp files non-png | glob only `*.png` / `frame_*.png` |
| Watch dir missing | create via workspace; count 0 until exists |
| Two watches one token | stop previous or one watch slot per token |
| Job finishes, cleanup deletes dir | stop watch **before** cleanup |
| total wrong (RIFE emits fewer) | final report uses real count; pct may stick at 99 then done |
| very fast stage (&lt;1s) | no rate/eta is OK |
| NFS / slow stat | interval 1.0s; don’t block event loop — `asyncio.to_thread(scandir_count)` |

---

## 8. Verification

### Manual / real job

1. Image Sort: ≥20 stills, RIFE ×4 (or RIFE tab on `/tmp/teste.mp4` upscaled load).  
2. During RIFE, status bar within ~1s of first output frame:  
   - `current` increases  
   - `total` = expected  
   - `rate` appears after ~2–3s of growth  
   - `ETA` decreases roughly as expected  
3. Run button elapsed still ticks.  
4. Stop mid-RIFE: process dies; watch stops; status cancelled.  
5. Console not flooded (no line per poll).  

### Quick count sanity

```bash
# while job runs
watch -n0.5 'ls /tmp/mtapi_jobs/imagesort_*/frames_out 2>/dev/null | wc -l'
# UI current should track this within ~1s
```

### Curl progress

```bash
# with job token from WebUI/network tab
curl -s http://localhost:24590/api/job/$TOKEN | jq '{phase,current,total,pct,rate,eta_s,message}'
```

**DONE for builder** = RIFE/Image Sort shows climbing frame counts + phase-local ETA; no silent multi-minute 0/N.

---

## 9. Follow-ups (later)

| Item | Note |
|------|------|
| Multi-phase remaining ETA | sum ETAs of queued phases (encode after rife) |
| ffmpeg `-progress pipe:1` | encode/dump % without dir watch |
| Thumbnail of latest frame in UI | optional live preview from `frames_out` max index |
| tilagup mode | same watch pattern for tile prompt count + SD tile outputs |

---

## 10. One-line summary

**The workspace is the progress bar.** Count what’s landing on disk, estimate rate from the last few seconds of *this* phase, and stop pretending long binaries are atomic.
