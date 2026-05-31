# Appendix A — Code-shape catalogue

A reference catalogue of the TypeScript shapes the rest of the course leans on. Each entry names the shape, says what problem it solves, gives the minimum interface and skeleton, points to the chapters that use it, and pins a Jest test shape. The shapes are deliberately small — small enough to type into a project from memory once the pattern is clear. This is the sister catalogue to [the stat-arb course's Appendix A](../../stat-arb/docs/appendix-a-code-shapes.md); the conventions are the same (bigint for money where it crosses a ledger, dependency-injected clocks, pure functions for signals) and the shapes compose with the stat-arb shapes wherever the two courses' infrastructure overlaps (notably the venue and risk layers in [§4](04-execution.md) and [§5](05-risk.md)).

A note on numeric types. Market-making code carries two kinds of numbers. *Ledger* numbers — fills, fees, realised P&L — are integer `bigint` units on the same convention as the stat-arb course (1 USDC = `1_000_000n` units; price = micros per asset). *Quote-time* numbers — bid/ask prices on a live book, micro-price, queue depth — appear in volume measured per second, get multiplied by floating-point intensities $\lambda$, and live inside pure functions where the math (Hamilton-Jacobi-Bellman quotes, VPIN volume buckets) doesn't admit an exact integer form. The boundary discipline is the same as stat-arb [Appendix A.5](../../stat-arb/docs/appendix-a-code-shapes.md): floats live inside named pure functions; results are converted back to bigint micros before they cross any boundary that touches a venue or a fill record. The shapes below mark with `// micros` where a price needs to be an exact integer and with `// number` where a float is acceptable.

## A.1 OrderBook & OrderBookLevel

**Purpose.** A snapshot of the visible limit order book — bid stack and ask stack, each a sorted list of price levels with aggregated size. Used by every downstream pattern that needs to read the book: the micro-price calculator (A.2), the quoter (A.4), the queue model (A.5), the LOB replay harness (A.10). The shape is deliberately read-only — mutating updates land via a `BookUpdater` that the chapters don't reproduce in the appendix. The two invariants the type enforces are: bids are sorted strictly descending by price, asks strictly ascending, and `best()` is O(1).

```typescript
// market-making/microstructure/order-book.ts
export interface OrderBookLevel {
  readonly priceMicros: bigint;   // venue-tick-rounded
  readonly sizeUnits: bigint;     // aggregated across all orders at this level
  readonly orderCount: number;    // number of distinct orders at this level
}

export interface OrderBook {
  readonly symbol: string;
  readonly ts: Date;
  readonly bids: readonly OrderBookLevel[];  // descending by price
  readonly asks: readonly OrderBookLevel[];  // ascending by price
}

export function bestBid(book: OrderBook): OrderBookLevel | undefined {
  return book.bids[0];
}

export function bestAsk(book: OrderBook): OrderBookLevel | undefined {
  return book.asks[0];
}

export function midMicros(book: OrderBook): bigint | undefined {
  const b = bestBid(book), a = bestAsk(book);
  if (!b || !a) return undefined;
  return (b.priceMicros + a.priceMicros) / 2n;
}

export function quotedSpreadMicros(book: OrderBook): bigint | undefined {
  const b = bestBid(book), a = bestAsk(book);
  if (!b || !a) return undefined;
  return a.priceMicros - b.priceMicros;
}
```

Where it appears in the chapters: [§2.2](02-microstructure.md) introduces the level structure, [§2.3](02-microstructure.md) draws the book diagram against this shape, [§4.4](04-execution.md) places quotes relative to `bestBid` / `bestAsk`, [§6.3](06-backtesting.md) replays L2 updates as a stream of `OrderBook` snapshots.

Test pattern:

```typescript
describe('OrderBook', () => {
  it('sorts bids descending and asks ascending', () => {
    const book = makeBook({
      bids: [{ priceMicros: 64_990_000_000n, sizeUnits: 2n * 1_000_000n, orderCount: 3 }],
      asks: [{ priceMicros: 65_010_000_000n, sizeUnits: 1n * 1_000_000n, orderCount: 1 }],
    });
    expect(bestBid(book)?.priceMicros).toBe(64_990_000_000n);
    expect(quotedSpreadMicros(book)).toBe(20_000_000n);
  });
});
```

The point of pinning the type as `readonly` everywhere is that a book *snapshot* must be immutable — a quoter that mutates the book it was passed corrupts the simulator's state in the next tick. This is the kind of bug that takes a day to find under shadow mode and ten minutes to find under TypeScript.

## A.2 MicroPriceCalculator

**Purpose.** The size-weighted micro price across $N$ levels. The textbook micro price is $p_\text{micro} = (a \cdot v_b + b \cdot v_a) / (v_a + v_b)$ where $a, b$ are the best ask and best bid prices and $v_a, v_b$ are the sizes resting at each — it overweights the side with *less* size, on the theory that the side with less size is closer to depleting and therefore the "true" price is closer to it. The $N$-level extension takes the same weighting across the top $N$ levels of each side. Used by the inventory-aware quoter (A.4) to anchor quotes to a price that already incorporates the book's shape, rather than to the raw mid.

```typescript
// market-making/microstructure/micro-price.ts
export interface MicroPriceConfig {
  readonly depth: number;  // number of levels per side to weight; typically 1-5
}

export class MicroPriceCalculator {
  constructor(private readonly cfg: MicroPriceConfig) {}

  compute(book: OrderBook): number | undefined {
    const bids = book.bids.slice(0, this.cfg.depth);
    const asks = book.asks.slice(0, this.cfg.depth);
    if (bids.length === 0 || asks.length === 0) return undefined;

    let bidNotional = 0, bidSize = 0, askNotional = 0, askSize = 0;
    for (const lvl of bids) {
      bidNotional += Number(lvl.priceMicros) * Number(lvl.sizeUnits);
      bidSize += Number(lvl.sizeUnits);
    }
    for (const lvl of asks) {
      askNotional += Number(lvl.priceMicros) * Number(lvl.sizeUnits);
      askSize += Number(lvl.sizeUnits);
    }
    const bidVwap = bidNotional / bidSize, askVwap = askNotional / askSize;
    return (askVwap * bidSize + bidVwap * askSize) / (bidSize + askSize);
  }
}
```

Where it appears: [§2.4](02-microstructure.md) defines the formula and the intuition; [§3.4](03-avellaneda-stoikov.md) substitutes micro price for mid in the Avellaneda-Stoikov reservation price as a practitioner refinement; [§6.5](06-backtesting.md) compares mid-anchored versus micro-anchored P&L attribution.

Test pattern (golden-vector style):

```typescript
describe('MicroPriceCalculator', () => {
  it('overweights the thinner side', () => {
    const book = makeBook({
      bids: [{ priceMicros: 100_000_000n, sizeUnits: 1n, orderCount: 1 }],     // thin bid
      asks: [{ priceMicros: 101_000_000n, sizeUnits: 100n, orderCount: 1 }],   // thick ask
    });
    const mp = new MicroPriceCalculator({ depth: 1 }).compute(book)!;
    expect(mp).toBeLessThan(100_500_000);  // pulled toward the bid because bid is thinner
  });
});
```

The float arithmetic here is fine because the result feeds back into a quoter that bigint-rounds before placing an order. No micro-price value ever lands in the fill ledger directly.

## A.3 QuoteRequest / QuotePair

**Purpose.** The structured output of every inventory-aware quoter in the course. A `QuotePair` is the canonical "one bid, one ask, both with size, both stamped with the inventory state that produced them" record. The stamping matters because [§5](05-risk.md) and [§7](07-production.md) both need to reconstruct *why* a quote was placed — which $q$, which $\sigma$, which $\gamma$ — when investigating a fill that turned bad. A bare bid/ask pair without inventory metadata is a debugging dead-end the moment something interesting happens.

```typescript
// market-making/quote/quote-pair.ts
export interface QuoteRequest {
  readonly side: 'bid' | 'ask';
  readonly priceMicros: bigint;     // venue-tick-rounded
  readonly sizeUnits: bigint;       // venue-lot-rounded
  readonly postOnly: boolean;       // true for maker; false only when crossing to flatten
  readonly timeInForce: 'GTC' | 'IOC' | 'POST_ONLY';
  readonly idempotencyKey: string;  // {strategyId}-{tickSeq}-{side}
}

export interface QuoteContext {
  readonly inventoryUnits: bigint;          // signed; positive = long
  readonly midMicros: bigint;
  readonly volatilityAnnualised: number;    // sigma, float
  readonly riskAversion: number;            // gamma, float
  readonly arrivalIntensity: number;        // lambda per side, float
  readonly horizonSeconds: number;          // T - t
  readonly schemaVersion: 1;
}

export interface QuotePair {
  readonly ts: Date;
  readonly symbol: string;
  readonly bid: QuoteRequest;
  readonly ask: QuoteRequest;
  readonly context: QuoteContext;  // pinned at the moment of computation
}
```

Where it appears: [§3.4](03-avellaneda-stoikov.md) — output type of `AvellanedaStoikovQuoter`; [§4.2](04-execution.md) — input to `QuoteScheduler`; [§5.2](05-risk.md) — `RiskGate.check` consumes a `QuotePair` plus state; [§7.4](07-production.md) — shadow-mode replay reconstructs decisions from logged `QuoteContext`.

Test pattern:

```typescript
describe('QuotePair invariants', () => {
  it('bid price is strictly less than ask price', () => {
    const pair = quoter.quote(makeCtx({ q: 0n }));
    expect(pair.bid.priceMicros).toBeLessThan(pair.ask.priceMicros);
    expect(pair.bid.postOnly).toBe(true);
    expect(pair.ask.postOnly).toBe(true);
  });
});
```

The `schemaVersion: 1` literal on `QuoteContext` is the small discipline that lets [§7](07-production.md)'s shadow-mode logger evolve the context schema without silently corrupting historical comparisons. If the schema version changes, the comparator refuses to compare across versions and asks for an explicit migration.

## A.4 AvellanedaStoikovQuoter

**Purpose.** The canonical inventory-aware quoter from **AS08**. Given an inventory state and a market context, returns a `QuotePair` whose bid and ask prices are skewed away from mid by the AS08 reservation price plus the AS08 half-spread:

$$
r(s, q, t) = s - q \gamma \sigma^2 (T - t), \qquad \delta^a + \delta^b = \gamma \sigma^2 (T - t) + \frac{2}{\gamma} \ln\!\left(1 + \frac{\gamma}{k}\right).
$$

The skeleton is deliberately tiny — the math is in [§3.3 and §3.4](03-avellaneda-stoikov.md). The shape is what every chapter from §3 onwards lifts.

```typescript
// market-making/quote/avellaneda-stoikov.ts
export interface AvellanedaStoikovParams {
  readonly gamma: number;             // risk aversion
  readonly k: number;                 // order-arrival decay (lambda = A * exp(-k * delta))
  readonly minHalfSpreadMicros: bigint;  // venue-tick floor
  readonly maxInventoryUnits: bigint;    // saturation point for the skew
}

export class AvellanedaStoikovQuoter {
  constructor(
    private readonly p: AvellanedaStoikovParams,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  quote(ctx: QuoteContext, symbol: string): QuotePair {
    const s = Number(ctx.midMicros);
    const q = Number(ctx.inventoryUnits);
    const sigma2 = ctx.volatilityAnnualised ** 2;
    const T = ctx.horizonSeconds / (365 * 24 * 3600);
    const skew = q * this.p.gamma * sigma2 * T;
    const halfSpread = Math.max(
      (this.p.gamma * sigma2 * T + (2 / this.p.gamma) * Math.log(1 + this.p.gamma / this.p.k)) / 2,
      Number(this.p.minHalfSpreadMicros),
    );
    const reservation = s - skew;
    const bidMicros = BigInt(Math.floor(reservation - halfSpread));
    const askMicros = BigInt(Math.ceil(reservation + halfSpread));
    return buildQuotePair({ symbol, bidMicros, askMicros, ctx, clock: this.clock });
  }
}
```

Where it appears: [§3.4](03-avellaneda-stoikov.md) — full derivation lives there; [§3.5](03-avellaneda-stoikov.md) — the GLFT13 infinite-horizon variant replaces the $T - t$ term; [§6.5](06-backtesting.md) — the LOB replay harness drives this class as the unit under test.

Test pattern:

```typescript
describe('AvellanedaStoikovQuoter', () => {
  it('skews quotes downward when long inventory', () => {
    const q = new AvellanedaStoikovQuoter({ gamma: 0.1, k: 1.5, minHalfSpreadMicros: 100n, maxInventoryUnits: 10n * 1_000_000n });
    const flat = q.quote(makeCtx({ inventoryUnits: 0n }), 'BTC-USDT');
    const long = q.quote(makeCtx({ inventoryUnits: 5n * 1_000_000n }), 'BTC-USDT');
    expect(long.bid.priceMicros).toBeLessThan(flat.bid.priceMicros);
    expect(long.ask.priceMicros).toBeLessThan(flat.ask.priceMicros);
  });
});
```

The clock injection (A.7 in stat-arb's catalogue, same discipline) is what lets the horizon $T - t$ tick down deterministically inside the unit test.

## A.5 QueueModel

**Purpose.** Simulated queue position for a posted order, plus a fill-probability estimate from that position. Used both at decision time (the quoter wants to know whether the bid it's about to place will get a useful queue slot) and at backtest time (the LOB replay harness needs to attribute fills to specific orders rather than to the aggregate level). The honest version of this shape is non-trivial — queue position decays as orders ahead get filled or cancelled — but the interface is the same. Anything that calls itself a market-making backtest and doesn't have a `QueueModel` somewhere is, almost certainly, lying about its fill rates.

```typescript
// market-making/microstructure/queue-model.ts
export interface QueuePosition {
  readonly priceMicros: bigint;
  readonly sizeUnits: bigint;
  readonly aheadUnits: bigint;   // total size ahead in queue when we joined
  readonly joinedAt: Date;
}

export interface QueueModel {
  // Called when we place a new order at a level.
  enqueue(level: OrderBookLevel, sizeUnits: bigint, now: Date): QueuePosition;

  // Called on every L2 update; returns the *new* ahead-size after consuming
  // trades that hit this level and cancellations on this level.
  decay(
    pos: QueuePosition,
    levelAfter: OrderBookLevel,
    aggressiveVolumeUnits: bigint,
    now: Date,
  ): QueuePosition;

  // Returns probability of being filled within `horizonSeconds`, conditional
  // on current queue position and a Poisson arrival model.
  fillProbability(pos: QueuePosition, lambdaPerSecond: number, horizonSeconds: number): number;
}
```

Where it appears: [§4.5](04-execution.md) — used as a cancel/hold decision input; [§6.4](06-backtesting.md) — the LOB replay harness instantiates one per resting order and decays them on every update; [§6.6](06-backtesting.md) — calibrates the `lambdaPerSecond` parameter from historical trade-vs-cancel ratios.

Test pattern:

```typescript
describe('QueueModel', () => {
  it('reduces aheadUnits when aggressive volume hits the level', () => {
    const model = new SimpleQueueModel();
    const lvl = { priceMicros: 100n, sizeUnits: 10n, orderCount: 5 };
    const pos = model.enqueue(lvl, 1n, NOW);
    const decayed = model.decay(pos, { ...lvl, sizeUnits: 6n }, /* aggressive */ 4n, NOW);
    expect(decayed.aheadUnits).toBeLessThan(pos.aheadUnits);
  });
});
```

The reason the interface exposes both `decay` and `fillProbability` separately is so that the backtest can step `decay` event-by-event while the live quoter calls `fillProbability` on a slower cadence to inform cancel decisions. The two use cases share the underlying state machine but want different sampling.

## A.6 IVenue

**Purpose.** The venue abstraction. Same role as `ITradingVenue` in [the stat-arb course](../../stat-arb/docs/appendix-a-code-shapes.md#a1-the-swap-seam-pattern-interface--mock-default--dormant-real); the market-making version exposes `amendOrder` because cancel-and-replace is too slow on a venue with reasonable amendment semantics, and an honest market-making backtest *must* model whether amendments preserve queue position (most venues: yes; some: no — see [§4.6](04-execution.md)).

```typescript
// market-making/execution/venue.interface.ts
export const VENUE = Symbol('VENUE');

export interface IVenue {
  readonly venueId: string;
  readonly tickSizeMicros: bigint;
  readonly lotSizeUnits: bigint;
  readonly amendPreservesQueue: boolean;

  placeOrder(req: QuoteRequest): Promise<OrderAck>;
  cancelOrder(externalRef: string): Promise<void>;
  amendOrder(externalRef: string, newPriceMicros: bigint, newSizeUnits: bigint): Promise<OrderAck>;

  // Streaming book and fill events; the implementation chooses websocket vs poll.
  subscribeBook(symbol: string, onUpdate: (book: OrderBook) => void): () => void;
  subscribeFills(onFill: (fill: Fill) => void): () => void;
}

export interface OrderAck {
  readonly externalRef: string;
  readonly accepted: boolean;
  readonly rejectReason?: string;
  readonly ackTs: Date;
}

export class VenueNotConfiguredError extends Error {
  constructor(venue: string) { super(`${venue} not configured — set credentials and arm LIVE_TRADING_ARMED`); this.name = 'VenueNotConfiguredError'; }
}
```

Where it appears: [§4.3](04-execution.md) — defines the interface; [§4.6](04-execution.md) — the `amendPreservesQueue` flag determines the cancel-vs-amend decision rule; [§6.2](06-backtesting.md) — the replay harness implements `IVenue` against an LOB tape; [§7.3](07-production.md) — shadow mode wraps the live venue and forwards every call to a parallel logger.

Test pattern:

```typescript
describe('SimulatedVenue', () => {
  it('rejects orders that violate tick size', async () => {
    const v = new SimulatedVenue({ tickSizeMicros: 100n });
    const ack = await v.placeOrder(makeReq({ priceMicros: 100_050n }));  // not on tick
    expect(ack.accepted).toBe(false);
    expect(ack.rejectReason).toMatch(/tick/i);
  });
});
```

The dormant-real discipline is the same as stat-arb's: ship the simulated implementation, leave the real adapter throwing `VenueNotConfiguredError` until credentials and an `EXECUTION_MODE=canary` arm are both in place.

## A.7 QuoteScheduler

**Purpose.** Turns a stream of desired `QuotePair`s into a sequence of venue commands. Manages the rate-limit budget (most venues cap message rate per second per IP and per account), decides between cancel-and-replace and amend, and de-duplicates redundant updates (placing the same bid twice in a row is a wasted message). The scheduler is what stands between the quoter's "ideal" intentions and the venue's "messages per second" reality. Without it, a naïve quoter will burn through its message budget on tiny re-pricings during a quiet minute and have nothing left when the market moves.

```typescript
// market-making/execution/quote-scheduler.ts
export interface RateLimitConfig {
  readonly maxMessagesPerSecond: number;
  readonly minRepostIntervalMs: number;     // floor between updates on the same side
  readonly tickEpsilonMicros: bigint;       // ignore re-pricings smaller than this
}

export class QuoteScheduler {
  constructor(
    private readonly venue: IVenue,
    private readonly cfg: RateLimitConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // Reconciles desired quotes with currently resting orders.
  async update(desired: QuotePair, resting: ReadonlyMap<string, RestingOrder>): Promise<SchedulerAction[]> {
    const actions: SchedulerAction[] = [];
    for (const side of ['bid', 'ask'] as const) {
      const want = desired[side];
      const have = resting.get(side);
      if (!have) { actions.push({ kind: 'place', req: want }); continue; }
      const priceDelta = want.priceMicros - have.priceMicros;
      if (abs(priceDelta) < this.cfg.tickEpsilonMicros && want.sizeUnits === have.sizeUnits) continue;
      if (this.venue.amendPreservesQueue) {
        actions.push({ kind: 'amend', externalRef: have.externalRef, newPriceMicros: want.priceMicros, newSizeUnits: want.sizeUnits });
      } else {
        actions.push({ kind: 'cancel', externalRef: have.externalRef });
        actions.push({ kind: 'place', req: want });
      }
    }
    return this.applyRateLimit(actions);
  }
}
```

Where it appears: [§4.4](04-execution.md) — full definition and the amend-vs-cancel decision tree; [§4.7](04-execution.md) — the rate-limit budget interacts with the §5 kill-switch; [§7.5](07-production.md) — shadow mode runs the scheduler with a no-op venue to log what *would* have been sent.

Test pattern:

```typescript
describe('QuoteScheduler', () => {
  it('amends rather than cancels when the venue preserves queue', async () => {
    const venue = makeVenue({ amendPreservesQueue: true });
    const sched = new QuoteScheduler(venue, defaultRateLimits());
    const actions = await sched.update(desiredPair, restingPair);
    expect(actions.filter((a) => a.kind === 'amend')).toHaveLength(2);
    expect(actions.filter((a) => a.kind === 'cancel')).toHaveLength(0);
  });
});
```

The `tickEpsilonMicros` filter is the single biggest message-budget saving in practice — most quote updates from a calmly-running Avellaneda-Stoikov quoter want to re-price by sub-tick amounts. Filtering them out at the scheduler is free and keeps the venue happy.

## A.8 RiskGate

**Purpose.** The pre-trade risk check. Same role as the `RiskLayer` pipeline in [stat-arb Appendix A.6](../../stat-arb/docs/appendix-a-code-shapes.md#a6-the-risk-layer-pipeline), specialised for market making's failure modes: inventory limits, adverse-selection circuit breakers, VPIN-based toxicity gates, message-rate exhaustion. Returns one of three verdicts — `Allow`, `Deny`, or `Pause` — and the `Pause` verdict is the market-making-specific one: it means "do not place new quotes for $N$ seconds, but do not cancel resting quotes either," which is the right response to a sharp VPIN spike where neither aggressive quoting nor a panicked flatten is helpful.

```typescript
// market-making/risk/risk-gate.ts
export type RiskVerdict =
  | { kind: 'Allow' }
  | { kind: 'Deny'; reason: string; component: RiskComponent }
  | { kind: 'Pause'; reason: string; component: RiskComponent; durationMs: number };

export type RiskComponent =
  | 'inventory-cap'
  | 'drawdown-gate'
  | 'vpin-toxicity'
  | 'adverse-selection-burst'
  | 'message-rate'
  | 'venue-cap'
  | 'kill-switch';

export interface RiskState {
  readonly inventoryUnits: bigint;
  readonly realisedPnlUnits: bigint;
  readonly vpin: number;            // 0..1
  readonly recentFillToxicity: number;  // rolling adverse-selection score
  readonly messagesUsedThisSecond: number;
}

export interface RiskGate {
  check(req: QuotePair, state: RiskState): RiskVerdict;
}
```

Where it appears: [§5.2](05-risk.md) — defines the three verdicts and the rationale for `Pause`; [§5.4](05-risk.md) — the adverse-selection burst component; [§5.5](05-risk.md) — VPIN gating; [§7.6](07-production.md) — the production run-book interprets each `RiskComponent` literal as a named alert.

Test pattern:

```typescript
describe('RiskGate', () => {
  it('returns Pause (not Deny) on a VPIN spike', () => {
    const gate = new CompositeRiskGate(defaultComponents());
    const verdict = gate.check(somePair, { ...zeroState, vpin: 0.92 });
    expect(verdict.kind).toBe('Pause');
    if (verdict.kind === 'Pause') expect(verdict.component).toBe('vpin-toxicity');
  });
});
```

The `RiskComponent` literal-union string is what lets the production stack route alerts: each component name maps to a Slack channel, a runbook page, and an on-call rotation. Without that mapping, all you get is "risk denied" — useful in a unit test, useless at 3am.

## A.9 VpinEstimator

**Purpose.** Running Volume-Synchronised Probability of Informed Trading (VPIN) per **ELO12**. VPIN buckets trade volume into fixed-size bins and computes the imbalance between buy-classified and sell-classified volume in each bucket; high VPIN signals toxic flow. The estimator is *intentionally simple* — exponential moving average of $|V_B - V_S| / (V_B + V_S)$ across the last $N$ buckets — because [Andersen-Bondarenko 2014](appendix-b-sources.md) has shown that more elaborate variants do not predict adverse-selection cost any better, and the simple version is easy to audit.

```typescript
// market-making/risk/vpin.ts
export interface VpinConfig {
  readonly bucketVolumeUnits: bigint;   // size of each volume bucket
  readonly emaWindowBuckets: number;    // typical: 50
}

export class VpinEstimator {
  private bucketBuyUnits = 0n;
  private bucketSellUnits = 0n;
  private emaVpin = 0;
  private buckets = 0;

  constructor(private readonly cfg: VpinConfig) {}

  // Called per trade with side classification (e.g. Lee-Ready tick rule).
  onTrade(sizeUnits: bigint, side: 'buy' | 'sell'): void {
    if (side === 'buy') this.bucketBuyUnits += sizeUnits;
    else this.bucketSellUnits += sizeUnits;
    while (this.bucketBuyUnits + this.bucketSellUnits >= this.cfg.bucketVolumeUnits) {
      const total = this.bucketBuyUnits + this.bucketSellUnits;
      const imbalance = Number(this.bucketBuyUnits > this.bucketSellUnits
        ? this.bucketBuyUnits - this.bucketSellUnits
        : this.bucketSellUnits - this.bucketBuyUnits) / Number(total);
      const alpha = 2 / (this.cfg.emaWindowBuckets + 1);
      this.emaVpin = this.buckets === 0 ? imbalance : alpha * imbalance + (1 - alpha) * this.emaVpin;
      this.buckets += 1;
      // Carry the overflow into the next bucket.
      this.bucketBuyUnits = 0n;
      this.bucketSellUnits = 0n;
    }
  }

  current(): number { return this.emaVpin; }
}
```

Where it appears: [§2.7](02-microstructure.md) — defines VPIN and the toxic-flow framing; [§5.5](05-risk.md) — feeds the `vpin-toxicity` component of `RiskGate`; [§6.7](06-backtesting.md) — the LOB replay harness drives this off the trade tape and validates that VPIN spikes align with subsequent adverse-fill clusters.

Test pattern (golden vector against a known-toxic burst):

```typescript
describe('VpinEstimator', () => {
  it('rises sharply on a one-sided burst', () => {
    const vpin = new VpinEstimator({ bucketVolumeUnits: 100n, emaWindowBuckets: 5 });
    for (let i = 0; i < 50; i++) { vpin.onTrade(10n, i % 2 === 0 ? 'buy' : 'sell'); }
    const baseline = vpin.current();
    for (let i = 0; i < 50; i++) { vpin.onTrade(10n, 'buy'); }  // one-sided burst
    expect(vpin.current()).toBeGreaterThan(baseline + 0.3);
  });
});
```

The estimator deliberately does not classify trades itself — the side argument is supplied by the caller. Trade classification (Lee-Ready, tick rule, BVC) is a separate concern with its own failure modes; see [§2.7](02-microstructure.md) for the comparison.

## A.10 LobReplayHarness

**Purpose.** The backtest harness. Reads a stream of L2 book updates and trade prints, maintains a simulated book, drives an `IVenue` implementation that hosts the quoter under test, attaches a `QueueModel` (A.5) to every order the quoter places, and attributes fills to specific orders (not levels) using the model's queue-decay logic. This is the shape that turns "we have a quoter" into "we have a quoter whose backtest reflects realistic fill rates." Anything simpler — fill-on-touch, or fill-if-trade-crosses-our-price — overstates fill rates by an order of magnitude in liquid books and a smaller but still significant amount in thinner ones.

```typescript
// market-making/backtest/lob-replay.ts
export interface LobReplayConfig {
  readonly symbol: string;
  readonly startTs: Date;
  readonly endTs: Date;
  readonly tape: AsyncIterable<L2Event | TradeEvent>;
  readonly quoter: { quote(ctx: QuoteContext, symbol: string): QuotePair };
  readonly queueModel: QueueModel;
  readonly riskGate: RiskGate;
}

export interface LobReplayResult {
  readonly fills: readonly Fill[];
  readonly attributions: readonly PnlComponent[];
  readonly verdictHistogram: Record<RiskComponent | 'Allow', number>;
  readonly summary: {
    readonly grossSpreadCapturedUnits: bigint;
    readonly adverseSelectionUnits: bigint;
    readonly inventoryCarryUnits: bigint;
    readonly feesUnits: bigint;
    readonly netPnlUnits: bigint;
  };
}

export class LobReplayHarness {
  async run(cfg: LobReplayConfig): Promise<LobReplayResult> {
    const book = new MutableBook(cfg.symbol);
    const venue = new SimulatedVenue(book, cfg.queueModel);
    // ... drive the quoter on every book-update event ...
    // ... mark fills against the queue model ...
    // ... attribute every closed round-trip to the four P&L components ...
  }
}
```

Where it appears: [§6.2](06-backtesting.md) — full definition; [§6.4](06-backtesting.md) — the queue-decay attribution logic; [§6.5](06-backtesting.md) — the four-component P&L attribution; [§6.8](06-backtesting.md) — the three canonical backtest pathologies the harness is designed to surface.

Test pattern (a golden tape with a known answer):

```typescript
describe('LobReplayHarness', () => {
  it('attributes a closed long round-trip into the four P&L buckets', async () => {
    const result = await new LobReplayHarness().run({ ...goldenCfg, tape: goldenRoundTrip() });
    expect(result.summary.grossSpreadCapturedUnits).toBe(20_000n);
    expect(result.summary.feesUnits).toBeLessThan(0n);
    expect(result.summary.netPnlUnits).toBe(
      result.summary.grossSpreadCapturedUnits
      - result.summary.adverseSelectionUnits
      - result.summary.inventoryCarryUnits
      - (-result.summary.feesUnits),
    );
  });
});
```

The golden-tape pattern is the same one stat-arb's golden-vector tests use for cointegration. The point is that any change to the harness that breaks attribution will break a fixed, easy-to-read test rather than silently changing reported P&L on a real run.

## A.11 PnlAttributor

**Purpose.** Splits realised P&L into the four components a market-making book actually has: **spread captured** (the gross revenue on round-trip fills); **adverse selection** (the loss between fill time and a configurable post-fill reference price, typically mid at $t + \tau$); **inventory carry** (mark-to-market on open inventory between fills); and **fees** (signed; rebates are positive). The attribution is the only honest way to know whether a quoter is good — net P&L alone hides the case where you're paying $X$ in adverse selection and earning $X + \epsilon$ in spread, which is a different business from earning $X + \epsilon$ on uninformed flow with zero adverse selection.

```typescript
// market-making/backtest/pnl-attribution.ts
export interface AttributionConfig {
  readonly markoutHorizonSeconds: number;   // typical: 60s, 300s, 600s
  readonly midPriceSource: (ts: Date) => bigint;
}

export interface PnlComponent {
  readonly fillId: string;
  readonly spreadCapturedUnits: bigint;
  readonly adverseSelectionUnits: bigint;     // loss vs reference; positive = loss to us
  readonly inventoryCarryUnits: bigint;       // signed; mark-to-market drift
  readonly feesUnits: bigint;                 // signed; rebate positive
}

export class PnlAttributor {
  constructor(private readonly cfg: AttributionConfig) {}

  attribute(fill: Fill, referenceMid: bigint, openInventoryBefore: bigint): PnlComponent {
    const fairValue = referenceMid;
    const spreadCaptured = fill.side === 'sell'
      ? (fill.priceMicros - fairValue) * fill.sizeUnits / 1_000_000n
      : (fairValue - fill.priceMicros) * fill.sizeUnits / 1_000_000n;
    const markoutMid = this.cfg.midPriceSource(addSeconds(fill.ts, this.cfg.markoutHorizonSeconds));
    const adverseSelection = fill.side === 'sell'
      ? (fairValue - markoutMid) * fill.sizeUnits / 1_000_000n
      : (markoutMid - fairValue) * fill.sizeUnits / 1_000_000n;
    const inventoryCarry = (markoutMid - referenceMid) * openInventoryBefore / 1_000_000n;
    return { fillId: fill.id, spreadCapturedUnits: spreadCaptured, adverseSelectionUnits: adverseSelection, inventoryCarryUnits: inventoryCarry, feesUnits: fill.feeUnits };
  }
}
```

Where it appears: [§6.5](06-backtesting.md) — defines the four-component attribution; [§6.6](06-backtesting.md) — markout-horizon selection (the $\tau$ choice is load-bearing — too short and adverse selection looks invisible; too long and you're confusing it with inventory carry); [§7.7](07-production.md) — the same attribution runs live on every fill so the operator dashboard can show which component is leaking.

Test pattern:

```typescript
describe('PnlAttributor', () => {
  it('detects adverse selection when post-fill mid runs against us', () => {
    const att = new PnlAttributor({ markoutHorizonSeconds: 60, midPriceSource: midAtFn });
    const comp = att.attribute(fillSellAt100, /* refMid */ 100n, /* invBefore */ 0n);
    expect(comp.spreadCapturedUnits).toBeGreaterThan(0n);
    expect(comp.adverseSelectionUnits).toBeGreaterThan(0n);  // mid moved up after our sell
  });
});
```

The markout-horizon as a config field is what lets a single attributor run with several horizons in parallel — a common technique is to attribute at 1-minute, 5-minute, and 10-minute horizons and report all three, because adverse selection at different horizons indicates different counterparty types ([§6.6](06-backtesting.md)).

## A.12 ShadowModeLogger

**Purpose.** Structured event logger for the paper / canary / live comparison in [§7](07-production.md). Every quoter decision — the input `QuoteContext`, the output `QuotePair`, the `RiskVerdict`, the venue ack — gets written to a JSONL log with a stable schema. Two streams (shadow and live) running on the same input can be reconciled offline to answer "does the new quoter behave identically to the old one on the same book?" Without this, shadow-mode promotion is a coin flip; with it, promotion is a one-line `jq` query.

```typescript
// market-making/production/shadow-mode-logger.ts
export interface ShadowLogEvent {
  readonly ts: string;                       // ISO-8601
  readonly schemaVersion: 1;
  readonly streamId: 'shadow' | 'live';
  readonly tickSeq: number;
  readonly symbol: string;
  readonly context: QuoteContext;
  readonly desiredQuote: QuotePair;
  readonly riskVerdict: RiskVerdict;
  readonly schedulerActions: readonly SchedulerAction[];
  readonly venueAcks: readonly OrderAck[];
}

export class ShadowModeLogger {
  constructor(private readonly sink: (line: string) => void) {}

  log(event: ShadowLogEvent): void {
    this.sink(JSON.stringify(event) + '\n');
  }
}

// Reconciler: load two streams, group by tickSeq, diff per-field.
export function reconcile(shadow: ShadowLogEvent[], live: ShadowLogEvent[]): ReconcileReport {
  // ...
}
```

Where it appears: [§7.4](07-production.md) — defines the schema; [§7.5](07-production.md) — the shadow-vs-live diff procedure; [§7.7](07-production.md) — the operator dashboard reads the same JSONL stream.

Test pattern:

```typescript
describe('ShadowModeLogger', () => {
  it('writes one JSON line per event with stable field order', () => {
    const lines: string[] = [];
    const logger = new ShadowModeLogger((s) => lines.push(s));
    logger.log(makeEvent({ tickSeq: 1 }));
    logger.log(makeEvent({ tickSeq: 2 }));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tickSeq).toBe(1);
  });
});
```

The `schemaVersion: 1` literal is the same discipline as `QuoteContext.schemaVersion`. When the schema needs to evolve, the reconciler refuses to compare events with mismatched versions, and the operator runs an explicit migration. The wrong behaviour — silently dropping unknown fields and reporting "streams identical" — is exactly the kind of thing that ships a regression under shadow mode without anyone noticing.

## Cross-pattern composition

The shapes above are not independent; they compose into one canonical market-making run:

1. **L2 events** stream from `IVenue.subscribeBook` (A.6) into an `OrderBook` (A.1).
2. The `MicroPriceCalculator` (A.2) reads the book and produces the float micro-price that the **`QuoteContext`** (A.3) carries alongside the bigint mid.
3. The `AvellanedaStoikovQuoter` (A.4) reads `QuoteContext` and emits a `QuotePair` (A.3).
4. The `RiskGate` (A.8) inspects the pair plus the current `RiskState`, which includes the `VpinEstimator`'s current value (A.9), and returns a verdict.
5. If allowed, the `QuoteScheduler` (A.7) reconciles the desired pair against resting orders, emits venue commands respecting the message-rate budget, and dispatches them to `IVenue` (A.6).
6. Fills come back via `IVenue.subscribeFills`, get attributed by `PnlAttributor` (A.11) into the four components, and every step of the loop is logged by `ShadowModeLogger` (A.12).

The same shape runs identically in backtest (`LobReplayHarness`, A.10, supplies the L2 events from a tape and hosts a `SimulatedVenue`) and in production (live exchange, real `IVenue` implementation). That equivalence is what makes "backtest reflects live" enforceable as an invariant rather than a hope.
