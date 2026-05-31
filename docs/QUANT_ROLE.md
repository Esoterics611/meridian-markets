# Quant Researcher — Meridian Markets (role + operating manual)

> This is the standing job description for the desk quant (human **or** an agent
> session). The daily job is simple to state and hard to do well: **find a
> tradeable relationship, prove it pays after fees, ship it as a strategy, watch
> it.** Then do it again. This doc is the full-stack manual for that loop; the
> running results live in [QUANT_JOURNAL.md](./QUANT_JOURNAL.md).

## 0. Mission

Turn market structure into **consistent, net-of-fee profit** on the stat-arb
desk. Not one hero trade — a *book* of small, weakly-correlated, positive-
expectancy strategies whose combined equity curve is smooth across days. You own
the full stack from signal → backtest → validation → live paper deploy → monitor.

The hard constraint that defines the job: **fees are ~20 bps round-trip**
(5 bps/leg × 4 taker fills). Most "signals" don't clear that bar. Your edge is
finding and sizing the few that do.

## 1. The daily loop (this is the workflow)

```
  SCAN ──▶ HYPOTHESIZE ──▶ BACKTEST ──▶ VALIDATE(OOS) ──▶ SHIP ──▶ MONITOR ──▶ JOURNAL
   ▲                                                                              │
   └──────────────────────────────────────────────────────────────────────────┘
```

| Step | What you do | Tool / command | Output |
|---|---|---|---|
| **Scan** | Sweep every asset class for pairs whose net-edge/day clears fees | `/demo` → Research → ⊹ Scan; or `GET /api/opportunities` | ranked board, by class |
| **Hypothesize** | Pick a pair/class + a strategy idea; write the thesis in the journal | — | a one-line thesis + expected edge |
| **Backtest** | Measure it on real history across strategies × entry-z × **bar interval** | `npx ts-node -r tsconfig-paths/register scripts/quant-research.ts` | value board (PnL, Sharpe, edge/trade) + JSON |
| **Validate** | Out-of-sample / walk-forward; sanity-check vs multiple-testing | `/api/stat-arb/research/*` (synthetic today — see §6) | does it survive OOS? |
| **Ship** | Add/tune a registry entry; deploy a paper station | edit `strategy-registry.ts`; `/demo` Research → ▶ trade, or `POST /portfolio/launch` | a live paper book |
| **Monitor** | Watch the book on the Desk; flatten/remove if it breaks | `/demo` Desk → Live books; `/api/stat-arb/live/portfolio` | realised P&L, drawdown, alerts |
| **Journal** | Record hypothesis, numbers, decision, next step | append to `QUANT_JOURNAL.md`; raw run JSON in `docs/research/` | continuity |

**A "strategy" here = a pure signal + a registry entry.** Shipping one is usually
a few lines in `strategy-registry.ts` (reuse a signal class with new tuning) or a
new signal class + entry. That's the unit of daily work.

## 2. The tech stack — where everything lives

```
SIGNAL        src/stat-arb/signal/         cointegration, spread, z, fee-gate (roundTripFeeFraction, stdev)
STRATEGIES    src/stat-arb/backtest/pairs-strategy.ts          PairsStrategy (rolling-z)
              src/stat-arb/strategies/bollinger-pairs-strategy.ts  EWMA z
              src/stat-arb/strategies/ou-spread-strategy.ts        OU / Bertram
              src/stat-arb/strategies/strategy-registry.ts         ← the catalogue you edit daily
CONTRACT      src/stat-arb/backtest/strategy.interface.ts      ManagedStrategy: onBar(ctx)→orders,
                                                               currentRegime(), currentBeta(), rollbackEntry(), lastZ
DISCOVERY     src/stat-arb/discovery/pair-discovery.ts         cointegration + half-life screen → PairCandidate
              src/stat-arb/discovery/net-edge-scorer.ts        net-edge-after-fees/day, fee gate
              src/stat-arb/discovery/opportunity-scanner.ts    sweep presets → ranked board
BACKTEST      src/stat-arb/backtest/backtest-runner.ts         event loop, no look-ahead
              src/stat-arb/historical-replay-venue.ts          fills at real bar close, 5 bps/leg
              src/stat-arb/backtest/pnl-attribution.ts         summarize() → Sharpe/maxDD/winRate
RESEARCH      scripts/quant-research.ts                        ← YOUR HARNESS: class×strategy×entry×interval + sizing
              scripts/quant-session.ts                         end-to-end (discover→backtest→live round-trips)
              src/stat-arb/research/{walk-forward,parameter-sweep,monte-carlo}.ts   robustness (synthetic feed today)
ASSET CLASSES src/stat-arb/markets/market-presets.ts           Binance presets (crypto, stables, FX-stables)
              src/market-data/reference/reference-presets.ts   reference-source presets (Pyth FX)
DATA          src/stat-arb/feed/binance-public-client.ts       real klines, no key
              src/market-data/reference/*                      Pyth FX OHLC / DefiLlama peg / Bit2C ILS
LIVE DEPLOY   src/execution/live-portfolio-trader.ts           N isolated paper books, per-source feed
              src/execution/live.controller.ts                 /api/stat-arb/live/portfolio/* control plane
SIZING        src/market-data/market-data.controller.ts        POST /api/market-data/sizing-study
UI            src/stat-arb/demo/public/index.html              /demo → Research (scan, deep-dive, sizing, robustness)
```

## 3. How to ship a NEW strategy (the common case)

Most new strategies are a **registry entry** reusing an existing signal class with
new tuning. To add one:

1. **Open** `src/stat-arb/strategies/strategy-registry.ts`.
2. **Copy** an existing `StrategyDefinition` (e.g. `PAIRS_ZSCORE_SELECTIVE`) and edit:
   - `id` (unique, kebab-case), `label`, `description` (state the **thesis**), `courseRef`.
   - `defaultRiskProfile`, `defaultParams` (the tuning that *is* the strategy).
   - `build({ beta, notionalUnits, params })` → return a configured signal class.
3. **Register** it in the `DEFINITIONS` array.
4. **Backtest** it: add its id to `QR_STRATS` and run the harness on the target classes.
5. **Gate**: it ships only if it clears the bar in §5 (net-of-fee positive, OOS-stable).
6. **Journal** the result (numbers + ship/kill decision).

The registry spec (`strategy-registry.spec.ts`) is **structural** — it asserts the
catalogue grows cleanly, never an exact list. New entries don't break it.

**A genuinely new signal** (not just tuning) is a new class implementing
`ManagedStrategy` (`onBar(ctx)` returns `DesiredOrder[]` with `reason` ∈
OPEN_LONG/OPEN_SHORT/CLOSE; `ctx.history*` is strictly historical — no
look-ahead). Add a `*.spec.ts` next to it, then a registry entry as above. Keep
the **fee gate** in the entry decision (see `signal/fee-gate.ts`) — the desk
discipline is fees-in-the-decision, not just in P&L.

## 4. How to modify an existing strategy

- **Re-tune** → prefer a *new* registry id (e.g. `-selective`) over mutating a
  shipped default, so live books and backtests stay reproducible.
- **Change behaviour** (e.g. add a time-stop, a stop-loss, a borrow cost) → edit
  the signal class, add/extend its spec, then expose it via params on the entry.
- Never silently change a default that a live book or another doc references by id.

## 5. The bar: when is a strategy "real"?

Ship only if **all** hold:
1. **Clears the fee gate with margin** — net edge/trade ≳ 1.5–2× the ~20 bps round-trip.
2. **Net-of-fee positive** over the test window, with **Sharpe > ~1** (per-trade).
3. **Breadth** — positive across *several pairs* in the class (not one lucky pair).
4. **OOS-stable** — survives a held-out window / walk-forward (not just in-sample).
5. **Impact-feasible** — the size that produces the $ is below the pair's
   impact-optimal N* (run the sizing study; thin legs cap you hard).

If it fails any, it's a hypothesis, not a strategy. Kill it in the journal with the reason.

## 6. The profitability levers (what actually moves net P&L)

Ranked by leverage, from the research (see journal):
1. **Bar interval** — slower bars (5–15m) grow σ-per-trade while the fee is fixed,
   so edge/trade clears the floor. *The single biggest free lever found so far.*
2. **Cost base** — taker fees dominate. **Maker/limit execution** (reuse the MM
   infra in `src/market-making/`) would cut ~20 bps → ~0 and flip many sub-fee
   pairs. *Biggest unbuilt lever.*
3. **Entry-z + fee gate** — wider band + stiffer `minEdgeMultiple` ⇒ fewer, fatter,
   fee-clearing trades. (Encoded in the `-selective` / `-wide` strategies.)
4. **Breadth + risk-parity sizing** — many cleared pairs, sized ∝ 1/σ_spread, give
   a *smooth* daily curve (diversification, not bigger bets). *Build an allocator.*
5. **Honest exits** — time-stop (close after N half-lives), divergence stop-loss
   (cointegration broke), short borrow/funding cost. (OU bleeds without these —
   see `ou-bertram-throttled`.)
6. **Signal validation** — deflated-Sharpe / purged k-fold against the
   multiple-testing of a wide scan (we test ~90 pairs/class). Don't trust the top row.

**Position size is NOT a lever for edge.** Under flat % fees, net edge in bps is
size-invariant (proved in the sizing study: 1×/10×/100× → bps & Sharpe flat, only
$ scales). Size is a *risk* lever (vol-target / Kelly) capped by *market impact*
(∝ N²). "Bigger size, smaller fee" is false here — fees are a % of notional.

## 7. Continuity protocol (so the next session continues, not restarts)

- **Read** `QUANT_JOURNAL.md` top-to-bottom; the latest entry has the current
  state + next actions. Raw numbers per run are in `docs/research/*.json`.
- **Re-run** the harness to refresh the board (markets move):
  `QR_INTERVAL=15m QR_NOTIONAL_USDC=25000 npx ts-node -r tsconfig-paths/register scripts/quant-research.ts`
- **Pick up** from the journal's "Standing backlog" (§ below) — it's the worklist.
- **Append, never overwrite** journal entries; each is dated with hypothesis →
  method → numbers → decision → next.

## 8. Standing backlog (the worklist — keep it stocked)

- [ ] **Maker-execution stat-arb** — post entries/exits passively (reuse MM quoting) to kill the fee floor. *Highest expected value.*
- [ ] **Risk-parity allocator** — take the scan's fee-clearing pairs, size ∝ 1/σ_spread, auto-launch a diversified book; rebalance daily.
- [ ] **Real-history robustness** — plumb `ReplayEngine` into `/api/stat-arb/research/*` so walk-forward/sweep/MC run on the scanned pair, not the synthetic feed; add deflated-Sharpe.
- [ ] **Time-stopped OU** — add `maxHoldBars` to `OuSpreadStrategy` (a real signal change) and a `ou-bertram-timed` entry.
- [ ] **Interval sweep in the scanner** — rank pairs at 5m/15m/1h, not just the live 1m.
- [ ] **Borrow/funding cost** in the P&L for short legs (currently ignored — optimistic).
- [ ] **Cross-sectional baskets + funding-carry** (course §8.2/§8.4) — catalogued `liveCapable:false`; wire the N-leg live path.

## 9. Definition of done for a session

A session ends with: (a) the journal updated with what you tested + decided,
(b) any shipped strategy committed on `master` with its spec green, (c) the
backlog re-stocked so the next session starts mid-stride.
