# static — WebUI Frontend Client

Vanilla HTML5 / CSS / JS (no build step, no npm). Served by FastAPI from `/`, `/app.js`, `/style.css`.

---

## Files

```
static/
├── index.html   # Shell + sidebar nav tabs
├── style.css    # Dark theme, DAW knobs, pool, morph lists
└── app.js       # State, forms, pool, run/stop, progress poll
```

---

## Tabs (Neural FX & tools)

| Tab | Op id | Notes |
|-----|--------|--------|
| Datamosh Smear | `datamosh_*` | Melt / classic / hijack / residual / MV |
| DeepDream | `deepdream` | Multi-model, ouroboros, optical flow, Stop + progress |
| Face Morph | `facemorph` | Image list, morph knobs, optional dream mode |
| withoutBG | `withoutbg` | Cutout / mask / background knobs |
| Style Transfer | `styletransfer` | Content + style image, strength, max side |
| Single-Clip Ops | transmute flags | Crop / letterbox / frames… |
| Layouts | `join` / `grid` | Multi-clip stitch |
| Quick Transmute | `fit` | One-clip pad/crop/stretch to canvas |
| Media Pool | — | Library, sequence, projects (`.ffproject.json`) |
| Raw CLI | `transmute_raw` | Free-form flags |

---

## UX patterns

- **DAW knobs**: continuous rotaries + binary snap knobs (`setupContinuousKnob` / `setupBinaryKnob`)
- **Jobs**: `POST /ops/{id}` with `X-Job-Token`; poll `GET /api/job/{token}`; **Stop** → `POST /api/cancel`
- **Outputs**: server-side sequential names (`_0001`, `_0002`…) so re-runs never clobber prior files
- **Pool → Send**: context menu can send items into DeepDream / morph / etc.

---

## Local paths

File pickers use native dialogs via `GET /api/picker` (and related browse endpoints). Prefer absolute paths when calling the API outside the UI.
