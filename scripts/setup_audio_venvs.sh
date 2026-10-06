#!/usr/bin/env bash
# Rebuild the isolated Media Catalog analysis venvs (spec §17).
#
# Why two venvs: the analysis engines need mutually incompatible pins.
#   madmom   -> Python <= 3.9, numpy < 1.22 (uses collections.MutableSequence
#               and old ufunc signatures)
#   basic-pitch -> TensorFlow 2.15, which would DOWNGRADE the app's TF 2.21 and
#               break the styletransfer Magenta path
# The app venv (openvino + torch + TF 2.21) therefore stays untouched, and the
# engines are called as subprocesses via tools/audio_worker.py.
#
# Usage:  scripts/setup_audio_venvs.sh
# Env overrides honoured at runtime: MTAPI_AUDIO_VENV, MTAPI_AUDIO_LEGACY_VENV
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"

MODERN="${APP_ROOT}/.venv-audio"
LEGACY="${APP_ROOT}/.venv-audio-legacy"
UV="${UV:-uv}"

say() { printf '\n=== %s ===\n' "$1"; }

say "modern audio venv (py3.11, numpy 1.26): essentia, librosa, basic-pitch, mido"
"$UV" venv --python 3.11 "$MODERN"
"$UV" pip install --python "$MODERN/bin/python" "numpy<2" soundfile scipy essentia mido librosa basic-pitch

say "legacy audio venv (py3.9, numpy 1.20): madmom"
"$UV" venv --python 3.9 "$LEGACY"
"$UV" pip install --python "$LEGACY/bin/python" "numpy==1.20.3" Cython "setuptools<81" wheel soundfile
# madmom's sdist declares Cython usage without declaring the build dep, so it
# must build against this venv rather than an isolated build env.
"$UV" pip install --python "$LEGACY/bin/python" --no-build-isolation madmom

say "verify"
"$MODERN/bin/python" - <<'PY'
import essentia.standard, librosa, mido, basic_pitch, numpy, soundfile, scipy
print(f"  modern OK — numpy {numpy.__version__}, basic_pitch, essentia, librosa, mido")
PY
"$LEGACY/bin/python" - <<'PY'
import madmom, numpy, soundfile
print(f"  legacy OK — numpy {numpy.__version__}, madmom")
PY

cat <<'EOF'

Not installed, on purpose:
  aubio  — 0.4.9's C bindings do not compile against any modern numpy
           (PyUFunc const signature) and no wheel exists for any version.
           Essentia + librosa already provide two independent onset opinions.
  keyfinder — its sdist is broken upstream (missing keyfinder/constants.h).

Both are single-file exclusions in app/audio_pipeline/scanner.py::engine_status.
EOF