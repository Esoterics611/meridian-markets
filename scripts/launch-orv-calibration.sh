#!/usr/bin/env bash
#
# launch-orv-calibration.sh — SUPERVISED runner for the ORV Phase 0 calibration
# collector (docs/QUANT_JOURNAL.md #97/#98; scripts/orv-calibration.ts).
#
# Why this exists (#100 pickup): the collector is DB-free, NO-POSITION, pure
# measurement — every HIP-4 daily that settles gives a free (RND fair, market mid,
# outcome) triple, ~10-50x the data per day that trading produces. It needs WEEKS of
# tape (~2 Deribit-priceable settles/day) before the #96 Brier gate (Brier(RND) vs
# Brier(market) over >=100 settles) can render a verdict, so it should run
# continuously rather than depend on someone remembering to start it in a foreground
# terminal each session — the exact gap that stalled the M2 board twice (#93/#99).
#
# Usage:
#   bash scripts/launch-orv-calibration.sh          # start (refuses if already running)
#   bash scripts/launch-orv-calibration.sh status   # alive? tail the log
#   bash scripts/launch-orv-calibration.sh stop     # graceful SIGINT (tape flushed, no positions to unwind)
#
# Tapes land in docs/research/orv-maker/tapes/ (git-ignored, ~50-100MB/day/market).
# The #96 Brier verdict is read off the tape via scripts/orv-maker-replay.ts once it
# qualifies (>=100 settles) — never judged from this launcher's log.

set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR=logs
PIDFILE="$LOG_DIR/orv-calibration.pid"
mkdir -p "$LOG_DIR"

alive() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  status)
    if alive; then
      echo "RUNNING (pid $(cat "$PIDFILE")) — last log lines:"
      tail -n 10 "$(ls -t "$LOG_DIR"/orv-calibration-*.log | head -1)"
    else
      echo "NOT RUNNING — the collector is idle (no tape accruing). Last log (if any):"
      ls -t "$LOG_DIR"/orv-calibration-*.log 2>/dev/null | head -1 || echo "  (no logs yet)"
    fi
    ;;
  stop)
    # setsid at start makes the pidfile PID a process-group leader; -PID signals the
    # whole npx->sh->node chain in one shot (the #100 launcher lesson — a plain kill
    # on the top PID does not reliably propagate down that chain).
    if alive; then
      kill -INT -- -"$(cat "$PIDFILE")"
      echo "SIGINT sent — the collector flushes its current tape file and exits (no positions to unwind)."
    else
      echo "not running"
    fi
    ;;
  start)
    if alive; then
      echo "already running (pid $(cat "$PIDFILE")) — use status/stop." >&2
      exit 1
    fi
    LOG="$LOG_DIR/orv-calibration-$(date -u +%Y-%m-%dT%H-%M-%S).log"
    setsid nohup npx ts-node -r tsconfig-paths/register scripts/orv-calibration.ts >> "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    disown
    echo "started (pid $(cat "$PIDFILE")) — log: $LOG"
    echo "check:   bash scripts/launch-orv-calibration.sh status"
    ;;
  *)
    echo "usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac
