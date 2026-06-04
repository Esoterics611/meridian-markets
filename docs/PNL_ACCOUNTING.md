# P&L Accounting — Meridian Markets

> **What this is.** The authoritative reference for how every dollar of profit and loss on the desk is measured, attributed, and reconciled — written to serve two readers at once: an **engineer** who needs to know which function owns which number, and an **accounting/risk analyst** who needs the ledger logic, the sign conventions, and the invariants that make the books trustworthy. Honesty about the numbers is the desk's entire mandate (a paper-trading demo that reports inflated returns is worthless), so this document is deliberately exhaustive about *where a number could lie* and how the accounting prevents it.
>
> **Scope.** Covers the live/backtest **trading** P&L (market-making + stat-arb), not the dormant treasury ledger (that is a separate append-only Postgres system — see CLAUDE.md §3). Every claim here is traceable to a named source file.

---

## 1. Units & sign conventions (read first)

All money and quantity are **integers**, never floats, at the venue boundary. Floating point is used only for *rates* and *statistics* (volatility, Sharpe, funding fractions), never for a cash balance.

| Concept | Type | Unit | Example |
|---|---|---|---|
| Price | `bigint` | **micros** — 1.0 quote-unit = 1,000,000 | `$63,166.00` → `63166000000n` |
| Quantity / inventory | `bigint` | **6-dec asset units** — 1.0 asset = 1,000,000 | `0.785 BTC` → `785000n` |
| Cash P&L, fees, equity | `bigint` | **USDC-units** (6-dec) | `$1.50` → `1500000n` |
| Fee / funding *rate* | `number` | fraction or bps | `-0.2 bps`, `0.0000125` (1.25 bps/h) |

The one multiplication rule that keeps both legs exact:

```
value(qtyUnits, priceMicros) = qtyUnits · priceMicros / 1_000_000
```

**Signs are load-bearing and consistent everywhere:**

- **Inventory:** `+` = long, `−` = short.
- **Fees (`feeUnits`):** `+` = a **cost** you pay; `−` = a **rebate** you earn (revenue). A maker rebate is negative fees.
- **Funding:** `+` = the book **received** funding; `−` = the book **paid** it.
- **Adverse selection:** `+` = a **loss** to us (the informed-flow tax), by convention, so it reads as a cost in the attribution.

> Analyst note: because fees and funding are *signed into the same USDC-unit space* as realised P&L, the books never need a separate "rebate income" vs "fee expense" pair of accounts — one signed line carries both directions. This is the integer analogue of a contra-account.

---

## 2. The InventoryBook — the trade ledger

**Source:** `src/market-making/inventory/inventory-book.ts`. This is the shared accounting engine used **identically** by the bar backtest, the queue-aware backtest, and the live paper book — so a strategy's P&L cannot change merely because it moved from research to live.

### 2.1 The average-cost method

A market maker's position is *involuntary* — the flow chooses it — so the book marks every tick. It uses **volume-weighted average cost (WAC)**, the same convention as a perpetual-inventory accounting system:

- A fill that **extends** the position (same side, or from flat) rolls the average cost:
  `avgCost' = (avgCost·oldQty + fillPrice·addQty) / (oldQty + addQty)`.
- A fill that **reduces** the position realises P&L on the closed quantity against the open side's average cost:
  - Long closed by a SELL: `realised += (sellPrice − avgCost)·closedQty`
  - Short closed by a BUY: `realised += (avgCost − buyPrice)·closedQty`
- A fill that **crosses through zero** realises the entire old side, then opens a fresh position at the fill price (the remainder), resetting `avgCost` to the fill price.

The open side's average cost is **unchanged** by a partial reduction (you don't re-mark the survivors) — the standard WAC treatment. `avgCost` resets to 0 exactly when the book goes flat.

### 2.2 The five accumulators

The book maintains, and exposes via getters:

| Accumulator | Getter | Meaning |
|---|---|---|
| `inventory` | `inventoryUnits()` | signed open position |
| `avgCostMicros` | `avgCost()` | WAC of the open side (0 when flat) |
| `realised` | `realisedUnits()` | cumulative **realised** trading P&L, **excl. fees** |
| `fees` | `feesUnits()` | cumulative **signed** fees (+ cost / − rebate) |
| `fillCount` | `fills()` | number of applied fills |

### 2.3 Mark-to-market, total, equity

```
unrealised(mid)        = value(inventory, mid − avgCost)          // 0 when flat
totalPnl(mid)          = realised − fees + unrealised(mid)
equity(capital, mid)   = capital + totalPnl(mid)
```

> **Invariant (the reconciliation identity).** At any mid, `equity = capital + realised − fees + unrealised`. Realised is monotone only in the absence of losing closes; unrealised is the only term that moves without a fill. If a reported equity ever fails this identity, the bug is in the *caller* (e.g. a P&L line added outside the book), not the ledger — which is exactly why funding is accounted as an explicit external line (§5), never smuggled into `realised`.

---

## 3. The component attribution — why "net" alone lies

**Source:** `src/market-making/backtest/pnl-attribution.ts`. Net P&L hides the difference between *earning a spread on clean flow* and *earning the same spread while paying it back in adverse selection* — a different, worse business. Every fill is therefore decomposed into components a market maker actually has. The first four come from `attributeFill`; the fifth (funding) is accrued at the book level (§5).

For a fill of `size` at `price`, against the **fair mid at fill time** and the **mark-out mid** (fair mid + a horizon), holding signed `inventoryBefore`:

| Component | Definition | Reads as |
|---|---|---|
| **Spread captured** | SELL: `size·(price − fairMid)`; BUY: `size·(fairMid − price)` | gross revenue vs fair value — always ≥ 0 for a passive maker quoting around mid |
| **Adverse selection** | SELL: `size·(markoutMid − fairMid)`; BUY: `size·(fairMid − markoutMid)` | the informed-flow tax: how far the mid moved *against* the new position over the mark-out horizon (`+` = loss) |
| **Inventory carry** | `value(inventoryBefore, markoutMid − fairMid)` | mark-to-market drift on the position we were *already* holding |
| **Fees** | the fill's signed `feeUnits` | `+` cost / `−` rebate |

`sumComponents` folds these into an `AttributionSummary`. The honest read on whether a quoter has edge is **spread − adverse**, not net: a quoter can show positive net on a rebate while bleeding spread to adverse selection (see the DEX and HL findings in [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md)).

> Analyst note: spread and adverse selection are measured against the **same fair mid**, so they are directly comparable — adverse > spread means the flow you caught was toxic, regardless of what the net says.

---

## 4. Venue fees — each book at its own economics

**Source:** `src/market-making/backtest/venue-fees.ts` (`venueFeeFor(sourceId)`). Maker bps are **signed**, and each venue is judged at *its own* schedule, not a desk-wide assumption:

| Venue | Maker | Taker | Note |
|---|---:|---:|---|
| Hyperliquid | **−0.2 bps** (rebate) | 2.5 bps | the default MM venue |
| Binance spot | +1 bps | +5 bps | base tier |
| GeckoTerminal (AMM) | +5 bps* | +5 bps | *LP fee, pool-dependent 1/5/30/100 bps |
| unknown | 0 bps | 5 bps | structural-only default |

A passive (post-only) book only fills on the maker side, so **`makerBps` drives the fee charge**; `takerBps` is reserved for flatten/hedge legs and a worst-case read. The fee on a fill is `value(qty, price)·makerBps/10000`, applied with the maker sign, and flows into `InventoryBook.fees`.

---

## 5. Funding — the fifth P&L line (perps)

**Source:** funding rate from `src/market-data/funding/hyperliquid-funding-client.ts`; accrual in `src/market-making/backtest/lob-replay.ts` (`fundingRatePerHour`); standalone carry model in `src/market-data/funding/funding-carry.ts`.

A perpetual swap pays/charges **funding** on the position held, periodically (Hyperliquid: **hourly**; Binance: 8h). A market maker on a perp holds involuntary inventory, so funding is real P&L that the four trading components do **not** capture. It is accounted as an explicit external line so the reconciliation identity (§2.3) stays clean:

```
fundingPnl over [t0,t1] = − value(signedInventory, mark) · ratePerHour · ΔtHours
```

The sign convention (Hyperliquid): a **positive** rate means **longs pay shorts**. So a long position (`inventory > 0`) at a positive rate yields **negative** funding (a cost); a short receives. The harness accrues this each step on the inventory carried over the inter-snapshot interval, pro-rated by real elapsed time, with the rate held static over the run (the same assumption as `staticCarry`). It is folded into **both** the equity/drawdown mark and the net — but reported as its own `fundingUnits` metric so it is never confused with trading edge.

The standalone `staticCarry` model (used by `scripts/funding-carry-research.ts`) prices a **delta-neutral cash-and-carry** (long spot + short perp): `net = fundingCollected + basisPnl − fees`, annualised on a venue-specific `periodsPerYear` (HL 8760, Binance 1095). A `markRatio` guard accrues on entry notional when a source omits the per-settlement mark (HL `fundingHistory` does), so missing mark data never silently zeroes funding.

---

## 6. Structural vs. net vs. the fee sweep

The desk reports P&L at **three honesty layers**, because the right number depends on the question:

1. **Structural P&L** = `realised + unrealised` at **0 bps fee** = `spread captured − adverse selection` (+ inventory carry). This is **the trading edge** — does the quoting strategy make money before the venue's fee/rebate is even considered? It is fee-assumption-free, so it cannot be flattered by picking a generous venue.
2. **Net P&L** = structural − fees (+ funding) = what the book actually earns at a given maker schedule.
3. **The fee sweep** re-prices the structural edge at several maker assumptions — e.g. `−0.2 bps` (HL rebate), `0 bps` (structural), `+1 bps` (retail cost) — so a result that only survives on a rebate is visibly distinguished from one that survives a real cost. Funding, being orthogonal to the maker fee, is added to **every** layer of the sweep.

> This three-layer split is why the desk can say "structurally positive but needs a ≤0 bps maker venue" — a precise, honest claim that a single net number would hide.

---

## 7. How fills enter the books honestly (queue-aware vs fill-on-touch)

**Source:** `src/market-making/backtest/lob-replay.ts`. The *number of fills* is the noisiest, most-overstated input to an MM backtest. Two models:

- **Fill-on-touch** (the bar runner): you fill the instant a trade prints at your quote price, assuming you were alone at the front of the queue. This is an **upper bound** on fills.
- **Queue-aware** (`LobReplayHarness`): replays a real L2 depth tape, tracks FIFO **price-time priority** — the cumulative size resting at your price *and better* is ahead of you — and fills you only once aggressive flow consumes that queue. The aggressive flow itself is real per-trade taker volume (Hyperliquid trades WebSocket), not a candle estimate.

The harness reports `queueFills` vs `touchFills` as the **honesty number** — the fraction of touches the queue actually let through. Every P&L component above is computed on the queue-aware fills, so the books reflect fills the desk could actually have gotten. (Finding: at top-of-book a maker fills ≈ as often as touch claims — the loss there is adverse selection, not phantom fills — but a quote placed *into* the stack fills far less than touch assumes. See [RESEARCH_FINDINGS.md §6](RESEARCH_FINDINGS.md).)

---

## 8. Drawdown & the conservation verdict

The desk's mandate is **conserved equity, low drawdown** — so drawdown is a first-class accounted number, not a derived afterthought. The harness marks equity at every step (including funding) and tracks the running peak:

```
equity_t  = capital + totalPnl(mid_t) + funding_t
peak      = max(peak, equity_t)
drawdown% = max over t of (peak − equity_t) / peak · 100
```

The **conservation verdict** a session prints judges two things on the queue-aware, funding-inclusive curve: (a) max drawdown ≤ a limit (default 2%), and (b) structural-plus-funding net > 0. Both must pass. This is the accounting expression of "show steady, conserved returns."

---

## 9. Worked example (one round trip on Hyperliquid)

A $50,000 BTC quote on HL (maker −0.2 bps), BTC mid = $63,166 (`63166000000n`), quote size ≈ `0.7916 BTC` (`791600n`):

1. **Bid fills** at $63,156 (we bought below fair mid $63,166). `value = 791600·63156000000/1e6 = 50,000,289,696n` ≈ $50,000.29 notional.
   - Spread captured (BUY): `value(791600, 63166000000 − 63156000000) = value(791600, 10000000) = 7,916,000n` = **+$7.92**.
   - Fee: `50,000,289,696·(−0.2)/10000 = −1,000,006n` = **−$1.00** (rebate, revenue).
   - Inventory → `+791600`, avgCost → `63156000000`.
2. **One hour passes** holding the long; funding rate `+0.0000125` (1.25 bps/h, longs pay):
   - `funding = −value(791600, 63166000000)·0.0000125·1 = −50,000,289,696n · 0.0000125 = −625,004n` = **−$0.63** (we paid).
3. **Ask fills** at $63,176 (we sold above the new mid, closing the long):
   - Realised (long closed by SELL): `value(791600, 63176000000 − 63156000000) = value(791600, 20000000) = 15,832,000n` = **+$15.83**.
   - Fee: another **−$1.00** rebate. Inventory → flat, avgCost → 0.

**Books after the round trip:** realised **+$15.83**, fees **−$2.00** (rebate ⇒ adds), funding **−$0.63**, unrealised $0 (flat). **Net = 15.83 + 2.00 − 0.63 = +$17.20.** The attribution shows the trade earned spread + capture, the rebate added, and an hour of carry cost $0.63 — each line auditable, none hidden in the net.

---

## 10. Invariants & controls (the audit checklist)

A reviewer (or a test) can assert all of these:

- **Reconciliation:** `equity == capital + realised − fees + unrealised + funding` at every mark.
- **Flat ⇒ no unrealised:** `inventory == 0` ⇒ `unrealised == 0` and `avgCost == 0`.
- **Fee sign:** a rebate venue never produces positive `fees` on a passive fill; a cost venue never produces negative.
- **Funding default-off:** with no `fundingRatePerHour`, `fundingUnits == 0` and net equals the pure trading result (back-compat; pins 11 prior harness specs).
- **Funding sign:** long + positive rate ⇒ `fundingUnits < 0`; the sign flips with the rate sign and with the inventory sign.
- **Queue ≤ touch:** `queueFills ≤ touchFills` always; equality only when every quote sat at the front of its queue.
- **Structural is fee-free:** the 0 bps layer of the sweep equals `realised + unrealised` exactly.

These invariants are the desk's internal controls. They are enforced by the unit suites (`inventory-book.spec.ts`, `pnl-attribution.spec.ts`, `funding-carry.spec.ts`, `lob-replay.spec.ts`, `gamma-kappa-sweep.spec.ts`) and are the reason a P&L number on this desk can be trusted to the unit.

---

## 11. File map (where each number lives)

| Number | Owner |
|---|---|
| Realised / unrealised / fees / equity | `src/market-making/inventory/inventory-book.ts` |
| 4-component attribution | `src/market-making/backtest/pnl-attribution.ts` |
| Venue maker/taker fees | `src/market-making/backtest/venue-fees.ts` |
| Funding accrual (5th line) | `src/market-making/backtest/lob-replay.ts` |
| Funding rate source (HL) | `src/market-data/funding/hyperliquid-funding-client.ts` |
| Delta-neutral carry model | `src/market-data/funding/funding-carry.ts` |
| Queue-aware fills + drawdown + sweep | `src/market-making/backtest/lob-replay.ts`, `gamma-kappa-sweep.ts` |

See also: the [Market-Making course §8 "The Meridian desk stack"](../courses/market-making/docs/08-the-meridian-desk-stack.md) for the operational procedures these accounts sit under, and [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md) for what the numbers have actually said.
