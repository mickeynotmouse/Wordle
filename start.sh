#!/usr/bin/env bash
# Starts everything: Rasa assistant (5005), Rasa action server (5055), and the game (8000).
# Usage: ./start.sh            (trains the model first if there isn't one)
#        ./start.sh --retrain  (always retrain, e.g. after editing rasa/data)
set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -x "$VENV/bin/rasa" ]; then
  echo "Setting up Python 3.10 environment for Rasa (one-time, takes a few minutes)…"
  python3.10 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r rasa/requirements.txt
fi

cd rasa
if [ "${1:-}" = "--retrain" ] || [ -z "$(ls models/*.tar.gz 2>/dev/null)" ]; then
  echo "Training the assistant…"
  ../$VENV/bin/rasa train
fi

pids=()
cleanup() { echo; echo "Stopping…"; kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

../$VENV/bin/rasa run actions --port 5055 > ../actions.log 2>&1 &
pids+=($!)
../$VENV/bin/rasa run --enable-api --cors "*" --port 5005 > ../rasa.log 2>&1 &
pids+=($!)
cd ..

python3 -m http.server 8000 --directory frontend > /dev/null 2>&1 &
pids+=($!)

echo ""
echo "  Game:       http://localhost:8000   (open in Chrome, Edge or Safari)"
echo "  Assistant:  http://localhost:5005   (takes ~20 seconds to load)"
echo "  Logs:       rasa.log, actions.log"
echo ""
echo "Press Ctrl+C to stop."
wait
