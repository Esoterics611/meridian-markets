# Strategy Library Rewrite — beyond stat-arb into FX, rates & derivatives (Greeks)

> **Status: SPEC (next deliverable for the Strategy Developer).** No strategy
> code is written by this doc. It is the binding brief the next
> `/strategy-developer` session executes. Method/doctrine unchanged:
> [QUANT_ROLE.md](./QUANT_ROLE.md), [desk/ROLE_strategy_developer.md](../desk/ROLE_strategy_developer.md),
> [[feedback-desk-risk-doctrine]]. Pairs with the live earner shipped in S23:
> [MARKET_MAKING.md](./MARKET_MAKING.md) (the `mm-paper-session` harness).

## 1. Context — why a rewrite, not a tweak

The stat-arb strategy family **stalled, and the stall is structural, not a tuning
miss.** z-score / Bollinger / OU-Bertram are **mean-reversion-on-a-cointegrated-
spread** tools. That edge is real on **equity baskets** (dozens of co-moving names,
a slow-moving fundamental tether, borrow you can actually get). On crypto and
FX-stable pairs the desk has proven, repeatedly and net of real cost, that:

- **Cointegration is a cliff, not a plateau** (Journal #5): a spread that's
  stationary in-sample loses it out-of-sample; β drifts and flips sign.
- **Fee drag dominates a thin per-trade edge** (the founding problem in
  [STRATEGY_PROFITABILITY_NEXT_STEPS.md](./STRATEGY_PROFITABILITY_NEXT_STEPS.md));
  the fee gate correctly steers most "spreads" *away* from taking.
- **The OOS gate kills the survivors anyway** (Journal #4): too few OOS trades +
  the deflated-Sharpe selection haircut. The gate earning its keep = no edge here.

The conclusion the desk has paid for: **the statistical-arbitrage hammer has run
out of nails in this universe.** The fix is not another z-score variant — it is a
strategy library whose *vocabulary* spans the instruments where edge actually
lives 24/7 for a small, fast desk: **FX, interest-rate / funding carry, and
options & swaps**, pricing risk through **Greeks** alongside the statistical layer.

## 2. The structural blocker in today's `IStrategy`

The current seam (`src/stat-arb/backtest/strategy.interface.ts`) is **hardwired to
a 2-leg cash spread** and cannot express the new families:

| Today | Limitation for the rewrite |
|---|---|
| `BarContext { a, b, historyA, historyB }` | Exactly **two** legs. No N-leg basket, no option chain, no curve. |
| `DesiredOrder { symbol, side, notionalUnits }` | No **instrument type** (spot vs perp vs option vs swap), no expiry/strike, no contract multiplier. |
| `ManagedStrategy { lastZ, currentBeta(), currentRegime() }` | State is **pairs-specific** (z-score, hedge ratio, LONG/SHORT/FLAT). An options book has no β; it has Greeks. |
| Risk = `correlation-cap / exposure-caps / drawdown-gate` | All **notional/correlation** gates. No **Greeks budget** (net Δ/Γ/ν/Θ limits). |
| Cost model = taker fee + half-spread + impact | No **carry/funding** leg, no **option premium / theta decay**, no **borrow** on a short. |

Everything below replaces these seams while **preserving the validation gate**
(`src/stat-arb/research/*`: walk-forward, deflated-Sharpe, purged-kfold) — the
gate is the desk's crown jewel and stays the arbiter of deploy/wait/kill.

## 3. The rewrite — new contracts

### 3.1 Instrument model (the missing vocabulary)
A typed instrument descriptor every leg references:

```
type InstrumentKind = 'SPOT' | 'PERP' | 'FUTURE' | 'OPTION' | 'SWAP';
interface Instrument {
  id: string;                 // venue-resolvable symbol
  kind: InstrumentKind;
  underlying: string;         // e.g. 'BTC', 'EURUSD'
  quote: string;              // 'USDT' | 'USD'
  expiryMs?: number;          // FUTURE/OPTION/SWAP
  strikeMicros?: bigint;      // OPTION
  optionType?: 'CALL' | 'PUT';
  contractMultiplier?: bigint;// units per contract
  // funding/borrow handles for PERP/SWAP/short legs
  fundingRateSource?: string; // wired by the Market Data Researcher
}
```

### 3.2 Generalised strategy seam (`MultiLegStrategy`)
Generalise `IStrategy.onBar` from a 2-leg context to an **N-leg, instrument-typed**
context, and `DesiredOrder` to carry the instrument + (for options) the leg's role.
Keep `onBar(ctx): DesiredOrder[]` shape so the **backtest runner and live loop
barely change**; the spread strategies become the 2-leg `SPOT` special case (§5).

```
interface MarketContext {
  asOfMs: number;
  legs: Map<string, LegView>;          // id → { bar, history, instrument }
  greeks?: GreeksProvider;             // §3.3, present for OPTION/SWAP books
  funding?: FundingProvider;           // §3.4 carry
}
interface MultiLegStrategy {
  onBar(ctx: MarketContext): DesiredOrder[];   // DesiredOrder gains instrumentId, contracts?
  riskView(): StrategyRiskView;        // generalises lastZ/β: { signal, exposures, greeks? }
  reset(): void;
}
```

### 3.3 Pricing / Greeks layer (the new core capability)
A first-class seam, same discipline as every other integration (CLAUDE.md §7 —
interface + mock + real, safe default on):

- **`IOptionPricer`** — `price(instrument, spot, iv, rate, asOfMs)` →
  `{ priceMicros, delta, gamma, vega, theta, rho }`.
  - `BlackScholesPricer` (crypto/FX options) and `BachelierPricer` (rates, where
    normal vol is the convention). Pure functions, unit-tested against textbook
    values — the same "test direction + known points" rigor the AS quoter uses.
  - `MockOptionPricer` (deterministic) is the default so the engine stays offline-
    testable; the real pricer activates when an IV source is wired.
- **IV / surface ingest** — `IVolSurfaceSource` (mock + real). Real source =
  Deribit public option chain (no key), wired by the **Market Data Researcher**
  through the existing `IReferenceBarSource` pattern (`src/market-data/reference/`).
- **`GreeksProvider`** aggregates a book's net Δ/Γ/ν/Θ/ρ from its open legs — the
  read the new risk gate and dashboard consume.

### 3.4 Carry / funding leg in the cost model
Extend the backtest + live cost accounting (today: taker fee + half-spread +
impact in `HistoricalReplayVenue`) with:
- **Funding** on PERP/SWAP legs (8h funding accrual, signed) — a `FundingProvider`
  over Binance funding history (no new venue).
- **Borrow** on a short cash/spot leg (the deferred P0.4) — a flat or sourced rate.
- **Premium & theta** on OPTION legs (handled by the pricer's Θ, marked per bar).

### 3.5 Greeks-budget risk gate
A new gate beside the notional gates (`src/stat-arb/risk/`), modelled on the MM
`CompositeRiskGate` (Allow / Deny / **Pause**): hard caps on **net delta**, **net
gamma**, **net vega**, and **theta burn rate**; deny opens that would breach the
budget, pause the book when realised vega P&L runs against it. This is the
options-era analogue of the inventory cap that makes the MM book conserve equity.

### 3.6 Validation gate — unchanged arbiter, extended P&L
`walk-forward` / `deflated-sharpe` / `purged-kfold` stay exactly as-is; only the
**P&L series they consume** gains the carry/premium/Greeks legs. A derivative
strategy ships only when **DSR ≥ 0.95 and ≥ 20 OOS trades** net of all the new
cost legs — same bar, wider instruments. No strategy ships on in-sample numbers.

## 4. Strategy menu — more ways to make money on this setup

Ranked by **(reuses an existing seam) × (data already on hand) × (edge
durability)**. Each leverages the setup we already have: the real Binance feed,
the MM books + portfolio trader, the `IReferenceBarSource` reference layer, and
the validation gate.

| # | Strategy | Edge source | Seam it reuses | New data needed | Status |
|---|---|---|---|---|---|
| 1 | **Stablecoin-peg MM** | maker spread + rebate − adverse on the peg | `MmBook` / `IQuoter` | none | **LIVE (S23)** — scale it |
| 2 | **Funding-rate carry** | long spot / short perp earns funding when it's positive (and the reverse) | live loop + new `FundingProvider` | Binance funding history (no key) | **✅ first build + real result** — `src/market-data/funding/` + `scripts/funding-carry-research.ts` (Journal #8): majors carry +3–4%/yr, fee-bound (~30d breakeven) |
| 3 | **Cross-source / triangular FX-stable basis** | EUR-stable vs USD-stable vs the FX benchmark mispricing | `IReferenceBarSource` (Pyth FX already wired) | none new | **✅ researched** — `scripts/fx-basis-research.ts` (Journal #11): real reversion (σ1.5bps, 7min half-life) but **sub-fee taker → route to the MM book** |
| 4 | **Delta-hedged short-vol / covered-call** | sell rich implied vol, hedge Δ on the live loop; harvest Θ | `IOptionPricer` + Greeks gate (§3) | Deribit chain + IV (Researcher) | spec |
| 5 | **Calendar / term basis & rate carry** | futures/perp term structure & swap-vs-spot basis | `Instrument` (FUTURE/SWAP) + funding | term curve | spec |
| 6 | **MM on the FX-via-stables book** | the EUR/USD microstructure spread, 24/7 | `MmBook` on `fx-via-stables` preset | none | ready to A/B now |

**Doctrine note:** every line earns its place only after the gate. #1 is live
because it cleared a real-money-shaped bar (S23: structural edge positive, equity
conserved, deploy-condition = a ≤0 bps maker venue). #2–#6 are candidates, not
promises — the next session validates them in rank order and kills what doesn't
survive, exactly as the stat-arb family was killed.

## 5. Phasing & migration (don't break the live loop)

1. **Keep the z-score / OU strategies** as the `SPOT`-2-leg special case behind the
   registry. They remain runnable; they just stop being the only shape.
2. **Land the seams first, behind mocks** (`Instrument`, `MultiLegStrategy`,
   `IOptionPricer` + `MockOptionPricer`, `FundingProvider`, Greeks gate) with the
   safe defaults on — zero behaviour change until a real source is wired.
3. **Build #2 (funding-rate carry) end-to-end first** — it needs *no new venue*
   (Binance funding is public), so it proves the generalised seam + carry cost
   model without waiting on the Researcher.
4. **Then #4 (options)** once the Market Data Researcher wires Deribit IV.
5. Each family runs through the **unchanged validation gate** before it deploys.

## 6. Data dependencies — for the Market Data Researcher

Flag these to [desk/ROLE_market_data_researcher.md](../desk/ROLE_market_data_researcher.md):
- **Funding rates** — Binance public funding history (perp). Unblocks #2.
- **Options chain + IV** — Deribit public (BTC/ETH), an `IReferenceBarSource`-shaped
  adapter. Unblocks #4 and the whole Greeks layer's real path.
- **Rates / term curve** — a benchmark curve source. Unblocks #5.

## 7. Definition of done (the next session's deliverable)

A `QUANT_JOURNAL.md` entry that:
1. Lands the generalised seams (§3.1–§3.5) with mock defaults + unit tests, **all
   existing tests still green** (the z-score family unchanged behind the registry).
2. Ships **funding-rate carry (#2)** end-to-end and runs it through the **real-
   history OOS gate** (`/api/market-data/walk-forward`, pass `trials`), with an
   explicit **deploy / wait / need-data** verdict at a stated size (≤ N\*).
3. Narrates every step **terminal + UI**, and states what data the Researcher must
   wire to unblock the options families.
