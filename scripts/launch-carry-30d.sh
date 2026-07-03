#!/usr/bin/env bash
#
# launch-carry-30d.sh — SUPERVISED launch for the 30-day carry-desk paper run (P0).
#
# Why this exists (#92): the first launch (2026-07-02) ran bare-foreground, stopped
# after ~9.6h when the terminal went away, and sat with 8 open books unmonitored for
# 3h+ — the DD kill-switch and daily re-gate are inert while the process is down.
# nohup + a pidfile means a closed terminal can't end the demo, and `status` tells
# you in one command whether the desk is actually alive.
#
# Symbols: the 13 deployables from the 2026-07-02 universe scan, MINUS LIT (the #92
# ticker collision — HL "LIT" is Lighter, Binance "LITUSDT" is Litentry). The runner
# re-gates every symbol at boot (90d funding gate + recency veto) and the #92
# collision guard re-checks every entry/resume, so a stale list degrades safely.
#
# Usage:
#   bash scripts/launch-carry-30d.sh          # start (refuses if already running)
#   bash scripts/launch-carry-30d.sh status   # is it alive? tail the log
#   bash scripts/launch-carry-30d.sh stop     # graceful SIGINT (books checkpoint OPEN)
#
# Prereq (once): sudo docker compose up -d postgres && npm run migration:run
# Score it (any session): mm_nav WHERE desk='carry' + the TCA log lines — never the
# raw log end-to-end (CLAUDE.md §12).

set -euo pipefail
cd "$(dirname "$0")/.."

SYMBOLS="${CD_SYMBOLS:-GRAM,NEAR,DYDX,LINK,AAVE,XPL,UNI,PUMP,TAO,BNB,ENA,ZEC}"
LOG_DIR=logs
PIDFILE="$LOG_DIR/carry-desk.pid"
mkdir -p "$LOG_DIR"

alive() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  status)
    if alive; then
      echo "RUNNING (pid $(cat "$PIDFILE")) — last log lines:"
      tail -n 8 "$(ls -t "$LOG_DIR"/carry-desk-*.log | head -1)"
    else
      echo "NOT RUNNING — the desk is unsupervised. Last log (if any):"
      ls -t "$LOG_DIR"/carry-desk-*.log 2>/dev/null | head -1 || echo "  (no logs yet)"
    fi
    ;;
  stop)
    if alive; then
      kill -INT "$(cat "$PIDFILE")"   # graceful: MM_PERSIST checkpoints books OPEN (resume-not-flatten)
      echo "SIGINT sent — books checkpoint OPEN and resume on the next start."
    else
      echo "not running"
    fi
    ;;
  start)
    if alive; then
      echo "already running (pid $(cat "$PIDFILE")) — use status/stop." >&2
      exit 1
    fi
    LOG="$LOG_DIR/carry-desk-$(date -u +%Y-%m-%dT%H-%M-%S).log"
    CD_SYMBOLS="$SYMBOLS" CD_MAKER_PATIENCE_S="${CD_MAKER_PATIENCE_S:-300}" MM_PERSIST=true \
      nohup npx ts-node -r tsconfig-paths/register scripts/carry-desk-live.ts >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    disown
    echo "started (pid $(cat "$PIDFILE")) — log: $LOG"
    echo "check:   bash scripts/launch-carry-30d.sh status"
    ;;
  *)
    echo "usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac
