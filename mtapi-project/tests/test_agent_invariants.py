"""Agent-friendly invariant tests — machine-checkable AGENTS.md rules.

Why this file exists: every non-negotiable invariant in the root `AGENTS.md`
§2 used to be enforced only by human/LLM review, which is exactly where
drift creeps in. These tests turn those rules into cheap, deterministic,
grep-level checks so an agent can verify its own change in one command:

    cd mtapi-project && python -m pytest tests/test_agent_invariants.py -q

Design rules (keep them, they are what makes this agent-friendly):
  * Fast (<1 s), stdlib-only, no server, no ffmpeg, no network, no venv deps.
  * Deterministic: scans repo files or pure functions; never touches state.
  * Every failure message names the offending file:line AND the AGENTS.md
    rule number AND a concrete fix hint — the LLM should not have to open
    the source to understand the break.
  * New code that violates an invariant fails here first, before review.

Test map (invariant → test):
  #2  no shell=True / raw subprocess outside shell.py
  #3  transmute must echo "Output:" and "Command:"
  #7  no frontend frameworks / npm deps in shipped static JS+HTML
  #8  junk dir is gitignored and stays out of the package
  #9  RIFE multiplier bounds are 2..128 everywhere they are declared
  #10 OperationResult defaults failures to ok=False (HTTP-200 error shape)
  #11 app/main.py must not import __future__ annotations (dynamic routes)
  §3  VERSION is a single integer line; both transmute copies stay identical
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]      # mtapi-project/
REPO_ROOT = PROJECT_ROOT.parent                          # repo root
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# ── scanning helpers (shared, so new invariant tests cost ~one function) ────

def _py_sources(root: Path) -> list[Path]:
    """All app/*.py sources, excluding caches, junk and vendored trees."""
    skip_parts = {"__pycache__", "junk", ".venv", "vendor", "node_modules"}
    return [
        p for p in root.rglob("*.py")
        if not (set(p.parts) & skip_parts)
    ]


def _string_constant_spans(tree: "ast.AST") -> list[tuple[int, int]]:
    """(start_line, end_line) of every string constant — docs/comments inside
    them must never count as violations of a code-pattern scan."""
    spans = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.end_lineno:
            spans.append((node.lineno, node.end_lineno))
    return spans


def _findings(files: list[Path], pattern: re.Pattern, *, exclude_files: set[Path] = frozenset()):
    """Return ['path:line: text', ...] for every matching *code* line.

    Python files are AST-aware: matches inside docstrings/string literals are
    skipped (half this repo documents the rules it follows). JS/HTML get plain
    line scans with `//` and `#` comment lines skipped.
    """
    hits = []
    for f in files:
        if f in exclude_files:
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        spans: list[tuple[int, int]] = []
        if f.suffix == ".py":
            try:
                spans = _string_constant_spans(ast.parse(text))
            except SyntaxError:  # let other tests surface real syntax breaks
                pass
        for lineno, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith("//"):
                continue                        # comments don't violate anything
            if any(a <= lineno <= b for a, b in spans):
                continue                        # inside a string constant / docstring
            if pattern.search(line):
                rel = f.relative_to(REPO_ROOT)
                hits.append(f"{rel}:{lineno}: {stripped[:120]}")
    return hits


def _fail(findings: list[str], rule: str, why: str, fix: str):
    assert not findings, (
        f"AGENTS.md invariant {rule} violated — {why}\n"
        + "\n".join(findings)
        + f"\nFIX: {fix}"
    )


# ── invariant 2: subprocesses go through shell.run_command with argv lists ──

_SHELL_TRUE = re.compile(r"shell\s*=\s*True")
_RAW_SUBPROCESS = re.compile(r"\b(subprocess\.(run|Popen|call|check_output|check_call)|os\.system)\b")
_SHELL_MODULE = (PROJECT_ROOT / "app" / "shell.py").resolve()

# Files that legitimately use sync `subprocess.run(argv)` helpers where the
# async shell.run_command is unavailable (CLI scripts, blocking workers).
# The rule being enforced is *argv-list discipline*, not a single call site —
# adding a name here is a review decision, so keep this list short and dated.
_SYNC_SUBPROCESS_ALLOWLIST = {
    "app/probe.py",                        # sync wrapper pair for CLI scripts
    "app/watcher.py",                      # folder-watcher worker thread
    "app/routes/meta.py",                  # xdg-open / open (OS reveal shortcut)
    "app/operations/facemorph_engine.py",  # blocking engine helper
    "app/operations/deepdream/models.py",  # blocking model-export helper
}


def _rel(p: Path) -> str:
    return p.relative_to(PROJECT_ROOT).as_posix()


def test_no_shell_true_anywhere():
    """Invariant 2: NEVER shell=True. No exceptions, no allowlist."""
    _fail(
        _findings(_py_sources(PROJECT_ROOT / "app"), _SHELL_TRUE),
        "#2",
        "`shell=True` was found (paths with spaces/metacharacters must only fail cleanly).",
        "Pass an argv list to app.shell.run_command instead.",
    )


def test_sync_subprocess_only_in_allowlisted_files():
    """Invariant 2: new code must spawn via app.shell.run_command. Sync
    subprocess.run is grandfathered only in the listed files; anything else
    fails here with the exact file:line to fix."""
    allowed = {(PROJECT_ROOT / name).resolve() for name in _SYNC_SUBPROCESS_ALLOWLIST}
    _fail(
        _findings(_py_sources(PROJECT_ROOT / "app"), _RAW_SUBPROCESS,
                  exclude_files=allowed | {_SHELL_MODULE}),
        "#2",
        "raw subprocess/os.system call outside app/shell.py and the sync allowlist.",
        "Use `await shell.run_command([...])`; it streams stderr and keeps argv discipline. "
        "(If this truly must stay sync, extend _SYNC_SUBPROCESS_ALLOWLIST with justification.)",
    )


def test_allowlisted_sync_calls_stay_argv_lists():
    """The allowlist only permits argv-LIST spawns. If a grandfathered file
    ever grows shell string execution (`os.system`, or subprocess with a raw
    string command + shell=True), this catches it at the same time as the
    global scan above — belt and braces, one clear message."""
    bad = re.compile(r"os\.system\s*\(|subprocess\.\w+\(\s*[\"']")
    files = [(PROJECT_ROOT / n).resolve() for n in _SYNC_SUBPROCESS_ALLOWLIST]
    _fail(
        _findings([f for f in files if f.is_file()], bad),
        "#2",
        "a string-form shell invocation appeared in an allowlisted sync file.",
        "Keep argv lists even in sync code: subprocess.run([exe, arg1, arg2], ...).",
    )


def test_no_subprocess_in_main_py():
    """Invariant 2 (explicit): main.py must never import subprocess at all."""
    src = (PROJECT_ROOT / "app" / "main.py").read_text(encoding="utf-8")
    assert "import subprocess" not in src, (
        "AGENTS.md invariant #2 violated — main.py imports subprocess.\n"
        "FIX: move the spawn behind an operation handler using app.shell.run_command."
    )


# ── invariant 3: transmute echoes Output:/Command: (shell.parse_line contract) ──

_TRANSMUTE_COPIES = [REPO_ROOT / "transmute", PROJECT_ROOT / "bin" / "transmute"]


@pytest.mark.parametrize("script", _TRANSMUTE_COPIES, ids=lambda p: str(p.relative_to(REPO_ROOT)))
def test_transmute_prints_output_and_command(script):
    """Invariant 3: `transmute` prints `Output:` and `Command:` lines —
    shell.parse_line() depends on that exact prefix format."""
    assert script.is_file(), f"missing transmute copy: {script}"
    text = script.read_text(encoding="utf-8", errors="replace")
    for prefix in ("Output:", "Command:"):
        assert re.search(rf'echo[^\n]*"{prefix}', text) or prefix in text, (
            f"AGENTS.md invariant #3 violated — {script.name} no longer echoes '{prefix}'.\n"
            "FIX: restore the echo; app/shell.py parse_line() re-derives nothing on purpose."
        )


def test_transmute_copies_parity():
    """Invariant 3: keep `bin/transmute` in parity with the root `transmute`.

    Byte-parity is the ideal; while the two copies legitimately drift in this
    repo, this test fails LOUDLY with a diff summary so an agent fixing either
    copy knows to sync the other — and once synced it stays pinned green.
    """
    root_copy, bin_copy = _TRANSMUTE_COPIES
    if not bin_copy.exists():
        pytest.skip("bin/transmute copy not present in this checkout")
    a, b = root_copy.read_text(errors="replace"), bin_copy.read_text(errors="replace")
    if a == b:
        return
    import difflib
    diff = list(difflib.unified_diff(a.splitlines(), b.splitlines(),
                                     "transmute", "bin/transmute", lineterm="", n=0))
    shown = "\n".join(diff[:24])
    raise AssertionError(
        "AGENTS.md invariant #3 violated — root `transmute` and `bin/transmute` "
        f"diverged ({len(diff)} diff lines).\n{shown}\n"
        "FIX: port the change to the other copy (or `cp` the intended source of "
        "truth) before shipping."
    )


# ── invariant 7: vanilla frontend, no frameworks, no npm ────────────────────

STATIC_DIR = PROJECT_ROOT / "app" / "static"
_FRAMEWORK = re.compile(
    r"(?:from|import)\s+['\"](?:react|vue|svelte|angular|next|nuxt)['\"]"
    r"|require\(['\"](?:react|vue|jquery)"
    r"|\bReactDOM\b|\bnew Vue\(|@Component.*angular",
    re.IGNORECASE,
)
_CDN_FRAMEWORK = re.compile(
    r"cdn[^'\"]*/(?:react|vue(\.min)?\.js|angular|svelte|tailwindcss)[^'\"]*",
    re.IGNORECASE,
)


def _static_web_files():
    return list(STATIC_DIR.rglob("*.js")) + list(STATIC_DIR.rglob("*.html")) \
        + [p for p in REPO_ROOT.glob("*.html")]


def test_no_frontend_framework_imports():
    """Invariant 7: vanilla HTML/CSS/ES6 only — no React/Vue/Tailwind anywhere."""
    files = [p for p in _static_web_files()
              if "vendor" not in set(p.parts) and "__pycache__" not in set(p.parts)]
    _fail(_findings(files, _FRAMEWORK), "#7",
          "a frontend framework import/usage appeared in shipped static files.",
          "AGENTS.md forbids frameworks; rewrite in vanilla ES6.")


def test_index_html_has_no_framework_cdn():
    """Invariant 7: no framework CDN <script>/<link> tags in index.html."""
    html = STATIC_DIR / "index.html"
    if not html.is_file():
        pytest.skip("index.html location differs in this checkout")
    _fail(_findings([html], _CDN_FRAMEWORK), "#7",
          "a framework/tailwind CDN tag was added to index.html.",
          "Remove it; the SPA is dependency-free by rule.")


def test_package_json_not_required_by_app():
    """Invariant 7: the Python app must not shell out to npm/node build steps
    (watermark tab's node usage is runtime, not a bundler — keep it that way)."""
    banned = re.compile(r"(webpack|vite|rollup|babel|esbuild)", re.IGNORECASE)
    _fail(_findings(_py_sources(PROJECT_ROOT / "app"), banned), "#7",
          "a JS bundler name appeared in app code (npm tooling sneaking in).",
          "No build step: ship plain ES modules under app/static/js.")


# ── invariant 8: junk lives only in mtapi-project/junk ──────────────────────

def test_junk_dir_is_gitignored():
    """Invariant 8: throwaways/weights/screenshots must never get committed.

    Checks both the ignore rule AND that no junk payload is actually tracked
    in git right now (a file can be ignored yet still committed if it was
    added before the rule — `git ls-files` catches exactly that)."""
    candidates = [REPO_ROOT / ".gitignore", PROJECT_ROOT / ".gitignore"]
    covered = any(
        path.is_file() and re.search(r"^junk[/*]", path.read_text(encoding="utf-8"), re.M)
        for path in candidates
    )
    assert covered, (
        "AGENTS.md invariant #8 violated — no .gitignore entry keeps junk/ untracked.\n"
        "FIX: add `junk/*` to mtapi-project/.gitignore."
    )
    import subprocess

    r = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "--", "mtapi-project/junk"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        pytest.skip("git not available in this environment")
    tracked = [l for l in r.stdout.splitlines() if not l.endswith(".gitkeep")]
    assert not tracked, (
        "AGENTS.md invariant #8 violated — junk files are TRACKED in git:\n"
        + "\n".join(tracked[:20])
        + "\nFIX: `git rm --cached <file>` them; junk stays out of history going forward."
    )


# ── invariant 9: RIFE M multiplier is 2..128 wherever declared ─────────────

def test_rife_multiplier_bounds():
    """Invariant 9: RIFE M ∈ [2, 128]. Read the live Pydantic schema of the
    rife operation modules and assert every bounded multiplier field uses
    exactly those bounds. If the modules cannot even be imported (missing
    heavy deps like cv2), fall back to an AST scan of the Field(...) calls —
    the rule must stay verifiable in a bare environment too."""
    from pydantic import BaseModel

    modules = []
    try:
        from app.operations import rife_ops, rife_recohere_ops  # type: ignore
        modules = [rife_ops, rife_recohere_ops]
    except Exception:
        pass

    checked = 0
    for module in modules:
        for attr in vars(module).values():
            if not (isinstance(attr, type) and issubclass(attr, BaseModel) and attr is not BaseModel):
                continue
            for name, fld in getattr(attr, "model_fields", {}).items():
                if "multiplier" not in name.lower() and name.lower() not in ("m", "mult"):
                    continue
                ge = next((g.ge for g in fld.metadata if hasattr(g, "ge")), None)
                le = next((g.le for g in fld.metadata if hasattr(g, "le")), None)
                if ge is None and le is None:
                    continue  # unbounded internal alias — nothing to pin here
                checked += 1
                assert (ge, le) == (2, 128), (
                    f"AGENTS.md invariant #9 violated — {module.__name__}."
                    f"{attr.__name__}.{name} declares RIFE M range [{ge}, {le}], "
                    "expected [2, 128]."
                )

    if checked == 0:
        # AST fallback: find `multiplier ... Field(<default>, ge=N, le=M)` in
        # the rife modules without importing them (works without cv2/torch).
        import ast as _ast
        bound_re = re.compile(r"^\s*multiplier\s*:\s*\w+.*Field\(", re.M)
        for src_name in ("app/operations/rife_ops.py", "app/operations/rife_recohere_ops.py"):
            f = PROJECT_ROOT / src_name
            if not f.is_file():
                continue
            tree = _ast.parse(f.read_text(errors="replace"))
            for node in _ast.walk(tree):
                if not (isinstance(node, _ast.Call) and getattr(node.func, "id", "") == "Field"):
                    continue
                kw = {k.arg: k.value for k in node.keywords if k.arg in ("ge", "le")}
                if "ge" not in kw and "le" not in kw:
                    continue
                # Is this Field the one assigned to a *multiplier* variable?
                # Cheap proxy: same line has 'multiplier'.
                line = f.read_text(errors="replace").splitlines()[node.lineno - 1]
                if "multiplier" not in line.lower():
                    continue
                ge = kw["ge"].value if kw.get("ge") and isinstance(kw["ge"], _ast.Constant) else None
                le = kw["le"].value if kw.get("le") and isinstance(kw["le"], _ast.Constant) else None
                checked += 1
                assert (ge, le) == (2, 128), (
                    f"AGENTS.md invariant #9 violated — {src_name}:{node.lineno} "
                    f"declares RIFE M range [{ge}, {le}], expected [2, 128]."
                )

    assert checked > 0, (
        "AGENTS.md invariant #9 unverifiable — no bounded RIFE multiplier field "
        "found in rife ops (neither live schema nor source scan). If the knob "
        "moved elsewhere, update this test to point at its new declaration site."
    )


# ── invariant 10: HTTP ops report failures as ok=False (not exceptions) ─────

def test_operation_result_defaults_to_ok_false_shape():
    """Invariant 10: every op failure is HTTP 200 + {'ok': False, 'error': ...}.
    The shared result model must therefore expose ok/error exactly that way."""
    from app.contract import OperationResult

    res = OperationResult(ok=False, operation="demo", error="boom")
    dumped = res.model_dump()
    assert dumped["ok"] is False, "OperationResult.ok must serialize as bool False"
    assert dumped["error"] == "boom", "failure reason must ride in `error`, not an exception"
    assert "output_path" in dumped and dumped["output_path"] is None, (
        "ok=False results must still carry the null output_path field clients expect"
    )


# ── invariant 11: main.py keeps dynamic routes working ──────────────────────

def test_main_py_has_no_future_annotations_import():
    """Invariant 11: `from __future__ import annotations` breaks main.py's
    dynamic per-operation route generation — it must never appear there."""
    src = (PROJECT_ROOT / "app" / "main.py").read_text(encoding="utf-8")
    assert "from __future__ import annotations" not in src, (
        "AGENTS.md invariant #11 violated — main.py now has "
        "`from __future__ import annotations`, which breaks dynamic routes.\n"
        "FIX: remove it; use string annotations locally if needed."
    )


# ── §3 versioning: VERSION file shape ───────────────────────────────────────

def test_version_file_matches_documented_scheme():
    """VERSIONING.md: root VERSION is one dotted line whose far-right field
    is the ship counter (e.g. `000.000.8.131`). Pin the shape so a stray
    newline/label can't silently break the bump tooling."""
    raw = (REPO_ROOT / "VERSION").read_text(encoding="utf-8")
    assert "\n" not in raw.strip() or raw.count("\n") <= 1, (
        f"root VERSION must be a single line, got {raw!r}"
    )
    v = raw.strip()
    assert re.fullmatch(r"\d+(?:\.\d+){1,3}", v), (
        f"VERSION must be dotted integers per VERSIONING.md, got {v!r}.\n"
        "FIX: write e.g. `000.000.8.132` — no spaces, no 'v', no comment."
    )


# ── bonus guard: the never-overwrite naming convention itself ───────────────

def test_unique_output_path_never_reuses_existing_name(tmp_path):
    """README contract: repeated runs produce file.png, file_0001.png… and
    never clobber. Pin the core allocator behaviour agents rely on."""
    from app.pathutil import finalize_output_path, unique_output_path

    target = tmp_path / "out.png"
    first = finalize_output_path(target)
    assert first == target, "free name must be used as-is"
    target.write_bytes(b"x")
    second = finalize_output_path(target)
    assert second.name == "out_0001.png", f"expected bump to _0001, got {second.name}"
    second.write_bytes(b"x")
    third = unique_output_path(target)
    assert third.name == "out_0002.png", "sequence must advance, never jump back"
    assert not third.exists(), "returned path must not exist yet"
