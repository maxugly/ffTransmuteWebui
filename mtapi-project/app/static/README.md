# static — WebUI Frontend Client

Vanilla HTML5 / CSS / ES6 modules (no build step, no npm). Served by FastAPI from `/`, `/app.js`, `/css/*`, `/js/*`.

**Agent handoff (pools + Cut):** repo root `docs/video-image-pools-spec.md`  
**Frame range:** `docs/frame-range-spec.md`  
**Frontend rules:** root `AGENTS.md`
---

## Layout

```
static/
├── index.html           # Shell + sidebar (data-tab=…)
├── app.js               # State, tabs, global inputs, module exports
├── css/                 # base, layout, forms, pool, …
└── js/
    ├── timeline.js      # Probe + global frame range
    ├── frame-scrubber.js
    ├── job-control.js
    ├── preview.js
    ├── utils.js
    ├── tabs/            # Per-op UI modules (incl. cut.js)
    └── pool/            # Video Pool, Image Pool, sequence, persistence
```

---

## Tabs

| Tab | `data-tab` | Op / notes |
|-----|------------|------------|
| Datamosh Smear | `mosh` | datamosh_* |
| DeepDream | `deepdream` | deepdream |
| Face Morph | `facemorph` | facemorph |
| withoutBG | `withoutbg` | withoutbg |
| Style Transfer | `styletransfer` | styletransfer |
| RIFE Slow-Mo | `rife` | rife |
| Single-Clip Ops | `transmute` | geometry / extract |
| Layouts | `multi` | join / grid |
| Quick Transmute | `quick` | fit defaults |
| Convert / Export | `convert` | codecs + frames_* |
| **Video Pool** | `pool` | video library + projects |
| **Image Pool** | `images` | still library (`images[]`) |
| **Sequence** | `sequence` | stitch (videos only) |
| **Cut** | `cut` | In/Out from global range + Ref A/B (no encode yet) |
| Watcher | `watcher` | folder → DNxHR |
| Raw CLI | `advanced` | transmute_raw |

---

## Dual libraries (short)

| | Video Pool | Image Pool |
|--|------------|------------|
| State | `state.pool` | `state.imagePool` |
| Persist | `items[]` | `images[]` |
| Cards | dual absolute first/last | single thumb |
| Sequence | yes | no |

**Cut** uses global **Video file(s)** + **Frame range** only (no private video path).  
Refs from Image Pool. Details: `docs/video-image-pools-spec.md`.

---

## UX patterns

- **Global bar**: video / image / path in-out / frame range — primary I/O for ops  
- **DAW knobs**: `setupContinuousKnob` / `setupBinaryKnob`  
- **Jobs**: `POST /ops/{id}` + `X-Job-Token`; poll / cancel  
- **Outputs**: sequential names (`_0001`…) so re-runs never clobber  
- **Pool → Send**: Video Pool / Image Pool context menus and Use-as dropdowns  
- **Events**: `mtapi:frame-range`, `mtapi:video-probed` (timeline.js)

---

## Local paths

Native pickers: `GET /api/picker` (filter: `video` | `image` | `project` | `all`).  
Prefer absolute paths when calling the API outside the UI.
