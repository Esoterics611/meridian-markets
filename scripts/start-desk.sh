#!/usr/bin/env bash
#
# start-desk.sh — start the MM paper desk with the full regime-aware config baked in.
# One command; owns the terminal (Ctrl-C to stop). Then run scripts/launch-mm-10h.sh
# from a SECOND terminal to launch the books. See docs/RUN_THE_DESK.md.
#
# Tunables are overridable on the command line, e.g.:
#   MM_DIR_SINGLE_SIDE_BIAS=0 bash scripts/start-desk.sh   # skew only, never single-sided
#   MM_FLOW_BIAS_LIVE=false   bash scripts/start-desk.sh   # neutral spread-engine run
set -euo pipefail
cd "$(dirname "$0")/.."

LOG="docs/research/run-$(date +%Y%m%d-%H%M%S)-mm10h.log"
mkdir -p docs/research
echo "▶ MM desk starting — logging to $LOG  (Ctrl-C to stop)"

FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
MM_PERSIST="${MM_PERSIST:-true}" \
MM_FAST_REQUOTE_ENABLED=true \
MM_FAST_REQUOTE_MS="${MM_FAST_REQUOTE_MS:-100}" \
MM_CANCEL_REPLACE_LATENCY_MS="${MM_CANCEL_REPLACE_LATENCY_MS:-30}" \
MM_FAST_SYMBOLS="${MM_FAST_SYMBOLS:-BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI}" \
MM_MICROPRICE_DEPTH="${MM_MICROPRICE_DEPTH:-5}" \
MM_FLOW_BIAS_LIVE="${MM_FLOW_BIAS_LIVE:-true}" \
MM_FLOW_BIAS_HORIZON_MS="${MM_FLOW_BIAS_HORIZON_MS:-60000}" \
MM_FLOW_BIAS_MIN_IC="${MM_FLOW_BIAS_MIN_IC:-0.05}" \
MM_DIR_SPREAD_SKEW="${MM_DIR_SPREAD_SKEW:-0.5}" \
MM_DIR_SINGLE_SIDE_BIAS="${MM_DIR_SINGLE_SIDE_BIAS:-0.6}" \
MM_FLOW_SHADOW="${MM_FLOW_SHADOW:-true}" \
MM_FLOW_SHADOW_MIN_MS="${MM_FLOW_SHADOW_MIN_MS:-1000}" \
TELEMETRY_ENABLED=true \
npm run start:dev 2>&1 | tee "$LOG"
