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

# The fast L2 path is the DEFAULT now (Journal #44 fast-only) — no MM_FAST_REQUOTE_ENABLED flag;
# HL books fill queue-aware automatically, a non-L2 venue is refused at launch. The inventory
# governor (#43) is also default-ON. MM_FAST_SYMBOLS just scopes the real trades-WS aggressor feed.
#
# Run A′ (docs/NEXT_RUN_PREREG.md) — the four "make money" pillars are all wired ON here so a run
# never silently ships with a control off again (Journal #44 DR-0):
#   1. POSITIONS HEDGED      MM_DELTA_HEDGE=true — auditable perp delta hedge on the fast path (DR-4),
#                            folded into desk NAV + on the tape (DR-2).
#   2. HEDGE COST IN SPREADS the engine widens the maker half-spread by the hedge round-trip
#                            (hedgeTaker+½spread bps) whenever the hedge is on, so a fill earns ≥ the
#                            perp taker we pay to neutralise it (no guaranteed bleed).
#   3. CONTROL ADVERSE FLOW  MM_F3_TOXICITY=true — widen into toxic one-sided flow, tighten into calm
#                            (instrumented: grep 'F3 toxicity' in $LOG to confirm it fires).
#   4. GOOD-EXPOSURE LEAN    MM_FLOW_BIAS_LIVE — the directional axe, OOS-GATED: an unvalidated read is
#                            zeroed, so neutral mm-glft books stay neutral until the signal clears the
#                            markout gate (the real lean is Run B; this just leaves the seam on).
# MM_HEDGE_BETA_MAP defaults to per-symbol self-hedge; set the OOS alt→major map from
# scripts/hedge-beta-fit.ts to hedge the basket with one major-perp leg (the #41 "8 books = 1 β bet").
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
MM_PERSIST="${MM_PERSIST:-true}" \
MM_FAST_REQUOTE_MS="${MM_FAST_REQUOTE_MS:-100}" \
MM_CANCEL_REPLACE_LATENCY_MS="${MM_CANCEL_REPLACE_LATENCY_MS:-30}" \
MM_FAST_SYMBOLS="${MM_FAST_SYMBOLS:-BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI}" \
MM_MICROPRICE_DEPTH="${MM_MICROPRICE_DEPTH:-5}" \
MM_F3_TOXICITY="${MM_F3_TOXICITY:-true}" \
MM_DELTA_HEDGE="${MM_DELTA_HEDGE:-true}" \
MM_HEDGE_BAND_USD="${MM_HEDGE_BAND_USD:-2000}" \
MM_HEDGE_TAKER_BPS="${MM_HEDGE_TAKER_BPS:-2.5}" \
MM_HEDGE_HALF_SPREAD_BPS="${MM_HEDGE_HALF_SPREAD_BPS:-1}" \
MM_HEDGE_COST_SPREAD_MULT="${MM_HEDGE_COST_SPREAD_MULT:-0.5}" \
MM_HEDGE_BETA_MAP="${MM_HEDGE_BETA_MAP:-}" \
MM_FLOW_BIAS_LIVE="${MM_FLOW_BIAS_LIVE:-true}" \
MM_FLOW_BIAS_HORIZON_MS="${MM_FLOW_BIAS_HORIZON_MS:-60000}" \
MM_FLOW_BIAS_MIN_IC="${MM_FLOW_BIAS_MIN_IC:-0.05}" \
MM_DIR_SPREAD_SKEW="${MM_DIR_SPREAD_SKEW:-0.5}" \
MM_DIR_SINGLE_SIDE_BIAS="${MM_DIR_SINGLE_SIDE_BIAS:-0.6}" \
MM_FLOW_SHADOW="${MM_FLOW_SHADOW:-true}" \
MM_FLOW_SHADOW_MIN_MS="${MM_FLOW_SHADOW_MIN_MS:-1000}" \
TELEMETRY_ENABLED=true \
npm run start:dev 2>&1 | tee "$LOG"
