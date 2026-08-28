# Python Environment card (uv-managed packages) — Spec

> **Status**: Candidate. Builder follows this when implementing.
> **Hat**: Spec writer. This document only — no app code.
> **Drives**: `VERSION` bump on ship (far-right DD) + STATUS top box + changelog entry.

---

## 1. Problem

The venv is not a mirror of `mtapi-project/requirements.txt`, and nobody can see the drift:

- `requirements.txt` declares `dlib>=19.24, imutils, scikit-image`, but the venv shipped without them — facemorph failed at the gate (`ensure_facemorph_available` ImportError) until I hand-fixed it via CLI.
- The venv contains packages that are **not** in `requirements.txt` at all (torch, onnxruntime, openvino, ultralytics, playwright, polars, …) and `requirements.txt` lists packages that are **not** installed (tensorflow, diffusers, optimum, qrcode, pyzbar, …).
- There is no UI to see this, and no safe way to install/upgrade/remove from the app.

**Goal**: a card in **Settings** that lists every dependency with **version installed vs required**, a status (Installed / Missing / Update / Extra), and a checkbox column driving **mass operations: Install / Upgrade / Remove** — executed through `uv`.

## 2. Scope

**In (v1)**:
- Read-only inspection card: pending/os/thermal table of declared + installed packages.
- SELECT-all / per-row checkboxes; bulk **Install missing**, **Upgrade selected**, **Remove selected** (extras only).
- Execution via a registered operation (`POST /ops/packages`) so the existing job/progress/cancel machinery is reused.
- `GET /api/packages` for the list payload.

**Out (v1, follow-ups)**:
- `uv pip sync` (“make venv == requirements.txt”): too destructive to be one button. Later.
- Ad-hoc install of packages not in `requirements.txt` and not installed (the “search PyPI” case). Later.
- Server/process restart from the UI. We can only print “restart recommended”.
- Uninstalling a declared package permanently (removing a line from `requirements.txt`). Edit the file instead.

## 3. Data model

The server holds the truth; the browser renders it.

### 3.1 Requirements source

- File: `mtapi-project/requirements.txt` (absolute, resolved from the repo root via `Path(__file__).resolve().parents[3]` or an env override `MTAPI_REQUIREMENTS` if already a convention — confirm at build time).
- Parse with `packaging.requirements.Requirement` line by line:
  - name = canonicalized dist name (`importlib.metadata.canonicalize_name`)
  - specifier = the raw constraint string as written (`>=2.7`, `==20.0.1`, plain name = any)
  - blank lines and `#`-only lines skipped
  - lines whose name resolves to nothing are skipped and surfaced as a warning list in the payload (`unparsed`)
  - a fully commented-out requirement (line starts with `#`) is **not declared**

### 3.2 Installed source

- Import **in-process**: `importlib.metadata.distributions()` (flat list of `name` → `version`).
- This is necessarily the running interpreter, which *is* the app venv (`run.py` executes `.venv/bin/python`), so no subprocess is needed to *list* state.

### 3.3 Row classification

For each dist name in `declared ∪ installed`:

| status | condition |
|--------|-----------|
| `missing` | declared (`spec` present) and name not in installed |
| `ok` | installed and `spec.specifier.contains(version)` |
| `stale` | installed, declared, and `not spec.specifier.contains(version)` |
| `extra` | installed, not declared |
| `protected` | installed and name ∈ BOOT_PROTECT (below) — also flagged `remove_blocked` |

Payload row:

```json
{
  "name": "dlib",
  "required": ">=19.24",
  "installed": null,
  "status": "missing",
  "protected": false,
  "notes": ""            // human note, e.g. why protected
}
```

Sort for display is decided client-side, but the server orders: `missing`, `stale`, `ok`, `extra`, `protected` last; alphabetical within bucket.

### 3.4 BOOT_PROTECT (never removable from the UI)

`fastapi, uvicorn, starlette, anyio, httpcore, h11, pydantic, pydantic_core, typing_extensions, pillow, numpy, packaging, importlib_metadata`. Remove attempts on these return a refusal (see §5.4). The list lives server-side only (single source of truth); UI greys the checkbox for display.

### 3.5 Environment header

Payload also carries:

```json
{
  "ok": true,
  "python": "3.11.15",
  "executable": "/home/m/snc/cod/ffTransmuteWebui-wip/mtapi-project/.venv/bin/python",
  "uv": "0.12.1",                 // from `uv --version` (cached at startup, best-effort)
  "requirements_path": "...requirements.txt",
  "packages": [ …rows above… ],
  "summary": { "missing": 0, "stale": 0, "extra": 0, "ok": 0, "protected": 0 },
  "unparsed": [ "…#ally broken lines…" ]
}
```

## 4. API

### 4.1 `GET /api/packages`  (meta route, tag `meta`)

Read-only. Registers in `app/routes/meta.py` alongside `/api/job/{token}`. Returns 3.5. Never runs subprocess — `importlib.metadata` + `packaging` in-process, `uv --version` read from a startup-cached value in `main.py` (fetch once with `check_tools`-style hook, log warning if missing).

### 4.2 `POST /ops/packages`  (registered `OperationSpec`)

Reuses the full op lifecycle: `run_registered_op` → job token → `GET /api/job/{token}` polling → cancel via `POST /api/cancel` → HTTP 200 + `{"ok": false}` on failure. **Picks up the existing single-flight gate in `main.py`** (a venv edit won’t run while a video op is in flight, and vice-versa) — acceptable for v1, note it in the card.

Params (`pydantic.BaseModel`):

```json
{
  "action": "install" | "upgrade" | "remove",
  "targets": ["dlib", "imutils", "scikit-image"],
  "dry_run": false
}
```

Validation inside the handler (fail = `OperationResult(ok=False, error=…)`, never an HTTP 4xx):
- `targets` must be a non-empty list of names, each ∈ `declared ∪ installed` (else `unknown package: X`).
- `remove` with a protected/BOOT_PROTECT target → `protected: cannot remove core package 'pillow'`.
- `upgrade` with a target that has no declared spec → run `install --upgrade` (makes it a newest extra) — acceptable, list which went which way in `meta`.
- Duplicates deduped; names canonicalized.

Humans do not type specs here — `specs` always come from `requirements.txt` (or `none` for extras).

### 4.3 Command mapping (all via `app.shell.run_command`, argv only, never `shell=True`)

Interpreter pin: **`--python <sys.executable>`** of the *app* process (that is the venv python; using `sys.executable` keeps it true after any future rename).

- install: `uv pip install --python <exe> <target> <target> …  "pkg>=spec"` for declared, `"pkg"` for extras.
- upgrade: same with `--upgrade` prepended.
- remove: `uv pip uninstall --python <exe> <name> …`

Batch all targets for an action into **one** `uv` invocation (faster, one resolve). Run with `cwd=mtapi-project` so uv discovers `.venv` for error hints, but rely on `--python`.

Dry-run: prepend uv’s own `--dry-run` (install/upgrade) and still report each package as `would_*`. For remove, `--dry-run` is unsupported by `uv pip uninstall` → simulate by skipping the subprocess and reporting `would_remove` (state is already known).

### 4.4 Progress & result

- `report_progress("installing 3 of 8: dlib", phase="packages", current=3, total=8, unit="packages")` — one call per package resolved (AGENTS Invariant 9).
- `job_control.check_cancelled()` between packages; a cancel kills the remaining targets cleanly and reports `Cancelled by user`.
- stdout/stderr of uv are streamed to the `mtapi` logger by `run_command` already.
- `OperationResult`:
  ```json
  {
    "ok": true,
    "operation": "packages",
    "command": "uv pip install --python … dlib imutils scikit-image",
    "stdout": "…",
    "stderr": "…",
    "meta": {
      "summaries": ["installed dlib 20.0.1", "already satisfied imutils", "failed: scikit-image (…)"],
      "changed": ["dlib"], "unchanged": ["imutils"], "failed": [], "cancelled": [],
      "dry_run": false,
      "recommend_restart": true
    }
  }
  ```
- `recommend_restart: true` always after a successful mutation (imported modules are frozen in the running process).

## 5. Frontend — the card

### 5.1 Where

Settings tab, new `settings-card` appended in `renderSettingsForm()` (`app/static/js/tabs/settings.js`) after the “UI tweaks” card. `elements.actionPanel.innerHTML` currently builds 3 cards — add a 4th. CSS in `settings.css` (`settings-card`, `settings-card-head`, `settings-card-kicker`, `settings-card-name` are reused; new table + toolbar classes prefixed `env-`).

Card heading: kicker **“Python environment”**, name **“Dependencies”**. Description line states the interpreter + uv version + the single-flight warning.

### 5.2 Table

Columns, in order:

| Column | content |
|--------|---------|
| (head = select-all) | checkbox, disabled while busy; select-all toggles all *actionable* rows |
| Package | mono name + status badge dot |
| Required | spec string or `—` |
| Installed | version or `—` |
| Status | badge: **Missing** (red), **Update** (amber), **Installed** (green), **Extra** (gray), **Protected** (gray + lock note, row uncheckable) |

Rows render in server order. Badges use the app palette (`var(--error)`, accent amber, `var(--ok)`-style green), body still dark-theme.

### 5.3 Toolbar & actions

- Buttons: **Install missing**, **Upgrade selected**, **Remove selected**, **Refresh**. A selection counter (“3 selected”) sits beside them.
- Enablement:
  - Install missing — visible/active unless zero `missing` rows exist at all (acts on missing set even if unchecked — that’s the point; visually select them first to preview).
  - Upgrade selected — enabled iff ≥1 selected row is `stale` **or** `extra`.
  - Remove selected — enabled iff ≥1 selected row is `extra` (extras only; `protected` rows can’t be checked anyway; `stale`/`missing` can’t be removed from here in v1).
  - Refresh — always on (except while busy).
- **Remove** requires a confirm: first click arms the button (“Remove N — confirm?”) and a 3 s disarm timer; second click within the window fires. (Keeps it keyboard-accessible and avoids a modal; reuse `btn` styles.)
- **Dry-run**: a small checkbox next to the toolbar, off by default, applies `--dry-run` and labels the run `[DRY RUN]`.

### 5.4 Execution flow (browser)

1. `GET /api/packages` on tab render + after every mutation (auto-refresh).
2. Action → `POST /ops/packages` with job token via the existing op exec path (`app/static/js/job-control.js` exports, e.g. `newJobToken` + `runOpWithCancel`/`runActiveOperation` + `displayOpResult`); card logs `[EXECUTE]: POST /ops/packages …`, `[STDOUT]/[STDERR]/[ERROR]` via `logConsole` — same console contract as every other op.
3. Busy state: `setRunUiBusy(true)`; toolbar+table disabled; a one-line status shows the latest job message (from the active job snapshot protocol, `getMainJobSnapshot`); stop goes through `abortMainJob` → `POST /api/cancel`.
4. On completion: `displayOpResult(res)` for console summary; then `GET /api/packages` refresh; if `meta.recommend_restart` show a persistent inline note: **“Packages changed — restart the server process to fully apply (some imports are already loaded).”**
5. Failure (`ok:false`): `displayOpResult` path already handles console `[ERROR]`; the card additionally shows `res.error` inline (e.g. “protected: cannot remove core package 'pillow'”).

### 5.5 No new frameworks

Vanilla HTML/CSS/ES modules. No npm. `index.html` gains nothing (settings.css already loaded on the Settings page body class).

## 6. Test plan

**Unit (new `tests/test_packages.py`)**
- `parse_requirements` on a fixture: names canonicalized, `#`-commented lines not declared, spec strings preserved, unparsed lines collected.
- Classification matrix: `missing` / `ok` / `stale` (installed 1.0, required `>=2.0` → stale) / `extra` / `protected`.
- Handler validation: unknown target fail, dedupe, protected-remove refusal, empty targets fail.
- argv builder: install/upgrade/remove mapping incl. `--python <sys.executable>`, no shell, one invocation per action, no targets → fail.

**API**: fake `run_command` (monkeypatch) returning canned `(0, “…”, “”)`; assert `/ops/packages` returns `ok:true` + meta summaries, dry-run sends `--dry-run`, cancel mid-batch reports `Cancelled by user`.

**Playwright (WebUI proof — click the real control, per AGENTS #12)**
1. Settings → “Dependencies” card renders: header shows interpreter + uv; rows sorted missing-first.
2. Check a `missing` row (cast with a fixture with e.g. `imutils` absent, as it was today) → **Install missing** → busy state appears → table auto-refreshes → row now `Installed` (version shown) → restart note visible.
3. Select an `extra` row → **Remove selected** → arm → confirm → row gone from table.
4. Attempt remove on a protected row is impossible (checkbox disabled) and, via crafted payload, `/ops/packages` returns the refusal inline.
5. Refresh button re-scans without mutation. Clean console (favicon 404 aside).

## 7. Files touched (build hint)

- `app/routes/meta.py` — `GET /api/packages`.
- `app/operations/` new `packages_ops.py` — parse/classify module + `register(OperationSpec(id="packages", …))`.
- `app/main.py` — optional: cache `uv --version` at startup next to `check_tools`; nothing else.
- `app/static/js/tabs/settings.js` — card render + action wiring.
- `app/static/css/settings.css` — env-* table/toolbar/badge styles.
- `tests/test_packages.py` — as above.
- `docs/STATUS.md` top box, `VERSION`, `docs/archive/changelog.md` (on ship).

## 8. Invariants honored

1. Filter platform / dump-encode stack — untouched.
2. Subprocesses only via `app.shell.run_command` + argv; **no** `shell=True`; none in `main.py` (the op handler lives in `operations/`).
3. Absolute paths; requirements file resolved from repo root.
10. Failures are HTTP 200 + `{"ok": false}`.
12. WebUI proof = Playwright clicks, not curl.