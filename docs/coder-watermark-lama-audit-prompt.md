# Audit Prompt — Watermark LaMA Spec (Round 1 of 2)

> **Branch:** `wip` (not `main`)
> **Role:** Reviewer — assigned in this prompt. Report vs spec. Do not fix.
> **Kind:** One-shot audit. Product is locked in `docs/watermark-lama-spec.md` (Proposed).
> **Hat:** Spec auditor. `docs/` output only — no app code, no spec edits. Your two deliverables are both new files (see DONE).
> **Chain:** You are audit agent #1. Your second deliverable is the prompt for audit agent #2 (round 2). The human then brings both audits back to the spec author to finalize.

---

## MISSION

Stress-test `docs/watermark-lama-spec.md` for buildability on this box and consistency with repo law. Find every load-bearing lie, gap, or invariant violation — then hand round 2 a sharper knife, not a blank page.

## READ FIRST (in this order)

1. `docs/watermark-lama-spec.md` (whole file — the target).
2. `docs/watermark-tab-spec.md` §§3/5/6 (V1 contract you must not re-spec or break).
3. `AGENTS.md` §2 (all 12 invariants — cite by number).
4. `mtapi-project/app/operations/watermark_ops.py` (V1 op shape, validation, naming, `_ensure_output_file` posture).
5. `mtapi-project/app/static/js/tabs/watermark.js` + `mtapi-project/app/static/js/job-control.js` (dispatch path you must extend, not fork).
6. `docs/filter-platform-spec.md` §§2/3/10 (`directory` stage contract, `run_staged_job` pattern).
7. `docs/backlog/inpaint-spec.md` (mod-8 pad requirement) + `mtapi-project/requirements.txt` (what's already a dep: `openvino`, `optimum[openvino]` — and what is NOT: `onnxruntime-openvino`, `torch`, `transformers` standalone).
8. `docs/STATUS.md` top box (what's shipped; do not re-queue shipped work).

## AUDIT DIMENSIONS (all seven, no skipping)

1. **Codebase reality:** every file path, module name, function, route, knob helper, and status key the spec names — does it exist as described? Flag invented APIs.
2. **Invariant compliance:** check all 12 (filter platform, argv-only subprocesses, absolute I/O, pixel integrity, dual pools, wall/preview rules, vanilla JS, junk-only weights, per-frame progress, HTTP 200 + `ok:false`, `main.py` untouched, Playwright proof). One line per invariant: hold / break / n/a.
3. **V1 non-regression:** does anything in the LaMA spec force changes to `watermark_remove`/`watermark_detect`/status V1 keys, the engine dropdown's disabled placeholders, or `job-control.js` existing branches? Quote the collision.
4. **Model facts:** `Carve/LaMa-ONNX` asset name/license/inputs, direct-OpenVINO-vs-ORT-EP framing, FP16 IR claim, Florence-2-base size/license/4-part conversion claim in §12, 25% cap and 60s kill criterion — what's verifiable from the searching agent's evidence vs asserted? Mark each: confirmed / needs-verify / wrong.
5. **Dependency honesty:** anything the spec implies is "already present" that isn't (`transformers`, `torch` weight for Florence-2, GPU plugin on this box)? Name the installer or the fallback.
6. **Frontend feasibility:** tab-local preview sourcing (`/api/thumbnail?frame=N` — does that endpoint exist with that shape?), overlay-div approach vs wall invariant, engine-gated rows, `collectWatermarkLamaBody()` dispatch — buildable with zero new infra as claimed?
7. **Test plan realism:** can each DONE item actually be executed on this box (isolated port, fixtures, Playwright clicks)? Which items need a fixture or endpoint that doesn't exist yet?

## RULES

- Do not edit the spec, app code, STATUS, or VERSION. New files only.
- Quote file:line for every factual claim. No drive-by "this seems off."
- Severity per finding: **BLOCKER** (builder cannot proceed) / **MAJOR** (spec change needed before build) / **MINOR** (wording/nit).
- If a finding contradicts the spec, trust evidence-backed claims and say what you ran/read to prove it.
- Keep the audit under ~150 lines. Dense, not chatty.

## DONE (exactly these two new files, then stop)

- [ ] `docs/watermark-lama-audit-1.md` — the audit: verdict line (APPROVE / APPROVE-WITH-CHANGES / REWRITE-SECTION), findings table (| # | Severity | Location | Claim vs evidence | Fix direction |), invariant checklist (§12-style, one line each), and an explicit **residual-risk list** (everything you could NOT verify — this is round 2's hit list, minimum 5 items).
- [ ] `docs/coder-watermark-lama-audit2-prompt.md` — the round-2 prompt, written in the same shape as this file (mission / read-first / dimensions / rules / done), but: (a) it points at the spec PLUS your audit-1, (b) its dimensions are your residual-risk list plus a mandatory re-verification of your two least-certain BLOCKER/MAJOR findings (name them), (c) its deliverable is `docs/watermark-lama-audit-2.md` in the same finding-table format plus a final GO/NO-GO per spec section (§§1–12), and (d) it forbids round 2 from re-grading anything audit-1 already proved with a file:line quote unless new evidence is cited. Include the same docs-only, no-code law.
- [ ] Nothing else touched (`git status` shows only the two new files).
