# Appendix A — Code-shape catalogue

A reference catalogue of the code patterns the course relies on, in TypeScript, matching the conventions in [`src/yield/`](../../../src/yield/) and [`src/hedge/`](../../../src/hedge/). Each pattern lists its TypeScript signature, a five-line Jest test pattern, and a pointer to the existing repo file that demonstrates the same shape in a different domain.

## A.1 The swap-seam pattern (interface + mock-default + dormant real)

**Purpose.** Every external dependency in this codebase has the same shape: an interface, a deterministic mock that is the default, and a dormant real implementation that throws `NotConfiguredError` until a flag is flipped and credentials are populated. The pattern enables tests that don't touch the network, deployments that can't accidentally hit production venues, and a single-line factory swap when KYB closes.

```typescript
// stat-arb/execution/trading-venue.interface.ts
export const TRADING_VENUE = Symbol('TRADING_VENUE');

export interface ITradingVenue {
  readonly venueId: string;
  place(req: PlaceOrderRequest): Promise<OrderResult>;
  cancel(externalRef: string): Promise<void>;
  fetchPosition(symbol: string): Promise<{ sizeUnits: bigint; avgPriceMicros: bigint }>;
  fetchBalance(): Promise<{ availableUnits: bigint }>;
}

export class TradingVenueNotConfiguredError extends Error {
  constructor(venue: string) {
    super(`${venue} is not configured — populate KYB-gated secrets and set MOCK_TRADING_ENABLED=false`);
    this.name = 'TradingVenueNotConfiguredError';
  }
}
```

Test pattern:

```typescript
describe('RealBinanceTradingVenue', () => {
  it('throws NotConfigured on every method until KYB closes', async () => {
    const venue = new RealBinanceTradingVenue();
    await expect(venue.place({} as any)).rejects.toBeInstanceOf(TradingVenueNotConfiguredError);
    await expect(venue.cancel('ref')).rejects.toBeInstanceOf(TradingVenueNotConfiguredError);
  });
});
```

Existing repo demonstrations: [`src/yield/yield-provider.interface.ts`](../../../src/yield/yield-provider.interface.ts), [`src/yield/real-ondo-yield-provider.ts`](../../../src/yield/real-ondo-yield-provider.ts), [`src/hedge/hedge-venue.interface.ts`](../../../src/hedge/hedge-venue.interface.ts), [`src/hedge/real-hyperliquid-hedge-venue.ts`](../../../src/hedge/real-hyperliquid-hedge-venue.ts). The exact same shape, four times, in four different domains — that consistency is the point.

## A.2 Pure signal functions

**Purpose.** Statistical computations (cointegration test, OU fit, half-life, z-score) are pure functions of `readonly number[]` arrays. No `Date`, no `process.env`, no DI, no I/O. This is what makes them testable with golden vectors — you can pin an input and an expected output, and any regression breaks loudly.

```typescript
// stat-arb/signal/cointegration.ts
export interface CointegrationResult {
  beta: number;          // hedge ratio
  alpha: number;         // intercept
  adfStatistic: number;
  pValue: number;
  halfLifeBars: number;
}

export function engleGranger(
  logA: readonly number[],
  logB: readonly number[],
): CointegrationResult {
  if (logA.length !== logB.length) throw new RangeError('series length mismatch');
  if (logA.length < 30) throw new RangeError('series too short for cointegration test');
  // 1. OLS regress logA on logB → β, α
  // 2. ADF test on residuals → statistic, p-value
  // 3. Fit AR(1) to residuals → half-life
  // ...
}
```

Test pattern with a golden vector (a series that has been verified against `statsmodels`):

```typescript
describe('engleGranger', () => {
  it('matches statsmodels output on the canonical Pepsi/Coke vector', () => {
    const result = engleGranger(GOLDEN.logPepsi, GOLDEN.logCoke);
    expect(result.beta).toBeCloseTo(0.738, 3);
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.halfLifeBars).toBeCloseTo(14.2, 1);
  });
});
```

Existing repo demonstrations: the deterministic-yield math in [`src/yield/mock-yield-provider.ts`](../../../src/yield/mock-yield-provider.ts) (specifically the time-weighted accrual) — same posture: pure-function math with no I/O, tested with deterministic inputs. The cointegration / OU functions will live in `src/stat-arb/signal/` when Phase 3 implementation begins.

## A.3 IStrategy — the canonical strategy interface

**Purpose.** A strategy is a side-effect-free transformation `(BarEvent, StrategyContext) → Order[]`. Every strategy in the codebase implements the same interface; the backtest runner and the live runner both invoke it identically. The decoupling is what makes "live runs the same code as backtest" enforceable.

```typescript
// stat-arb/strategy/strategy.interface.ts
export interface BarEvent {
  readonly ts: Date;
  readonly symbol: string;
  readonly open: bigint;    // micros
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
}

export interface StrategyContext {
  readonly history: ReadonlyHistoryView;   // last N bars per symbol, immutable
  readonly portfolio: ReadonlyPortfolioView;
  readonly bars: number;                   // count of bars seen so far
}

export interface Order {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly sizeUnits: bigint;
  readonly type: 'market' | 'limit' | 'post-only';
  readonly limitPriceMicros?: bigint;
  readonly idempotencyKey: string;
  readonly strategyId: string;
}

export interface IStrategy {
  readonly strategyId: string;
  onBar(bar: BarEvent, ctx: StrategyContext): Order[];
}
```

Test pattern (strategy tests use synthetic bars, never real market data):

```typescript
describe('PairsTradingStrategy', () => {
  it('emits a short-spread order when z crosses +2', () => {
    const strategy = new PairsTradingStrategy({ beta: 0.7, kEnter: 2, kExit: 0.5, windowBars: 60 });
    const ctx = makeSyntheticContext({ spreadZ: 2.1 });
    const orders = strategy.onBar(LATEST_BAR, ctx);
    expect(orders).toHaveLength(2);  // one leg each side
    expect(orders[0].side).toBe('sell');
  });
});
```

Variant: streaming strategies that buffer multiple bars before emitting. Same interface — they just return `[]` until the buffer is full. The buffer lives in private fields on the strategy instance; the public interface stays the same.

## A.4 Append-only ledger (recap from `treasury_movements`)

**Purpose.** Financial state changes are recorded as immutable, monotonically-ordered facts. UPDATEs and DELETEs are forbidden at the DB-grant layer; the only way to "correct" a row is to write a compensating row. This is what makes the audit trail reconstructable from the DB alone, without trust in application code.

The pattern repeats for `prop_movements` when the stat-arb code lands:

```sql
CREATE TABLE prop_movements (
  id BIGSERIAL PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  size_units BIGINT NOT NULL CHECK (size_units > 0),
  fill_price_micros BIGINT NOT NULL CHECK (fill_price_micros > 0),
  fee_units BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX prop_movements_venue_idem
  ON prop_movements (venue, idempotency_key);

-- Privileges: app role gets SELECT, INSERT only.
GRANT SELECT, INSERT ON prop_movements TO meridian_markets_app;
-- No GRANT UPDATE, no GRANT DELETE.
```

Test pattern (DB-gated like the treasury integration tests):

```typescript
describeIfDb('prop_movements append-only', () => {
  it('refuses UPDATE under the meridian_markets_app role', async () => {
    await expect(
      db.query('UPDATE prop_movements SET size_units = 1 WHERE id = $1', [rowId]),
    ).rejects.toMatchObject({ code: '42501' });  // PG insufficient_privilege
  });
});
```

Existing repo demonstrations: [`migrations/1715000000000-Initial.ts`](../../../migrations/1715000000000-Initial.ts) creates `treasury_movements` with this exact privilege posture; [`src/database/append-only.int-spec.ts`](../../../src/database/append-only.int-spec.ts) is the regression oracle that asserts the grants. The `prop_movements` migration extends the oracle to its own table.

## A.5 Bigint price arithmetic

**Purpose.** All money math in this codebase is integer arithmetic on bigints with explicit scaling. Floats are forbidden at storage and movement boundaries; they're allowed only inside pure signal functions where the math (regressions, eigendecompositions) doesn't admit an integer representation. Conversion is explicit and one-way: floats into the signal layer, results converted back to bigint integers before they cross any boundary.

Conventions:

- **Amounts** in 6-decimal USDC units: `1 USDC = 1_000_000n` units. Matches `treasury_movements.amount_units` (USDC micros).
- **Prices** in micros (1e6) of the quote unit: `1 USDC per asset = 1_000_000n` micros. Same scale, kept in a `bigint` to avoid mixing floating-point error into the ledger.
- **All arithmetic is exact** within the bigint domain: addition / subtraction / multiplication followed by division-with-rounding at the end. Never compute a price-times-size product as a `Number`.

```typescript
// Example: realised P&L on a closed short, in bigint
function realisedPnlUnits(
  notionalUnits: bigint,
  entryPriceMicros: bigint,
  exitPriceMicros: bigint,
): bigint {
  // P&L = notional * (entry - exit) / entry  [for a short]
  const delta = entryPriceMicros - exitPriceMicros;
  return (notionalUnits * delta) / entryPriceMicros;  // integer-truncated
}
```

Test pattern:

```typescript
describe('realisedPnlUnits', () => {
  it('returns positive units when ILS weakens vs USD (short profits)', () => {
    const pnl = realisedPnlUnits(1_000_000n * 1_000_000n, 1_000_000n, 990_000n);
    expect(pnl).toBe(10_000n * 1_000_000n);  // 1% gain on 1M USDC short
  });
});
```

Existing repo demonstrations: [`src/hedge/mock-hedge-venue.ts`](../../../src/hedge/mock-hedge-venue.ts) does all FX P&L math in bigint with the exact pattern above. The 9-spec `mock-hedge-venue.spec.ts` test file exercises the deterministic accrual to a millionth of a USDC.

**The boundary discipline.** When a pure signal function (e.g. `ouFit`) needs to operate on a price series in `number` array form, the conversion is explicit:

```typescript
// Boundary: bigint micros → float for the regression
const priceFloats = bigintMicros.map((m) => Number(m) / 1e6);
const params = ouFit(priceFloats, /* dt */ 1 / 252);

// Boundary: float result → bigint micros for orders
const exitThresholdMicros = BigInt(Math.round(params.mu * 1e6 + params.sigma * 1e6 * thresholdA));
```

The conversion is in one named place; downstream code stays in bigint. This is what prevents accumulated floating-point error from creeping into the ledger.

## A.6 The risk-layer pipeline

**Purpose.** Strategies emit *desired* orders; the risk layer transforms them through a series of validators and sizers before any order reaches a venue. Each step is independently testable, each rejection is logged with a reason, and risk does not silently swallow orders.

```typescript
// stat-arb/risk/risk-layer.ts
export class RiskLayer {
  constructor(
    private readonly killSwitch: KillSwitch,
    private readonly drawdownGate: DrawdownGate,
    private readonly circuitBreakers: CircuitBreakerRegistry,
    private readonly sizer: KellySizer,
    private readonly venueCap: VenueCap,
  ) {}

  async vet(orders: Order[], ctx: RiskContext): Promise<{ accepted: Order[]; rejected: RejectedOrder[] }> {
    if (this.killSwitch.isHalted()) return { accepted: [], rejected: orders.map((o) => ({ order: o, reason: 'kill-switch' })) };
    if (!this.drawdownGate.check(ctx.currentNav)) return { accepted: [], rejected: orders.map((o) => ({ order: o, reason: 'drawdown-gate' })) };
    if (!this.circuitBreakers.allows(ctx)) return { accepted: [], rejected: orders.map((o) => ({ order: o, reason: 'circuit-breaker' })) };
    const sized = orders.map((o) => this.sizer.scale(o, ctx));
    const capped = sized.map((o) => this.venueCap.cap(o, ctx));
    const accepted = capped.filter((o) => o.sizeUnits > 0n);
    const rejected = capped.filter((o) => o.sizeUnits === 0n).map((o) => ({ order: o, reason: 'venue-cap-zero' }));
    return { accepted, rejected };
  }
}
```

Test pattern:

```typescript
describe('RiskLayer', () => {
  it('rejects all orders when the kill switch is halted', async () => {
    const layer = makeLayer({ killSwitch: { isHalted: () => true } });
    const result = await layer.vet([buildOrder()], makeCtx());
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('kill-switch');
  });
});
```

The five-component split (kill-switch / drawdown / circuit-breakers / sizer / venue-cap) is the §5.7 architecture made concrete. Each component is testable in isolation; the pipeline is testable end-to-end with mocked components.

## A.7 The deterministic-clock pattern

**Purpose.** Anything time-dependent (accrual, half-life decay, refit cadence, funding-rate intervals) uses an injectable `() => Date` clock rather than `new Date()`. Tests pass a clock that returns a frozen or fast-forwardable time; production passes `() => new Date()`. This is what makes tests deterministic without sleep / setTimeout hacks.

```typescript
// Constructor signature
constructor(
  private readonly refitIntervalBars: number,
  private readonly clock: () => Date = () => new Date(),
) {}

// Internal usage
private nowMs(): number { return this.clock().getTime(); }
```

Test pattern:

```typescript
it('refits OU parameters when the bar interval elapses', () => {
  let nowMs = 1_700_000_000_000;
  const strategy = new OUReversionStrategy({ refitInterval: 100 }, () => new Date(nowMs));
  for (let i = 0; i < 99; i++) { strategy.onBar(makeBar(i), ctx); }
  expect(strategy.lastRefitBar).toBe(0);  // not yet
  strategy.onBar(makeBar(99), ctx);
  expect(strategy.lastRefitBar).toBe(99);  // refit triggered
});
```

Existing repo demonstrations: every spec in [`src/hedge/mock-hedge-venue.spec.ts`](../../../src/hedge/mock-hedge-venue.spec.ts) and [`src/yield/mock-yield-provider.spec.ts`](../../../src/yield/mock-yield-provider.spec.ts) uses this pattern — the `clock` parameter is passed into the venue / provider constructor, and tests advance `nowMs` to drive accrual deterministically.

## A.8 The factory selector

**Purpose.** Choice between mock and real implementations happens in exactly one place per module: the module's factory function inside the NestJS `@Module({ providers: ... })` block. Nothing else in the codebase reads the `MOCK_*` flag; everything else receives the injected concrete implementation.

```typescript
// stat-arb/execution/execution.module.ts
@Module({
  providers: [
    {
      provide: TRADING_VENUE,
      useFactory: (cfg: AppConfig): ITradingVenue =>
        cfg.execution.mockEnabled
          ? new MockTradingVenue(cfg.execution.mockFeeBps)
          : new RealBinanceTradingVenue(),
      inject: [APP_CONFIG],
    },
  ],
  exports: [TRADING_VENUE],
})
export class ExecutionModule {}
```

The factory is the single point of variance. Tests inject a custom `TRADING_VENUE` provider (a fake or spy) without touching application code. Production reads the flag from `AppConfig`, which itself is the only sanctioned `process.env` reader ([CLAUDE.md §6](../../../CLAUDE.md)).

Existing repo demonstrations: [`src/yield/yield.module.ts`](../../../src/yield/yield.module.ts), [`src/hedge/hedge.module.ts`](../../../src/hedge/hedge.module.ts). Identical shape, two domains. The stat-arb modules will follow the same pattern.

## A.9 The DB-gated integration spec

**Purpose.** Specs that need a real Postgres instance are tagged `*.int-spec.ts` and use `describeIfDb` to auto-skip when Postgres on `:5433` is unreachable. This means a developer can run `npm test` without Docker, and CI runs the full suite with Docker up — the same source file works for both.

```typescript
// src/stat-arb/nav/nav.service.int-spec.ts
import { describeIfDb } from '../../test-helpers/postgres-available';

describeIfDb('NavService (DB)', () => {
  it('persists daily NAV snapshots into prop_nav_snapshots', async () => {
    const svc = await app.resolve(NavService);
    await svc.crystalliseDailyNav();
    const row = await db.query('SELECT * FROM prop_nav_snapshots ORDER BY created_at DESC LIMIT 1');
    expect(row.rows[0].nav_units).toBeGreaterThan(0n);
  });
});
```

Existing repo demonstrations: [`src/treasury/treasury.service.int-spec.ts`](../../../src/treasury/treasury.service.int-spec.ts), [`src/database/append-only.int-spec.ts`](../../../src/database/append-only.int-spec.ts), [`src/test-helpers/postgres-available.ts`](../../../src/test-helpers/postgres-available.ts). The helper is the single source of truth for "is Postgres reachable?" — every int-spec depends on it.

## A.10 Cross-pattern: how the patterns compose in one strategy

The patterns above are not a la carte — they compose into a single shape that every stat-arb strategy follows. The shape, end to end:

1. **Pure signal function** (A.2) reads price arrays and returns a value object.
2. **`IStrategy.onBar`** (A.3) consumes the signal, looks at the portfolio (A.4 ledger), and emits desired orders in bigint quantities (A.5).
3. **RiskLayer.vet** (A.6) pipes the desired orders through kill-switch → drawdown → circuit-breakers → Kelly sizer → venue cap.
4. **ITradingVenue.place** (A.1) records the fill back to the append-only `prop_movements` table (A.4).
5. **Daily NAV cron** reads the ledger and writes a `prop_nav_snapshots` row (DB-gated spec, A.9).

The deterministic-clock pattern (A.7) and the factory selector (A.8) appear at every layer where time or external dependencies are involved. The whole stack is testable, deterministic, and swap-seam ready before any real venue's API keys are populated.
