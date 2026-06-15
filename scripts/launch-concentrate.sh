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
# So this run does the three things the screen + the FULL journal re-read earned (MASTER_PLAN.md §3.3):
#   1. CONCENTRATE on the positive-fillEdge / clean-adverse books (25 → 8).
#   2. ATTACK WAREHOUSE DRIFT AT THE SOURCE with the F4 FLOW REGIME GATE (MM_REGIME_GATE=flow) —
#      #56 calls the trend/sweep detector "the most important knob": it pulls quotes BEFORE one-
#      sided inventory builds into a sweep, so the drift never accumulates. #63 shipped it OFF only
#      because it was a no-op on CALM tapes and said the verdict needs "a live A/B... a real
#      directional sweep day" — the toxic regime that sank #67 (vpin 0.16→0.30) is exactly that test.
#      We KEEP the 0.01% loss-stop as the backstop (#62 VALIDATED it: warehouse −95% on replay,
#      "keep 0.01% as the desk-wide default"). The inventory TIME-STOP is DROPPED — #53 says it is
#      MIXED/regime-dependent ("enable ONLY behind the regime gate"; it killed SOL −$1,524) and it
#      is redundant with the validated loss-stop (in #67 it never fired BECAUSE the loss-stop was
#      doing the warehouse job). Wrong lever; removed to kill the confusion.
#   3. ARM F2 (MM_REQUOTE_MIN_BPS=1) — the pre-registered #62 queue-position fill-edge lever.
#
# THE #67 LOSS WAS NEGATIVE fillEdge IN A TOXIC REGIME, not a missing warehouse knob. #55 is
# explicit: "a guardrail bounds inventory losses; it CANNOT make a picked-off book profitable."
# So the dominant P&L driver is REGIME + MARKET selection: LAUNCH IN A LIQUID SESSION (London/US
# open), NOT deep overnight (overnight toxicity crushed fillEdge in #67 AND #51 AND #64). Keep the
# cleanest-edge books — BNB held POSITIVE fillEdge through the #67 toxicity (the template to clone).
#
# DIRECTIONAL STAYS PARKED (#65 κ-gate: flow does not lead price, pooled IC 0.12@1s→0.004@300s;
# this run's alignment split agreed — ZEC even PAID to be contra-flow). MM_FLOW_BIAS_LIVE stays
# OOS-gated to NEUTRAL — forcing a lean is leverage on noise. Kept ON (the fixes that WORKED):
# governor (cap 0.10 / skew 6), F3 toxicity widen-only, micro-price + 100ms requote, the VALIDATED
# 0.01% loss-stop, delta hedge w/ anti-churn. NEW levers this run: the F4 flow gate + F2.
#
# PRE-REGISTERED SUCCESS METRIC (judge on the leak table, realised-first):
#   desk REALISED P&L ≥ 0  AND  every book maxDD ≤ ~1.5%  over a multi-hour LIQUID-SESSION window.
#   Secondary: the F4 gate ENGAGES on the toxic books (grep 'F4 flow:' / 'REGIME ▸') and their
#   warehouse MTM is smaller than the screen (the gate stopping the build before it drifts).
#
# ── HOW TO RUN ──────────────────────────────────────────────────────────────────────
# Terminal 1 (server) — start-desk.sh with the concentrate overrides (TIME-STOP & loss-stop loosening
# are GONE — the journal re-read killed them; the flow gate is the real lever):
#   MM_REGIME_GATE=flow \
#   MM_REQUOTE_MIN_BPS=1 \
#   MM_FAST_SYMBOLS=SOL,SUI,XRP,BNB,ENA,ZEC,XMR,TRUMP \
#   MM_HEDGE_BETA_MAP='SOL|ETH|1.02,SUI|ETH|1.29' \
#   MM_HEDGE_BASIS_GATE='' MM_SESSION_GATE='' \
# (Loss-stop stays at its VALIDATED start-desk default 0.0001 — #62. Time-stop stays OFF — #53/#62.)
# ⚠ AND THE BIGGEST LEVER ISN'T A KNOB: launch this in a LIQUID SESSION (London/US open). The #67
#  run died in deep-overnight toxicity (vpin 0.16→0.30) where fillEdge collapsed — and #55 says no
#  guardrail fixes negative fillEdge. Regime + book selection is the P&L driver, not the warehouse knob.
# (Hedge map trimmed by mm-rank-books.ts: only SOL/SUI clear rule #55b's R²≥0.5. BNB/XRP factor
#  hedges have LIVE R² 0.43/0.44 and the screen's BTC leg gave 0% variance reduction for fees —
#  so BNB/XRP run NAKED — the governor + the validated loss-stop are their warehouse control.)
#   bash scripts/start-desk.sh
# Terminal 2 (books), once the server logs "desk loop started":
#   bash scripts/launch-concentrate.sh
# Score after: npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts \
#   --since <start-ISO> --until <end-ISO> --log <the run log> --label concentrate
set -euo pipefail

HOST="${MM_HOST:-http://localhost:3100}"
SOURCE="${MM_BOOK_SOURCE:-hyperliquid}"
CAP="${MM_BOOK_CAPITAL_USDC:-1000000}"     # $1M/book × 8 = $8M desk. Capital HELD CONSTANT vs the
                                           # screen on purpose — isolate the changes (selection +
                                           # flow gate + F2). Scale capital only AFTER realised ≥ 0.
NOTIONAL="${MM_BOOK_NOTIONAL_USD:-50000}"  # $50k/quote
STRATEGY="${MM_BOOK_STRATEGY:-mm-glft}"    # neutral GLFT + inventory governor (directional parked)

# THE CONCENTRATE-8 — ranked by realised fillEdge from leak-table-screen25-s2.md:
#   SUI   fillEdge +16, adverse +1   ⭐ pristine — quoter almost never picked off (hedge ETH β1.29)
#   TRUMP fillEdge +20, 183 fills    best edge, most active (naked pad — governor+loss-stop+flow gate)
#   ENA   fillEdge +17, 130 fills    strong edge (naked — drop the self-hedge that bled −187)
#   ZEC   fillEdge +18               strong edge; warehouse −110 → flow gate stops the build (naked)
#   XMR   fillEdge +6,  adverse +24  clean quoter, killed ONLY by warehouse −258 → flow gate (naked)
#   BNB   fillEdge +4,  adverse +2   pristine adverse, held edge through #67 toxicity (NAKED — BTC R²0.43<0.5)
#   XRP   fillEdge +9,  adverse 0    clean; only 9 fills last window — give it room (NAKED — BTC R²0.44<0.5)
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

echo "=== launching the concentrate-8 ($STRATEGY, neutral + governor + flow gate + F2) ==="
for s in "${BOOKS[@]}"; do launch "$s" "$STRATEGY"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq '.books[]|{symbol,fills,realisedPnlUnits}'"
echo "  flow gate: grep -E 'F4 flow:|REGIME ▸' the run log — confirm it ENGAGES on one-sided/toxic books"
echo "  F2       : grep 'F2 requote' the run log — confirm requote hysteresis is firing"
echo "  JUDGE BY : desk REALISED ≥ 0 + per-book maxDD ≤ ~1.5% on the leak table (realised-first)."
