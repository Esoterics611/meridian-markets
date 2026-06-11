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

HOST="${MM_HOST:-http://localhost:3100}"

# ── Pre-flight (Journal #46a/#47): exactly ONE desk, and a KNOWN starting state ───────────────
# 0. Postgres on :5433. MM_PERSIST=true (the default here) hard-requires it — without it TypeORM
#    retries then kills the boot (ECONNREFUSED 127.0.0.1:5433). Bring it up + migrate so this stays
#    a true one-command start. Docker needs sudo on this machine — it may prompt for the password.
pg_up() { (exec 3<>/dev/tcp/127.0.0.1/5433) 2>/dev/null && exec 3>&- && return 0; return 1; }
if [ "${MM_PERSIST:-true}" = "true" ] && ! pg_up; then
  echo "▶ Postgres :5433 is down — starting it (sudo docker compose up -d postgres)…"
  sudo docker compose up -d postgres
  for _ in $(seq 1 30); do pg_up && break; sleep 1; done
  pg_up || { echo "✗ Postgres still unreachable on :5433 — check 'sudo docker compose ps'."; exit 1; }
  sleep 2 # accept TCP ≠ accepting auth; give the server a beat before migrating
  npm run migration:run # idempotent — applies only pending migrations
fi
# 1. Stale server still on :3100 = the classic ghost-P&L trap (the browser talks to an old process
#    holding poisoned in-memory hedge state). Refuse to start a second one.
if curl -sf --max-time 3 "$HOST/health" >/dev/null 2>&1; then
  echo "✗ a desk is already serving $HOST — refusing to start a second (the stale-server ghost-P&L trap)."
  echo "  Stop it (Ctrl-C its terminal) or:  pkill -f 'nest start'   then re-run."
  exit 1
fi
# 2. Surface whether this boot RESUMES persisted books (carry old inventory + P&L) or comes up clean.
#    A 'fresh trial' that silently rehydrates old books is the #47 confusion. Best-effort (needs psql).
if command -v psql >/dev/null 2>&1; then
  open=$(PGPASSWORD=meridian_markets_app psql -h localhost -p 5433 -U meridian_markets_app \
    -d meridian_markets -tAc "select count(*) from mm_book_state where status='OPEN'" 2>/dev/null || echo '?')
  if [ "$open" != "0" ] && [ "$open" != "?" ] && [ -n "$open" ]; then
    echo "⚠ $open persisted OPEN book(s) will be REHYDRATED on boot — this RESUMES them with their carried"
    echo "  inventory + P&L (NOT a fresh trial). For a clean slate: Ctrl-C now, run scripts/reset-desk.sh"
    echo "  (clears persisted OPEN books while the desk is stopped), then re-run."
    echo "  Continuing in 5s — Ctrl-C to abort."
    sleep 5
  fi
fi

LOG="docs/research/run-$(date +%Y%m%d-%H%M%S)-mm10h.log"
mkdir -p docs/research
echo "▶ MM desk starting — logging to $LOG  (Ctrl-C to stop)"
echo "ℹ Once started, CONFIRM the fast path in $LOG (Journal #47): the loop logs"
echo "    'desk loop started — N book(s): N on fast L2 re-quote (driver on), 0 on the …ms bar path'"
echo "  If it says '0 on fast L2 re-quote', books fell onto the slow bar path — stop and report, don't trade it."

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
# GUARDRAILS (Journal #55 — run53's "earn slowly on spread, lose suddenly on inventory" fix;
# the xyz books are UNHEDGED by design, so flat is their only hedge):
#   MM_MAX_INVENTORY_NOTIONAL_FRAC=0.10  cap cut 0.15→0.10 — the warehouse tail scales linearly
#                                        with the rail ($50k max inventory on a $500k book).
#   MM_LOSS_STOP_FRAC=0.0006             warehouse loss-stop: flatten at taker + 15min stand-aside
#                                        when a position's unrealised < −0.06% of capital (−$300 on
#                                        $500k). Tail-only insurance — it does NOT add expectation,
#                                        it converts the fat left tail into a bounded, known cost.
#   MM_SESSION_GATE=…=1330-2000          xyz US-equity books quote ONLY US RTH (13:30–20:00Z) and go
#                                        home flat — off-hours their reference market is closed/stale
#                                        and quoting it is pure pick-off (run53: SKHX fillEdge −$632,
#                                        all pre-US-open). CL/GOLD exempt (~24h real markets).
# Audit trail: grep 'GUARDRAIL ▸' $LOG — every loss-stop / session flatten is a tape event + log line.
# MM_HEDGE_BETA_MAP: crypto books keep the OOS alt→major map (scripts/hedge-beta-fit.ts, 30d×1h HL —
# RE-FIT between runs, β drifts; this map fit 2026-06-11). FARTCOIN/kPEPE now FITTED (R² .65/.77 —
# the #51 run's live KPI agreed); PURR stays 0 (R² .13 = no factor, governor-capped). ADA's BTC/ETH
# fit tied at R² .59 → kept on the single ETH leg (one-leg netting beat the A″ BTC-leg churn).
# HIP-3 RWA books (xyz:*) are beta 0 BY DESIGN —
# gold/equities/oil have no crypto factor; the inventory governor is their risk rail, and venue-fees
# quotes them with NO maker rebate (HIP3_FEE) so paper P&L stays honest. Sweet-16 set:
# docs/BOOK_SELECTION_ANALYSIS.md + smoke first: scripts/smoke-sweet16.ts.
#
# RISK-AVERSE PROFILE (Ronnie, 2026-06-11, Journal #51 — binding doctrine: prefer FEWER fills over
# LOSING fills; broaden the spread when needed; warehouse less). Each knob does what the engine
# math actually says (avellaneda-stoikov.ts asHalfSpreadMicros / asReservationMicros):
#   MM_F3_MIN_SCALE=1.0   F3 becomes WIDEN-ONLY — never quotes tighter than the GLFT baseline
#                         (was 0.5 = tighten into calm flow to farm the rebate). The direct
#                         "fewer, better fills" lever.
#   MM_GAMMA=0.005        2× risk aversion. Honest note: this ~doubles the inventory-risk term and
#                         the reservation skew (mean-revert to flat harder = shed inventory), but
#                         barely widens the BASE spread — the arrival term ≈2/κ is γ-insensitive.
#                         The base-width knob is κ: leave it to the next mm-l2-tune γ/κ sweep, a
#                         blind global κ cut un-quotes the tight books (xyz:CL trades at 0.11bps).
#   MM_MAX_INVENTORY_NOTIONAL_FRAC=0.15  max inventory $75k/book (was $125k) — caps warehouse-drift
#                         exposure, the #51 run's biggest surviving leak (ADA −707 unreal).
#   MM_INVENTORY_SKEW_MULT=6  (was 4) reservation mean-reverts toward flat harder.
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
MM_GAMMA="${MM_GAMMA:-0.005}" \
MM_F3_MIN_SCALE="${MM_F3_MIN_SCALE:-1.0}" \
MM_MAX_INVENTORY_NOTIONAL_FRAC="${MM_MAX_INVENTORY_NOTIONAL_FRAC:-0.10}" \
MM_INVENTORY_SKEW_MULT="${MM_INVENTORY_SKEW_MULT:-6}" \
MM_LOSS_STOP_FRAC="${MM_LOSS_STOP_FRAC:-0.0006}" \
MM_LOSS_STOP_COOLDOWN_MIN="${MM_LOSS_STOP_COOLDOWN_MIN:-15}" \
MM_SESSION_GATE="${MM_SESSION_GATE:-xyz:NVDA,xyz:TSLA,xyz:SKHX,xyz:ORCL,xyz:SNDK,xyz:MU,xyz:MRVL=1330-2000}" \
MM_PERSIST="${MM_PERSIST:-true}" \
MM_FAST_REQUOTE_MS="${MM_FAST_REQUOTE_MS:-100}" \
MM_CANCEL_REPLACE_LATENCY_MS="${MM_CANCEL_REPLACE_LATENCY_MS:-30}" \
MM_FAST_SYMBOLS="${MM_FAST_SYMBOLS:-xyz:CL,xyz:GOLD,xyz:NVDA,xyz:TSLA,xyz:SKHX,xyz:ORCL,FARTCOIN,kPEPE}" \
MM_MICROPRICE_DEPTH="${MM_MICROPRICE_DEPTH:-5}" \
MM_F3_TOXICITY="${MM_F3_TOXICITY:-true}" \
MM_DELTA_HEDGE="${MM_DELTA_HEDGE:-true}" \
MM_HEDGE_BAND_USD="${MM_HEDGE_BAND_USD:-2000}" \
MM_HEDGE_TAKER_BPS="${MM_HEDGE_TAKER_BPS:-2.5}" \
MM_HEDGE_HALF_SPREAD_BPS="${MM_HEDGE_HALF_SPREAD_BPS:-1}" \
MM_HEDGE_COST_SPREAD_MULT="${MM_HEDGE_COST_SPREAD_MULT:-0.5}" \
MM_HEDGE_BETA_MAP="${MM_HEDGE_BETA_MAP:-FARTCOIN:ETH:1.53,kPEPE:ETH:1.20,xyz:CL:CL:0,xyz:GOLD:GOLD:0,xyz:NVDA:NVDA:0,xyz:TSLA:TSLA:0,xyz:SKHX:SKHX:0,xyz:ORCL:ORCL:0}" \
MM_FLOW_BIAS_LIVE="${MM_FLOW_BIAS_LIVE:-true}" \
MM_FLOW_BIAS_HORIZON_MS="${MM_FLOW_BIAS_HORIZON_MS:-60000}" \
MM_FLOW_BIAS_MIN_IC="${MM_FLOW_BIAS_MIN_IC:-0.05}" \
MM_DIR_SPREAD_SKEW="${MM_DIR_SPREAD_SKEW:-0.5}" \
MM_DIR_SINGLE_SIDE_BIAS="${MM_DIR_SINGLE_SIDE_BIAS:-0.6}" \
MM_FLOW_SHADOW="${MM_FLOW_SHADOW:-true}" \
MM_FLOW_SHADOW_MIN_MS="${MM_FLOW_SHADOW_MIN_MS:-1000}" \
MM_MARKOUT_HORIZONS_MS="${MM_MARKOUT_HORIZONS_MS:-1000,5000,30000,60000,300000}" \
TELEMETRY_ENABLED=true \
npm run start:dev 2>&1 | tee "$LOG"
