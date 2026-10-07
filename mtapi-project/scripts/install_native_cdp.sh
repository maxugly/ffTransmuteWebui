#!/usr/bin/env bash
# Install Composers Desktop Project (CDP8) Native CLI Tools (Approach B)
#
# Builds the official CDP8 source from GitHub:
#   1. Clones/pulls https://github.com/ComposersDesktop/CDP8 into ~/.cache/cdp-build/CDP8
#   2. Builds all native C executables using cmake + make
#   3. Installs all ~220 binaries (500+ sub-functions) into ~/.local/share/cdp/bin/
#   4. Installs single unified dispatcher script into ~/.local/bin/cdp
#
# This keeps ~/.local/bin clean (only 1 executable: cdp) while providing
# full access to the complete native suite without tab-completion flood.
set -euo pipefail

REPO_URL="https://github.com/ComposersDesktop/CDP8.git"
CACHE_DIR="${HOME}/.cache/cdp-build"
SRC_DIR="${CACHE_DIR}/CDP8"
TARGET_BIN_DIR="${HOME}/.local/share/cdp/bin"
LAUNCHER_PATH="${HOME}/.local/bin/cdp"

echo "[cdp-install] Checking prerequisites..."
for cmd in git cmake make gcc; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: prerequisite '$cmd' is not installed." >&2
        exit 1
    fi
done

mkdir -p "$CACHE_DIR"
if [ -d "$SRC_DIR/.git" ]; then
    echo "[cdp-install] Updating existing source in ${SRC_DIR}..."
    git -C "$SRC_DIR" fetch --depth 1 origin HEAD
    git -C "$SRC_DIR" reset --hard origin/HEAD
else
    echo "[cdp-install] Cloning CDP8 from ${REPO_URL}..."
    git clone --depth 1 "$REPO_URL" "$SRC_DIR"
fi

echo "[cdp-install] Configuring build with CMake..."
cmake -B "${SRC_DIR}/build" -S "$SRC_DIR" -Wno-dev

NPROC=$(nproc 2>/dev/null || echo 4)
echo "[cdp-install] Compiling CDP8 with ${NPROC} parallel jobs..."
cmake --build "${SRC_DIR}/build" -j"$NPROC"

RELEASE_DIR="${SRC_DIR}/NewRelease"
if [ ! -d "$RELEASE_DIR" ]; then
    echo "Error: expected build output directory ${RELEASE_DIR} not found." >&2
    exit 1
fi

echo "[cdp-install] Staging binaries into ${TARGET_BIN_DIR}..."
mkdir -p "$TARGET_BIN_DIR"
cp -f "${RELEASE_DIR}"/* "$TARGET_BIN_DIR"/
chmod +x "${TARGET_BIN_DIR}"/*

TOOL_COUNT=$(find "$TARGET_BIN_DIR" -maxdepth 1 -type f -executable | wc -l)
echo "[cdp-install] Successfully staged ${TOOL_COUNT} binaries in ${TARGET_BIN_DIR}."

echo "[cdp-install] Creating unified dispatcher at ${LAUNCHER_PATH}..."
mkdir -p "$(dirname "$LAUNCHER_PATH")"

cat > "$LAUNCHER_PATH" << 'EOF'
#!/usr/bin/env bash
# CDP (Composers Desktop Project) CLI Unified Dispatcher
# Isolates 500+ audio tools in ~/.local/share/cdp/bin while keeping PATH clean.
set -e

CDP_BIN_DIR="${CDP_BIN_DIR:-$HOME/.local/share/cdp/bin}"

if [ $# -eq 0 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "CDP (Composers Desktop Project) CLI Dispatcher"
    echo "Usage: cdp <tool> [arguments...]"
    echo ""
    echo "Options & Commands:"
    echo "  cdp --list         List all available CDP binaries ($CDP_BIN_DIR)"
    echo "  cdp --count        Print total count of installed tools"
    echo "  cdp --path         Print CDP binary directory path"
    echo "  cdp env [cmd...]   Run a command or spawn a subshell with CDP binaries in PATH"
    echo "  cdp <tool> ...     Execute a CDP tool directly (e.g. cdp blur blur in.ana out.ana 50)"
    echo ""
    echo "Example: cdp distort average input.wav output.wav 10"
    exit 0
fi

if [ "$1" = "--count" ]; then
    if [ -d "$CDP_BIN_DIR" ]; then
        find "$CDP_BIN_DIR" -maxdepth 1 -type f -executable | wc -l
    else
        echo "0"
    fi
    exit 0
fi

if [ "$1" = "--list" ]; then
    if [ -d "$CDP_BIN_DIR" ]; then
        echo "Installed CDP binaries in $CDP_BIN_DIR:"
        find "$CDP_BIN_DIR" -maxdepth 1 -type f -executable -printf "%f\n" | sort | column -c 80
        echo ""
        COUNT=$(find "$CDP_BIN_DIR" -maxdepth 1 -type f -executable | wc -l)
        echo "Total programs: $COUNT (each program contains multiple sub-modes)"
    else
        echo "Error: CDP directory not found: $CDP_BIN_DIR" >&2
        exit 1
    fi
    exit 0
fi

if [ "$1" = "--path" ]; then
    echo "$CDP_BIN_DIR"
    exit 0
fi

if [ "$1" = "env" ] || [ "$1" = "sh" ]; then
    shift
    export PATH="$CDP_BIN_DIR:$PATH"
    if [ $# -gt 0 ]; then
        exec "$@"
    else
        exec "${SHELL:-/bin/bash}"
    fi
fi

TOOL="$1"
shift

TARGET="$CDP_BIN_DIR/$TOOL"
if [ -x "$TARGET" ]; then
    exec "$TARGET" "$@"
else
    echo "Error: CDP tool '$TOOL' not found in $CDP_BIN_DIR" >&2
    echo "Run 'cdp --list' to see all installed tools." >&2
    exit 127
fi
EOF

chmod +x "$LAUNCHER_PATH"

echo "[cdp-install] DONE: Launcher installed at ${LAUNCHER_PATH}."
echo "[cdp-install] Total installed tools: ${TOOL_COUNT}"
