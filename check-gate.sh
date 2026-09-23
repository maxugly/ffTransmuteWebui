#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATIC="$ROOT/mtapi-project/app/static"
APP="$ROOT/mtapi-project/app"
CAP="${CHECK_GATE_CAP:-10}"

_total_ok=0
_total_bad=0

stage_pass() { echo "  [PASS] $1"; _total_ok=$((_total_ok + 1)); }
stage_fail() { echo "  [FAIL] $1"; _total_bad=$((_total_bad + 1)); }

_prereq_bad=0

stage_prereq() {
    local label="prerequisites"
    if ! command -v node >/dev/null 2>&1; then
        echo "  [FAIL] $label — node not found on PATH: required for the JS ESM compile scan"
        _prereq_bad=1
        return 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        echo "  [FAIL] $label — python3 not found on PATH: required for the import/tag/syntax stages"
        _prereq_bad=1
        return 1
    fi
    stage_pass "$label — node $(node -v 2>/dev/null) + python3"
}

stage_js_compile() {
    local label="JS ESM compile scan"
    local f err n=0 bad=0 shown=0
    while IFS= read -r f; do
        n=$((n + 1))
        if ! err=$(node --input-type=module --check < "$f" 2>&1); then
            bad=$((bad + 1))
            if [ "$shown" -lt "$CAP" ]; then
                printf '      %s\n' "$f"
                printf '%s\n' "$err" | sed -n '1,2p' | sed 's/^/        /'
                shown=$((shown + 1))
            fi
        fi
    done < <(find "$STATIC" -name '*.js' -type f | sort)
    if [ "$bad" -eq 0 ]; then
        stage_pass "$label ($n modules clean)"
        return 0
    fi
    stage_fail "$label ($n scanned, $bad fail)"
    return 1
}

stage_imports() {
    local label="JS import resolution"
    local rc
    python3 - "$STATIC" "$CAP" <<'PY'
import os, re, sys

static_root, cap = sys.argv[1], int(sys.argv[2])
exclude_dirs = {"stablefluids"}
extract = re.compile(r"""["']([^"']+)["']""")

def local_spec(spec):
    return spec and (spec.startswith("/") or spec.startswith("./") or spec.startswith("../"))

def resolve(importing, spec):
    base = spec.split("?", 1)[0].split("#", 1)[0]
    if base.startswith("/"):
        return os.path.join(static_root, base.lstrip("/"))
    return os.path.normpath(os.path.join(os.path.dirname(importing), base))

failures = []

for dirpath, dirnames, filenames in os.walk(static_root):
    dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
    for fn in sorted(filenames):
        if not fn.endswith(".js"):
            continue
        path = os.path.join(dirpath, fn)
        try:
            lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
        except OSError:
            continue
        for line in lines:
            ls = line.lstrip()
            if not (ls.startswith("import") or ls.startswith("export") or "import(" in line):
                continue
            if ls.startswith("*") or ls.startswith("//") or ls.startswith("/*"):
                continue
            for m in extract.finditer(line):
                spec = m.group(1)
                if not local_spec(spec):
                    continue
                target = resolve(path, spec)
                if not os.path.isfile(target):
                    failures.append((os.path.relpath(path, static_root), spec, os.path.relpath(target, static_root)))

script_meta = os.path.join(static_root, "index.html")
if os.path.isfile(script_meta):
    for m in re.finditer(r"""<script[^>]*\bsrc=["']([^"']+)["']""",
                         open(script_meta, encoding="utf-8", errors="replace").read()):
        spec = m.group(1)
        if local_spec(spec):
            target = resolve(script_meta, spec)
            if not os.path.isfile(target):
                failures.append(("index.html", spec, os.path.relpath(target, static_root)))

if failures:
    print("      unresolved imports:")
    for imp, spec, target in failures[:cap]:
        print(f"        {imp}: '{spec}'  →  {target}")
    if len(failures) > cap:
        print(f"        … and {len(failures) - cap} more")
    sys.exit(1)
PY
    rc=$?
    if [ "$rc" -eq 0 ]; then
        stage_pass "$label"
    else
        stage_fail "$label"
    fi
    return "$rc"
}

stage_html() {
    local label="HTML tag balance (index.html)"
    local rc
    python3 - "$STATIC/index.html" "$CAP" <<'PY'
import sys
from html.parser import HTMLParser

path, cap = sys.argv[1], int(sys.argv[2])
void = {"area", "base", "br", "col", "command", "embed", "hr", "img", "input",
        "keygen", "link", "meta", "param", "source", "track", "wbr"}
stack = []
errors = []

class Balance(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if tag.lower() not in void:
            stack.append((tag.lower(), self.getpos()))
    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in void:
            return
        if not stack:
            errors.append(f"extra </{tag}> at line {self.getpos()[0]}")
            return
        if stack[-1][0] != tag:
            errors.append(f"mismatch </{tag}> at line {self.getpos()[0]}, expected </{stack[-1][0]}> opened at line {stack[-1][1][0]}")
            stack.pop()
            return
        stack.pop()

Balance(convert_charrefs=True).feed(open(path, encoding="utf-8", errors="replace").read())

for tag, pos in stack:
    errors.append(f"unclosed <{tag}> opened at line {pos[0]}")

if errors:
    for e in errors[:cap]:
        print(f"      {e}")
    if len(errors) > cap:
        print(f"      … and {len(errors) - cap} more")
    sys.exit(1)
PY
    rc=$?
    if [ "$rc" -eq 0 ]; then
        stage_pass "$label"
    else
        stage_fail "$label"
    fi
    return "$rc"
}

stage_python() {
    local label="Python syntax (app tree)"
    local rc
    python3 - "$APP" "$CAP" <<'PY'
import glob, sys

app_root, cap = sys.argv[1], int(sys.argv[2])
errors = []

for f in glob.glob(app_root + "/**/*.py", recursive=True):
    try:
        compile(open(f, encoding="utf-8", errors="surrogateescape").read(), f, "exec")
    except SyntaxError as e:
        errors.append(f"{f}: {e.msg}({e.lineno})")

if errors:
    for e in errors[:cap]:
        print(f"      {e}")
    if len(errors) > cap:
        print(f"      … and {len(errors) - cap} more")
    sys.exit(1)
PY
    rc=$?
    if [ "$rc" -eq 0 ]; then
        stage_pass "$label"
    else
        stage_fail "$label"
    fi
    return "$rc"
}

echo "=== fast check gate ==="
stage_prereq
if [ "$_prereq_bad" -eq 1 ]; then
    echo "  prerequisites failed — skipping remaining stages"
    echo "=== result: $_total_ok pass, $_total_bad fail ==="
    exit 1
fi
stage_js_compile
stage_imports
stage_html
stage_python
echo "=== result: $_total_ok pass, $_total_bad fail ==="
[ "$_total_bad" -eq 0 ]