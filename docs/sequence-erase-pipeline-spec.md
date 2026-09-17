# Sequence Erase → RIFE → Conform Pipeline Spec

> **Status:** Shipped (`8.071`, 2026-09-16) — implemented as specified; see STATUS top box.
> **Related:** `erase-tab-spec.md` · `sequence_rife_interpolation_spec.md` ·
> `sequence-conform-copy-spec.md` · `universal-persistence-spec.md` ·
> `server-memory-catalog-spec.md`

## 1. Goal

Allow a user to prepare watermark masks for video clips already present in the
Sequence, then run a bounded batch that processes each clip in this order:

```text
original source
  → erase every frame with the saved mask
  → RIFE the cleaned source when the Sequence requires more frame density
  → conform the cleaned/RIFED result to the active Sequence settings
  → adopt the resulting variants for the Sequence entry
  → continue with the next clip
```

The erase stage must always start from the original source, never from the
currently selected RIFE or conformed file. The original remains on disk and is
recoverable. RIFE and conform continue to use their existing pipelines and
registries; this feature orchestrates them and adds the missing media-lineage
identity.

This is a Sequence workflow. The existing standalone Erase tab remains useful
for one-off operations and is not replaced.

## 2. Current identity model and required addition

The current model has useful local identities but no single identity spanning
all derivatives:

| Current field | Meaning | Limitation |
|---|---|---|
| `sequence[].id` | One occurrence/placement in the Sequence | Two placements of the same file have different IDs |
| `sequence[].path` | Base file selected by that occurrence | It is a path, not a durable media identity |
| `sequence[].variantPath` | Selected RIFE derivative | Only one selected RIFE path is held on the entry |
| `sequence[].conformedPath` | Selected conform derivative | Valid only for its conform signature |
| Catalog content hash | Identity of one physical file's bytes | Original, erased, RIFE, and conform files have different hashes |
| Variant record `parent_path` | Registry relationship for a derivative | Does not yet model the complete erase lineage |

Add a first-class `lineageId` for the underlying source clip. It identifies a
media lineage, not a Sequence occurrence:

```js
// pool item and sequence entry
{
  lineageId: "uuid",
  path: "/abs/original.mp4",
  variantPath: "/abs/original_clean_rife4.mp4",
  conformedPath: "/abs/original_clean_rife4_conformed_....mp4"
}
```

`sequence[].id` remains the occurrence identity and must not be replaced. A
single lineage may appear more than once in a Sequence; each occurrence keeps
its own order, target duration, tag, and other transport settings.

### 2.1 Lineage record

Create a server-resident lineage record, keyed by `lineageId`, with this
minimum shape:

```json
{
  "lineage_id": "uuid",
  "original_path": "/abs/original.mp4",
  "original_hash": "sha256...",
  "active_clean_path": "/abs/original_clean.mp4",
  "mask": {
    "mask_id": "sha256...",
    "mask_path": "/abs/cache/lineages/<id>/mask.png",
    "width": 1920,
    "height": 1080,
    "threshold": 127,
    "source_hash": "sha256..."
  },
  "artifacts": {
    "erase": [],
    "rife": [],
    "conformed": []
  }
}
```

Every artifact records `lineage_id`, `derived_from`, operation parameters,
source hash/mtime, output path, output hash, and a complete operation
signature. A path or filename heuristic is never the lineage relationship.

The original path and original hash are both retained. If the original file is
replaced on disk, the hash mismatch invalidates downstream artifacts and the
user must explicitly re-accept the new source.

### 2.2 Migration

Existing pool and Sequence data has no `lineageId`. On hydration:

1. Reuse a persisted lineage ID when one already exists.
2. Otherwise create one for each distinct canonical source path and persist it
   with the pool/Sequence state.
3. Existing RIFE and conform records are attached to that lineage by their
   current parent path and stored source metadata where possible.
4. Ambiguous historical variants remain usable but are not silently treated as
   erase-derived artifacts.

Migration must not probe or encode media merely because a project is opened.

## 3. Mask contract

### 3.1 Mask ownership

Masks belong to a `lineageId`, not to `variantPath`, `conformedPath`, or a
Sequence occurrence. All occurrences of the same source therefore share the
same erase mask by default.

The UI may offer “duplicate mask for this occurrence” later, but that is out of
scope for the first version.

### 3.2 Mask data

The mask is the existing Erase mask contract:

- binary mask, threshold `127`;
- painted mask wins over rectangle fallback;
- the mask is applied to every frame;
- dimensions and coordinate space are recorded;
- no feather, blend, sharpen, or generative fill knobs;
- current crop/resize/Carve semantics remain unchanged.

The UI stores the canonical mask as a PNG in the lineage cache and persists
only its absolute cache reference, dimensions, and content hash in the project
snapshot. A mask content hash is the mask signature. Changing the drawing,
canvas dimensions, or erase HD settings creates a new signature and invalidates
the clean/RIFE/conform chain.

The original source is never modified. Clean outputs use collision-safe sibling
names such as:

```text
original_clean_<mask-signature>_<erase-signature>.mp4
```

## 4. User experience

### 4.1 Set a mask

Add a Sequence-local action on the selected clip:

- **Set erase mask** when no mask exists;
- **Edit erase mask** when one exists;
- **Clear erase mask** after confirmation.

The editor uses the existing Erase preview and paint canvas. It displays the
canonical/original source frame, even when the Sequence is currently showing a
RIFE or conformed variant. Saving the mask does not run an operation.

Mask canvas contract (measured fixes, 2026-09-17 — a full-frame "paper
texture" incident traced to these):
- **Transparent background.** The backend decodes the mask PNG by its alpha
  channel, so the canvas background must stay transparent (eraser restores
  transparency via `destination-out`). An opaque background decodes to a 100%
  mask and LaMA regenerates the whole frame as texture.
- **Aspect-matched canvas.** The backing store follows the base frame aspect
  (long side capped at 960px) and the stage `aspect-ratio` tracks it — never
  a fixed 960×540 stretch, which misplaces paint on non-16:9 frames.
- **25% area cap.** Painted masks get the same cap as the rect fallback: past
  ~25% LaMA hallucinates instead of inpainting. Save warns via `confirm()`
  past the cap; `erase_remove` (all paths: Erase tab image/video + this
  pipeline) refuses past the cap with HTTP 200 + `ok:false` and a plain
  message, so a bad mask fails loudly instead of burning GPU minutes.

The selected Sequence chip shows a small mask marker and a stale marker when
the source hash or erase settings no longer match the saved artifact.

The panel displays the source lineage and active processing state in plain
language, for example:

```text
Source: original.mp4
Mask: saved · 1920×1080
Clean: not run
RIFE: will run ×4
Conform: ready after RIFE
```

### 4.2 Batch control

The Sequence toolbar gets:

- **Run erase pipeline** — processes all eligible Sequence occurrences,
  deduplicated by `lineageId`;
- **Run selected erase pipeline** — optional convenience control for one
  lineage;
- **Stop** — uses the existing cooperative job cancellation.

Eligibility requires a valid original source and a saved mask. Unmasked clips
are skipped and reported before work starts. A clip whose clean artifact is
already valid is not erased again; it may still need RIFE or conform.

The batch runs one lineage at a time, never launches parallel GPU erase/RIFE
jobs, and reports:

```text
Erase pipeline 2/8 · clip-name · erase
Erase pipeline 2/8 · clip-name · RIFE ×4
Erase pipeline 2/8 · clip-name · conform
Erase pipeline 2/8 · clip-name · complete
```

Duplicate Sequence occurrences of one lineage are adopted together after the
shared artifacts are complete. Their occurrence-specific time/conform
signatures are still evaluated separately.

## 5. Processing contract

### 5.1 Per-lineage algorithm

For each distinct eligible `lineageId`:

1. Resolve and verify the immutable original path and current source hash.
2. Load the saved mask and validate dimensions/signature.
3. Reuse a clean artifact only when its source hash, mask hash, erase settings,
   and output existence/non-empty checks all match.
4. Otherwise run `/ops/erase_remove` against `original_path` with the saved
   mask. Register the output as an `erase` artifact derived from the original.
5. Evaluate the existing Sequence RIFE density rules against the cleaned
   source. If needed, run the existing RIFE directory pipeline from the clean
   artifact. Do not RIFE the original or an old erased/RIFED output.
6. Evaluate the existing conform signature for each affected Sequence
   occurrence. Conform from the cleaned native source or its newly generated
   RIFE source, following the existing RIFE-first ordering.
7. Register the clean, RIFE, and conform artifacts in the existing catalog/
   variant systems with lineage metadata.
8. Update the affected Sequence entries only after each adopted artifact exists
   and passes its validation.

The effective chain is therefore:

```text
original → erase → clean → RIFE (optional) → conform (optional)
```

Never perform:

```text
original → RIFE → erase
```

or:

```text
old conformed/RIFED output → erase → more RIFE
```

### 5.2 Adoption and active paths

`sequence[].path` remains the canonical source/original reference for lineage
and persistence. It must not be overwritten with a derivative merely because a
clean result exists.

After success:

- the clean artifact becomes the lineage's active processing source;
- `variantPath` points to the valid cleaned RIFE artifact when RIFE is needed;
- `conformedPath` points to the valid conform artifact when conform is enabled;
- the Sequence renderer labels the active derivative without hiding the
  original;
- selecting Original still selects the original source;
- selecting Clean/RIFED/Conformed chooses the corresponding variant explicitly.

This preserves the existing distinction between canonical source, selected
RIFE variant, and conformed cache.

### 5.3 Signatures and invalidation

An erase artifact is valid only when all of these match:

- lineage ID and original source hash;
- mask content hash and mask dimensions;
- erase model/setup identity;
- HD strategy, crop trigger, margin, resize limit, and device settings;
- output exists and is non-empty.

A valid RIFE artifact additionally matches the cleaned source hash, multiplier,
model, TTA/UHD settings, and frame/timing inputs.

A valid conform artifact additionally matches the cleaned/RIFE source identity,
mode, aspect, dimensions, target FPS, target duration/time factor, audio policy,
preset, and RIFE multiplier, exactly as required by
`sequence-conform-copy-spec.md`.

Changing a mask invalidates the clean artifact and every downstream artifact,
but does not delete any file. Changing only a Sequence occurrence's time or
conform settings invalidates that occurrence's conform artifact without
rerunning erase for the lineage.

## 6. Persistence and server records

Named project persistence must save:

- `lineageId` on pool items and Sequence entries;
- the original path reference;
- mask reference/signature and erase settings;
- selected `variantPath` and `conformedPath`;
- artifact signatures/status, when present.

Session autosave follows the existing rule: it may update the session snapshot
but must not overwrite a named project file by itself.

The server catalog/variant registry must retain lineage references when it
re-hydrates records. Referenced clean, RIFE, and conformed paths must not be
pruned merely because they are not current pool `items[]` paths.

The mask cache is not a pHash or wall source. Wall JPEGs remain presentation
assets only.

## 7. Failure, cancellation, and recovery

- Every operation failure is HTTP 200 with `{"ok": false}`.
- A failed erase leaves the original active and reports the clip as failed.
- A failed RIFE leaves the clean artifact available and reports RIFE failed;
  the original is never substituted silently for a successful clean result.
- A failed conform leaves clean/RIFE artifacts available and marks conform
  stale/failed; Stitch may use its existing re-encode fallback where allowed.
- Stop is cooperative. The current subprocess may finish, but incomplete
  outputs are never adopted.
- A later run resumes from the last valid stage.
- Existing artifacts are retained; garbage collection is out of scope.
- The batch must continue to the next lineage after an individual failure and
  provide a final summary of completed, skipped, failed, and cancelled items.

The batch endpoint follows the HTTP-200 operation rule even when one or more
lineages fail. Its response has this shape:

```json
{
  "ok": true,
  "summary": {
    "total": 3,
    "completed": 1,
    "skipped": 1,
    "failed": 1,
    "cancelled": 0
  },
  "items": [
    {"lineage_id": "uuid-a", "ok": true, "status": "completed", "stage": "conform"},
    {"lineage_id": "uuid-b", "ok": true, "status": "skipped", "stage": "mask", "reason": "no mask"},
    {"lineage_id": "uuid-c", "ok": false, "status": "failed", "stage": "erase", "error": "..."}
  ]
}
```

`ok` describes whether the batch request itself was accepted and completed as
a batch; individual failures are represented in `items[]`. A cancelled batch
uses `status: "cancelled"` for unfinished items and still returns HTTP 200.

## 8. Backend and frontend boundaries

Use the existing operation machinery and do not create a second frame pipeline:

- Erase: existing `erase_remove` staged dump → `app/filters/erase.py` → encode.
- RIFE: existing Sequence RIFE queue and `app/filters/rife.py` pipeline.
- Conform: existing direct file-to-file conform operation and signatures.
- Progress/cancel: existing job queue, `report_progress()`, and job control.
- Persistence: existing pool/project serialization and catalog allow-lists.

The new orchestration operation must not spawn subprocesses, import Python's
`subprocess` module, or call ffmpeg/RIFE/ONNX directly. It invokes the existing
erase, RIFE, and conform operation machinery through the job queue and passes
their absolute-path results between stages.

The batch orchestrator must call `report_progress()` at every stage boundary
for every lineage, including queued/skipped/failed items and transitions such
as erase complete → RIFE start, RIFE complete → conform start, and conform
complete → next lineage. Existing stage operations continue to report their
per-frame/per-item progress internally.

Likely implementation surfaces are:

```text
app/media/lineage.py                 new lineage/mask/artifact registry
app/media/catalog.py                 lineage references and referenced paths
app/routes/lineage.py                read/write mask and lineage metadata
app/operations/erase_pipeline_ops.py new batch orchestration operation
js/pool/sequence-erase.js            Sequence actions and batch state
js/pool/sequence-composer.js         chip/panel markers and controls
js/pool/sequence-rife.js             clean-source handoff
js/pool/sequence-conform.js          clean/RIFE source handoff
js/pool/persistence.js               serialize/hydrate lineage state
```

These are guidance, not permission to bypass existing module boundaries. The
builder must first inspect the current persistence and variant contracts and
reuse them where possible.

## 9. Non-negotiable invariants

1. Erase always starts from the original source, never a RIFE or conformed
   derivative.
2. Original files are never overwritten or deleted.
3. Neural/frame work remains dump → `app/filters/*` → encode.
4. RIFE runs before conform; conform runs after erase/RIFE.
5. Video and Image pools remain separate; this feature is video-only.
6. All paths are absolute and all subprocesses use argv lists through
   `shell.run_command`; no `shell=True` and no subprocess in `main.py`.
7. RIFE multiplier remains `2..128`.
8. Every frame/item reports progress; directory writers use `start_dir_watch`.
9. HTTP operation failures are HTTP 200 with `{"ok": false}`.
10. Named project persistence and session autosave retain their existing
    ownership rules.
11. The WebUI proof must use Playwright real clicks; curl is not UI proof.

## 10. Acceptance tests

### Backend/unit

- Create, persist, reload, and migrate a lineage ID.
- Save a mask; verify its dimensions/hash and reject invalid dimensions.
- A changed mask invalidates clean, RIFE, and conform artifacts.
- A changed Sequence duration invalidates only conform, not erase/RIFE.
- Erase receives the original path even when RIFE/conform variants are active.
- A clean result registers with `derived_from=original` and the lineage ID.
- RIFE consumes the clean result and registers against the clean lineage source.
- Conform consumes the clean/RIFE result and records the complete signature.
- Duplicate Sequence occurrences share erase/RIFE work but retain independent
  occurrence conform signatures.
- Failed/cancelled stages do not adopt partial output.
- Rerunning a completed batch reuses valid artifacts and performs no duplicate
  erase/RIFE/conform work.

### Playwright

Using real Sequence controls:

1. Select a clip that already has RIFE and conform variants.
2. Open Set erase mask; verify the editor uses the original source frame.
3. Paint and save a mask; reload and verify the marker persists.
4. Run the selected pipeline; verify the log/order is erase → RIFE → conform.
5. Verify the original remains selectable and unchanged.
6. Verify the clean/RIFE/conformed variants are visible and the final active
   Sequence state points to the cleaned lineage.
7. Add the same source twice; run the batch and verify one erase/RIFE job with
   two occurrence updates.
8. Change the mask; verify stale markers and regeneration on the next run.
9. Stop during a stage; verify no partial output is adopted and a retry resumes.
10. Run a mixed batch containing masked, unmasked, already-clean, and failing
    clips; verify continuation and final summary.
11. Verify zero new page errors and no load-time media-processing storm.

## 11. Explicit non-goals

- Automatic watermark detection.
- Moving-mark tracking or per-frame mask animation.
- Erasing arbitrary currently selected variants.
- Parallel GPU processing of multiple clips.
- Deleting old clean/RIFE/conform artifacts.
- Changing the standalone Erase tab's current behavior.
- Making one Sequence occurrence's mask differ from another occurrence of the
  same lineage.
