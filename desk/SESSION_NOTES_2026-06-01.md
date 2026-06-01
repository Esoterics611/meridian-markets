# Session Notes — 2026-06-01 (S22): real-history OOS gate + multiple-testing + desk roles

What shipped this session, and **how to demo every piece in both the UI and the
terminal**. The desk is a paper stat-arb engine on real Binance data; this session
closed the top of the P0 "trust the backtest" frontier (P0.1 already done): **P0.2
real-history walk-forward, P0.3 deflated Sharpe + purged k-fold, P0.5 regime
coverage**, plus desk-scale lots and two specialist desk roles.

## TL;DR of what's new

1. **Real-history OOS gate** — `POST /api/market-data/walk-forward`: runs a pair
   over real Binance history, **re-fits β per train slice**, judges it
   out-of-sample net of fee + half-spread + impact. Two schemes: sequential
   **walk-forward** and **purged k-fold** (`cv` param).
2. **Multiple-testing haircut (P0.3)** — pooled **PSR** + **Deflated Sharpe** over
   the # of pairs scanned (`trials`). PASS = DSR ≥ 0.95 and ≥ 20 OOS trades.
3. **Regime coverage (P0.5)** — days/bars/splits + warnings on thin history + a
   survivorship caveat.
4. **Desk-scale lots** — research/backtest defaults are now **$100k/leg** (no more
   single-dollar toy moves); the UI uses the top-strip **Lots/leg**.
5. **Verdict recorded (Journal #4):** the ai-data z-score deploy candidate was
   **KILLED** by the gate — too few OOS trades + the selection haircut.
6. **Desk roles + skills** — `/strategy-developer`, `/market-data-researcher`
   (see [README.md](./README.md)).

## Run the engine (for the UI + curl demos)

```bash
# from /home/nexus/code/meridian-markets
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev
# → http://localhost:3100/demo
```
(If you only want the headless research, the two scripts below need **no server
and no DB** — they hit Binance directly.)

## Demo 1 — the OOS gate (the headline)

**UI:** open `/demo` → **Research** tab.
1. Click **⊹ Scan all source data** → pairs grouped by asset class. (This sets the
   selection pool used for the deflated-Sharpe `trials`.)
2. Click a pair's **⚖** (or run a Backtest) — this sets the *active pair*.
3. Set **Lots / leg (USDC)** in the top strip (e.g. 100000).
4. In **"Validate before you trade — robustness tools"**, click
   **↻ Walk-forward (real OOS)** or **⊟ Purged k-fold (real OOS)**.
5. Read the stat row: **Verdict**, **Deflated Sharpe (×N trials)**, **PSR**,
   **OOS Sharpe (pooled)**, **Positive windows**, **Total OOS PnL**, **In-sample
   optimism**, **Coverage** (turns red if history is thin). The table shows
   per-window **β (train-fit)** so you can see β drift.

**Terminal:**
```bash
curl -s localhost:3100/api/market-data/walk-forward \
  -H 'content-type: application/json' \
  -d '{"symbolA":"AR","symbolB":"TAO","strategyId":"pairs-zscore",
       "lookbackHours":720,"trials":19,"notionalUnits":"100000000000"}' \
  | jq '{oos, multipleTesting, coverage}'
# purged k-fold instead of sequential windows:
curl -s localhost:3100/api/market-data/walk-forward -H 'content-type: application/json' \
  -d '{"symbolA":"AR","symbolB":"TAO","cv":"purged-kfold","folds":5,"trials":19}' | jq '.oos,.multipleTesting'
```
Reading it: **PASS** needs `multipleTesting.deflatedSharpe ≥ 0.95` **and**
`oosTrades ≥ 20`. `coverage.warnings` non-empty ⇒ not enough history to trust.

## Demo 2 — close-the-flag script (no server needed)

Runs the gate on a preset's discovered candidates against live Binance and prints
PSR / Deflated Sharpe / verdict per pair:
```bash
OOS_PRESET=ai-data OOS_DAYS=30 OOS_INTERVAL=15m \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```
This is what produced **Journal Entry #4** (ai-data candidate killed). Bump
`OOS_DAYS` (e.g. 180) once more history is backfilled to get enough OOS trades.

## Demo 3 — the sweep + sizing (context for the gate)

```bash
QR_INTERVAL=15m QR_BARS=1000 npx ts-node -r tsconfig-paths/register scripts/quant-research.ts
```
**UI:** Research → **⚖ Position sizing & fee economics** shows net edge is
size-invariant under flat fees, capped by the impact-optimal **N\***.

## Running it live for hours

The desk console keeps a **session equity curve** (localStorage, survives
refresh) and a **connection-health heartbeat** (an idle desk never shows
frozen-as-live) — both from S21. The OOS gate is **on-demand** (a button / curl),
so it doesn't affect a long-running paper session; run it whenever you want to
re-judge the active pair. Live paper books keep trading via the portfolio trader
the whole time.

## Where the code lives (for the next session)

- `src/stat-arb/research/deflated-sharpe.ts` — PSR / E[max] / Deflated Sharpe (+ spec).
- `src/stat-arb/research/purged-kfold.ts` — CV splitter w/ purge+embargo (+ spec).
- `src/stat-arb/research/cross-validate.ts` — purged k-fold runner (+ spec).
- `src/stat-arb/research/walk-forward.ts` — harness, now slice/train-aware + OOS trade pnls.
- `src/market-data/market-data.controller.ts` — `POST /walk-forward` (cv, trials, coverage).
- `src/stat-arb/demo/public/index.html` — Research tab buttons + verdict readout.
- `scripts/oos-candidates.ts` — close-the-flag run.
- Docs: [../QUANT_JOURNAL.md](../docs/QUANT_JOURNAL.md) (#3, #4), [../PRODUCTION_READINESS.md](../docs/PRODUCTION_READINESS.md) (P0.2/P0.3/P0.5).

## What's next (for whoever picks up)

- **Strategy Developer:** backfill 6–12 months and re-run the gate (the binding
  constraint on the ai-data verdict was OOS *trade count*); try baskets + maker
  fills. P0.4 (borrow/funding) still deferred.
- **Market Data Researcher:** wire a **GeckoTerminal** DEX-OHLC source to widen
  the universe (see [ROLE_market_data_researcher.md](./ROLE_market_data_researcher.md)).
