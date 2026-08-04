# Persistence Inventory — ffTransmute WebUI

Everything that survives a page refresh, browser close, or server restart.

---

## 1. Project file (`*.ffproject.json` — user-chosen path)

| Key | Type | Default |
|-----|------|---------|
| `kind` | string | `"fftransmute-project"` |
| `project_version` | int | `1` |
| `name` | string | project name |
| `created_at` | float | unix timestamp |
| `updated_at` | float | unix timestamp |
| `pool.*` | object | all session-state keys (§2) |

---

## 2. Session state (`~/.cache/mtapi/pool_state.json`)

| Key | Type | Default |
|-----|------|---------|
| `version` | int | `2` |
| `updated_at` | float | save timestamp |
| `items[]` | array | Video Pool clips |
| `items[].path` | string | absolute path |
| `items[].name` | string | display name |
| `items[].hash` | string | Blake2b content hash |
| `items[].size` | int | file bytes |
| `images[]` | array | Image Pool stills |
| `images[].path` | string | absolute path |
| `images[].name` | string | display name |
| `images[].hash` | string | content hash |
| `images[].size` | int | file bytes |
| `sequence[]` | array | Sequence composer entries |
| `sequence[].path` | string | absolute path |
| `sequence[].name` | string | display name |
| `sequence[].target_duration` | float\|null | per-clip duration |
| `selected_path` | string\|null | selected video path |
| `selected_image_path` | string\|null | selected image path |
| `reconcile` | string | `"pad"` |
| `aspect` | string | `"auto"` |
| `aspect_custom` | string | `""` |
| `output_path` | string | stitch output |
| `tile_zoom` | int | `200` |
| `tile_info.name` | bool | `true` |
| `tile_info.path` | bool | `true` |
| `tile_info.hash` | bool | `true` |
| `tile_info.opens` | bool | `true` |
| `tile_info.duration` | bool | `true` |
| `tile_info.fps` | bool | `true` |
| `tile_info.frames` | bool | `true` |
| `tile_info.video_codec` | bool | `true` |
| `tile_info.audio_codec` | bool | `true` |
| `tile_info.size` | bool | `true` |
| `tile_info.dims` | bool | `true` |
| `tile_info.frame_labels` | bool | `true` |
| `layout.composeHeight` | int | `280` |
| `layout.focusWidth` | int | `340` |
| `layout.selectionHeight` | int | `0` |
| `layout.matchHeight` | int | `180` |
| `layout.collapsed.sequence` | bool | `false` |
| `layout.collapsed.selection` | bool | `false` |
| `layout.collapsed.matches` | bool | `false` |
| `layout.collapsed.pool` | bool | `false` |

---

## 3. Watcher config (`mtapi-project/data/watcher.json`)

| Key | Type | Default |
|-----|------|---------|
| `enabled` | bool | `false` (always forced on write) |
| `in_dir` | string | `""` |
| `out_dir` | string | `""` |
| `target_width` | int | `1920` |
| `target_height` | int | `1080` |
| `resize_mode` | string | `"letterbox"` |

---

## 4. Last project path (`~/.cache/mtapi/last_project_path.txt`)

A single line containing the absolute path of the most recently opened or saved `.ffproject.json`.

---

## 5. localStorage (browser)

| Key | Type | Content |
|-----|------|---------|
| `mtapi_sidebar_collapsed` | `"1"`\|`"0"` | whole sidebar icon mode |
| `mtapi_preview_collapsed` | `"1"`\|`"0"` | preview panel collapsed |
| `mtapi_nav_sections` | JSON | nav category collapse — `{ sectionId: true }` = collapsed (`nav-collapse-spec.md`) · `4.69` |
| `mtapi_sidebar_w` | string px | sidebar width (clamped 56–600) |
| `mtapi_panel_split` | CSS string | left/right grid columns |
| `mtapi_console_h` | string px | console panel height |
| `fftransmute.quick` | JSON | `{reconcile, aspect, aspectCustom}` |
| `mtapi.notes.v1` | JSON | `{left: string, right: string}` |
| `mtapi_prompt_library` | JSON | Prompt Library ± pairs (if present) |

---

## 6. `beforeunload` beacon

On page close/refresh, `navigator.sendBeacon` fires a `PUT /api/pool/state` with identical payload to `savePoolStateNow()`. Non-blocking, best-effort.

---

## 7. What is NOT persisted (lost on F5)

> **Target redesign:** `docs/universal-persistence-spec.md` (session vs named project isolation + full desk).

| State key | Reset to |
|-----------|----------|
| `state.activeTab` | `"mosh"` |
| `state.operations` | fetched from `/ops` |
| `state.health` | fetched from `/health` |
| `state.fb` (file browser modal) | — |
| `state.multiClips` | `[]` |
| `state.selectedMoshMode` | `"melt"` |
| `state.moshVideoFrames` | `100` |
| `state.faceMorph.images[]` | `[]` |
| `state.faceMorph.folder` | `null` |
| `state.faceMorph.selected` | `0` |
| `state.withoutbg.images[]` | `[]` |
| `state.withoutbg.folder` | `null` |
| `state.withoutbg.selected` | `0` |
| `state.styleTransfer.contents[]` | `[]` |
| `state.styleTransfer.stylePath` | `null` |
| `state.styleTransfer.selected` | `0` |
| `state.imageSort.images[]` | `[]` |
| `state.imageSort.folder` | `null` |
| `state.imageSort.selected` | `0` |
| Speed / RIFE / DeepDream / Convert **form knobs** (mostly DOM-only) | defaults on tab re-render |
| `state.cut.refA` | — |
| `state.cut.refB` | — |
| `state.cut.mode` | — |
| `state.cut.compareMode` | — |
| `state.cut.overlayOpacity` | — |
| `state.cut.abPosition` | — |
| `state.pool.filterQuery` | `""` |
| `state.pool.hoverPath` | `null` |
| `state.pool.focusPath` | `null` |
| `state.pool.selectedSeqId` | `null` |
| `state.pool.seqDragId` | `null` |
| `state.pool.loading` | `false` |
| `state.pool.playback.*` | reset |
| `state.pool.matchMaxDistance` | `10` |
| `state.pool.matchMode` | `"next"` |
| `state.pool.matchResults` | `null` |
| `state.pool.matchLoading` | `false` |
| `state.imagePool.filterQuery` | `""` |
| `state.imagePool.loading` | `false` |
| `state.watcher.enabled` | `false` |
| `state.watcher.status` | fetched from `/api/watcher` |
| `state.watcher.pollTimer` | — (runtime only) |
| `state.project.dirty` | `false` |
| `window.globalInputs.video` | `""` |
| `window.globalInputs.image` | `""` |
| `window.globalInputs.pathIn` | `""` |
| `window.globalInputs.pathOut` | `""` |
| `window.globalInputs.frameStart` | `1` |
| `window.globalInputs.frameEnd` | `100` |
| `window.globalInputs.totalFrames` | `100` (re-probed after load) |
