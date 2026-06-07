#!/usr/bin/env bash
#
# launch-mm-10h.sh — fire the 10h paper-run book set against a live server.
#
#   ALL books → mm-directional-glft, driven by the SELF-VALIDATING rolling-IC flow bias.
#
# With MM_FLOW_BIAS_LIVE the flow bias is live + self-gating: it re-checks its own forward-
# return IC every minute and sizes carry ONLY on coins where it stays predictive (BTC/ETH/
# XRP in the last read), and STANDS ASIDE on reversal coins (ADA/DOGE) — those quote
# symmetric-neutral automatically (bias→0). On a live view the quoter SKEWS its spread and
# can go SINGLE-SIDED (MM_DIR_SPREAD_SKEW / MM_DIR_SINGLE_SIDE_BIAS). See QUANT_JOURNAL #38.
#
# Prereqs — start the server FIRST with persistence + the fast fair-value path on EVERY market:
#   FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
#   MM_PERSIST=true \
#   MM_FAST_REQUOTE_ENABLED=true MM_FAST_REQUOTE_MS=100 \
#   MM_CANCEL_REPLACE_LATENCY_MS=30 \
#   MM_FAST_SYMBOLS=BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI \
#   MM_MICROPRICE_DEPTH=5 \
#   MM_FLOW_BIAS_LIVE=true MM_FLOW_BIAS_HORIZON_MS=60000 MM_FLOW_BIAS_MIN_IC=0.05 \
#   MM_DIR_SPREAD_SKEW=0.5 MM_DIR_SINGLE_SIDE_BIAS=0.6 \
#   MM_FLOW_SHADOW=true MM_FLOW_SHADOW_MIN_MS=1000 \
#   TELEMETRY_ENABLED=true \
#   npm run start:dev 2>&1 | tee docs/research/run-$(date +%Y%m%d-%H%M)-mm10h.log
#
# MM_FLOW_SHADOW=true records the fast book-imbalance directional signal on EVERY fast
# market to docs/research/flow-shadow-<ts>.jsonl — measured but NEVER quoted (zero P&L
# impact). After the run, score it: npx ts-node -r tsconfig-paths/register \
#   scripts/flow-bias-markout.ts docs/research/flow-shadow-<ts>.jsonl 60,300,900
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

# ALL books run mm-directional-glft + the self-validating flow bias; each self-gates per
# coin (reversal coins fall back to symmetric-neutral). Entry #28 KEEP list + BTC.
BOOKS=(BTC ETH SOL DOGE BNB XRP ADA SUI)

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

echo "=== launching all books (mm-directional-glft, self-gating flow bias) ==="
for s in "${BOOKS[@]}"; do launch "$s" "mm-directional-glft"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq ."
echo "  nav curve: curl -s $HOST/api/market-making/nav | jq ."
echo "  fills    : curl -s '$HOST/api/market-making/events?since=0' | jq ."
echo "  (NAV persists to mm_nav when MM_PERSIST=true; fills are log-only — keep the tee'd logfile.)"
