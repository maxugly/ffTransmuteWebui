# Fast check gate — Spec

> **Status**: Implemented (built + proven 2026-09-23; **no VERSION bump** — tooling, ships nothing to users). `--selftest` (7-case) + Stage 2 comment-hardening added 2026-09-23. Phase 2 items (§5) remain optional.
> **Hat**: Spec writer. This document + STATUS queue entry only — **no app code**.
> **Drives**: a root `check-gate.sh` that humans *and* agents run **before pytest and before every Playwright pass**. Optionally a git hook and (much later) a GitHub Actions mirror — see §5.
> **Baseline today (verified 2026-09-23, Node v22.23.1):** all stages green, whole gate < 5 s across 82 JS modules + `index.html` + the whole Python `app/` tree.

---

## 1. Problem & intent

The WebUI loads as an ES-module graph: **one module with a parse error blanks the entire UI** (Chromium aborts the whole import tree). Bug class already shipped more than once:

| Shipped failure | Cheap check that would have caught it | Caught by |
|---|---|---|
| `8.096` `helpText: 'turbo's boost'` — unterminated string in `riferecohere.js` | ESM compile scan | Stage 1 |
| `8.070` two stray braces in `sequence-transport.js` | ESM compile scan | Stage 1 |
| `8.086` unquoted `refs-music:` object key (all refs tabs died) | ESM compile scan | Stage 1 |
| `8.094` 43 unclosed `</div>` in the sidebar nav | HTML tag balance | Stage 3 |
| `8.057` `savePoolStateNow()` called without importing it | **not** catchable cheaply → runtime | — |
| `8.093` TDZ `bindSwitch` used before its `const` | **not** catchable cheaply → runtime | — |

Every one of those was found only at the **Playwright** stage, costing real iteration time. The intent here is a **sub-5 s local pre-flight** that catches the syntax/structural class — the "blank UI / dead tab" killers — before anyone starts a browser.

**Why plain `node --check` failed before** (recorded so no one rebuilds the old trap): it checks one file in isolation, does not follow `import`, and on `.js` files modern Node auto-detects the goal — which is not the *guaranteed* ESM parse Chromium does for `type="module"`. The reliable forms are verified in §4.2.

**Boundary (honest scope):** this gate does **not** catch runtime errors — TDZ, undefined names, dead knobs, CSS specificity. Those are what pytest/Playwright are still for. The gate's job is to *shorten the loop* by making the syntax/structural class impossible to reach a browser.

---

## 2. Scope

**In (Phase 1 — zero new dependencies):**

1. JS **ESM compile scan** — every `app/static/**/*.js`, forced through V8's real ESM parser (same grammar Chromium uses). Catches unterminated strings, stray braces, unquoted keys, any SyntaxError.
2. JS **import-resolution scan** — every static import specifier (`from '…'`, bare `import '…'`, quoted `import('…')`) resolves to a real file. Catches module-graph typos and cache-buster mistakes.
3. **HTML tag balance** on `app/static/index.html` — catches the unclosed-`</div>` class.
4. **Python syntax** — in-process `compile()` over `app/**/*.py` (src→AST, never executed, no `__pycache__` writes), the milliliter version of what pytest does on import anyway.
5. `node` present-and-warn check (fail loudly with a hint, same posture as `check_tools()`).

**Out (Phase 2, optional, named but not built — see §5):** ruff diff-gate on Python, git pre-commit hook, hosted GitHub Actions mirror. None are needed for Phase 1 to pay for itself.

---

## 3. Placement & invocation

- **One executable**: `check-gate.sh` at the **repo root** (root currently hosts the flat tooling: `lsp-check.sh`, `datamosh.sh`, `check_value_id.py`; there is no root `bin/`).
- Run from repo root: `./check-gate.sh`. Exit non-zero if **any** stage failed. Runs **all** stages regardless (one failure pass fixes everything, not fail-fast).
- `./check-gate.sh --selftest` re-proves the gate itself against a throwaway fixture tree (see §6.0) — run it before or after editing `check-gate.sh`.
- Output: one `[PASS]`/`[FAIL]` line per stage; only failing stages print the offending file(s), capped (first ~10 each).
- Whole-run budget: **< 5 s** (measured 1.94 s for the JS scan alone; most of the rest is node spawn).
- `node` missing → Stage 1 fails at once: `node not found on PATH — required for ESM compile scan` (invariant 2 posture; the `shell.run_command`/`bin/transmute` world is untouched — this is a root bash script, not an app subprocess).

---

## 4. Stage design (verified commands — spec is the truth)

### 4.1 Stage 0 — prerequisites
`command -v node` and `command -v python3`. Both exist in this environment.

### 4.2 Stage 1 — JS ESM compile scan

```bash
fail=0
while IFS= read -r f; do
  if ! node --input-type=module --check < "$f" 2>/dev/null; then
    echo "  [FAIL] $f"; fail=1
  fi
done < <(find mtapi-project/app/static -name '*.js' -type f | sort)
```

- **stdin form is mandatory.** Verified on Node v22.23.1: `node --check --input-type=module <file>` → `ERR_INPUT_TYPE_NOT_ALLOWED` (`--input-type` is only valid with `--eval`/`--print`/stdin). Feeding the file over stdin (`< "$f"`) is the exact same V8 ESM parse with **no temp files** — this is the `.mjs`-copy trick (what the `8.096` fix used) minus the copies.
- Error paths are stderr (`[stdin]:` line numbers) — the guard above prints the *filename* separately so the failing module is identifiable.
- Synthetic baseline: all **82** files pass; scan = **1.94 s**.
- Syntax-only by design: it **never executes** module bodies. The SPA's modules touch `window`/`document` at import time, so a *load* (e.g. `node -e "import(...)"`) is not viable without a DOM stub — do not reach for it.
- Top-level `await` and `import(...)` are legal here; dynamic imports are syntactically fine even when unresolved (that's Stage 2's job).

### 4.3 Stage 2 — import-resolution scan

Implemented in Python (stdlib, one `python3 - <<'PY'` heredoc or small sibling file — builder's choice, prefer single file).

- Collect every import specifier of all forms **across all `app/static/**/*.js`**:
  - `import x from '…'`, `import * as x from '…'`, bare `import '…'`, `export … from '…'`
  - quoted dynamic `import('…')`; **backtick** dynamic imports are unresolvable by design → skip.
- Resolve each against the served root:
  - `/…` (absolute, e.g. `/js/utils.js`) → `mtapi-project/app/static/` + specifier.
  - `./…` / `../…` (relative) → dirname of the importing file.
- Strip cache-busters: `?v=N` suffix before the existence check.
- Only **local** specifiers are checked — skip `http(s)://`, `data:`, `blob:`, bare package names.
- **Exclusion: `stablefluids/Build/**`.** Verified: `StableFluids.loader.js` imports `./dictionary.bin.js`, which is not a real module (the file does not exist — it is a Unity-generated runtime data sibling). Any future pure-runtime/vendored trees go in the same exclusion list, not special-cased in code.
- Bonus: also resolve `<script type="module" src="…">` in `index.html` (catches a wrong cache-buster before a reload).
- Unresolved specifier → FAIL listing *importing file* + *specifier*.
- **Comment-aware matching.** `//` and `/* … */` (incl. multi-line, tracked with a state flag) are stripped before the import/export match, so `/* lead */ import x from './a.js'` is seen (a plain line-start guard previously skipped it) and a JSDoc `* } from '/js/…'` example is not a false positive. Known heuristic boundary: a `//` or `/*` appearing *inside a string literal* on the same line as a real import (e.g. `const u = "https://x"`) truncates the line at that point — benign for the guard, since every real-line import check either already ran or never depended on the truncated tail.
- Scan roots are overridable via `STATIC_ROOT` / `APP_ROOT` / `HTML_FILE` (default to the real tree) — this is what makes `--selftest` (below) run against a throwaway fixture tree instead of mutating the app.
- Synthetic baseline: **359** local specifiers across 82 modules; the single unresolvable one is the excluded Unity import → green today.

### 4.4 Stage 3 — HTML tag balance

- Python stdlib `html.parser` over `app/static/index.html` with a void-element set (`br`, `img`, `input`, `link`, `meta`, …). `html.parser` treats `<script>`/`<style>` bodies as CDATA, so JS inside them does **not** false-positive the balance.
- Mismatched/unclosed non-void tag → FAIL with tag + frame. Verified green on current `index.html` (post-`8.094`).

### 4.5 Stage 4 — Python syntax

- Stdlib, **~0.2 s**, green today. Catches broke parens/indentation across `app/` — one sweep instead of pytest hitting the same error one `import` at a time.
- Implemented as `compile(src, f, "exec")` in a `glob` walk (`app/**/*.py`), not `compileall` — identical SyntaxError coverage with **zero `__pycache__`/`*.pyc` writes** into the tree.
- It does **not** type-check or catch unused/undefined names; that is deliberately Phase 2 (§5.2) because a full `ruff --select F` today surfaces pre-existing debt (verified: unused imports incl. a pile in `app/main.py`), which would make the gate chronically red.

---

## 5. Phase 2 — optional, not in this ticket

1. **git pre-commit hook.** The repo is a **worktree** on branch `wip` (`git rev-parse --git-dir` → `ffTransmuteWebui/.git/worktrees/ffTransmuteWebui-wip/`). A `pre-commit` hook written there is **per-worktree and uncommitted** — it does not replicate to the `main` worktree. Install script shells the hook out to `check-gate.sh`, only on changed JS/HTML/PY files if we want it lighter.
2. **ruff diff-gate.** `uvx ruff check --select F` on the *changed* `.py` files only. `uvx` is present (fetches ruff 0.16.8 on demand, no repo dependency). Needs the diff-scoping because a tree-wide run is red today on pre-existing debt; scrub or diff-gate *first*.
3. **Hosted CI (GitHub Actions on `origin`).** Only ever runs Stages 0–4 + a **unit subset that needs no weights/GPU/iGPU** — full pytest plus Playwright stay human/agent-local (they need real media, GPU models, and an iGPU to settle; invariant 12). Not worth doing until Phase 1 has proven itself locally.

---

## 6. Test plan / acceptance (no Playwright needed — that's the point)

0. **Self-test (`./check-gate.sh --selftest`, exit 0 = the gate is still trustworthy):** builds a throwaway fixture tree under `mktemp -d`, re-runs the real gate against it (`STATIC_ROOT`/`APP_ROOT`/`HTML_FILE` overrides), and asserts all seven cases: baseline green, Stage 1 catches bad syntax, Stage 2 catches a missing import, Stage 3 catches unbalanced HTML, Stage 4 catches a broken `.py`, restored fixture green again, and prereq fails without `node`. Cleanup even on failure (`rm -rf "$tmp"` guarded by case order; a mid-way crash only leaks a `/tmp` dir).
1. **Baseline:** `./check-gate.sh` prints all `[PASS]` and exits 0 in < 5 s on the current tree.
2. **Fault injection — each must FAIL naming the file** (the same injections `--selftest` performs automatically):
   - Copy a real module into `app/static/js/tabs/` with `helpText: 'turbo's boost'` → Stage 1 fails on it.
   - Delete a stray `}` from any module → Stage 1 fails.
   - `import './does-not-exist.js'` added to any module → Stage 2 fails listing importer + specifier.
   - Delete one `</div>` in `index.html` → Stage 3 fails.
   - Append `def f(` to any `app/*.py` → Stage 4 fails.
3. Remove the injected faults → green again.
4. `PATH` without `node` → Stage 0 fails with the install hint and skips the rest.
5. `check-gate.sh` must contain no `shell=True`, no `subprocess` (it is bash + node + python stdlib; invariant 2 spirit).

---

## 7. Files touched (build hint)

- `check-gate.sh` — **new** (repo root; single executable, stages as heredocs).
- `docs/testing-strategy.md` — §1 smoke template gains a **step 0**: `./check-gate.sh` must be green before connecting Playwright.
- `AGENTS.md` — one line under WebUI proof (invariant 12 neighborhood): "run `./check-gate.sh` before Playwright." (Proposal; AGENTS is law, so the human approves at kickoff.)
- `docs/STATUS.md` — queue entry (this spec) in *Ready to build*.
- **No VERSION bump by default** — this ships nothing to users; the human decides at kickoff if they want a DD for history.

---

## 8. Invariants honored

1. Filter platform untouched (zero app/runtime change). 2. No `shell=True`, nothing in `main.py`. 7. Vanilla only: bash + node + python stdlib; ruff is Phase 2 and diff-only via `uvx` (no repo dep). 10. Fail-loud posture for missing `node`. 12. This gate *feeds* Playwright proofs; it does not replace them.