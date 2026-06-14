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
#   MM_FAST_SYMBOLS=<the BOOKS list below, comma-joined — start-desk.sh carries the default> \
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
CAP="${MM_BOOK_CAPITAL_USDC:-500000}"      # $500k/book × 8 books = $4M desk (the Elite-8, Journal #53 addendum)
NOTIONAL="${MM_BOOK_NOTIONAL_USD:-50000}"  # $50k/quote → 4-lot cap ≈ $200k max inventory on $500k

# THE SWEET-16 (2026-06-10, docs/BOOK_SELECTION_ANALYSIS.md — priors, to be verified by the
# live run + the book-scoring tool). The shape of the bet: stop being the Nth-best quoter on
# Binance-led majors (BTC/ETH/XRP bled −$203/−$286/−$326 realised in Run A″; markout@300s
# −9…−17bps = slow pick-off by informed flow) and quote where OUR edge fits:
#   • 8 HIP-3 RWA books (trade.xyz dex): gold/silver/oil/index/single-name retail flow,
#     structurally fewer pro makers, growth-mode fees (NO maker rebate assumed — venue-fees.ts
#     HIP3_FEE), and no Binance lead to snipe us. EXACT-CASE coin keys ("xyz:GOLD").
#     UNHEDGED BY DESIGN (beta 0 in MM_HEDGE_BETA_MAP) — no crypto factor; governor-capped.
#   • HYPE + PURR: HL-native price discovery — our local microprice IS the global truth.
#   • FARTCOIN + kPEPE: the meme basket (HL-primary flow, huge spreads, naive takers).
#   • SOL + ADA: the desk's measured winners (+$752/+$494 realised in A″) — live data
#     overrides the analysis's "majors are donated slots" prior for these two; the run decides.
#   • SUI + DOGE: incumbents on the bubble — kept for continuity, first rotation candidates.
# Dropped: BTC, ETH (hedge LEGS, not quoted books), XRP (worst bleeder + worst basis), BNB (inert).
# CUT after the first Sweet-16 read (Journal #51, 2026-06-11 — one ~3.6h window, so these are
# rotation-outs, not permanent kills; the S6 scoring tool re-adjudicates):
#   HYPE         realised −$1,507, maxDD 1.76% (bar breach), VPIN 0.58, 387/219 one-sided fills
#   xyz:BRENTOIL realised −$1,187, maxDD 1.61% (bar breach), sprd/adverse 597/867
#   xyz:SILVER   realised −$816,  sprd/adverse 528/1273 — the desk's worst pick-off ratio
# (xyz:CL — same dex, same asset class — stays: +$1,397 realised, maxDD 0.25%.)
# THE ELITE-8 (2026-06-11, Journal #53 addendum — picked on the #51 leak table, realised-first):
#   xyz:CL    +$1,397 realised / 3.7h, maxDD 0.25%, 318 fills — the desk's best book ever
#   xyz:GOLD  +$161 realised · xyz:NVDA +$155 / 117 fills · xyz:TSLA +$165 / 84 fills
#   FARTCOIN  +$313 realised, 231 fills, hedged (ETH β1.53 R².65)
#   PURR      +$117 realised, maxDD 0.15%, 44bps native spread (unhedged — no factor, R².13)
#   kPEPE     +$69 realised, 176 fills, hedged (ETH β1.20 R².77)
#   xyz:SPCX  DISCOVERY slot (operator pick): SpaceX pre-IPO perp, $66M/day, 1.85bps spread,
#             smoked through the engine client 2026-06-11 (20×20). NO live P&L evidence yet —
#             β=0, governor-capped, judge it on its first leak table.
# Cut at this swap: SOL ADA DOGE SUI (flat realised + warehouse bleed; "no big markets"),
# xyz:SP500 xyz:XYZ100 (near-dead our hours; XYZ100 red). Earlier cuts stand (HYPE/SILVER/BRENTOIL).
# NEXT-ROTATION SHORTLIST (universe scan 2026-06-11, spread×volume revenue proxy @1% share —
# structural priors, UNMEASURED, the S6 tool adjudicates): xyz:SNDK $160/d (2.3bps×$139M),
# xyz:MU $148/d (1.2bps×$251M), xyz:SKHX $138/d (2.2bps×$128M). For reference the same proxy:
# CL $451/d, SPCX $142/d, GOLD $12/d, NVDA $27/d, TSLA $4/d — measured realised beat the proxy
# on GOLD/NVDA/TSLA in #51, which is why they keep their slots over the shortlist.
# PRE-FLIGHT (mandatory): npx ts-node -r tsconfig-paths/register scripts/smoke-sweet16.ts
# ELITE-8 v3 — THE HEDGED DESK (2026-06-11, operator rule #55b: "we do not make markets in
# what we cannot delta-hedge"; board: scripts/hedgeable-universe.ts, R²≥0.5 on 30d×1h):
#   xyz:CL    hedge xyz:BRENTOIL β1.08 R².91 — best measured book ever (+$1,397 #51)
#   xyz:GOLD  hedge PAXG       β1.03 R².98 — the cleanest hedge on the desk
#   SOL       hedge ETH        β1.02 R².81 — +$752 realised A″ (re-admitted: now hedged+guardrailed)
#   ADA       hedge ETH        β1.04 R².59 — +$494 realised A″ (same)
#   DOGE      hedge ETH        β0.94 R².72 — incumbent, flat-positive
#   SUI       hedge ETH        β1.29 R².66 — incumbent
#   FARTCOIN  hedge ETH        β1.54 R².65 — +$313 realised #51
#   kPEPE     hedge ETH        β1.20 R².77 — positive fillEdge in BOTH #51 (+$69) and run53 (+$37)
# OUT by the hedge rule (single-name idio doesn't hedge to an index): xyz:NVDA R².41,
# xyz:TSLA R².45, xyz:SKHX R².28, xyz:ORCL R².38, PURR R².14, HYPE R².27.
# OUT by the edge rule despite hedgeable: XRP (worst bleeder #50), xyz:SILVER (worst pick-off #51).
BOOKS=(
  xyz:CL xyz:GOLD
  SOL ADA DOGE SUI FARTCOIN kPEPE
)
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

# Books DROPPED from the set still rehydrate from mm_book_state under MM_PERSIST and would keep
# trading silently — remove them explicitly (flattens + checkpoints; no-op if absent).
DROPPED=(BTC ETH XRP BNB HYPE xyz:SILVER xyz:BRENTOIL xyz:SP500 xyz:XYZ100 xyz:SPCX PURR xyz:NVDA xyz:TSLA xyz:SKHX xyz:ORCL)
echo "=== removing dropped incumbents (${DROPPED[*]}) ==="
for s in "${DROPPED[@]}"; do
  curl -s -X POST "$HOST/api/market-making/remove" -H 'content-type: application/json' \
    -d "{\"symbol\":\"$s\"}" >/dev/null 2>&1 || true
done

echo "=== launching all books ($STRATEGY, neutral + inventory governor) ==="
for s in "${BOOKS[@]}"; do launch "$s" "$STRATEGY"; done

echo
echo "=== verify ==="
echo "  snapshot : curl -s $HOST/api/market-making/snapshot | jq ."
echo "  nav curve: curl -s $HOST/api/market-making/nav | jq ."
echo "  fills    : curl -s '$HOST/api/market-making/events?since=0' | jq ."
echo "  (NAV persists to mm_nav when MM_PERSIST=true; fills are log-only — keep the tee'd logfile.)"
echo "  JUDGE BY: desk UNREALISED stays small (inventory controlled) + steady low-DD NAV curve."
