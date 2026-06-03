import { sweepGammaKappa, rankSweep, SweepResult, SweepCombo } from './gamma-kappa-sweep';
import { L2TapeStep } from './l2-tape';
import { OrderBook, OrderBookLevel } from '../microstructure/order-book';
import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext, QuotePair, buildQuotePair } from '../quote/quote-pair';

// --- helpers (mirror lob-replay.spec) --------------------------------------
const px = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const u = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const lvl = (p: bigint, s: bigint): OrderBookLevel => ({ priceMicros: p, sizeUnits: s, orderCount: 1 });

function book(bb: number, bbsz: number, ba: number, basz: number): OrderBook {
  return { symbol: 'BTC', ts: new Date(0), bids: [lvl(px(bb), u(bbsz))], asks: [lvl(px(ba), u(basz))] };
}
function step(ob: OrderBook, aggSell: number, low: number, high: number): L2TapeStep {
  return { book: ob, aggressiveSellUnits: u(aggSell), aggressiveBuyUnits: 0n, tradedLowMicros: px(low), tradedHighMicros: px(high) };
}

// Stub quoter whose half-spread tracks the swept floor (γ,κ ignored, as GLFT does):
// a wider floor buys further below the 100 mid → captures MORE spread per fill.
function stubBuilder(calls: SweepCombo[]): (c: SweepCombo) => IQuoter {
  return (combo: SweepCombo): IQuoter => {
    calls.push(combo);
    return {
      familyId: 'stub',
      quote(ctx: QuoteContext, symbol: string): QuotePair {
        const half = (ctx.midMicros * BigInt(Math.round(combo.minHalfSpreadBps * 100))) / 1_000_000n;
        return buildQuotePair({
          symbol,
          reservationMicros: ctx.midMicros,
          halfSpreadMicros: half,
          sizeUnits: u(1),
          ctx,
          strategyId: 'stub',
          tickSeq: 0,
          clock: () => new Date(0),
        });
      },
    };
  };
}

// 8 steps, bid improves over best (98) so it's front-of-queue (ahead 0); a 5-unit
// sell hits it each step (low 99 ≤ both candidate bids); ask never reached (high 100).
const tape: L2TapeStep[] = Array.from({ length: 8 }, () => step(book(98, 10, 102, 10), 5, 99, 100));

const base = {
  quoteSizeUnits: u(1),
  capitalUnits: u(1_000_000),
  volWindowBars: 2,
  volFloor: 0.0001,
  horizonBars: 1,
  makerBps: -0.2, // HL rebate
  minHalfSpreadBps: 1,
  symbol: 'BTC',
  ddLimitPct: 2,
};

describe('sweepGammaKappa', () => {
  it('returns one result per grid combo and rebuilds the quoter for each', () => {
    const calls: SweepCombo[] = [];
    const res = sweepGammaKappa({
      tape,
      grid: { gammas: [0.001, 0.005], kappas: [1, 2], minHalfSpreadsBps: [1, 50] },
      buildQuoter: stubBuilder(calls),
      base,
    });
    expect(res).toHaveLength(8); // 2 × 2 × 2
    expect(calls).toHaveLength(8); // quoter rebuilt per combo (γ,κ are baked, not ctx-read)
  });

  it('ranks the wider floor first — it captures more spread per fill on this tape', () => {
    const res = sweepGammaKappa({
      tape,
      grid: { gammas: [0.001], kappas: [1], minHalfSpreadsBps: [1, 50] },
      buildQuoter: stubBuilder([]),
      base,
    });
    expect(res).toHaveLength(2);
    expect(res[0].combo.minHalfSpreadBps).toBe(50); // winner buys deeper → more spread
    expect(res[0].makerNetUnits).toBeGreaterThan(res[1].makerNetUnits);
    expect(res[0].queueFills).toBeGreaterThan(0);
    expect(res[0].ddPass).toBe(true);
  });
});

describe('rankSweep', () => {
  const mk = (net: bigint, ddPass: boolean, struct = net): SweepResult => ({
    combo: { gamma: 0, kappa: 0, minHalfSpreadBps: 0 },
    queueFills: 0,
    touchFills: 0,
    fillRatio: 0,
    structuralUnits: struct,
    makerNetUnits: net,
    spreadCapturedUnits: 0n,
    adverseSelectionUnits: 0n,
    maxDrawdownPct: ddPass ? 0.5 : 9,
    ddPass,
  });

  it('orders drawdown-compliant combos first, then by maker net descending', () => {
    const ranked = rankSweep([
      mk(100n, false), // high net but blows the DD limit → demoted
      mk(10n, true),
      mk(50n, true),
    ]);
    expect(ranked.map((r) => r.makerNetUnits)).toEqual([50n, 10n, 100n]);
    expect(ranked[0].ddPass).toBe(true);
    expect(ranked[2].ddPass).toBe(false); // DD-failing combo last despite the biggest net
  });
});
