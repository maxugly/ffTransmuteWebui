# Settings: Media Import card + auto-reencode VFR → CFR — Spec

> **Status:** Ready to build (not shipped) · bump root `VERSION` far-right DD on ship
> **Related:** `docs/singleclip-cfr-spec.md` (the `/ops/cfr` op this consumes) · `app/operations/cfr_ops.py` · `js/pool/auto-firstlast.js` (module pattern to copy) · `js/pool/items.js:addPathsToPool` (insertion point)
> **Scope:** one new first Settings card (`Media Import`), six relocated switches, two new setting keys (frontend + server mirror), one new `js/pool/auto-vfrcfr.js` module, one 3-key allowlist addition in `media/open.py`. No new backend endpoint. Op-outputs and Neural-warm cards untouched.

## 1. Purpose

Give media import a dedicated home and make VFR footage self-healing: when enabled, VFR videos are detected on import (`r_frame_rate != avg_frame_rate`) and re-encoded to CFR with the same semantics as a manual `/ops/cfr` run — without RIFE, without user intervention. The pool ends up holding the CFR file; downstream hooks (Sequence, first/last) never see the VFR original.

## 2. Settings card (`js/tabs/settings.js`)

New **first** card in `renderSettingsForm()`:

```
<section class="settings-card settings-import">
  kicker "Media" / title "Import"
```

### 2.1 Relocated (same IDs, same handlers, only moved)

From the Pool & cache card: `settingsAutoSeq`, `settingsAutoFL` + `#settingsAutoFLSub` (mode radios + Batch existing), `settingsThumbRam`, `settingsPhashRam`, `settingsWallPair`. Pool & cache keeps Thumbnail size + Autosave knobs + Mute; trim the moved lines out of its desc text.

### 2.2 New VFR block

- Master switch `settingsAutoVfrCfr`: “Auto-reencode VFR to CFR” (default off).
- Sub-block `#settingsAutoVfrCfrSub` (hidden unless on — same `hidden`-toggle pattern as `#settingsAutoFLSub`):
  - `settingsVfrCfrFps` control, `0 = Auto` (default), range 0–120 — identical semantics to the op’s `cfrFps` knob (`0 → target_fps=null → probe avg_frame_rate, fallback r_frame_rate`).
  - `Batch normalize pool` button (`#btnVfrCfrBatch`): detect + `/ops/cfr` every VFR pool item (mirrors the auto-F/L batch handler shape).
- Desc text: detection rule, CFR pass-through, replace semantics (`*_cfr.mp4` enters the pool; the original stays on disk), failures keep the original + warn.

## 3. Setting keys

| Frontend (`state.settings`) | Server (`settings.json`) | Default | Normalize |
|---|---|---|---|
| `autoVfrToCfr` | `auto_vfr_to_cfr` | `false` | `bool(...)` |
| `vfrCfrFps` | `vfr_cfr_fps` | `0` (= Auto) | `0 → 0`, else clamp `1–240` |

Plumbing, following the existing three-layer pattern exactly:

- `app.js` `SETTINGS_DEFAULTS` += both keys (missing-key safety for old `localStorage`).
- `settings.js` `settingsSnapshot()` += both; `saveSettings()` POST body += `auto_vfr_to_cfr`, `vfr_cfr_fps`; `bindSwitch('settingsAutoVfrCfr', 'autoVfrToCfr')` + sub-visibility toggle + FPS control wiring.
- `media/performance.py` `DEFAULT_SETTINGS` + `_normalize_settings()` += both keys (old `settings.json` files default safely off).

## 4. Import flow

### 4.1 New module `js/pool/auto-vfrcfr.js`

Mirrors `auto-firstlast.js` (session `_done` set, delta-only, never scans, must-not-break-import `try/catch`):

```
normalizeImportsForPool(paths: string[]) → Promise<string[]>  // final pool paths
maybeAutoVfrCfrForImport(paths)   // fire-and-forget wrapper used by items.js
batchNormalizePool()              // batch button: current pool video items
```

Per path: skip unless setting on and video ext; `GET /api/media_info?ensure_thumbs=false` → read `is_vfr_guess` (§5); CFR/probe-unknown → pass through; VFR → `POST /ops/cfr {input_path, target_fps: <vfrCfrFps or null>}` via the standard job machinery (progress + cancel free) → success returns the op’s output path, failure logs a console warning and returns the original. Never throws.

### 4.2 Insertion (`js/pool/items.js:addPathsToPool`)

Await `normalizeImportsForPool` **before** pushing items / firing `autoAddToSequence` / `maybeAutoFLForImport`, so all downstream hooks run unchanged against final (CFR) paths. Image pool untouched (existing video gate excludes it). Dry runs never trigger this (real imports only).

## 5. Backend gap: expose VFR fields on `/api/media_info`

`video_pipeline.probe` already returns `fps_avg`, `fps_r`, `is_vfr_guess`, but `media/open.py:_public_payload` allowlists meta keys (lines 168–172) and drops them. Add the three keys to the allowlist. That is the only server change outside `performance.py`. (Verify `routes/media.py:probe_fn` forwards `video_pipeline.probe` — it wraps it with a `frames` floor; the VFR keys must survive that wrapper.)

## 6. Verification

- Unit: `_normalize_settings` new-key defaults/clamps (missing → off/`0`; `0 → 0`; `500 → 240`; garbage → default); `resolve_cfr_fps` with `target_fps=null` (avg wins, bad avg → r).
- Playwright (curl is not UI proof, invariant §12): Settings → new card renders first; master off hides sub; on reveals FPS control; reload persists; import a real VFR fixture → pool entry becomes `*_cfr.mp4` and Sequence/F-L reference it; import a CFR clip → untouched; forced op failure → original kept + warning. Zero new JS errors.
- Ship: bump root `VERSION` far-right DD + update `docs/STATUS.md` top box (no digits copied), per `AGENTS.md` §3.
