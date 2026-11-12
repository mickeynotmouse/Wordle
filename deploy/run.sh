#!/usr/bin/env bash
# Container start-up: the action server (internal) and the Rasa server on $PORT.
set -euo pipefail
cd "$(dirname "$0")/../rasa"

rasa run actions --port 5055 &

# --cors "*": the game is served from GitHub Pages, a different address.
# No --enable-api: the chat webhook works without it, and the full HTTP API
# would let anyone on the internet replace the model.
rasa run --port "${PORT:-8080}" --cors "*" &

# If either stops, exit so Cloud Run starts a fresh container.
wait -n
exit 1
