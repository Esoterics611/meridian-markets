#!/usr/bin/env bash
#
# launch-differential-board.sh — SUPERVISED daily runner for the M2 funding-
# differential board (PROFIT_PIVOT_II E4/R4).
#
# Why this exists (#99): the M2 pre-registration needs ≥7 CONSECUTIVE daily boards
# before any differential leg opens, and the manual cadence stalled twice at day 2/7
# (boards exist for 2026-07-02 and -03 only — the streak broke because it depended
# on a human remembering). This loop runs the one-shot board script once per UTC
# day so the measurement accrues unattended; `status` shows the consecutive-day
# streak so the go/no-go date is always visible.
#
# Usage:
#   bash scripts/launch-differential-board.sh          # start (refuses if running)
#   bash scripts/launch-differential-board.sh status   # alive? + streak count
#   bash scripts/launch-differential-board.sh stop
#
# Boards land in docs/research/funding-differentials/board-<ts>.json (one per run).
# The M2 verdict cites the series, never one board.

set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR=logs
PIDFILE="$LOG_DIR/differential-board.pid"
BOARD_DIR=docs/research/funding-differentials
mkdir -p "$LOG_DIR"

alive() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

streak() {
  # Consecutive UTC days with ≥1 board, counting back from today (or yesterday if
  # today's hasn't run yet — the loop may fire later in the day than you check).
  local days d n=0
  days=$(ls "$BOARD_DIR"/board-*.json 2>/dev/null | sed -E 's/.*board-([0-9]{4}-[0-9]{2}-[0-9]{2})T.*/\1/' | sort -u)
  [[ -z "$days" ]] && { echo 0; return; }
  d=$(date -u +%F)
  if ! grep -q "^$d$" <<<"$days"; then d=$(date -u -d "$d -1 day" +%F); fi
  while grep -q "^$d$" <<<"$days"; do n=$((n + 1)); d=$(date -u -d "$d -1 day" +%F); done
  echo "$n"
}

case "${1:-start}" in
  status)
    if alive; then echo "RUNNING (pid $(cat "$PIDFILE"))"; else echo "NOT RUNNING — the daily cadence is unsupervised."; fi
    echo "consecutive daily boards: $(streak)/7 (M2 gate needs ≥7 before any differential leg opens)"
    ls -t "$BOARD_DIR"/board-*.json 2>/dev/null | head -3 | sed 's/^/  latest: /' || true
    ;;
  stop)
    if alive; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo "stopped — the streak breaks if a UTC day passes without a board."; else echo "not running"; fi
    ;;
  start)
    if alive; then
      echo "already running (pid $(cat "$PIDFILE")) — use status/stop." >&2
      exit 1
    fi
    LOG="$LOG_DIR/differential-board-$(date -u +%Y-%m-%dT%H-%M-%S).log"
    nohup bash -c '
      while true; do
        echo "=== board run $(date -u +%FT%TZ) ==="
        npx ts-node -r tsconfig-paths/register scripts/funding-differential-board.ts || echo "board run FAILED (kept alive; retries next cycle)"
        sleep 86400
      done
    ' >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    disown
    echo "started (pid $(cat "$PIDFILE")) — first board runs now, then every 24h. Log: $LOG"
    echo "check:   bash scripts/launch-differential-board.sh status"
    ;;
  *)
    echo "usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac
