# Job Queue — Spec

> **Status:** **Implemented v1** `000.000.4.64` — in-memory FIFO + Jobs tab + Add to Queue; pending not persisted across restart  

> **Audience:** Builders & reviewers  
> **Related:** `job_control.py`, `static/js/job-control.js`, `workspace-progress-spec.md`, `main.py` op dispatcher, `STATUS.md`  
> **Problem:** Users want to line up long ops (RIFE → DeepDream → Convert…) without babysitting each finish.  
> **Not this:** Parallel GPU free-for-all · Celery/Redis · rewriting every op handler

---

## 1. Current reality (as-built)

| Layer | Behavior today |
|-------|----------------|
| **WebUI** | **One job at a time.** `runOpWithCancel` refuses if `activeJob.controller` is set: *“Already running — stop first or wait.”* |
| **POST `/ops/<id>`** | Holds the HTTP request open until the handler finishes. Client sends `X-Job-Token`; server `register` / `bind` / `finish` / `unregister`. |
| **Progress** | `GET /api/job/{token}` while POST is open; sticky Run-button timer; phase-local rate/ETA; RIFE **dir watch**. |
| **Cancel** | `POST /api/cancel` + `job_control.request_cancel(token)` + cooperative `check_cancelled()`; fetch abort. |
| **Server concurrency** | FastAPI *can* accept multiple POSTs; UI does not. No global “engine busy” flag for other clients. |

So “queue” is **not** fixing a mysterious backend deadlock — it is productizing **batching sequential work** the UI currently forbids as a second Run.

---

## 2. Goals

| # | Goal |
|---|------|
| 1 | **Enqueue** a fully specified op (`op_id` + JSON body) without starting it immediately |
| 2 | **Run pending jobs FIFO** when the engine is free (one active op at a time — v1) |
| 3 | **Jobs UI** — pending / running / recent done|failed|cancelled with progress on the active job |
| 4 | **Reuse** existing handlers via `contract.REGISTRY` — no second execution path |
| 5 | **Cancel** pending (drop) or running (existing cancel path) |
| 6 | Survive **tab switch** and ideally **F5** for pending items (see persistence) |

### Non-goals (v1)

- Parallel execution of two heavy neural ops on one GPU  
- Priority / dependency graphs / “run after file X appears” (Watcher is separate)  
- Cross-machine queue / Redis / RQ  
- Changing filter-platform or per-op math  
- Auto-retry with backoff (optional later; v1 fail → next)

---

## 3. Product decisions (locked for v1)

| # | Decision |
|---|----------|
| 1 | **Serial executor only** — one running job globally on this server process. |
| 2 | **Run still exists** — “run now” if idle; if busy, either disable Run and offer **Queue**, or Run = “queue and prefer front” (prefer: **disable Run when busy**, Queue always available). |
| 3 | **Enqueue snapshots params** — body frozen at add time (paths, knobs). Editing the form later does not change queued jobs. |
| 4 | **Token = job_id** — each queue item gets a UUID used as `X-Job-Token` when executed so progress/cancel stay one system. |
| 5 | **Handler invocation** — worker calls `await REGISTRY[op_id].handler(params_model(**body))` inside the same register/bind/finish lifecycle as `/ops/*` (extract shared `run_registered_op(spec, params, token)` helper from `main.py`). |
| 6 | **History cap** — keep last N completed (e.g. 50) in memory; optional disk later. |

---

## 4. Architecture

```text
                    ┌─────────────────────┐
  Add to Queue ──►  │  job_queue.py       │
  (or idle Run)     │  pending: deque     │
                    │  history: list      │
                    └─────────┬───────────┘
                              │ worker loop (asyncio)
                              ▼
                    ┌─────────────────────┐
                    │ run_registered_op   │  ◄── same as POST /ops/*
                    │ job_control.bind    │
                    │ REGISTRY.handler    │
                    └─────────┬───────────┘
                              │
                    GET /api/job/{token}   (progress — already exists)
                    GET /api/queue        (pending + running + history)
```

### 4.1 Module: `app/job_queue.py`

```python
@dataclass
class QueueItem:
    id: str                 # uuid = job token when run
    op_id: str              # e.g. "rife", "imagesort_rife"
    body: dict              # raw JSON params
    label: str              # short UI title
    created_at: float
    status: Literal["pending","running","done","failed","cancelled"]
    error: str | None = None
    result_summary: str | None = None   # output_path or error snippet
    started_at: float | None = None
    finished_at: float | None = None
```

**Worker** (started in FastAPI lifespan / `startup`):

```text
loop forever:
  wait until pending non-empty and no running
  pop left → status=running
  register(token=item.id, operation=op_id); bind
  try:
    params = REGISTRY[op_id].params_model(**item.body)
    result = await handler(params)
    item.status = done|failed from result.ok
  except JobCancelled:
    cancelled
  except Exception:
    failed; log; do not kill worker
  finally:
    finish/unregister; push history; clear running
```

**Thread safety:** single asyncio task owns mutations; HTTP handlers schedule onto that loop via asyncio-safe queue or a lock.

### 4.2 API

| Method | Path | Role |
|--------|------|------|
| `POST` | `/api/queue` | Add job: `{ "op_id", "body", "label?" }` → `{ ok, id, position }` |
| `GET` | `/api/queue` | Snapshot: `{ running, pending[], history[], busy: bool }` |
| `DELETE` | `/api/queue/{id}` | Remove **pending** only |
| `POST` | `/api/queue/{id}/cancel` | Pending → drop; Running → `request_cancel(id)` |
| `POST` | `/api/queue/clear` | Clear all **pending** (not running) |

**Do not** invent `job_control.cancel_job` — use **`request_cancel(token)`**.

Optional convenience:

| Method | Path | Role |
|--------|------|------|
| `GET` | `/api/queue/busy` | `{ "busy": true/false }` for cheap UI poll |

Progress for the active item remains **`GET /api/job/{id}`** (same id as queue item).

### 4.3 Extract shared runner (required refactor)

Today logic lives inside `_make_endpoint` in `main.py`. Extract:

```python
async def run_registered_op(
    spec: OperationSpec,
    params: BaseModel,
    *,
    token: str,
) -> OperationResult:
    ...
```

`/ops/*` endpoint and queue worker both call this. One cancel/progress story.

### 4.4 Persistence (v1.1 recommended, v1 optional)

| Approach | Pros | Cons |
|----------|------|------|
| **Memory only** | Simple | F5 / server restart loses pending |
| **Session file** `~/.cache/mtapi/job_queue.json` | Pending survives refresh | Restart mid-run is messy |

**v1:** memory OK if Jobs tab warns “queue is in-memory”.  
**v1.1:** persist **pending** only (not running); on startup rehydrate pending, never auto-resume a half-dead run without user confirm.

---

## 5. WebUI

### 5.1 Global chrome

| Control | Behavior |
|---------|----------|
| **Run** | If `busy`: disabled (tooltip: “Engine busy — use Add to Queue”). If idle: current `runOpWithCancel` **or** enqueue-and-worker-picks-up immediately (either OK; prefer **direct run when idle** for low latency). |
| **Add to Queue** | Always enabled when form validates. Collect body via same `collect*Body` as Run; `POST /api/queue`. Toast / console: `queued #3 rife`. |
| Status bar | If running: existing sticky timer + phase. If pending only: `Queue: 2 waiting`. |

### 5.2 Jobs tab (`data-tab="jobs"`)

New nav item **Jobs**.

```text
┌ Jobs ─────────────────────────────────────────┐
│ Running                                       │
│  ● rife  ·  clip.mp4  ·  412/1400  ·  ETA …  │
│                         [Stop]                │
│ Pending (2)                                   │
│  1. deepdream  ·  out.mp4           [Remove]  │
│  2. convert    ·  frames            [Remove]  │
│ Recent                                        │
│  ✓ imagesort  ·  /path/out.mp4                │
│  ✗ rife       ·  file not found               │
│ [Clear pending]                               │
└───────────────────────────────────────────────┘
```

- Poll `GET /api/queue` every 1s when tab visible; every 2–3s when hidden (or piggyback existing job poll when busy).  
- Active progress: if `running.id`, also poll `/api/job/{id}` (reuse `formatJobLine` / paint helpers).  
- **Do not** spam console every second — phase changes only (existing rule).

### 5.3 Wiring enqueue

Each tab already has collect functions. Shared helper:

```js
async function enqueueCurrentOp() {
  const { opId, body } = resolveActiveOpAndBody(); // same switch as Run
  if (!body) return;
  await fetch('/api/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op_id: opId,
      body,
      label: shortLabel(opId, body),
    }),
  });
}
```

Self-batch tabs (Image Sort, Face Morph, …) enqueue **one** op with full body — same as Run. Do not explode into N queue items unless product asks later.

### 5.4 Idle “Run” vs queue worker

**Recommended v1:**

- Idle + Run → **direct** `runOpWithCancel` (today’s path; lowest friction).  
- Busy + user wants more → **Add to Queue** only.  
- When direct run finishes, worker immediately starts next pending if any.

**Alternative:** always enqueue (even idle); worker always executes. Slightly higher latency; simpler mental model. Acceptable if builder prefers one path.

---

## 6. Labels & body hints for Jobs list

| op_id | label hint |
|-------|------------|
| `rife` | `input_path` basename + `×M` |
| `imagesort_rife` | `K images` + RIFE on/off |
| `deepdream` | mode + basename |
| `convert` | preset / basename |
| default | `op_id` + first path-like field |

Store `label` at enqueue time so Jobs UI does not re-parse bodies.

---

## 7. Failure & cancel semantics

| Event | Behavior |
|-------|----------|
| Pending removed | Gone; never runs |
| Running cancel | `request_cancel(token)`; item → `cancelled`; worker proceeds to next |
| `ok: false` from handler | item → `failed`, `error` set; **continue** queue |
| Uncaught exception | same as failed; worker must not die |
| Missing input file | fail that item; continue |
| Server restart (memory v1) | queue empty; document it |

---

## 8. Interaction with other systems

| System | Interaction |
|--------|-------------|
| `job_control` progress | Unchanged; token = queue id |
| Dir watch / rate ETA | Works for queued RIFE same as Run |
| Watcher tab | Separate; may later enqueue ops — out of scope |
| Dual pools | Queued bodies hold absolute paths; user responsible if files move |
| Universal persistence | Queue persistence is **separate** from desk project JSON |

---

## 9. Implementation phases

### Phase A — Backend only

1. Extract `run_registered_op` from `main.py`.  
2. `job_queue.py` + worker on startup.  
3. `/api/queue` CRUD + cancel.  
4. Curl: enqueue 2 dry-run-ish or short ops; verify serial execution.

### Phase B — WebUI chrome

5. **Add to Queue** next to Run; busy disables Run.  
6. Poll busy for button state (all tabs).  
7. Console log on enqueue / job start / job end.

### Phase C — Jobs tab

8. `js/tabs/jobs.js` + nav item.  
9. Pending list + remove; running progress; recent history.  
10. Stop on running item.

### Phase D — Polish

11. Persist pending to disk.  
12. Optional: “Queue and run” always.  
13. Bottom `.tool-docs` on Jobs tab (what queue does / serial / memory).

---

## 10. Files to touch

| File | Change |
|------|--------|
| `app/job_queue.py` | **New** — queue + worker |
| `app/main.py` | Extract runner; start worker; mount routes (or `routes/queue.py`) |
| `app/routes/queue.py` | Optional thin routes |
| `app/static/js/job-control.js` | enqueue helper, busy flag, Run disable |
| `app/static/js/tabs/jobs.js` | **New** Jobs tab |
| `app/static/app.js` / `index.html` | Nav + import |
| `docs/STATUS.md` | Move to Partial/Implemented when shipped |

---

## 11. Pitfalls

| Pitfall | Mitigation |
|---------|------------|
| Second full executor path drifts from `/ops/*` | Single `run_registered_op` |
| Worker crashes on one bad op | try/except per item |
| UI still starts parallel fetch Run | Disable Run when `busy` |
| Stale paths | Fail item; show error in history |
| Cancel only aborts fetch | Must call `/api/queue/{id}/cancel` → `request_cancel` |
| Params validation at run time | Validate on enqueue with `params_model` → reject add if invalid |
| GPU thrash if parallel later | Keep serial v1 |
| “is_running” invented flag | Use queue snapshot `busy` / `running is not None` |

---

## 12. Verification

1. Idle: Run works as today (smoke `/tmp/teste.mp4` RIFE or Convert).  
2. Start long job; Run disabled; Add to Queue adds second op.  
3. Jobs tab: first running with climbing progress; second pending.  
4. First completes → second starts without user click.  
5. Cancel running → stops; next pending starts (or not — product: **start next**).  
6. Remove pending → never runs.  
7. Invalid body on add → `ok: false`, not queued.  
8. Console clean; no double progress spam.

**DONE** = serial queue + Run/Queue chrome + Jobs tab progress + cancel/remove.  
**Spec DONE** = this document accepted (no code claim).

---

## 13. One-line summary

**FIFO server-side queue of frozen op payloads, one runner shared with `/ops/*`, Jobs tab for pending/running/history — so long pipelines can be lined up without holding the Run button hostage.**
