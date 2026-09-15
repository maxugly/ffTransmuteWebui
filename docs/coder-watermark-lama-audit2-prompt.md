# Audit Prompt — Watermark LaMA Spec (Round 2 of 2)

> **Branch:** `wip` (not `main`)
> **Role:** Reviewer — assigned in this prompt. Report vs spec. Do not fix.
> **Kind:** Second-pass audit. Product is locked in `docs/watermark-lama-spec.md` (Proposed) + `docs/watermark-lama-audit-1.md` (Round 1 findings).
> **Hat:** Spec auditor. `docs/` output only — no app code, no spec edits. Your one deliverable is `docs/watermark-lama-audit-2.md`.
> **Chain:** You are audit agent #2. Round 1's residual-risk list is your primary hit list. The human then brings both audits back to the spec author to finalize.

---

## MISSION

Re-audit `docs/watermark-lama-spec.md` against round 1's residual risks and least-certain findings. Verify what round 1 could not, or correct what round 1 missed. Produce a GO/NO-GO verdict per spec section (§§1–12).

## READ FIRST (in this order)

1. `docs/watermark-lama-spec.md` (whole file — the target).
2. `docs/watermark-lama-audit-1.md` (whole file — round 1 findings + residual-risk list).
3. `docs/watermark-tab-spec.md` §§3/5/6 (V1 contract you must not re-spec or break).
4. `AGENTS.md` §2 (all 12 invariants — cite by number).
5. `mtapi-project/app/operations/watermark_ops.py` (V1 op shape, validation, naming).
6. `mtapi-project/app/static/js/tabs/watermark.js` + `mtapi-project/app/static/js/job-control.js` (dispatch path).
7. `docs/filter-platform-spec.md` §§2/3/10 (`directory` stage contract, `run_staged_job` pattern).
8. `docs/backlog/inpaint-spec.md` (mod-8 pad requirement) + `mtapi-project/requirements.txt` (deps).
9. `docs/STATUS.md` top box (what's shipped; do not re-queue shipped work).

## AUDIT DIMENSIONS

1. **Residual-risk verification (primary):** Address every item in `watermark-lama-audit-1.md` "Residual-risk list" (§1–7). For each, mark: confirmed / needs-verify / wrong. If you cannot verify from this box, say exactly what the builder must run/read and what they must record.

2. **Re-verify least-certain MAJOR findings (mandatory):**
   - **Finding #2** (`/api/thumbnail?frame=N` endpoint shape): Re-read `app/routes/media.py:123-214`. Confirm whether `?path=` or `?hash=` is required alongside `&frame=N`, and whether the spec's "-style" shorthand is buildable as written or misleads the frontend coder.
   - **Finding #4** (progress double-reporting): Re-read `app/staged_job.py:160-180` and `app/job_control.py:289-333`. Confirm whether a `report_progress` call inside a `directory` filter function produces visible duplicate progress lines, or whether the platform suppresses/stages them.

3. **Invariant compliance:** Re-check all 12 (filter platform, argv-only subprocesses, absolute I/O, pixel integrity, dual pools, wall/preview rules, vanilla JS, junk-only weights, per-frame progress, HTTP 200 + `ok:false`, `main.py` untouched, Playwright proof). One line per invariant: hold / break / n/a.

4. **V1 non-regression:** Does anything in the LaMA spec force changes to `watermark_remove`/`watermark_detect`/status V1 keys, the engine dropdown's disabled placeholders, or `job-control.js` existing branches? Quote the collision.

5. **Model facts:** `Carve/LaMa-ONNX` asset name/license/inputs, direct-OpenVINO-vs-ORT-EP framing, FP16 IR claim, Florence-2-base size/license/4-part conversion claim in §12, 25% cap and 60s kill criterion — what's verifiable from the searching agent's evidence vs asserted? Mark each: confirmed / needs-verify / wrong.

6. **Dependency honesty:** anything the spec implies is "already present" that isn't (`transformers`, `torch` weight for Florence-2, GPU plugin on this box)? Name the installer or the fallback.

7. **Frontend feasibility:** tab-local preview sourcing (exact `?path=`/`?hash=` + `&frame=N` shape confirmed?), overlay-div approach vs wall invariant, engine-gated rows, `collectWatermarkBody()` dispatch — buildable with zero new infra as claimed?

8. **Test plan realism:** can each DONE item actually be executed on this box (isolated port, fixtures, Playwright clicks)? Which items need a fixture or endpoint that doesn't exist yet?

## RULES

- Do not edit the spec, app code, STATUS, or VERSION. New files only.
- Quote file:line for every factual claim. No drive-by "this seems off."
- Severity per finding: **BLOCKER** (builder cannot proceed) / **MAJOR** (spec change needed before build) / **MINOR** (wording/nit).
- If a finding contradicts the spec, trust evidence-backed claims and say what you ran/read to prove it.
- **Do not re-grade anything audit-1 already proved with a file:line quote unless you cite new evidence.** Audit-1's confirmed findings are frozen; your job is to extend or correct them, not repeat them.
- Keep the audit under ~200 lines. Dense, not chatty.

## DONE (exactly this one new file, then stop)

- [ ] `docs/watermark-lama-audit-2.md` — the audit: verdict line (GO / GO-WITH-CHANGES / NO-GO), findings table (| # | Severity | Location | Claim vs evidence | Fix direction |), invariant checklist (§12-style, one line each), and an explicit **GO/NO-GO per spec section (§§1–12)**. Round 1's residual-risk list must be addressed item by item in the findings or explicitly marked "unchanged from audit-1."
- [ ] Nothing else touched (`git status` shows only the one new file).
