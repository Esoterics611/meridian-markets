#!/usr/bin/env bash
#
# launch-mm-10h.sh — fire the 10h paper-run book set against a live server.
#
#   Liquid substrate  → NEUTRAL  (mm-glft)            : the steady-curve / spread-engine demo
#   BTC               → DIRECTIONAL (mm-directional-glft): the funding "axe" forward-data book
#
# The funding bias attaches ONLY to a mm-directional-glft book whose symbol is in
# MM_FUNDING_BIAS_SYMBOLS (default BTC) — effectiveBias() zeroes anything unvalidated,
# so the neutral books stay neutral by construction. See docs/QUANT_JOURNAL.md #36.
#
# Prereqs — start the server FIRST with persistence + the fast fair-value path on EVERY market:
#   FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
#   MM_PERSIST=true \
#   MM_FAST_REQUOTE_ENABLED=true MM_FAST_REQUOTE_MS=100 \
#   MM_CANCEL_REPLACE_LATENCY_MS=30 \
#   MM_FAST_SYMBOLS=BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI \
#   MM_MICROPRICE_DEPTH=5 \
#   MM_FUNDING_BIAS_SYMBOLS=BTC MM_FUNDING_BIAS_MAX=0.39 MM_FUNDING_REFRESH_MS=120000 \
#   TELEMETRY_ENABLED=true \
#   npm run start:dev 2>&1 | tee docs/research/run-$(date +%Y%m%d-%H%M)-mm10h.log
#
# Cadence note: 100ms re-quote with a 30ms cancel/replace latency is the internally
# CONSISTENT low-latency-maker assumption (a desk re-quoting at 100ms is colocated, so
# its round-trip is tens of ms, not the retail ~100ms). 100ms > 30ms leaves a ~70ms
# live window for queue maturation. The micro-price center (layer-1 fast fair value)
# is on EVERY book and refreshes each re-quote — that is the fresh directional input on
# all markets. The weekly funding axe (layer-2 alpha) stays BTC-only + OOS-gated.
# Honesty caveat: real HL rate-limits order actions; paper does not — so 100ms is a
# clean upper bound on cadence, not a claim a live account could sustain it unthrottled.
#
# Then run this script. Override any knob via env, e.g. MM_BOOK_NOTIONAL_USD=50000 bash scripts/launch-mm-10h.sh
set -euo pipefail

HOST="${MM_HOST:-http://localhost:3100}"
SOURCE="${MM_BOOK_SOURCE:-hyperliquid}"
CAP="${MM_BOOK_CAPITAL_USDC:-1000000}"      # $1M/book — the established desk scale (journal #23/#27)
NOTIONAL="${MM_BOOK_NOTIONAL_USD:-100000}"  # $100k/quote → 8-lot cap ≈ $800k inventory on $1M

NEUTRAL=(DOGE BNB ETH SOL XRP ADA SUI)      # Entry #28 KEEP list: liquid, low-σ, fills recycle, low DD
DIRECTIONAL=(BTC)                           # the only (marginally) validated funding tilt

launch () {
  local sym="$1" strat="$2"
  local resp
  printf '%-22s ' "launch $sym ($strat)"
  resp=$(curl -s -X POST "$HOST/api/market-making/launch" \
    -H 'content-type: application/json' \
    -d "{\"symbol\":\"$sym\",\"strategyId\":\"$strat\",\"source\":\"$SOURCE\",\"capitalUsdc\":$CAP,\"quoteNotionalUsd\":$NOTIONAL}") || {
      echo "REQUEST FAILED (is the server up on $HOST?)"; return 1; }
  if echo "$resp" | jq -e 'has("error")' >/dev/null 2>&1; then
    echo "ERROR: $(echo "$resp" | jq -r .error)"
  else
    echo "ok"
  fi
}

echo "=== launching neutral substrate (mm-glft) ==="
for s in "${NEUTRAL[@]}"; do launch "$s" "mm-glft"; done
echo "=== launching BTC axe (mm-directional-glft) ==="
for s in "${DIRECTIONAL[@]}"; do launch "$s" "mm-directional-glft"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq ."
echo "  nav curve: curl -s $HOST/api/market-making/nav | jq ."
echo "  fills    : curl -s '$HOST/api/market-making/events?since=0' | jq ."
echo "  (NAV persists to mm_nav when MM_PERSIST=true; fills are log-only — keep the tee'd logfile.)"
