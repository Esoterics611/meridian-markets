import { buildQuotePair, QuoteContext } from './quote-pair';

// buildQuotePair spec — the shared quote constructor every quoter funnels through. The
// mechanics under test here are the symmetric/asymmetric half-spread assembly and the
// hedge-cost premium (ctx.hedgeCostBps): the additive that prices the perp hedge we pay
// to neutralise each fill into the maker spread, so hedging is not a guaranteed bleed.

function ctx(over: Partial<QuoteContext> = {}): QuoteContext {
  return {
    inventoryUnits: 0n,
    midMicros: 100_000_000n, // $100.000000
    volatility: 0.0004,
    riskAversion: 0,
    arrivalDecay: 1,
    horizonBars: 1,
    schemaVersion: 1,
    ...over,
  };
}

const build = (c: QuoteContext, over: Partial<Parameters<typeof buildQuotePair>[0]> = {}) =>
  buildQuotePair({
    symbol: 'BTC',
    reservationMicros: 100_000_000n,
    halfSpreadMicros: 50_000n,
    sizeUnits: 1_000_000n,
    ctx: c,
    strategyId: 's',
    tickSeq: 0,
    clock: () => new Date(0),
    ...over,
  });

describe('buildQuotePair — hedge-cost premium (ctx.hedgeCostBps)', () => {
  it('leaves the spread unchanged when no premium is supplied (every legacy quoter is unchanged)', () => {
    const q = build(ctx());
    expect(q.halfSpreadMicros).toBe(50_000n);
    expect(q.bid.priceMicros).toBe(100_000_000n - 50_000n);
    expect(q.ask.priceMicros).toBe(100_000_000n + 50_000n);
  });

  it('widens BOTH sides by mid·bps/1e4 (3.5bps of $100 = $0.035 = 35_000 micros)', () => {
    const q = build(ctx({ hedgeCostBps: 3.5 }));
    expect(q.halfSpreadMicros).toBe(50_000n + 35_000n);
    expect(q.bid.priceMicros).toBe(100_000_000n - 85_000n);
    expect(q.ask.priceMicros).toBe(100_000_000n + 85_000n);
  });

  it('adds the premium once per side under asymmetric (skewed) half-spreads — no double-count', () => {
    const q = build(ctx({ hedgeCostBps: 3.5 }), { bidHalfSpreadMicros: 20_000n, askHalfSpreadMicros: 80_000n });
    expect(q.halfSpreadMicros).toBe(85_000n); // reported base reflects the premium
    expect(q.bid.priceMicros).toBe(100_000_000n - (20_000n + 35_000n));
    expect(q.ask.priceMicros).toBe(100_000_000n + (80_000n + 35_000n));
  });

  it('treats hedgeCostBps 0 as off (identical to undefined)', () => {
    expect(build(ctx({ hedgeCostBps: 0 })).halfSpreadMicros).toBe(50_000n);
  });
});

describe('buildQuotePair — F4 per-side throttle scales (ctx.*HalfSpreadScale / *SizeScale)', () => {
  it('widens only the scaled side, on top of the quoter per-side half-spread', () => {
    const q = build(ctx({ askHalfSpreadScale: 2 }), { bidHalfSpreadMicros: 20_000n, askHalfSpreadMicros: 80_000n });
    expect(q.bid.priceMicros).toBe(100_000_000n - 20_000n); // untouched
    expect(q.ask.priceMicros).toBe(100_000_000n + 160_000n); // ×2 on the quoter's own ask half
  });

  it('cuts a side size multiplicatively and pulls it entirely at scale 0 (FLATTEN-ONLY)', () => {
    const q = build(ctx({ bidSizeScale: 0.5, askSizeScale: 0 }), { bidSizeUnits: 800_000n });
    expect(q.bid.sizeUnits).toBe(400_000n); // composes with the quoter's F3 per-side size
    expect(q.ask.sizeUnits).toBe(0n); // side pulled — engines treat 0 as not quoted
  });

  it('scale 1 / undefined leaves everything unchanged (legacy quoters unaffected)', () => {
    const q = build(ctx({ bidHalfSpreadScale: 1, askSizeScale: 1 }));
    expect(q.bid.priceMicros).toBe(100_000_000n - 50_000n);
    expect(q.ask.sizeUnits).toBe(1_000_000n);
  });

  it('floors a widened/tightened side at 1 micro', () => {
    const q = build(ctx({ bidHalfSpreadScale: 1e-9 }), { bidHalfSpreadMicros: 5n });
    expect(q.bid.priceMicros).toBe(100_000_000n - 1n);
  });
});
