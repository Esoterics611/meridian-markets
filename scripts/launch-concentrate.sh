#!/usr/bin/env bash
#
# launch-concentrate.sh — THE CONCENTRATE RUN (2026-06-14, Journal #67).
#
# The 25-market wide screen (#66) ranked the HL universe by realised fillEdge. The verdict was
# unambiguous and it is the #49/#66 thesis at scale:
#   • The QUOTER is fine. fillEdge (spread − adverse) is POSITIVE on the clean markets —
#     TRUMP +20, ZEC +18, ENA +17, SUI +16, XRP +9, XMR +6, BNB +4. The quoter earns its spread.
#   • The BLEED is WAREHOUSE DRIFT. Desk realised −$2,783 / 3.7h / $25M, and it is almost ALL
#     warehouse MTM: WLD −371, XPL −321, XMR −258, CRV −257, VVV −237, FARTCOIN −210, ZEC −110.
#     Books with the SAME good quoter (XMR/ZEC/XRP fillEdge +6/+18/+9) still lost — unlucky drift.
#   • Some books are GREEN ON LUCK, not edge: HYPE net +226 is fillEdge −120 (picked off,
#     adverse +509) rescued by +344 FAVOURABLE warehouse drift that reverts. NOT a keeper.
#   • Structural losers (negative fillEdge = genuinely picked off, no time-stop fixes a bad quoter):
#     TAO −187 (mk300s −14bps), HYPE −120, TON −104, CRV −96, XPL −70, VVV −54. CUT.
#
# So this run does the three things the screen earned the right to do (MASTER_PLAN.md §3.3):
#   1. CONCENTRATE on the 8 positive-fillEdge / clean-adverse books (25 → 8).
#   2. CUT THE DRIFT with the inventory TIME-STOP (validated this session, timestop-sweep.md:
#      T=30m/shift=8bps cut BTC warehouse −$2127→−$730, Δ +1397, maxDD 0.85→0.35; did NOT hurt
#      SOL; the aggressive 10m variant DID hurt SOL −1524, so 30m/8bps, not 10m). On the naked
#      pads (ENA/ZEC/XMR/TRUMP — no factor hedge exists, R²<0.5) the time-stop is the substitute
#      for the impossible delta hedge: it caps HOLDING TIME → caps warehouse exposure.
#   3. ARM F2 (MM_REQUOTE_MIN_BPS=1) — the pre-registered queue-position fill-edge lever.
#
# DIRECTIONAL IS STILL PARKED (honest, #65 + this run's alignment-split table): flow does NOT lead
# price (κ=0; A+/A− markout is inconsistent across books — ZEC even PAID to be contra-flow). The
# MM_FLOW_BIAS_LIVE seam stays ON but OOS-GATED (MM_FLOW_BIAS_MIN_IC=0.05) so it trades NEUTRAL —
# forcing a lean is leverage on noise. We include every fix that WORKED (governor, F3 toxicity,
# micro-price + 100ms requote, 0.01% loss-stop, delta hedge w/ anti-churn) + the two new validated
# levers (time-stop, F2). We do NOT include the one thing that didn't (blind directional).
#
# PRE-REGISTERED SUCCESS METRIC (judge on the leak table, realised-first):
#   desk REALISED P&L ≥ 0  AND  every book maxDD ≤ ~1.5%  over a multi-hour window.
#   Secondary: warehouse MTM per book materially smaller than the screen (the time-stop working).
#
# ── HOW TO RUN ──────────────────────────────────────────────────────────────────────
# Terminal 1 (server) — start-desk.sh with the concentrate overrides:
#   MM_TIME_STOP=true MM_TIME_STOP_AGE_MIN=30 MM_TIME_STOP_SHIFT_BPS=8 \
#   MM_REQUOTE_MIN_BPS=1 \
#   MM_FAST_SYMBOLS=SOL,SUI,XRP,BNB,ENA,ZEC,XMR,TRUMP \
#   MM_HEDGE_BETA_MAP='SOL|ETH|1.02,SUI|ETH|1.29,XRP|BTC|1.15,BNB|BTC|0.92' \
#   MM_HEDGE_BASIS_GATE='' MM_SESSION_GATE='' \
#   bash scripts/start-desk.sh
# Terminal 2 (books), once the server logs "desk loop started":
#   bash scripts/launch-concentrate.sh
# Score after: npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts \
#   --since <start-ISO> --until <end-ISO> --log <the run log> --label concentrate
set -euo pipefail

HOST="${MM_HOST:-http://localhost:3100}"
SOURCE="${MM_BOOK_SOURCE:-hyperliquid}"
CAP="${MM_BOOK_CAPITAL_USDC:-1000000}"     # $1M/book × 8 = $8M desk. Capital HELD CONSTANT vs the
                                           # screen on purpose — isolate the 3 changes (selection +
                                           # time-stop + F2). Scale capital only AFTER realised ≥ 0.
NOTIONAL="${MM_BOOK_NOTIONAL_USD:-50000}"  # $50k/quote
STRATEGY="${MM_BOOK_STRATEGY:-mm-glft}"    # neutral GLFT + inventory governor (directional parked)

# THE CONCENTRATE-8 — ranked by realised fillEdge from leak-table-screen25-s2.md:
#   SUI   fillEdge +16, adverse +1   ⭐ pristine — quoter almost never picked off (hedge ETH β1.29)
#   TRUMP fillEdge +20, 183 fills    best edge, most active (naked pad — time-stop is its warehouse cap)
#   ENA   fillEdge +17, 130 fills    strong edge (naked — drop the self-hedge that bled −187)
#   ZEC   fillEdge +18               strong edge; warehouse −110 → time-stop is the fix (naked)
#   XMR   fillEdge +6,  adverse +24  clean quoter, killed ONLY by warehouse −258 → time-stop (naked)
#   BNB   fillEdge +4,  adverse +2   pristine adverse, quiet but clean (hedge BTC β0.92)
#   XRP   fillEdge +9,  adverse 0    clean; only 9 fills last window — give it room (hedge BTC β1.15)
#   SOL   proven A″ winner (+$752); barely quoted this window (2 fills) — continuity (hedge ETH β1.02)
BOOKS=(SUI TRUMP ENA ZEC XMR BNB XRP SOL)

# Everything else from the 25-screen rehydrates under MM_PERSIST and would keep trading silently —
# remove it explicitly (flatten + checkpoint CLOSED; no-op if absent). This is the whole "cut" list.
DROPPED=(
  ADA DOGE FARTCOIN kPEPE AAVE PUMP CRV TAO HYPE NEAR WLD VVV XPL LIT TON MEGA ONDO
  BTC ETH   # hedge legs, never quoted books
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
  echo "✗ no server on $HOST — start it first: bash scripts/start-desk.sh (with the concentrate overrides in the header)"; exit 1
fi

echo "=== removing screen books NOT in the concentrate-8 (${DROPPED[*]}) ==="
for s in "${DROPPED[@]}"; do
  curl -s -X POST "$HOST/api/market-making/remove" -H 'content-type: application/json' \
    -d "{\"symbol\":\"$s\"}" >/dev/null 2>&1 || true
done

echo "=== launching the concentrate-8 ($STRATEGY, neutral + governor + time-stop + F2) ==="
for s in "${BOOKS[@]}"; do launch "$s" "$STRATEGY"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq '.books[]|{symbol,fills,realisedPnlUnits}'"
echo "  time-stop: grep 'TIME-STOP ▸' the run log — confirm it ENGAGES on aged inventory"
echo "  F2       : grep 'F2 requote' the run log — confirm requote hysteresis is firing"
echo "  JUDGE BY : desk REALISED ≥ 0 + per-book maxDD ≤ ~1.5% on the leak table (realised-first)."
