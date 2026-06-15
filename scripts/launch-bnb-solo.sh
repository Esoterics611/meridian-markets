#!/usr/bin/env bash
#
# launch-bnb-solo.sh — THE RUTHLESS-CONCENTRATION TEST (2026-06-15, Journal #69).
#
# Nine straight realised-negative multi-book runs (#41→#68) say the same thing: the rebate + spread
# does NOT out-earn warehouse drift + adverse selection across HL alt books. The ONE exception, in
# EVERY run, is BNB — net flat-to-positive, fillEdge +1/+4/+11, maxDD 0.03–0.12%, the cleanest
# two-sided-flow book on the desk. So the last empirical question worth asking: can a SINGLE
# genuinely-clean book, sized up and hedged, post POSITIVE realised? If BNB can't, MM on these
# markets has no positive realised edge and we report that honestly (the mission is honesty).
#
# THE BET: one book, bigger, fully hedged, all our best knowledge, nothing that didn't work.
#   • BNB only — the proven-clean book.
#   • LARGER SIZE: $5M capital (5× the concentrate run) + $100k/quote (2×). DD stays tiny (BNB's
#     maxDD was ≤0.12%), so "do it big on real edge" is the doctrine-right move here.
#   • HEDGED to BTC (β0.92, R².61 — #55b/#66). The hedge cost is priced into the maker spread.
#   • KEEP everything VALIDATED: micro-price center + 100ms requote (#47/#48), F3 toxicity widen-only
#     (#64), the 0.01% loss-stop (#62), the inventory governor (#43/#44), F2 queue lever (#61),
#     and the flow regime gate as the standing auto-defense (#56/#63). Time-stop OFF (#53/#62).
#     Directional OFF (κ=0, #65).
#
# WHY a single book is the clean test: no cross-book correlation, no naked pads, no warehouse from
# books we can't hedge — just "does the rebate+spread beat the drift on the ONE market where the
# quoter is provably clean." A positive realised here is the first real green; a negative one is the
# honest verdict that paper MM on HL has no edge after costs, and we stop tweaking and say so.
#
# ── HOW TO RUN ──────────────────────────────────────────────────────────────────────
# Terminal 1 (server) — start-desk.sh with the BNB-solo overrides (ONE book, 24/7, self-defending):
#   MM_REGIME_GATE=flow \
#   MM_VPIN_PAUSE_THRESHOLD=0.6 \
#   MM_REQUOTE_MIN_BPS=1 \
#   MM_FAST_SYMBOLS=BNB \
#   MM_HEDGE_BETA_MAP='BNB|BTC|0.92' \
#   MM_HEDGE_BASIS_GATE='' MM_SESSION_GATE='' \
#   bash scripts/start-desk.sh
# Terminal 2 (book), once the server logs "desk loop started":
#   bash scripts/launch-bnb-solo.sh
# Score after: npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts \
#   --since <start-ISO> --label bnb-solo --log <the run log>
#
# PRE-REGISTERED SUCCESS METRIC (realised-first): BNB realised ≥ 0 over a multi-hour 24/7 window,
# maxDD ≤ ~1.5% (it will be far under). Secondary: fillEdge ≥ 0 (the quoter holds at size) and the
# BTC hedge tracks (residual small, leg P&L not a churn bleed). A clean green = scale further; a
# clean red at size = the honest "no positive realised edge on HL MM" verdict.
set -euo pipefail

HOST="${MM_HOST:-http://localhost:3100}"
SOURCE="${MM_BOOK_SOURCE:-hyperliquid}"
CAP="${MM_BOOK_CAPITAL_USDC:-5000000}"     # $5M on ONE book — the concentration. Governor caps |inv|
                                           # at 0.10 = $500k; DD% is tiny on BNB so this is safe-big.
NOTIONAL="${MM_BOOK_NOTIONAL_USD:-100000}" # $100k/quote (2× the concentrate run) — "larger size".
STRATEGY="${MM_BOOK_STRATEGY:-mm-glft}"    # neutral GLFT + governor (directional parked, κ=0 #65)

BOOKS=(BNB)

# Every other book rehydrates under MM_PERSIST and would keep trading silently — remove them all so
# the desk is genuinely BNB-only (flatten + checkpoint CLOSED; no-op if absent).
DROPPED=(
  XRP SUI SOL ZEC XMR TRUMP ENA                              # the robust-6/8 minus BNB
  ADA DOGE FARTCOIN kPEPE AAVE PUMP CRV TAO HYPE NEAR WLD VVV XPL LIT TON MEGA ONDO  # the 25-screen
  xyz:CL xyz:GOLD PURR                                       # older incumbents, just in case
  ETH                                                        # ETH hedge leg not used (BNB→BTC); BTC is the only leg
)

launch () {
  local sym="$1" strat="$2" resp
  printf '%-26s ' "launch $sym ($strat)"
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

if ! curl -sf --max-time 3 "$HOST/health" >/dev/null 2>&1; then
  echo "✗ no server on $HOST — start it first: bash scripts/start-desk.sh (with the BNB-solo overrides in the header)"; exit 1
fi

echo "=== removing every non-BNB book (${DROPPED[*]}) ==="
for s in "${DROPPED[@]}"; do
  curl -s -X POST "$HOST/api/market-making/remove" -H 'content-type: application/json' \
    -d "{\"symbol\":\"$s\"}" >/dev/null 2>&1 || true
done

echo "=== launching BNB solo ($STRATEGY, \$$CAP cap / \$$NOTIONAL quote, hedged BTC) ==="
for s in "${BOOKS[@]}"; do launch "$s" "$STRATEGY"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq '.books[]|{symbol,fills,realisedPnlUnits,unrealisedPnlUnits}'"
echo "  hedge    : grep 'desk delta hedge ON' the run log — confirm BNB→BTC×0.92, ONE leg"
echo "  regime   : curl -s $HOST/api/market-making/snapshot | jq -r '.books[]|[.symbol,(.flow.regime//\"warming\"),(.vpin//0)]|@tsv'"
echo "  JUDGE BY : BNB REALISED ≥ 0 + fillEdge ≥ 0 on the leak table (realised-first). One book, no excuses."
