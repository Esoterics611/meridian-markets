#!/usr/bin/env bash
#
# launch-mm-10h.sh — fire the paper-run book set against a live server.
#
#   ALL books → mm-glft (NEUTRAL spread-capture) + the INVENTORY GOVERNOR.
#
# Why neutral (Journal #39): the all-directional run lost −$11.6k/$8M in ~90min, and the
# split was unambiguous — realised ≈ flat, UNREALISED −$10.5k = open inventory marked
# underwater. The 3 books that stayed flat (ETH/DOGE/XRP) made money; the 5 that
# accumulated a one-sided position and held it lost it. The spread engine is fine; the
# position is the bleed. So this run isolates ONE change — the inventory governor — and
# asks the single question that matters: does unrealised stop being the loss column?
#
# The inventory governor is now DEFAULT-ON (Journal #43) — no env needed:
#   hardInventoryCap=true            — park the accumulating side at the rail at |q|≥cap.
#   maxInventoryNotionalFrac=0.25    — cap |inv| at ¼ of book capital at the live mid (risk-uniform).
#   inventorySkewMult=4              — make the A-S reservation actively mean-revert toward flat.
# (Override any of MM_HARD_INVENTORY_CAP / MM_MAX_INVENTORY_NOTIONAL_FRAC / MM_INVENTORY_SKEW_MULT to tune.)
#
# Plus the ADVERSE-SELECTION defence ("avoid informed orders, like the big desks do"):
#   MM_F3_TOXICITY=true         — scale the half-spread by trade-flow toxicity vs its rolling
#                                 average: TIGHTEN into calm two-sided flow (farm the rebate),
#                                 WIDEN into a one-sided sweep (informed flow = where you get
#                                 picked off). Inventory-neutral, width only. This was validated
#                                 in the offline LOB replay but had never been wired to live —
#                                 same FlowToxicityScaler now drives both.
#
# Directional is DELIBERATELY OFF this run (no mm-directional-glft, MM_FLOW_BIAS_LIVE unset).
# It returns in the NEXT run together with the inventory TIME-STOP + hedge leg (phase B) and
# only on the pre-registered BTC/ETH/XRP at a ~60s horizon — see docs/NEXT_RUN_PREREG.md.
# MM_FLOW_SHADOW stays ON: it keeps recording the fast signal (zero P&L impact) so the
# directional validation set keeps growing for when the time-stopped lean comes back.
#
# Prereqs — start the server FIRST. Easiest: `bash scripts/start-desk.sh` (the canonical config).
# The fast L2 path + the inventory governor are now BUILT-IN DEFAULTS (Journal #43/#44), so the
# minimal server env is just:
#   FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
#   MM_PERSIST=true MM_FAST_REQUOTE_MS=100 MM_CANCEL_REPLACE_LATENCY_MS=30 \
#   MM_FAST_SYMBOLS=BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI \
#   MM_F3_TOXICITY=true MM_FLOW_SHADOW=true TELEMETRY_ENABLED=true \
#   npm run start:dev 2>&1 | tee docs/research/run-$(date +%Y%m%d-%H%M)-mm.log
# (Fast is L2-default — no MM_FAST_REQUOTE_ENABLED; the governor caps + skew default ON; add
#  MM_DELTA_HEDGE=true to run the auditable perp delta hedge.)
#
# After the run, score the captured signal (still measure-only, never quoted):
#   npx ts-node -r tsconfig-paths/register scripts/flow-bias-markout.ts docs/research/flow-shadow-<ts>.jsonl 30,60,300,900
#
# Cadence note: 100ms re-quote with a 30ms cancel/replace latency is the internally
# CONSISTENT low-latency-maker assumption. Honesty caveat: real HL rate-limits order
# actions; paper does not — so 100ms is a clean upper bound, not a sustainable live claim.
#
# Then run this script. Override any knob via env, e.g. MM_BOOK_NOTIONAL_USD=50000 bash scripts/launch-mm-10h.sh
set -euo pipefail

HOST="${MM_HOST:-http://localhost:3100}"
SOURCE="${MM_BOOK_SOURCE:-hyperliquid}"
CAP="${MM_BOOK_CAPITAL_USDC:-1000000}"      # $1M/book — the established desk scale (journal #23/#27)
NOTIONAL="${MM_BOOK_NOTIONAL_USD:-100000}"  # $100k/quote → 4-lot cap ≈ $400k max inventory on $1M

# ALL books run mm-glft (neutral spread-capture) + the inventory governor. Entry #28 KEEP set + BTC.
BOOKS=(BTC ETH SOL DOGE BNB XRP ADA SUI)
STRATEGY="${MM_BOOK_STRATEGY:-mm-glft}"

launch () {
  local sym="$1" strat="$2"
  local resp
  printf '%-22s ' "launch $sym ($strat)"
  # Reset: drop any rehydrated/old book for this symbol (MM_PERSIST restores the prior
  # run's books on boot) so we relaunch it CLEAN — flat, fresh capital, the new strategy.
  # No-op if no such book exists.
  curl -s -X POST "$HOST/api/market-making/remove" -H 'content-type: application/json' \
    -d "{\"symbol\":\"$sym\"}" >/dev/null 2>&1 || true
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

echo "=== launching all books ($STRATEGY, neutral + inventory governor) ==="
for s in "${BOOKS[@]}"; do launch "$s" "$STRATEGY"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq ."
echo "  nav curve: curl -s $HOST/api/market-making/nav | jq ."
echo "  fills    : curl -s '$HOST/api/market-making/events?since=0' | jq ."
echo "  (NAV persists to mm_nav when MM_PERSIST=true; fills are log-only — keep the tee'd logfile.)"
echo "  JUDGE BY: desk UNREALISED stays small (inventory controlled) + steady low-DD NAV curve."
