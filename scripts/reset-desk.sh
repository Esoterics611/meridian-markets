#!/usr/bin/env bash
#
# reset-desk.sh — CLEAN SLATE. Clear persisted OPEN MM books so the NEXT `start-desk.sh` boots
# fresh and does NOT rehydrate old positions (no carried inventory / P&L). This is the thing that
# silences the "N persisted OPEN book(s) will be REHYDRATED" warning.
#
# Run this when the desk is STOPPED. If it's still running, stop it first (Ctrl-C the start-desk
# terminal) or use scripts/stop-desk.sh — a live desk re-checkpoints its books OPEN every tick, so
# the wipe wouldn't stick. Idempotent; mm_nav history (the equity curve) is append-only and untouched.
set -euo pipefail
HOST="${MM_HOST:-http://localhost:3100}"

if curl -sf --max-time 3 "$HOST/health" >/dev/null 2>&1; then
  echo "✗ desk is still running on $HOST — stop it first (Ctrl-C / scripts/stop-desk.sh), then re-run."
  echo "  (A live desk re-checkpoints its books OPEN every tick, so the wipe wouldn't stick.)"
  exit 1
fi

PGPASSWORD="${PGPASSWORD:-meridian_markets_app}" psql -h localhost -p 5433 \
  -U meridian_markets_app -d meridian_markets \
  -c "UPDATE mm_book_state SET status='CLOSED', updated_at=NOW() WHERE status='OPEN';"
echo "✓ persisted OPEN books cleared — next start-desk.sh comes up CLEAN."
