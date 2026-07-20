#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: datamosh.sh <input> <output> [options]

Modes:
  --mode melt      (default) continuous motion-vector smear -- image
                    content drips/streaks throughout the whole clip.

  --mode classic    keyframe-suppression mosh -- the Yamborghini High /
                    Avidemux-era technique. No motion is added; the
                    bleeding comes entirely from your footage's own
                    motion dragging across a suppressed keyframe. Only
                    shows up where your source actually cuts to
                    something else -- a single unbroken shot will look
                    basically unglitched in this mode.

melt-only tuning:
  --tail N          frames of "memory" in the smear (default 18)
  --hdamp N         horizontal damping, 0-100 percent, lower = more vertical
                    drip (default 15). Whole numbers only -- ffedit's -sp
                    parser doesn't accept decimals.
  --vdrift N        constant per-frame vertical push, whole numbers (default 1)

Examples:
  datamosh.sh in.mp4 out.mp4
  datamosh.sh in.mp4 out.mp4 --mode classic
  datamosh.sh in.mp4 out.mp4 --tail 30 --hdamp 5 --vdrift 2
EOF
  exit 1
}

MODE="melt"
TAIL=18
HDAMP=15
VDRIFT=1

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)    MODE="${2:?--mode needs a value}";   shift 2 ;;
    --tail)    TAIL="${2:?--tail needs a value}";   shift 2 ;;
    --hdamp)   HDAMP="${2:?--hdamp needs a value}"; shift 2 ;;
    --vdrift)  VDRIFT="${2:?--vdrift needs a value}"; shift 2 ;;
    -h|--help) usage ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]}"
[[ $# -ge 2 ]] || usage
INPUT="$1"
OUTPUT="$2"

[[ "$MODE" == "melt" || "$MODE" == "classic" ]] \
  || { echo "unknown mode: $MODE (use 'melt' or 'classic')" >&2; exit 1; }
[[ -f "$INPUT" ]] \
  || { echo "input file not found: $INPUT" >&2; exit 1; }

for bin in ffgac ffedit ffmpeg; do
  command -v "$bin" >/dev/null 2>&1 \
    || { echo "missing '$bin' on PATH -- is ffglitch's bin/ (and regular ffmpeg) on your PATH?" >&2; exit 1; }
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
GLITCHED="$WORKDIR/glitched.m4v"

if [[ "$MODE" == "melt" ]]; then
  GLITCH_JS="$SCRIPT_DIR/melt.js"
  [[ -f "$GLITCH_JS" ]] || { echo "melt.js not found next to this script" >&2; exit 1; }
  PREPPED="$WORKDIR/prepped.m4v"

  echo "==> [melt] transcoding to an editable MPEG-4 stream..."
  ffgac -i "$INPUT" -an -vcodec mpeg4 -mpv_flags +nopimb+forcemv \
        -qscale:v 1 -fcode 6 -g max -sc_threshold max \
        -f rawvideo -y "$PREPPED"

  echo "==> [melt] running melt.js (tail=$TAIL h_damp=$HDAMP v_drift=$VDRIFT)..."
  ffedit -i "$PREPPED" -s "$GLITCH_JS" -sp "[$TAIL, $HDAMP, $VDRIFT]" \
         -o "$GLITCHED" -y
else
  NO_KF_JS="$SCRIPT_DIR/no_keyframe.js"
  [[ -f "$NO_KF_JS" ]] || { echo "no_keyframe.js not found next to this script" >&2; exit 1; }

  echo "==> [classic] transcoding with keyframes suppressed..."
  echo "    (glitches will only appear at hard cuts already in your footage)"
  ffgac -i "$INPUT" -an -vcodec mpeg4 -mpv_flags +nopimb+forcemv \
        -qscale:v 1 -fcode 6 -g max -sc_threshold max \
        -pict_type_script "$NO_KF_JS" \
        -f rawvideo -y "$GLITCHED"
fi

echo "==> re-encoding to a normal, shareable mp4..."
ffmpeg -i "$GLITCHED" -i "$INPUT" -map 0:v -map 1:a? \
       -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy -shortest \
       -y "$OUTPUT"

echo "done -> $OUTPUT"
