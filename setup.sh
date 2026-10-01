#!/usr/bin/env bash
# Cara a Cara — one command: Python env → IXI download → card rendering → game.
#
#   ./setup.sh                 asks before downloading IXI, then starts the game
#   ./setup.sh --yes           accepts the IXI terms without asking
#   ./setup.sh --tar FILE      uses a local IXI-T1.tar instead of downloading
#   ./setup.sh --no-serve      builds everything but does not start the game
#   ./setup.sh --lan           starts the game open to the local network
#
# Re-running is safe: finished steps are skipped.
set -euo pipefail
cd "$(dirname "$0")"

SERVE=1
DL_ARGS=()
SERVE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes)      DL_ARGS+=(--yes) ;;
    --tar)      DL_ARGS+=(--tar "$2"); shift ;;
    --no-serve) SERVE=0 ;;
    --lan)      SERVE_ARGS+=(--lan) ;;
    -h|--help)  sed -n '2,10p' "$0"; exit 0 ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  echo "== Creating Python environment (.venv)"
  "$PY" -m venv .venv
fi
echo "== Installing rendering dependencies"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt

echo "== IXI scans"
.venv/bin/python scripts/download_ixi.py ${DL_ARGS[@]+"${DL_ARGS[@]}"}

echo "== Rendering cards"
.venv/bin/python scripts/build_cards.py

if [ "$SERVE" = 1 ]; then
  echo "== Starting the game"
  exec .venv/bin/python serve.py ${SERVE_ARGS[@]+"${SERVE_ARGS[@]}"}
fi
echo "Done. Start the game with:  python3 serve.py"
