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
# ONE config, runs 24/7, DETECTS REGIME ITSELF — no time-of-day switching, no babysitting:
#   1. CONCENTRATE on the ROBUST-6 — books with the best two-window fillEdge AND a factor hedge where
#      one exists (25 → 6). See the per-book table below.
#   2. AUTO-DETECT REGIME, PER BOOK, IN REAL TIME — the F4 FLOW REGIME GATE (MM_REGIME_GATE=flow,
#      #56's "most important knob") reads each book's aggressor flow every tick: NORMAL when two-sided
#      (capture spread+rebate), DEFENSIVE/FLATTEN-ONLY when flow turns one-sided AGAINST inventory
#      (widen the toxic side, cut size, pull the adding side). It does BOTH jobs at once: it stops the
#      one-sided ACCUMULATION (the warehouse drift) AND avoids the picked-off FILLS (the fillEdge
#      loss) — at the SOURCE, before either happens. VPIN pause 0.6 is the blunt backstop; F3 widens
#      into toxicity. This is why you do NOT need to run different programs at different hours.
#   3. ARM F2 (MM_REQUOTE_MIN_BPS=1) — the #62 queue-position fill-edge lever (improved s−adv on every
#      coin in the replay). KEEP the 0.01% loss-stop (#62-VALIDATED, warehouse −95%); time-stop OFF
#      (#53 redundant/regime-dependent). HEDGE every book that has a factor (4 of 6); ZEC/XMR naked.
#
# fillEdge IS THE ISSUE and it is REGIME-dependent, not market-fixed: the SAME book flips +fillEdge
# (calm) → −fillEdge (toxic) — TRUMP +20→−190, SUI +16→−32. The gross pick-off is already fixed
# (micro-price + F3, #47/#64). What re-opens it is a TOXIC one-sided regime — which is exactly what
# the flow gate detects and defends, automatically, per book. BNB is the proof a book CAN hold
# positive fillEdge through toxicity (+4→+11) — the template.
#
# DIRECTIONAL STAYS PARKED (#65 κ-gate: flow does not lead price, pooled IC 0.12@1s→0.004@300s;
# this run's alignment split agreed — ZEC even PAID to be contra-flow). MM_FLOW_BIAS_LIVE stays
# OOS-gated to NEUTRAL — forcing a lean is leverage on noise. Kept ON (the fixes that WORKED):
# governor (cap 0.10 / skew 6), F3 toxicity widen-only, micro-price + 100ms requote, the VALIDATED
# 0.01% loss-stop, delta hedge w/ anti-churn. NEW levers this run: the F4 flow gate + F2.
#
# PRE-REGISTERED SUCCESS METRIC (judge on the leak table, realised-first):
#   desk REALISED P&L ≥ 0  AND  every book maxDD ≤ ~1.5%  over a multi-hour 24/7 window (spanning a
#   toxic patch — that's the point: the desk should defend itself through one, not avoid the clock).
#   Secondary: the F4 gate ENGAGES on the toxic books (grep 'F4 flow:' / 'REGIME ▸') and their
#   warehouse MTM + adverse are smaller than #68 (the gate stopping the build before it drifts).
#
# ── HOW TO RUN ──────────────────────────────────────────────────────────────────────
# Terminal 1 (server) — start-desk.sh with the concentrate overrides. ONE config, runs 24/7 — the
# desk DETECTS REGIME ITSELF (no time-of-day switching): the flow gate per book reads aggressor flow
# in real time and goes DEFENSIVE/FLATTEN-ONLY when flow turns one-sided against inventory; F3 widens
# into toxicity; the VPIN pause is the hard backstop. That is the answer to "I can't run different
# programs at different hours" — the SAME program adapts.
#   MM_REGIME_GATE=flow \
#   MM_VPIN_PAUSE_THRESHOLD=0.6 \
#   MM_REQUOTE_MIN_BPS=1 \
#   MM_FAST_SYMBOLS=BNB,XRP,SUI,SOL,ZEC,XMR \
#   MM_HEDGE_BETA_MAP='SOL|ETH|1.02,SUI|ETH|1.29,XRP|BTC|1.15,BNB|BTC|0.92' \
#   MM_HEDGE_BASIS_GATE='' MM_SESSION_GATE='' \
# (Loss-stop stays at its VALIDATED 0.0001 — #62. Time-stop OFF — #53/#62. 4 of 6 books factor-hedged;
#  ZEC/XMR have no hedge (privacy coins) → flat-kept by governor+loss-stop+flow gate.)
# WHY VPIN pause 0.6 (was 0.75): in #68 the toxic books peaked at vpin ~0.6 and NEVER hit 0.75, so the
#  pause never fired and the desk got picked off. 0.6 makes the auto-defense actually engage in that
#  regime. The flow gate (alignment-aware) is the precise tool; the VPIN pause is the blunt backstop.
#   bash scripts/start-desk.sh
# Terminal 2 (books), once the server logs "desk loop started":
#   bash scripts/launch-concentrate.sh
# Score after: npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts \
#   --since <start-ISO> --until <end-ISO> --log <the run log> --label concentrate
set -euo pipefail

HOST="${MM_HOST:-http://localhost:3100}"
SOURCE="${MM_BOOK_SOURCE:-hyperliquid}"
CAP="${MM_BOOK_CAPITAL_USDC:-1000000}"     # $1M/book × 6 = $6M desk. Capital HELD CONSTANT vs the
                                           # screen on purpose — isolate the changes (selection +
                                           # flow gate + F2). Scale capital only AFTER realised ≥ 0.
NOTIONAL="${MM_BOOK_NOTIONAL_USD:-50000}"  # $50k/quote
STRATEGY="${MM_BOOK_STRATEGY:-mm-glft}"    # neutral GLFT + inventory governor (directional parked)

# THE ROBUST-6 — two-window fillEdge (#67 calm / #68 toxic) + hedgeability (#55b):
#   BNB   fillEdge +4 / +11   ⭐ the ONLY book POSITIVE through BOTH regimes — the template (HEDGE BTC β0.92)
#   XRP   fillEdge +9 / +57   good quoter, warehouses → flow gate stops the build (HEDGE BTC β1.15)
#   SUI   fillEdge +16 / −32  pristine in calm, picked off in toxic → flow gate defends (HEDGE ETH β1.29)
#   SOL   fillEdge ~0 / ~0    quiet; proven A″ winner (+$752) — continuity (HEDGE ETH β1.02)
#   ZEC   fillEdge +18 / +95  BEST quoter, but warehouses HARD (−804 in #68) → the flow gate's main job (naked)
#   XMR   fillEdge +6 / −15   calm even overnight (vpin 0.14), low-vol (naked — no factor hedge)
# OPTIMISED to the ROBUST-6 on TWO windows of data (#67 calm + #68 toxic). CUT:
#   TRUMP — most regime-FRAGILE: best calm fillEdge (+20) but −190 in toxicity. A coin-flip on regime.
#   ENA   — worst book in #68 (net −385, fillEdge −73) AND its self-hedge bled −187. Two strikes.
# 4 of 6 are factor-HEDGED (the #55b rule); ZEC/XMR have no factor hedge (privacy coins, ~0 R² to
# BTC/ETH) so FLAT is their hedge — governor + loss-stop + the flow gate keep them near flat.
BOOKS=(BNB XRP SUI SOL ZEC XMR)

# Everything else from the 25-screen rehydrates under MM_PERSIST and would keep trading silently —
# remove it explicitly (flatten + checkpoint CLOSED; no-op if absent). This is the whole "cut" list.
DROPPED=(
  ADA DOGE FARTCOIN kPEPE AAVE PUMP CRV TAO HYPE NEAR WLD VVV XPL LIT TON MEGA ONDO
  TRUMP ENA   # cut #68: regime-fragile / worst book + bleeding self-hedge
  BTC ETH     # hedge legs, never quoted books
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

echo "=== removing screen books NOT in the robust-6 (${DROPPED[*]}) ==="
for s in "${DROPPED[@]}"; do
  curl -s -X POST "$HOST/api/market-making/remove" -H 'content-type: application/json' \
    -d "{\"symbol\":\"$s\"}" >/dev/null 2>&1 || true
done

echo "=== launching the robust-6 ($STRATEGY, neutral + governor + flow gate + F2) ==="
for s in "${BOOKS[@]}"; do launch "$s" "$STRATEGY"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq '.books[]|{symbol,fills,realisedPnlUnits}'"
echo "  flow gate: grep -E 'F4 flow:|REGIME ▸' the run log — confirm it ENGAGES on one-sided/toxic books"
echo "  F2       : grep 'F2 requote' the run log — confirm requote hysteresis is firing"
echo "  JUDGE BY : desk REALISED ≥ 0 + per-book maxDD ≤ ~1.5% on the leak table (realised-first)."
