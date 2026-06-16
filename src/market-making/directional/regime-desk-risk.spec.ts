import { RegimeDeskRisk, BookRiskInput, RegimeDeskRiskConfig } from './regime-desk-risk';

const CFG: RegimeDeskRiskConfig = {
  maxGrossUsd: 100_000,
  maxNetUsd: 60_000,
  dailyLossLimitUsd: 1_000,
  capitalUsd: 1_000_000,
  maxDrawdownFrac: 0.02, // $20,000 budget
};

function bk(p: Partial<BookRiskInput> & { symbol: string }): BookRiskInput {
  return { notionalUsd: 0, side: 'FLAT', realisedPnlUsd: 0, unrealisedPnlUsd: 0, ...p };
}

describe('RegimeDeskRisk', () => {
  describe('config guard', () => {
    it('rejects non-positive caps / budgets', () => {
      expect(() => new RegimeDeskRisk({ ...CFG, maxGrossUsd: 0 })).toThrow();
      expect(() => new RegimeDeskRisk({ ...CFG, maxDrawdownFrac: 0 })).toThrow();
      expect(() => new RegimeDeskRisk({ ...CFG, dailyLossLimitUsd: 0 })).toThrow();
    });
  });

  describe('safe default', () => {
    it('a flat desk runs and allows every book', () => {
      const r = new RegimeDeskRisk(CFG);
      const a = r.assess([bk({ symbol: 'BTC' }), bk({ symbol: 'ETH' })]);
      expect(a.desk.kind).toBe('Run');
      expect(a.perBook.get('BTC')!.kind).toBe('Allow');
      expect(a.grossUsd).toBe(0);
    });
  });

  describe('gross exposure cap', () => {
    it('allows just under the cap', () => {
      const r = new RegimeDeskRisk(CFG);
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 49_999, side: 'LONG' }), bk({ symbol: 'ETH', notionalUsd: 50_000, side: 'SHORT' })]);
      expect(a.grossUsd).toBe(99_999);
      expect(Math.abs(a.netUsd)).toBeLessThan(CFG.maxNetUsd); // net under cap so only gross is exercised
      expect(a.perBook.get('BTC')!.kind).toBe('Allow');
    });

    it('blocks new entries AT the cap boundary (gross ≥ cap)', () => {
      const r = new RegimeDeskRisk(CFG);
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG' }), bk({ symbol: 'ETH', notionalUsd: 50_000, side: 'SHORT' })]);
      expect(a.grossUsd).toBe(100_000);
      const v = a.perBook.get('BTC')!;
      expect(v.kind).toBe('BlockNewEntry');
      expect((v as { component: string }).component).toBe('gross-cap');
      expect(a.desk.kind).toBe('Run'); // a cap blocks growth, it does NOT halt
    });
  });

  describe('net exposure cap', () => {
    it('a long+short book pair is net-flat (gross can be high, net low)', () => {
      const r = new RegimeDeskRisk({ ...CFG, maxGrossUsd: 1_000_000 });
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG' }), bk({ symbol: 'ETH', notionalUsd: 50_000, side: 'SHORT' })]);
      expect(a.netUsd).toBe(0);
      expect(a.perBook.get('BTC')!.kind).toBe('Allow');
    });

    it('blocks when net exceeds the net cap (one-sided book)', () => {
      const r = new RegimeDeskRisk({ ...CFG, maxGrossUsd: 1_000_000 });
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 40_000, side: 'LONG' }), bk({ symbol: 'ETH', notionalUsd: 40_000, side: 'LONG' })]);
      expect(a.netUsd).toBe(80_000);
      const v = a.perBook.get('BTC')!;
      expect(v.kind).toBe('BlockNewEntry');
      expect((v as { component: string }).component).toBe('net-cap');
    });
  });

  describe('daily-loss HALT', () => {
    it('does NOT halt exactly at the limit (−limit is not below −limit)', () => {
      const r = new RegimeDeskRisk(CFG);
      const a = r.assess([bk({ symbol: 'BTC', realisedPnlUsd: -1_000 })]);
      expect(a.desk.kind).toBe('Run');
    });

    it('HALTs and flattens ALL books once realised loss breaches the limit', () => {
      const r = new RegimeDeskRisk(CFG);
      const a = r.assess([
        bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG', realisedPnlUsd: -1_500 }),
        bk({ symbol: 'ETH', notionalUsd: 30_000, side: 'SHORT' }),
      ]);
      expect(a.desk.kind).toBe('Halt');
      expect((a.desk as { component: string }).component).toBe('daily-loss');
      expect(a.perBook.get('BTC')!.kind).toBe('FlattenNow');
      expect(a.perBook.get('ETH')!.kind).toBe('FlattenNow');
    });
  });

  describe('desk maxDD circuit breaker', () => {
    it('HALTs when peak-to-trough equity breaches the budget, and the halt LATCHES', () => {
      const r = new RegimeDeskRisk(CFG);
      // Peak: +$5,000 equity.
      let a = r.assess([bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG', unrealisedPnlUsd: 5_000 })]);
      expect(a.desk.kind).toBe('Run');
      expect(a.peakEquityUsd).toBe(5_000);
      // Trough: −$16,000 ⇒ drawdown $21,000 > $20,000 budget ⇒ HALT.
      a = r.assess([bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG', unrealisedPnlUsd: -16_000 })]);
      expect(a.desk.kind).toBe('Halt');
      expect((a.desk as { component: string }).component).toBe('desk-maxdd');
      expect(r.isHalted()).toBe(true);
      // Latched: even after equity recovers, the desk stays halted and opens NOTHING.
      a = r.assess([bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG', unrealisedPnlUsd: 4_000 }), bk({ symbol: 'NEW' })]);
      expect(a.desk.kind).toBe('Halt');
      expect(a.perBook.get('NEW')!.kind).toBe('FlattenNow');
    });

    it('counts a loss from the flat open as drawdown (peak starts at 0)', () => {
      const r = new RegimeDeskRisk({ ...CFG, maxDrawdownFrac: 0.01 }); // $10,000 budget
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG', unrealisedPnlUsd: -11_000 })]);
      expect(a.drawdownUsd).toBe(11_000);
      expect(a.desk.kind).toBe('Halt');
    });
  });

  describe('manual controls', () => {
    it('manualHalt latches the desk to Halt and flattens all', () => {
      const r = new RegimeDeskRisk(CFG);
      r.manualHalt('operator kill');
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 50_000, side: 'LONG' })]);
      expect(a.desk.kind).toBe('Halt');
      expect((a.desk as { component: string }).component).toBe('manual-halt');
      expect(a.perBook.get('BTC')!.kind).toBe('FlattenNow');
    });

    it('manualFlatten flattens only the named book; others Allow', () => {
      const r = new RegimeDeskRisk(CFG);
      r.manualFlatten('eth');
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 10_000, side: 'LONG' }), bk({ symbol: 'ETH', notionalUsd: 10_000, side: 'LONG' })]);
      expect(a.desk.kind).toBe('Run');
      expect(a.perBook.get('BTC')!.kind).toBe('Allow');
      expect(a.perBook.get('ETH')!.kind).toBe('FlattenNow');
    });

    it('reset un-latches a halt and clears flattens', () => {
      const r = new RegimeDeskRisk(CFG);
      r.manualHalt();
      expect(r.isHalted()).toBe(true);
      r.reset();
      expect(r.isHalted()).toBe(false);
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 10_000, side: 'LONG' })]);
      expect(a.desk.kind).toBe('Run');
    });
  });

  describe('verdict precedence', () => {
    it('a halt outranks an exposure cap (FlattenNow, not BlockNewEntry)', () => {
      const r = new RegimeDeskRisk(CFG);
      r.manualHalt();
      const a = r.assess([bk({ symbol: 'BTC', notionalUsd: 60_000, side: 'LONG' }), bk({ symbol: 'ETH', notionalUsd: 60_000, side: 'LONG' })]);
      expect(a.perBook.get('BTC')!.kind).toBe('FlattenNow');
    });
  });
});
