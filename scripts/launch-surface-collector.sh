#!/usr/bin/env bash
#
# launch-surface-collector.sh — SUPERVISED runner for the Phase O-0 IV-surface
# collector (docs/OPTIONS_DESK.md O-E1/O-E2; docs/QUANT_JOURNAL.md #101/#102;
# scripts/iv-surface-collector.ts).
#
# Why this exists: the Long-Horizon Options Desk's entire Phase O-0 deliverable is
# ≥14 CONTINUOUS days of hourly surface tape (≥30 for the z-score books' triggers) —
# NO positions, pure measurement, one Deribit chain call + a handful of tickers per
# hour. Like the ORV collector, it must not depend on someone remembering to start a
# foreground terminal each session (the gap that stalled the M2 board twice, #93/#99).
#
# Usage:
#   bash scripts/launch-surface-collector.sh          # start (refuses if already running)
#   bash scripts/launch-surface-collector.sh status   # alive? tail the log
#   bash scripts/launch-surface-collector.sh stop     # graceful SIGINT (append-only tape, nothing to unwind)
#
# Tape: docs/research/options-surface/surface-YYYY-MM.jsonl (git-ignored, ~100KB/day).
# Query with jq; the Phase O-1/O-3 gates read distributions off this tape — never
# judge them from this launcher's log.

set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR=logs
PIDFILE="$LOG_DIR/surface-collector.pid"
mkdir -p "$LOG_DIR"

alive() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  status)
    if alive; then
      echo "RUNNING (pid $(cat "$PIDFILE")) — last log lines:"
      tail -n 12 "$(ls -t "$LOG_DIR"/surface-collector-*.log | head -1)"
      echo "tape rows so far:"
      wc -l docs/research/options-surface/surface-*.jsonl 2>/dev/null || echo "  (no tape yet)"
    else
      echo "NOT RUNNING — no surface tape accruing (Phase O-0 clock is stopped). Last log (if any):"
      ls -t "$LOG_DIR"/surface-collector-*.log 2>/dev/null | head -1 || echo "  (no logs yet)"
    fi
    ;;
  stop)
    # setsid at start makes the pidfile PID a process-group leader; -PID signals the
    # whole npx->sh->node chain in one shot (the #100 launcher lesson).
    if alive; then
      kill -INT -- -"$(cat "$PIDFILE")"
      echo "SIGINT sent — the collector exits within ~2s (append-only tape, no positions)."
    else
      echo "not running"
    fi
    ;;
  start)
    if alive; then
      echo "already running (pid $(cat "$PIDFILE")) — use status/stop." >&2
      exit 1
    fi
    LOG="$LOG_DIR/surface-collector-$(date -u +%Y-%m-%dT%H-%M-%S).log"
    setsid nohup npx ts-node -r tsconfig-paths/register scripts/iv-surface-collector.ts >> "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    disown
    echo "started (pid $(cat "$PIDFILE")) — log: $LOG"
    echo "check:   bash scripts/launch-surface-collector.sh status"
    ;;
  *)
    echo "usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac
