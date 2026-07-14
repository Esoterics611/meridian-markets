#!/usr/bin/env bash
#
# launch-regime-track.sh — SUPERVISED launch for the regime directional benchmark track (P16).
#
# Why this exists (#95): the directional "take sides" bot has been fully built since #87
# (RegimeDirectionalBook + OOS gate + stress harness + persistence + the 907-line runner),
# but its forward run (P16, #88 handover) never happened — partly because launching it meant
# a hand-rolled foreground command chain, the exact failure mode that killed the carry desk's
# first run (#92: bare-foreground died with the terminal). This wrapper gives the directional
# bot the same supervision the carry desk got: nohup + pidfile + one-command status.
#
# Discipline built in:
#   1. STRESS PRE-FLIGHT — scripts/regime-stress.ts must print STRESS OK (exit 0) or the
#      launch is REFUSED. A desk that breaches its budget in a deterministic scenario does
#      not get to trade the live window.
#   2. GATE-FIRST is in the runner itself — regime-book-live.ts re-runs the 90d OOS gate at
#      boot (one code path with the morning board); 0 validated symbols ⇒ it trades nothing.
#   3. Defaults = the #88 PRE-REGISTERED command, unchanged: MM_PERSIST=true RBL_HOURS=8
#      RBL_SLIPPAGE_BPS=1 RBL_EXPOSURE=outright RBL_TOP_N=8. Override via env
#      (e.g. RBL_EXPOSURE=hedged for the comparison track). Pre-registered metric:
#      realised + funding − fees − slippage > 0 with maxDD inside 2%.
#
# stop semantics — NOT the carry desk's: SIGINT makes the runner FLATTEN every open book to
# realised (flatten-on-exit), then write the final checkpoint. A directional position never
# sits unsupervised; carry's resume-not-flatten is for delta-neutral books only.
#
# Usage:
#   bash scripts/launch-regime-track.sh          # start (stress pre-flight, refuses if running)
#   bash scripts/launch-regime-track.sh status   # is it alive? tail the log
#   bash scripts/launch-regime-track.sh stop     # graceful SIGINT (flatten + final checkpoint)
#
# Prereq (once): sudo docker compose up -d postgres && npm run migration:run
# Score it: mm_nav WHERE desk='regime' + the runner's Ctrl-C scorecard (realised-first verdict,
# DESK ATTRIBUTION, tear-sheet vs BTC) — never the raw log end-to-end (CLAUDE.md §12).

set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR=logs
PIDFILE="$LOG_DIR/regime-track.pid"
mkdir -p "$LOG_DIR"

alive() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  status)
    if alive; then
      echo "RUNNING (pid $(cat "$PIDFILE")) — last log lines:"
      tail -n 8 "$(ls -t "$LOG_DIR"/regime-track-*.log | head -1)"
    else
      echo "NOT RUNNING — the track is not live. Last log (if any):"
      ls -t "$LOG_DIR"/regime-track-*.log 2>/dev/null | head -1 || echo "  (no logs yet)"
    fi
    ;;
  stop)
    if alive; then
      kill -INT "$(cat "$PIDFILE")"   # graceful: flatten-on-exit books the realised close, then final checkpoint
      echo "SIGINT sent — open books flatten to realised and the final checkpoint is written."
    else
      echo "not running"
    fi
    ;;
  start)
    if alive; then
      echo "already running (pid $(cat "$PIDFILE")) — use status/stop." >&2
      exit 1
    fi
    echo "pre-flight: stress harness (must print STRESS OK)…"
    if ! npx ts-node -r tsconfig-paths/register scripts/regime-stress.ts; then
      echo "LAUNCH REFUSED — stress harness failed. Fix the breach before trading the window." >&2
      exit 1
    fi
    LOG="$LOG_DIR/regime-track-$(date -u +%Y-%m-%dT%H-%M-%S).log"
    MM_PERSIST=true \
      RBL_HOURS="${RBL_HOURS:-8}" \
      RBL_SLIPPAGE_BPS="${RBL_SLIPPAGE_BPS:-1}" \
      RBL_EXPOSURE="${RBL_EXPOSURE:-outright}" \
      RBL_TOP_N="${RBL_TOP_N:-8}" \
      nohup npx ts-node -r tsconfig-paths/register scripts/regime-book-live.ts >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    disown
    echo "started (pid $(cat "$PIDFILE")) — ${RBL_HOURS:-8}h ${RBL_EXPOSURE:-outright} window, gate-first at boot — log: $LOG"
    echo "check:   bash scripts/launch-regime-track.sh status"
    ;;
  *)
    echo "usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac
