#!/usr/bin/env bash
#
# stop-desk.sh — close the whole MM desk BEFORE you stop the server.
#
# Why this exists: with MM_PERSIST=true the trader checkpoints every book's live inventory
# after every tick, and on boot it rehydrates all OPEN books WITH that inventory. So if you
# just Ctrl-C (or the process gets hard-killed), the next start-up resurrects the old
# positions and the UI shows them — "very weird". This script flattens + soft-closes every
# book via the API, which is durable (the rows are marked CLOSED in mm_book_state
# synchronously), so the clean state survives even a later `kill -9`.
#
# Ritual:
#   bash scripts/stop-desk.sh     # books drop to zero + get soft-closed
#   # then Ctrl-C the start-desk.sh terminal (or kill the server)
#
# Next `bash scripts/start-desk.sh` then comes up with NO rehydrated positions.
set -euo pipefail

HOST="${MM_HOST:-http://localhost:3100}"

if ! curl -sf --max-time 3 "$HOST/health" >/dev/null 2>&1; then
  echo "✗ no server on $HOST — is the desk running? (nothing to close)"; exit 1
fi

before=$(curl -s "$HOST/api/market-making/snapshot" | jq '[.books[]] | length' 2>/dev/null || echo '?')
echo "▶ closing all desk books on $HOST  (open books before: $before)"

resp=$(curl -s -X POST "$HOST/api/market-making/close-all" -H 'content-type: application/json')
closed=$(echo "$resp" | jq -r '.closed // "?"' 2>/dev/null)
after=$(echo "$resp" | jq '[.books[]] | length' 2>/dev/null || echo '?')

echo "✓ closed $closed book(s) — open books now: $after"
echo "  Now stop the server (Ctrl-C in the start-desk.sh terminal). The next start comes up clean."
