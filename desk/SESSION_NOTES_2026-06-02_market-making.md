# Session Notes — 2026-06-02 (S23): the pivot — market-making is the live earner

What shipped this session and **how to test every piece in both the terminal and
the UI**. The pivot (Ronnie/Yoda): stat-arb stalled *structurally* (cointegration
cliff + fee drag; the OOS gate kills every survivor — Journal #4/#5), so the desk
**invests in market-making as the live earner** and writes the brief for a total
strategy-library rewrite beyond stat-arb. Commit `a12df61` (S23). Pairs with the
parallel equities track (S24, Alpaca) — different asset class, same engine.

## TL;DR of what's new
1. **`scripts/mm-paper-session.ts`** — DB-free, HTTP-free long-horizon MM session
   over **real Binance** data, driving the live `MmBook` + registry unchanged at
   **desk scale** ($50k/quote, $1M/book, 8-lot cap). Two modes: **replay** real
   history now / **live**-poll for hours. Honest **fee sweep**: net at −1 bps (VIP
   rebate), **0 bps (structural = spread − adverse)**, +1 bps (retail cost);
   conservation judged on the **structural** equity curve, never the rebate.
2. **[../docs/STRATEGY_LIBRARY_REWRITE.md](../docs/STRATEGY_LIBRARY_REWRITE.md)** —
   the Strategy Developer's binding next deliverable: generalise `IStrategy`
   (2-leg → N-leg, instrument-typed), add an `IOptionPricer`/**Greeks** layer
   (BS + Bachelier, Deribit IV) + a Greeks-budget gate + carry/funding in the cost
   model, behind the **unchanged** validation gate. Ranked strategy menu; **build
   funding-rate carry first** (no new venue). Hat updated:
   [ROLE_strategy_developer.md](./ROLE_strategy_developer.md).

## Headline result — 24h replay (GLFT, FDUSD/USDC/TUSD, $50k/quote, $400k max inv/book, $3M desk)
| Fee assumption | Desk net / 24h | % of $3M |
|---|---|---|
| **0 bps — structural (real edge)** | **+$1,361** | +0.045% |
| −1 bps — VIP maker rebate | +$4,844 | +0.161% |
| +1 bps — retail maker cost | **−$2,121** | −0.071% |

- **Stable:** structural net rose **monotonically across all 12 two-hour buckets**.
- **Large lots, equity conserved:** desk **max drawdown 0.0011%** at $400k max inventory.
- **The honest catch (deploy condition):** the structural edge (spread − adverse)
  is real but thin; the clear profit is the **maker rebate**. **At a +1 bps retail
  maker cost the book loses.** So **deploy only on a ≤0 bps maker venue** + add
  queue-aware fills (today's fills are fill-on-touch = an upper bound).

## Manual test — Terminal
```bash
# 1. tests + typecheck
npx tsc --noEmit
npx jest src/market-making        # MM suite
npx jest                          # full 785

# 2. the headline — MM over hours, REPLAY (deterministic, runs anywhere w/ network)
npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts          # default 24h
MM_SESSION_HOURS=3 MM_SESSION_REPORT_EVERY=30 \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts        # faster pass

# 3. prove the honest downside — drive the book at a retail maker COST and watch it go red
MM_SESSION_MAKER_BPS=1 MM_SESSION_HOURS=3 \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts

# 4. LIVE for hours (run on your own machine; the sandbox can't keep a server up)
MM_SESSION_MODE=live MM_SESSION_HOURS=8 \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
MM_SESSION_MODE=live MM_SESSION_HOURS=0.02 MM_SESSION_POLL_MS=3000 MM_SESSION_SYMBOLS=FDUSD \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts        # ~72s "does it tick"

# 5. cross-check vs the pre-existing smoke (same MmBook engine)
npx ts-node -r tsconfig-paths/register scripts/smoke-mm-stablecoin.ts
```
**Look for:** per-bucket `structural` ≥ 0 and **rising**; `maxDD` ≈ 0.00x%; the
3-column fee sweep; `CONSERVATION → PASS / PASS`; `12/12` buckets stable. Knobs:
`MM_SESSION_{MODE,SYMBOLS,STRATEGY,QUOTE_UNITS,CAPITAL_UNITS,MAX_LOTS,HOURS,MAKER_BPS,POLL_MS}`.

## Manual test — UI (`/demo`)
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev
# → http://localhost:3100/demo
```
**Market Making tab:**
1. Top strip **"Lots / leg (USDC)"** is the single sizing master — set it (e.g.
   `50000`); the panel **Capital** field follows it.
2. **◆ Market making** panel: **Preset** = *Stablecoin Peg* · **Instrument** =
   *FDUSD* · **Quoter** = *GLFT* (or *Avellaneda-Stoikov*).
3. Click **◆ Launch maker book** → appears under **Maker books** with live
   mid/bid/ask/inventory/equity + 4-part P&L. Click **▶ Start** for the poll loop.
4. Watch: inventory hovers near flat, equity drifts up on the rebate, DD stays
   tiny. **⏸ Stop** pauses · **⚑ Flatten all** zeroes inventory · **launch whole
   preset** runs one book per stablecoin.

**Research tab cross-check:** click **① ⊹ Scan all source data** → the
**"Market-making targets — by asset class"** table ranks instruments by
net/round-trip · fills/day · score/day with a **quote?** action → launches that book.

**Control plane (curl == the UI calls):**
```bash
curl localhost:3100/api/market-making/strategies
curl -XPOST localhost:3100/api/market-making/launch -H 'content-type: application/json' \
  -d '{"symbol":"FDUSD","strategyId":"mm-glft","capitalUsdc":1000000}'
curl localhost:3100/api/market-making/snapshot
curl -XPOST localhost:3100/api/market-making/flatten
```

## Read every number through these
- Fills are **fill-on-touch** (front-of-queue, no queue penalty) — an **upper
  bound**, not a promise (`src/market-making/backtest/fill-model.ts`).
- The **−1 bps rebate is a Binance VIP maker tier**; a retail maker pays the +1 bps
  cost column. Conservation is judged on the **structural (0 bps)** curve.
- The harness ≠ the UI, but **both drive the same `MmBook`** — the harness is the
  long-horizon/replay proof; the UI is the single-process live view. They agree.

## Where the code/docs live (for the next session)
- `scripts/mm-paper-session.ts` — the harness (this session's deliverable).
- `src/market-making/live/mm-book.ts` — the `MmBook` both the harness and the
  control plane drive; `src/market-making/mm.controller.ts` — `/api/market-making/*`.
- `src/stat-arb/demo/public/index.html` — the **Market Making** tab.
- Docs: [../docs/STRATEGY_LIBRARY_REWRITE.md](../docs/STRATEGY_LIBRARY_REWRITE.md),
  [../docs/MARKET_MAKING.md](../docs/MARKET_MAKING.md) §1.5,
  [../docs/QUANT_JOURNAL.md](../docs/QUANT_JOURNAL.md) #6.

## What's next (for whoever picks up)
- **Strategy Developer:** execute the rewrite — generalise the seams behind mocks,
  then ship **funding-rate carry** end-to-end and run it through the real-history
  OOS gate before any deploy.
- **Market Data Researcher:** wire **Binance funding history** (unblocks carry) and
  **Deribit IV** (unblocks the Greeks/options families).
- **Go-live on MM:** secure a **≤0 bps maker venue** + queue-aware fills (L2 tape →
  `SimpleQueueModel`/`LobReplayHarness`) before treating the rebate edge as real money.
