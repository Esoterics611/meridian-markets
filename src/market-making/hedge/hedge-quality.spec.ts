import { HedgeQualityTracker } from './hedge-quality';
import { BookDelta } from './desk-delta-hedger';

// HedgeQualityTracker — the §0 KPI of residual_mm_risk_study.md. The point under test:
// a beta hedge can only touch the factor part of inventory variance; the tracker must
// (a) split factor vs basis correctly, (b) recover the live beta/R² from returns, and
// (c) show cross-book netting at the DESK level that per-book numbers cannot see.

const M = 1_000_000;
const book = (symbol: string, qtyCoins: number, priceUsd: number): BookDelta => ({
  symbol,
  inventoryUnits: BigInt(Math.round(qtyCoins * M)),
  midMicros: BigInt(Math.round(priceUsd * M)),
});

describe('HedgeQualityTracker (study §0: factor-vs-basis residual variance)', () => {
  it('a book that moves exactly at beta to its underlying has ~zero basis vol, betaLive=β, R²=1', () => {
    const t = new HedgeQualityTracker({ SOL: { underlying: 'BTC', beta: 2 } }, 0.5, 1000);
    // r_BTC alternates ±1%; SOL moves exactly 2× that return (β=2, perfectly hedgeable).
    let btc = 50_000;
    let sol = 100;
    let ts = 0;
    t.update([book('SOL', 10, sol)], { BTC: BigInt(btc * M), SOL: BigInt(sol * M) }, ts);
    for (let i = 0; i < 12; i++) {
      const rU = i % 2 === 0 ? 0.01 : -0.01;
      btc *= 1 + rU;
      sol *= 1 + 2 * rU;
      ts += 1_000;
      t.update([book('SOL', 10, sol)], { BTC: BigInt(Math.round(btc * M)), SOL: BigInt(Math.round(sol * M)) }, ts);
    }
    const snap = t.snapshot();
    const solQ = snap.perBook.find((b) => b.symbol === 'SOL')!;
    expect(solQ.underlying).toBe('BTC');
    expect(solQ.betaLive).toBeCloseTo(2, 3);
    expect(solQ.r2).toBeCloseTo(1, 6);
    expect(solQ.factorVolUsdPerHour).toBeGreaterThan(0);
    expect(solQ.basisVolUsdPerHour).toBeLessThan(solQ.factorVolUsdPerHour * 1e-3); // basis ≈ 0
    expect(solQ.basisShare).toBeLessThan(1e-6);
    expect(solQ.pnlVolUsdPerHour).toBeCloseTo(solQ.factorVolUsdPerHour, 4);
  });

  it('a book uncorrelated with its underlying is ALL basis — the part the delta hedge cannot touch', () => {
    const t = new HedgeQualityTracker({ SOL: { underlying: 'BTC', beta: 1 } }, 0.5, 1000);
    // BTC flat, SOL alternates ±1%: the hedge underlying explains nothing.
    let sol = 100;
    let ts = 0;
    t.update([book('SOL', 10, sol)], { BTC: BigInt(50_000 * M), SOL: BigInt(sol * M) }, ts);
    for (let i = 0; i < 12; i++) {
      sol *= i % 2 === 0 ? 1.01 : 0.99;
      ts += 1_000;
      t.update([book('SOL', 10, sol)], { BTC: BigInt(50_000 * M), SOL: BigInt(Math.round(sol * M)) }, ts);
    }
    const solQ = t.snapshot().perBook.find((b) => b.symbol === 'SOL')!;
    expect(solQ.betaLive).toBeNull(); // var(r_u)=0 ⇒ no measurable beta
    expect(solQ.factorVolUsdPerHour).toBe(0);
    expect(solQ.pnlVolUsdPerHour).toBeGreaterThan(0);
    expect(solQ.basisShare).toBeCloseTo(1, 6); // 100% of the risk is unhedgeable
  });

  it('desk-level vol nets opposite inventories that per-book vols cannot see (the WP3 prize)', () => {
    const t = new HedgeQualityTracker(
      {
        AAA: { underlying: 'BTC', beta: 1 },
        BBB: { underlying: 'BTC', beta: 1 },
      },
      0.5,
      1000,
    );
    // Two books, identical price path, equal-and-OPPOSITE inventory: each book is risky alone,
    // the desk is flat. Desk series sum per tick before squaring, so this must read ≈ 0.
    let px = 100;
    let ts = 0;
    const feed = () =>
      t.update(
        [book('AAA', 10, px), book('BBB', -10, px)],
        { BTC: BigInt(50_000 * M), AAA: BigInt(Math.round(px * M)), BBB: BigInt(Math.round(px * M)) },
        ts,
      );
    feed();
    for (let i = 0; i < 10; i++) {
      px *= i % 2 === 0 ? 1.01 : 0.99;
      ts += 1_000;
      feed();
    }
    const snap = t.snapshot();
    const a = snap.perBook.find((b) => b.symbol === 'AAA')!;
    expect(a.pnlVolUsdPerHour).toBeGreaterThan(0); // each book alone carries real risk
    expect(snap.deskPnlVolUsdPerHour).toBeLessThan(a.pnlVolUsdPerHour * 1e-6); // the desk nets to ~0
  });

  it('an unmapped book self-hedges at beta 1: its own move IS the factor, basis ≈ 0', () => {
    const t = new HedgeQualityTracker({}, 0.5, 1000);
    let px = 50_000;
    let ts = 0;
    t.update([book('BTC', 1, px)], { BTC: BigInt(px * M) }, ts);
    for (let i = 0; i < 8; i++) {
      px *= i % 2 === 0 ? 1.01 : 0.99;
      ts += 1_000;
      t.update([book('BTC', 1, px)], { BTC: BigInt(Math.round(px * M)) }, ts);
    }
    const q = t.snapshot().perBook.find((b) => b.symbol === 'BTC')!;
    expect(q.underlying).toBe('BTC');
    expect(q.betaLive).toBeCloseTo(1, 6);
    expect(q.basisShare).toBeLessThan(1e-6);
  });

  it('buckets sub-interval ticks (WP1.1 Epps fix): 100ms feeds compound into one 1s sample', () => {
    const t = new HedgeQualityTracker({}, 0.5, 1000);
    // 100ms hedge-tick cadence: ticks inside the bucket must be ignored, and the closing
    // sample must carry the COMPOUNDED open→close return, not the last 100ms sliver.
    let px = 50_000;
    t.update([book('BTC', 1, px)], { BTC: BigInt(px * M) }, 0);
    for (let i = 1; i <= 10; i++) {
      px *= 1.001; // +0.1% per 100ms, all one way
      t.update([book('BTC', 1, px)], { BTC: BigInt(Math.round(px * M)) }, i * 100);
    }
    const snap = t.snapshot();
    expect(snap.samples).toBe(1); // ten ticks, ONE bucket
    expect(snap.bucketMs).toBe(1000);
    const q = snap.perBook.find((b) => b.symbol === 'BTC')!;
    expect(q.samples).toBe(1);
    // q_usd ≈ $50k at open; compounded return ≈ 1.001^10 − 1 ≈ 1.0046% ⇒ pnl ≈ $500.2 over 1s.
    // vol/√h = |pnl|/√(dtHours) = 500.2/√(1/3600) ≈ 500.2·60 ≈ $30k/√h.
    expect(q.pnlVolUsdPerHour).toBeGreaterThan(29_000);
    expect(q.pnlVolUsdPerHour).toBeLessThan(31_000);
  });

  it('needs two distinct timestamps before reporting anything (priming + dt≤0 guard)', () => {
    const t = new HedgeQualityTracker({}, 0.5, 1000);
    t.update([book('BTC', 1, 50_000)], { BTC: BigInt(50_000 * M) }, 1_000);
    expect(t.snapshot().samples).toBe(0);
    t.update([book('BTC', 1, 50_500)], { BTC: BigInt(50_500 * M) }, 1_000); // same ts ⇒ ignored
    expect(t.snapshot().samples).toBe(0);
    t.update([book('BTC', 1, 50_500)], { BTC: BigInt(50_500 * M) }, 2_000);
    expect(t.snapshot().samples).toBe(1);
  });
});
