# Meridian Markets

A **paper-trading demonstration of an AI-agent-run quant desk** — several strategies running concurrently, each manned by a quant agent, aiming to **minimize drawdown and show steady, conserved returns over hours and days** of live paper trading on real market data. Underneath is a self-contained **stat-arb engine**, an automated **market-making desk**, and a **funding-carry desk** (market-data spine, signal/risk library, execution path, live event loop). The UI is a **role-scoped, server-rendered console** — open `/` for the launcher: `/exec` (fund overview), `/ops`, `/desk/mm`, `/desk/carry`, `/desk/statarb`, `/risk`, `/research` — every page a thin read-only view over the engine (the legacy `/demo` cockpit still runs alongside).

> **Scope: paper-only, for the foreseeable future.** This is a *demonstration*, not a path to managing real capital — there is **no production / real-money deployment on the roadmap**. Two engines drive it: **crypto market-making** (the steady, low-drawdown earner) and **equities stat-arb** (a thin, uncorrelated diversifier). The frontier where the edge grows is **discovering new markets — especially DEX / decentralized / anonymous markets** to make markets in. Because it's a demo, **truthful numbers are the whole point**: the OOS / survivorship / cost gates exist to keep the paper P&L honest, not to clear a deploy.

It runs in three postures — engineering switches, no business gate (`EXECUTION_MODE` + `FEED_SOURCE`):

- **mock** — synthetic feed + synthetic venue; offline, deterministic (unit tests + demo).
- **paper** — **real** market data (Binance public REST / Alpaca equities) + `PaperVenue` (simulated fills at real prices). **This is the mode we run** — the demo lives here. No API key for crypto, no real money.
- **canary / live** — routes flow to a real venue, behind the `LIVE_TRADING_ARMED=true` arm switch. **Out of scope for now** — the seam is kept honest but wiring a real venue is not a current goal.

Read [`CLAUDE.md`](CLAUDE.md) first — the authoritative architecture + session log.

### What the research says (the honest read)

The point of the desk is truthful numbers, so the findings — including the unflattering ones — are logged in full ([`docs/QUANT_JOURNAL.md`](docs/QUANT_JOURNAL.md) for the chronological trail, [`docs/RESEARCH_FINDINGS.md`](docs/RESEARCH_FINDINGS.md) for the citable verdicts). The current read:

- **Naive spread market-making loses** to adverse selection at every spread width — the edge is **fair-value prediction + speed**, not a wider spread. Quoting around the book-imbalance **micro-price** cuts adverse selection; at **sub-second** re-quote cadence the spread edge flips from losing to positive (the desk's spread-vs-adverse measure went −$1,020 → +$133 on one 8h window). The remaining loss is **inventory carry / net delta** — the inventory governor (notional caps + skew, now default-on) **bounds drawdown** (per-book maxDD ≤ ~1.5% on a 10h run, vs 17% before), and an auditable perp **delta hedge** neutralises the residual; the desk is now a *small, bounded* result, not a blow-up. Turning that into a steady *positive* is the open problem (the edge is the adverse-selection defence + a validated lean, not more coins).
- **Crypto taker stat-arb is killed** (a cointegration cliff); **equities sector stat-arb** is real but thin (~0.06 Sharpe) and survivorship-bound; **funding carry** is real but modest (fatter on non-major perps). Every one of these was measured against fees, adverse selection, and out-of-sample gates before it counted.

See [`docs/WEEKLY_WRAP_2026-06-05.md`](docs/WEEKLY_WRAP_2026-06-05.md) for the latest summary.

> **Legacy:** this repo began as a treasury/yield service that fed an external payments service over an HTTP contract. **That integration is retired** and the repo is now standalone. The `src/treasury/` + `src/yield/` code and the `treasury_*` tables remain as dormant legacy (CLAUDE.md §5); the historical spec is archived at [`docs/archive/INTEGRATION_WITH_LIRA_BRIDGE.md`](docs/archive/INTEGRATION_WITH_LIRA_BRIDGE.md).

## Documentation — the key files

Start with [`CLAUDE.md`](CLAUDE.md) (binding architecture + mission + session log). Then, by need:

| you want | read |
|---|---|
| **The active plan + current state** (updated every session) | [`docs/PROFIT_PIVOT_II.md`](docs/PROFIT_PIVOT_II.md) — §4 is the session ledger / pickup point |
| The master plan / priorities behind it | [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) |
| **Run the carry desk as a human operator** (doctrine + workflow + playbook) | [`docs/CARRY_DESK_OPERATOR_MANUAL.md`](docs/CARRY_DESK_OPERATOR_MANUAL.md) |
| The hardest lesson, taught from first principles (ticker collision, #92) | [`docs/TICKER_COLLISION_POSTMORTEM.md`](docs/TICKER_COLLISION_POSTMORTEM.md) |
| Chronological research log (per-run numbers + artifacts) | [`docs/QUANT_JOURNAL.md`](docs/QUANT_JOURNAL.md) |
| Consolidated, citable findings (KEEP / CUT / RESERVE) | [`docs/RESEARCH_FINDINGS.md`](docs/RESEARCH_FINDINGS.md) |
| The UI: design + doctrine · role-by-role guide · what's next | [`docs/UI_ARCHITECTURE.md`](docs/UI_ARCHITECTURE.md) · [`docs/UI_ROLE_GUIDE.md`](docs/UI_ROLE_GUIDE.md) · [`docs/UI_REWRITE_PLAN_II.md`](docs/UI_REWRITE_PLAN_II.md) |
| How paper trading works (real data, simulated fills) | [`docs/PAPER_TRADING.md`](docs/PAPER_TRADING.md) |
| The MM desk (quoters, risk gates, attribution) + how to run it | [`docs/MARKET_MAKING.md`](docs/MARKET_MAKING.md) · [`docs/RUN_THE_DESK.md`](docs/RUN_THE_DESK.md) |
| MM fair-value / adverse-selection findings | [`docs/FAIR_VALUE_AND_THESIS_DESIGN.md`](docs/FAIR_VALUE_AND_THESIS_DESIGN.md) |
| The regime / "take-sides" directional desk | [`docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md`](docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md) |
| **The probability desk** (HIP-4 binaries vs the Deribit RND) — thesis + how to run | [`docs/PROBABILITY_DESK.md`](docs/PROBABILITY_DESK.md) |
| Equities stat-arb (Alpaca/Yahoo) | [`docs/EQUITIES_STATARB_PLAN.md`](docs/EQUITIES_STATARB_PLAN.md) |
| Venue / data-source ledger | [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) |
| Per-session engineering history | [`docs/SESSION_HISTORY.md`](docs/SESSION_HISTORY.md) |

## Run it locally

```bash
npm install
docker compose up -d postgres        # Postgres on :5433 (sudo on this host if needed)
cp .env.example .env
npm run migration:run                # one-time / when the schema changes
```

Default port is `3100`. The product run path is the **live trading desk** below; deeper design in [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md).

## The live trading desk — run the quant engine & watch paper trades

Meridian is also a **stat-arb trading engine** (CLAUDE.md §1 — the engine *is* the
product; the dashboard is a thin view over it). The "trader" is a background event
loop (`LivePaperTrader`, and the multi-book `LivePortfolioTrader`): each tick it
pulls the next closed 1-minute bar for both legs of a pair from **real Binance
public data**, runs the chosen strategy, and routes orders to `PaperVenue` (fills
at the real ticker, taker fee modelled). Closed round-trips persist to
`stat_arb_trades`. No API key, no account, no real money — paper predicts live
because only the injected venue changes.

An operator drives it from the `/demo` cockpit or the terminal control plane. In the
**agentic** design (the mission, [docs/AGENTIC_HEDGE_FUND_DESIGN.md](docs/AGENTIC_HEDGE_FUND_DESIGN.md))
each book is *manned by a quant agent* (a Claude session) that fits, launches, and
babysits its strategy; a human supervises the one screen. Deeper design:
[docs/PAPER_TRADING.md](docs/PAPER_TRADING.md) ·
[docs/UI_REWRITE_SPEC.md](docs/UI_REWRITE_SPEC.md) ·
[docs/QUANT_TERMINAL_SPEC.md](docs/QUANT_TERMINAL_SPEC.md) ·
[docs/AGENTIC_HEDGE_FUND_DESIGN.md](docs/AGENTIC_HEDGE_FUND_DESIGN.md).

### Prerequisites
```bash
docker compose up -d postgres      # Postgres on :5433 (sudo on this host if needed)
npm run migration:run              # one-time / when the schema changes
```

### The full operator flow — step by step (and why it never interferes)

There is **one backend** (the UI + the market-making desk) and **separate desk scripts** that run in
their own terminals. They are decoupled on purpose:

| Process | Role | Touches |
|---|---|---|
| **The backend** (`npm run start:dev`) | Serves `/demo` + every `/api/*` control plane, **and runs the MM desk in-process**. The only process that binds `:3100`. | `mm_nav` desk=`''`/symbol |
| **MM book launcher** (`scripts/launch-mm-10h.sh`) | **Drives the running backend** (`POST /api/market-making/launch`). Not a second trading process. | the backend |
| **Regime Desk** (`scripts/regime-book-live.ts`) | A **self-contained** directional desk in its own process — gates, seats, polls Hyperliquid, trades on paper. Needs no backend. | `mm_nav` desk=`regime` |
| **Carry Desk** (`scripts/launch-carry-30d.sh`) | The **flagship P0 30-day run** — funding carry on HL perps hedged with Binance spot, in its own supervised process (nohup + pidfile). Needs no backend; the backend's `/desk/carry` page reads its checkpoints. | `carry_book_state` + `mm_nav` desk=`carry` |

**Why no interference:** only the backend binds the port (and `start-desk.sh` refuses to start a
second one); the MM launcher *drives* that one backend rather than spawning a rival; the Regime script
writes a **different** `mm_nav` tag (`regime`) so curves never collide; and the backend **does not run
its own Regime desk** unless you explicitly set `REGIME_DESK_DRIVE=true`. So you can run all three at
once. The **one rule**: don't set `REGIME_DESK_DRIVE=true` *and* run `regime-book-live.ts` — that's the
only way to get two Regime desks competing.

**Step by step:**

```bash
# 0) One-time, then whenever the schema changes
npm install
docker compose up -d postgres && npm run migration:run

# 1) TERMINAL 1 — the backend: UI + MM desk + serves the Regime cockpit (read-only).
#    REGIME_DESK=true just serves the /demo tab; it does NOT start a Regime desk here.
REGIME_DESK=true MM_PERSIST=true FEED_SOURCE=binance EXECUTION_MODE=paper \
  MOCK_TRADING_ENABLED=false LIVE_AUTOSTART=false npm run start:dev
#    → open http://localhost:3100/demo

# 2) TERMINAL 2 — launch the MM books onto that backend (drives it; not a new process)
bash scripts/launch-mm-10h.sh
#    confirm the books took the fast L2 path in Terminal 1's log (Journal #47), then let it run.

# 3) TERMINAL 3 — the Regime "take-sides" desk, in its own process (re-gate + stress-check first)
RBO_DAYS=90 npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts   # today's validated set
npx ts-node -r tsconfig-paths/register scripts/regime-stress.ts                  # expect STRESS OK
MM_PERSIST=true RBL_HOURS=8 RBL_EXPOSURE=outright RBL_TOP_N=8 \
  npx ts-node -r tsconfig-paths/register scripts/regime-book-live.ts
```

```bash
# 4) WATCH (any terminal) — the UI at /demo, or the control planes:
curl -s localhost:3100/api/market-making/snapshot | jq '.books[] | {symbol, netPnlUnits, maxDrawdownPct}'
curl -s localhost:3100/api/regime/snapshot        | jq '{enabled, driving, desk}'   # driving:false ⇒ desk is in the script
# the Regime script prints its own live cockpit + a realised-first verdict + tear-sheet at Ctrl-C.

# 5) REVIEW a finished run — use the mm-run-review skill (pulls realised P&L from mm_nav; don't read the log end-to-end).
```

Details for each piece are in **A–E** below. To run the Regime desk **inside** the backend instead of
its own terminal (single process), see §E (`REGIME_DESK_DRIVE=true`) — and then skip step 3.

### A. The cockpit — launch strategies and watch them live
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  LIVE_AUTOSTART=false npm run start:dev
# → open http://localhost:3100/demo
```

> **Same command as before — the new data sources need no extra env.** The
> reference sources wired into the scanner (Pyth FX, DefiLlama peg, Bit2C ILS)
> are **public, no API key**, with built-in default URLs. Override only if you
> need a mirror/proxy:
> `PYTH_BENCHMARKS_BASE_URL`, `DEFILLAMA_STABLECOINS_BASE_URL`, `BIT2C_BASE_URL`
> (see `.env.example`). They do make outbound calls, which paper mode already does
> for Binance.

In `/demo`:
1. **Research → ⊹ Scan all source data** is the front door: it sweeps **every
   asset class at once** (crypto, stablecoin, **FX via Pyth**, …) and ranks each
   candidate by net-edge-after-fees, **grouped by asset class** with a rollup of
   which classes fit the model. A "data sources wired" readout shows the live
   sources (binance.spot + Pyth/DefiLlama/Bit2C). **Trade** straight from a row —
   every trade launches an isolated paper book (a *station*).
2. **▶ Launch a station** (Launch tab): asset class → market (leg A / leg B) →
   strategy → **edit its params** (entry/exit z, windows, tx-cost…) → β + capital
   → **Launch**. β auto-fills from discovery when the pair was found cointegrated.
3. **Desk → Live books** shows every concurrent station as a param card — z-score,
   β, bands, regime, position, capital, equity, realised/unrealised, **feed** —
   with z & equity **sparklines**. Each card has ▸ (chart its signal) and ✕
   (flatten + remove). **FLATTEN ALL** / **HALT ALL** are desk-wide.
4. **Research → Deep-dive** discovers one market set in detail (after ⤓ Backfill);
   **Validate before you trade** runs walk-forward / sweep / Monte-Carlo. **Trade
   history** is the persisted `stat_arb_trades` ledger (survives restart). The
   header strip shows desk P&L, feed/venue, a live UTC clock and a heartbeat.

> **Verify the reference sources** (no server, no DB):
> `npx ts-node -r tsconfig-paths/register scripts/smoke-reference-sources.ts`

> 1-minute bars: a freshly launched book warms from ~240 real klines so its
> z-score is live immediately, but an *entry* waits for z to cross the band —
> minutes or longer. Lower the lookback / use a faster interval to iterate.

### B. Headless proof the loop enters trades (no server)
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false LIVE_AUTOSTART=false \
  QS_PRESET=crypto-majors QS_HOURS=24 \
  npx ts-node -r tsconfig-paths/register scripts/quant-session.ts
```
Prints the strategy catalogue → discovered cointegrated pairs → a per-strategy
backtest table on real history → per-strategy live-loop round-trips with realised
PnL → arms the control plane. Ends `QUANT SESSION OK`.

### C. Terminal control plane
```bash
curl -s  localhost:3100/api/stat-arb/live/snapshot  | jq   # single book: z, regime, PnL, position
curl -s  localhost:3100/api/stat-arb/live/portfolio | jq   # all live books
curl -s  localhost:3100/api/stat-arb/live/trades    | jq   # persisted blotter (stat_arb_trades)
# launch one station additively, with param overrides:
curl -sX POST localhost:3100/api/stat-arb/live/portfolio/launch \
  -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","strategyId":"ou-bertram","beta":18.0,"params":{"ouWindow":90},"capitalUsdc":50000}' | jq
```

### D. The market-making desk (the live earner)

The automated MM books run **next to** the stat-arb portfolio on the same process. Two terminals
— full guide + every knob in [docs/RUN_THE_DESK.md](docs/RUN_THE_DESK.md):

```bash
bash scripts/start-desk.sh          # terminal 1: the canonical paper desk (Ctrl-C to stop)
bash scripts/launch-mm-10h.sh       # terminal 2: launch the 8 HL books
```

The **fast L2 queue-aware fill path is the default** for any L2 venue (Hyperliquid); a book on a
**non-L2 venue is refused** (candle fills can't resolve top-of-book turnover, so they're an
offline-test simulator only, not an honest track record). The inventory governor (notional/skew
caps) is **default-ON**, funding accrues on the fast path, and the desk carries an **auditable**
paper-perp **delta hedge** (`MM_DELTA_HEDGE=true` — folded into NAV + on the event tape). Watch it:

```bash
curl -s localhost:3100/api/market-making/snapshot | jq '.books[] | {symbol, netPnlUnits, maxDrawdownPct}'
curl -s localhost:3100/api/market-making/snapshot | jq '.hedge | {grossDeltaUsd, residualUsd, hedgePnlUsd}'
```

### E. The Regime Desk — "take sides" directional book

The standalone **Regime Desk** (the cross-sectional directional/"take-sides" book) is a *separate
desk*. The default + supported way to run it is the **terminal cockpit script** — the web backend
only **serves the UI**. These two are deliberately decoupled so they never interfere: **run the
backend for the `/demo` UI, run the script for the desk.** Full design in
[docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md](docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md).

**1) Run the desk — the terminal cockpit (this is the desk runner / track record).**
`scripts/regime-book-live.ts` is self-contained: it gates, seats the top-N validated symbols, polls
real Hyperliquid data itself, and **does not need the backend running**. It redraws a live position
table with the **STOP gauge**, desk-risk RUN/HALT + gross/net vs caps, the idio-vs-beta `attr` line,
and a tear-sheet vs BTC at Ctrl-C:

```bash
MM_PERSIST=true RBL_HOURS=8 RBL_SLIPPAGE_BPS=1 RBL_EXPOSURE=outright RBL_TOP_N=8 \
  npx ts-node -r tsconfig-paths/register scripts/regime-book-live.ts
```

Knobs (defaults shown): `RBL_TOP_N=8`, `RBL_EXPOSURE=outright` (or `hedged` — beta-neutral via
`RBL_HEDGE_SYMBOL`/`RBL_HEDGE_BAND_USD`/`RBL_HEDGE_BETA_LOOKBACK`), `RBL_HOURS=8`, `RBL_SLIPPAGE_BPS`,
`RBL_SYMBOLS`, `RBL_GATE_DAYS`, `RBL_INTERVAL`, `RBL_BASE_NOTIONAL_USD`, `RBL_STOP_FRAC`, plus
desk-risk caps `RBL_MAX_GROSS_USD` / `RBL_MAX_NET_USD` / `RBL_DAILY_LOSS_USD` / `RBL_DESK_MAX_DD_FRAC`.
With `MM_PERSIST=true` the curve lands in `mm_nav` (desk=`regime`) — review it with the `mm-run-review`
skill (don't read the log end-to-end). Re-gate first (`scripts/regime-bias-oos.ts`) and stress-check
(`scripts/regime-stress.ts`) before a long run.

**2) Run the backend — serves the `/demo` UI (the Regime Desk tab + control plane).**
`REGIME_DESK=true` **serves the cockpit only** — it does **not** spin up an in-process desk, so it
runs **light** and never competes with the script in (1) (no double HL polling, no event-loop
contention). The tab + `/api/regime/*` are live; the snapshot shows `driving:false` (SERVE-ONLY).

```bash
# Serve the cockpit + every other desk's UI — open http://localhost:3100/demo → Regime Desk tab
REGIME_DESK=true MM_PERSIST=true FEED_SOURCE=binance EXECUTION_MODE=paper \
  MOCK_TRADING_ENABLED=false npm run start:dev
```

**Optional all-in-one:** to also *drive* the desk **inside** the backend (the old in-process
behaviour), add `REGIME_DESK_DRIVE=true`. Then the backend runs the OOS gate + HL poll loop + trading
itself — so **do not also run the script** in (1), or you'd have two regime desks competing. Use this
only when you want a single process; otherwise prefer (1) + (2).

```bash
REGIME_DESK=true REGIME_DESK_DRIVE=true MM_PERSIST=true FEED_SOURCE=binance EXECUTION_MODE=paper \
  MOCK_TRADING_ENABLED=false npm run start:dev
```

In-process driver knobs (only apply with `REGIME_DESK_DRIVE=true`; defaults shown):
`REGIME_SYMBOLS=BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,LTC,SUI,APT,ARB,OP,INJ,TIA`, `REGIME_TOP_N=8`,
`REGIME_GATE_DAYS=90`, `REGIME_INTERVAL=1h`, `REGIME_BASE_NOTIONAL_USD=50000`, `REGIME_POLL_MS=60000`,
`REGIME_MARKET_SYMBOL=BTC` (beta benchmark). Watch it / control it (works in both serve-only and
driven modes — read-only in serve-only):

```bash
curl -s localhost:3100/api/regime/snapshot | jq         # enabled, driving, books, gross/net, STOP gauge, attr
curl -sX POST localhost:3100/api/regime/flatten | jq     # flatten all positions (driven mode)
curl -sX POST localhost:3100/api/regime/halt | jq        # halt the desk (driven mode)
```

Review a finished run with the `mm-run-review` skill (realised P&L from `mm_nav` desk=`regime`).

### F. The carry desk — the 30-day P0 forward run (the current flagship)

Funding carry on Hyperliquid perps hedged with Binance spot — gate-first (90d OOS persistence +
recency veto + the #92 ticker-collision guard), maker-routed entries, judged **realised-first**
(funding + realised − fees; the basis mark is reported, not judged). Runs as its **own supervised
process**; the backend's `/desk/carry` page (and `GET /api/carry/state`) read its durable
checkpoints — including a liveness banner that screams if the runner dies:

```bash
bash scripts/launch-carry-30d.sh           # start supervised (nohup + pidfile)
bash scripts/launch-carry-30d.sh status    # is the desk alive? + last log lines
bash scripts/launch-carry-30d.sh stop      # graceful: books checkpoint OPEN and resume next start
# daily measurement (M2 needs 7 consecutive boards before any differential leg opens):
npx ts-node -r tsconfig-paths/register scripts/funding-differential-board.ts
```

The full operator doctrine — what each number means and when to act — is
[`docs/CARRY_DESK_OPERATOR_MANUAL.md`](docs/CARRY_DESK_OPERATOR_MANUAL.md).

> **DB-free note:** without `MM_PERSIST=true` (and Postgres up) the carry desk runs fine but
> keeps **no durable checkpoints** — a restart re-gates and re-opens from scratch instead of
> resuming held books. Fine for a watch session; the real 30-day run wants persistence.

### G. The probability desk — HIP-4 binaries vs the Deribit RND (paper, live)

*(Built 2026-07-13; full thesis, pre-registered metrics, and honest gaps:
[`docs/PROBABILITY_DESK.md`](docs/PROBABILITY_DESK.md).)* Hyperliquid's HIP-4 event markets
(live on mainnet since 2026-05-02) quote daily **BTC/ETH price binaries** as normal L2 books in
probability units. The crowd prices them by feel; this desk prices them off its own
**smile-adjusted Deribit digital** (−dC/dK, the validated Greeks layer) and paper-trades only a
signed, fee-adjusted fair-value edge past a pre-registered gate. Defined-risk (max loss =
collateral, known at entry), self-settling within hours — realised P&L arrives daily.

```bash
# DB-free, no keys; journals every EVAL/ENTER/TP/SETTLE + 10-min SUMMARY lines:
npx ts-node -r tsconfig-paths/register scripts/outcome-rv-live.ts

# Knobs (defaults in parentheses — the defaults ARE the pre-registered run):
#   ORV_EDGE_MIN(0.03)      min fee-adjusted edge, prob units — DON'T lower mid-run; a looser
#                           run is an experiment, not the track record
#   ORV_FEE_PROB(0.005)     fee per $1 contract on close/settle — PLACEHOLDER until HIP-4's
#                           real schedule is confirmed against a settled market
#   ORV_CONTRACTS(500)      base size, $1-payout contracts
#   ORV_MAX_MKT_USD(500) ORV_MAX_TOTAL_USD(2000)   collateral caps (= max loss caps)
#   ORV_MIN_EXP_MIN(45)     no new entry this close to expiry
#   ORV_TP_FRAC(0.7)        take-profit: close early once ≥70% of entry edge is lockable
#   ORV_TOUCH_FRAC(0.5)     never take more than half the displayed touch size
#   ORV_HOURS(0)            0 = run until Ctrl-C (FINAL line = the honest scorecard)
#   ORV_JOURNAL(docs/research/outcome-rv)   JSONL journal dir — every gap seen, traded or not
```

Reading the log: `scan … yes 0.129/0.147 fair 0.1179 — no trade (edge 0.0067 < min 0.03)` is the
desk *working correctly* — doctrine #5, no edge past the gate → no position. Only
`class:priceBinary` markets on Deribit-priceable underlyings are ever touched; sports/politics
markets are refused by construction, and the #92 same-underlying guard (venue spot vs Deribit
index ±5%) sits on every pricing call.

### H. The VRP satellite — gated short vol, stopped and hedged (paper, live)

*(PROFIT_PIVOT_II E6 — the desk's largest validated, previously never-run edge: #12 = implied −
realized of +5.9 BTC / +3.7 ETH vol pts; #42 = short-vol won 86.3% of 117 rolling 24h windows.)*
Sells the ATM **daily** straddle off the live Deribit chain **only when** trailing realized vol
(HL 1h candles) sits ≥ `VRP_MIN_PTS` under mark IV — gate closed ⇒ it sits out and says so.
Band delta-hedges with a paper HL perp (avg-cost hedge P&L, taker fee), and a **hard dollar
stop** bounds the fat left tail that is this trade's whole risk.

```bash
npx ts-node -r tsconfig-paths/register scripts/vrp-live.ts

# Knobs (defaults in parentheses):
#   VRP_UNDERLYINGS(BTC,ETH)  one independent book per underlying
#   VRP_MIN_PTS(0.03)         entry gate: iv − rv ≥ 3 vol pts (the measured premium, #12)
#   VRP_CONTRACTS(0.1)        straddle size, coin units
#   VRP_BAND(0.25)            re-hedge when |net delta| > 25% of contracts
#   VRP_HEDGE_FEE_BPS(3.5)    taker fee on each hedge trade
#   VRP_STOP_USD(400)         HARD loss stop per position — the tail control; size around this
#   VRP_MIN_H(6)              don't sell a straddle with <6h of life
#   VRP_RV_HOURS(24)          realized-vol lookback (1h bars)
#   VRP_HAIRCUT_FRAC(0.02)    entry premium = Deribit mark − 2% (spreads are wide; honest default)
#   VRP_HOURS(0)              0 = run until Ctrl-C
#   VRP_JOURNAL(docs/research/vrp)   JSONL journal dir (GATE/OPEN/REHEDGE/STOP/SETTLE/FINAL)
```

Honest caveats (v0, also in the script header): marks use entry IV for the position's life (no
vega mark — settle is exact), hedges fill at HL mid + fee with no queue model, and the premium
haircut is an assumption until executable option quotes are measured. Judged **realised-first**
at daily settle, like everything on this desk.

### Execution modes
`EXECUTION_MODE`: `mock` (synthetic) · `paper`/`canary` (`PaperVenue`: real prices +
simulated fills) · `live` (real venue, requires `LIVE_TRADING_ARMED=true`).
`FEED_SOURCE`: `binance` (real public REST, no key) · `mock`. The `live` posture is an
engineering seam only — **real-money deployment is out of scope for the foreseeable
future** (the mission is paper-only); there is no business/KYB gate either way.

## Test

```bash
npm test
```

The DB-backed suites (`*.int-spec.ts`) auto-skip when Postgres is not reachable; set `MERIDIAN_DB_TESTS=off` to skip them explicitly. (Pure-unit specs run anywhere — see CLAUDE.md §10.)

## Architecture

Modular monolith — one repo, one Postgres, one ordered migration history. Every external integration sits behind a swap-seam interface (a mock and a real impl, selected by config), so the engine is testable offline and paper-tradable without ceremony. The repo is **self-contained** — no cross-repo coupling.

The binding rules and the maintained file map live in [`CLAUDE.md`](CLAUDE.md): §6 architecture, §7 execution modes & swap seams, §8 session log, §9 file map. Per-session history is in [`docs/SESSION_HISTORY.md`](docs/SESSION_HISTORY.md).

---

## Research Journey

Full detail in [`docs/QUANT_JOURNAL.md`](docs/QUANT_JOURNAL.md) (93 entries). The short version:

**Stat-arb (entries #1–#40):** We built a rigorous crypto stat-arb engine — cointegration, walk-forward OOS, deflated Sharpe, purged k-fold, half-spread + impact cost gates. The honest finding: *crypto taker stat-arb is dead.* Cointegration that looks real on 30d windows collapses to near-zero by 90–180d. It's a short-window artefact, not an edge. Equities sector stat-arb is real but ~0.06 Sharpe and survivorship-bound — worth running on paper for months before sizing up.

**Market-making (#41–#65):** We pivoted to maker-rebate MM on Hyperliquid (−0.2 bps rebate). Built a full MM desk: Avellaneda-Stoikov / GLFT / Directional quoters, VPIN risk gate, LOB replay with queue-aware fills, 4-component P&L attribution, per-book NAV curve. The key insight: *naive MM loses to adverse selection — it's a fair-value problem, not a spread-width problem.* The micro-price quote center + sub-second re-quote cadence flipped the desk from −$1,020 to +$133 on an 8h window. First honest net-positive read.

**Carry trade (#66–#72):** The desk's structural edge. HL perpetuals trade at a persistent discount to Binance spot; positive funding means the short (hedge) leg collects. We built the full carry stack: T1 cross-venue fair-value, T2 OOS persistence gate (60d, posFrac ≥ 0.65), T3 funding-aware inventory skew, T4 basis-arb detector. First live paper run: ETH carry is clean and structural — +0.125 bps/hr stable every poll, cleared fees in ~56 min, running at ~11% annualised gross on a $50K leg. BNB passed the 60d OOS gate but live funding flipped regime immediately — the gate needs recency weighting.

**Take Sides / Regime Desk (#73–#88 — the standalone directional book):** A separate, institutional-grade "take-sides" desk that goes directional **only on OOS-validated symbols**, conviction-sized and directional-stopped, with a desk-risk spine (caps + kill-switch + flatten-on-exit), durable restart recovery, honest slippage/impact fills, a walk-forward backtest, an outright⇄beta-hedged exposure toggle, desk-risk aggregation + factor split + TCA, a stress harness, a 16-symbol universe with cross-sectional allocation, a `/demo` cockpit, a tear-sheet vs BTC, and a feed watchdog. It runs as a self-contained terminal cockpit (`scripts/regime-book-live.ts`); the web backend only *serves* its cockpit (§E) — the two are decoupled so a desk run never interferes with the UI backend. The pre-registered verdict is realised-first (realised + funding − fees − slippage > 0, maxDD inside 2%), measured on a multi-hour forward run.

**The carry desk (#89–#93 — the current flagship):** [`docs/PROFIT_PIVOT_II.md`](docs/PROFIT_PIVOT_II.md) reviewed the whole record and concluded the desk's hours should follow its *realised* winners — so the validated funding carry became the P0 book. Built in days: the `FundingCarryBook` (time-weighted accrual, per-leg margin, resume-not-flatten persistence), a 231-perp universe scan (13 deployable), the maker-execution service (≈0.8bps maker legs vs the old 7bps taker), the three-venue funding-differential board (measurement pre-registered: 7 daily boards before any leg trades), and the 30-day supervised forward run. Its first launch also produced the desk's best lesson: HL's `LIT` perp (Lighter) string-matched to Binance's `LITUSDT` (Litentry) — a naked cross-asset bet wearing a carry trade's clothes, caught in review, closed honestly, and turned into a ±5% cross-venue basis guard on every entry path. Read [`docs/TICKER_COLLISION_POSTMORTEM.md`](docs/TICKER_COLLISION_POSTMORTEM.md).

**Where we're going:** the 30-day carry track record *is* the demo — plus the allocator + beta-hedge (P1), the VRP satellite (P2), more perp CLOBs (dYdX, Drift, Bybit, OKX), and longer track records. The OOS / cost / queue-aware gates are the discipline that keeps the paper P&L honest.
