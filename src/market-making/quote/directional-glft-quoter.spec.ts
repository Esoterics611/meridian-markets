import { DirectionalGlftQuoter } from './directional-glft-quoter';
import { GlftQuoter } from './glft-quoter';
import { QuoteContext } from './quote-pair';

const CLOCK = () => new Date('2026-01-01T00:00:00Z');

function ctx(over: Partial<QuoteContext> = {}): QuoteContext {
  return {
    inventoryUnits: 0n,
    midMicros: 1_000_000n,
    volatility: 0.002,
    riskAversion: 0.0025,
    arrivalDecay: 2,
    horizonBars: 1,
    schemaVersion: 1,
    ...over,
  };
}

const base = { gamma: 0.0025, kappa: 2, quoteSizeUnits: 1_000_000n, minHalfSpreadBps: 0, maxHalfSpreadBps: 10_000, maxInventoryLots: 10, steadyHorizonBars: 1 };

describe('DirectionalGlftQuoter', () => {
  it('bias=0 reproduces the neutral GLFT quoter exactly (swap-seam default)', () => {
    const dir = new DirectionalGlftQuoter({ ...base, bias: 0 }, CLOCK);
    const glft = new GlftQuoter(base, CLOCK);
    for (const inv of [0n, 3_000_000n, -2_000_000n]) {
      const a = dir.quote(ctx({ inventoryUnits: inv }), 'X');
      const b = glft.quote(ctx({ inventoryUnits: inv }), 'X');
      expect(a.reservationMicros).toBe(b.reservationMicros);
      expect(a.halfSpreadMicros).toBe(b.halfSpreadMicros);
    }
  });

  it('a LONG bias raises the reservation when flat (quotes up ⇒ accumulate long)', () => {
    const neutral = new DirectionalGlftQuoter({ ...base, bias: 0 }, CLOCK).quote(ctx({ inventoryUnits: 0n }), 'X');
    const longBias = new DirectionalGlftQuoter({ ...base, bias: 0.5 }, CLOCK).quote(ctx({ inventoryUnits: 0n }), 'X');
    expect(longBias.reservationMicros).toBeGreaterThan(neutral.reservationMicros);
  });

  it('a SHORT bias lowers the reservation when flat (quotes down ⇒ accumulate short)', () => {
    const neutral = new DirectionalGlftQuoter({ ...base, bias: 0 }, CLOCK).quote(ctx({ inventoryUnits: 0n }), 'X');
    const shortBias = new DirectionalGlftQuoter({ ...base, bias: -0.5 }, CLOCK).quote(ctx({ inventoryUnits: 0n }), 'X');
    expect(shortBias.reservationMicros).toBeLessThan(neutral.reservationMicros);
  });

  it('rests at the TARGET inventory: no skew when inventory == bias·maxLots', () => {
    // bias 0.5, maxLots 10, lot = quoteSize 1.0 ⇒ target = 5 lots = 5_000_000 units.
    const q = new DirectionalGlftQuoter({ ...base, bias: 0.5 }, CLOCK);
    const atTarget = q.quote(ctx({ inventoryUnits: 5_000_000n }), 'X');
    // At the target the reservation == the center (mid), like neutral GLFT at flat.
    expect(atTarget.reservationMicros).toBe(1_000_000n);
  });

  it('above the target it skews to SELL (reservation below center) — works the excess off', () => {
    const q = new DirectionalGlftQuoter({ ...base, bias: 0.5 }, CLOCK); // target 5 lots
    const overTarget = q.quote(ctx({ inventoryUnits: 8_000_000n }), 'X'); // 8 lots > 5
    expect(Number(overTarget.reservationMicros)).toBeLessThan(1_000_000);
  });

  it('conviction drift nudges the center toward the view', () => {
    const noDrift = new DirectionalGlftQuoter({ ...base, bias: 0.5, convictionGain: 0 }, CLOCK).quote(ctx({ inventoryUnits: 5_000_000n }), 'X');
    const drift = new DirectionalGlftQuoter({ ...base, bias: 0.5, convictionGain: 0.5 }, CLOCK).quote(ctx({ inventoryUnits: 5_000_000n }), 'X');
    expect(Number(drift.reservationMicros)).toBeGreaterThan(Number(noDrift.reservationMicros));
  });

  it('ctx.bias (the live OOS-gated view) OVERRIDES the static construction-time bias', () => {
    // built neutral, but the runtime supplies a live long view ⇒ quotes skew up.
    const q = new DirectionalGlftQuoter({ ...base, bias: 0 }, CLOCK);
    const neutral = q.quote(ctx({ inventoryUnits: 0n }), 'X');
    const liveLong = q.quote(ctx({ inventoryUnits: 0n, bias: 0.5 }), 'X');
    const liveShort = q.quote(ctx({ inventoryUnits: 0n, bias: -0.5 }), 'X');
    expect(liveLong.reservationMicros).toBeGreaterThan(neutral.reservationMicros);
    expect(liveShort.reservationMicros).toBeLessThan(neutral.reservationMicros);
    // and ctx.bias=0 with a static long bias ⇒ the live (0) wins (neutral)
    const staticLong = new DirectionalGlftQuoter({ ...base, bias: 0.5 }, CLOCK);
    expect(staticLong.quote(ctx({ inventoryUnits: 0n, bias: 0 }), 'X').reservationMicros).toBe(neutral.reservationMicros);
  });

  it('still honours referenceMicros (F1) + spreadScale (F3)', () => {
    const q = new DirectionalGlftQuoter({ ...base, bias: 0 }, CLOCK);
    const onMicro = q.quote(ctx({ inventoryUnits: 0n, referenceMicros: 1_000_500n }), 'X');
    expect(onMicro.reservationMicros).toBe(1_000_500n);
    const wide = q.quote(ctx({ inventoryUnits: 0n, spreadScale: 2 }), 'X');
    const tight = q.quote(ctx({ inventoryUnits: 0n, spreadScale: 0.5 }), 'X');
    expect(Number(wide.halfSpreadMicros)).toBeGreaterThan(Number(tight.halfSpreadMicros));
  });
});

describe('MmStrategyRegistry — directional GLFT', () => {
  it('registers mm-directional-glft and builds it', async () => {
    const { mmStrategyRegistry } = await import('../registry/mm-strategy-registry');
    expect(mmStrategyRegistry.has('mm-directional-glft')).toBe(true);
    const q = mmStrategyRegistry.build('mm-directional-glft', {
      quoteSizeUnits: 1_000_000n, minHalfSpreadBps: 1, maxHalfSpreadBps: 200, maxInventoryLots: 10, params: { bias: 0.4 },
    });
    expect(q.familyId).toBe('directional-glft');
  });
});
