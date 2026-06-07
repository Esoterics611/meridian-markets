import { DirectionalGlftQuoter, DirectionalGlftParams } from './directional-glft-quoter';
import { QuoteContext, QuotePair } from './quote-pair';

// #2 (asymmetric spread skew) + #3 (single-sided quoting) on the axed maker. Both are
// OFF by default (spreadSkewIntensity/singleSideBias = 0) so bias=0 still reproduces
// neutral GLFT and every existing directional spec is unchanged.

const baseParams: DirectionalGlftParams = {
  quoteSizeUnits: 1_000_000n,
  minHalfSpreadBps: 1,
  maxHalfSpreadBps: 200,
  maxInventoryLots: 8,
  gamma: 0.0025,
  kappa: 2,
  steadyHorizonBars: 1,
  bias: 0,
};

const ctx = (over: Partial<QuoteContext> = {}): QuoteContext => ({
  inventoryUnits: 0n,
  midMicros: 1_000_000n,
  volatility: 0.003,
  riskAversion: 0.0025,
  arrivalDecay: 2,
  horizonBars: 1,
  schemaVersion: 1,
  ...over,
});

// per-side half-spreads recovered off the reservation the quotes straddle
const halves = (q: QuotePair) => ({
  bid: Number(q.reservationMicros - q.bid.priceMicros),
  ask: Number(q.ask.priceMicros - q.reservationMicros),
});

const MAX_MICROS = Math.round((1_000_000 * 200) / 10_000); // = 20000

describe('DirectionalGlftQuoter — asymmetric skew + single-siding', () => {
  it('is symmetric (and not railed) when skew is OFF, even with a bias', () => {
    const q = new DirectionalGlftQuoter(baseParams).quote(ctx({ bias: 0.5 }), 'BTC');
    const h = halves(q);
    expect(h.bid).toBeGreaterThan(100); // precondition: base half is between the rails,
    expect(h.bid).toBeLessThan(MAX_MICROS); // so the skew below is actually visible
    expect(h.bid).toBe(h.ask); // skew off ⇒ symmetric
  });

  it('#2 long view ⇒ bid TIGHTER, ask WIDER', () => {
    const q = new DirectionalGlftQuoter({ ...baseParams, spreadSkewIntensity: 0.5 }).quote(ctx({ bias: 0.5 }), 'BTC');
    const h = halves(q);
    expect(h.bid).toBeLessThan(h.ask);
  });

  it('#2 short view ⇒ ask TIGHTER, bid WIDER (mirror)', () => {
    const q = new DirectionalGlftQuoter({ ...baseParams, spreadSkewIntensity: 0.5 }).quote(ctx({ bias: -0.5 }), 'BTC');
    const h = halves(q);
    expect(h.ask).toBeLessThan(h.bid);
  });

  it('#3 strong long view + still accumulating ⇒ SINGLE-SIDED (ask parked at max rail)', () => {
    const q = new DirectionalGlftQuoter({ ...baseParams, spreadSkewIntensity: 0.5, singleSideBias: 0.4 }).quote(
      ctx({ bias: 0.6, inventoryUnits: 0n }), // target = 0.6·8 = 4.8 lots, we hold 0 ⇒ want more
      'BTC',
    );
    const h = halves(q);
    expect(h.ask).toBe(MAX_MICROS); // offload side pulled to the rail
    expect(h.bid).toBeLessThan(MAX_MICROS); // accumulation side still working
  });

  it('#3 resumes TWO-SIDED once inventory is at/over target (recycle spread)', () => {
    const q = new DirectionalGlftQuoter({ ...baseParams, spreadSkewIntensity: 0.5, singleSideBias: 0.4 }).quote(
      ctx({ bias: 0.6, inventoryUnits: 10_000_000n }), // 10 lots > 4.8 target ⇒ no longer single-side
      'BTC',
    );
    expect(halves(q).ask).toBeLessThan(MAX_MICROS);
  });

  it('bias=0 reproduces a symmetric neutral quote even with skew + single-side enabled', () => {
    const q = new DirectionalGlftQuoter({ ...baseParams, spreadSkewIntensity: 0.5, singleSideBias: 0.4 }).quote(ctx({ bias: 0 }), 'BTC');
    expect(halves(q).bid).toBe(halves(q).ask);
  });
});
