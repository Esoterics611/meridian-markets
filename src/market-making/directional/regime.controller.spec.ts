import { RegimeController } from './regime.controller';
import { RegimeDeskTrader, SeatedRegimeBook } from './regime-desk-trader';
import { RegimeDirectionalBook } from './regime-directional-book';
import { RegimeMonitor } from './regime-monitor';

function seatBook(symbol: string): SeatedRegimeBook {
  return { symbol, ic: 0.3, signalName: 'momentum(24h)', allocNotionalUsd: 25_000, book: new RegimeDirectionalBook({ baseNotionalUsd: 50_000, book: symbol }), monitor: new RegimeMonitor(symbol) };
}

describe('RegimeController (P13)', () => {
  describe('inert default (REGIME_DESK off ⇒ trader null)', () => {
    const c = new RegimeController(null);
    it('snapshot reports disabled', () => {
      expect(c.snapshot()).toMatchObject({ enabled: false });
    });
    it('flatten + halt report disabled (no-op)', () => {
      expect(c.flatten({ symbol: 'ETH' })).toMatchObject({ enabled: false });
      expect(c.halt()).toMatchObject({ enabled: false });
    });
  });

  describe('enabled (trader present)', () => {
    let trader: RegimeDeskTrader;
    let c: RegimeController;
    beforeEach(() => {
      trader = new RegimeDeskTrader({ deskRisk: { maxGrossUsd: 3e5, maxNetUsd: 2e5, dailyLossLimitUsd: 6e3, capitalUsd: 1.5e5, maxDrawdownFrac: 0.02 } });
      trader.seat([seatBook('ETH')]);
      c = new RegimeController(trader);
    });
    it('snapshot returns enabled + the desk shape', () => {
      const s = c.snapshot() as { enabled: boolean; positions?: readonly unknown[] };
      expect(s.enabled).toBe(true);
      expect(s.positions).toHaveLength(1);
    });
    it('flatten requires a symbol and routes to the trader', () => {
      expect(c.flatten({})).toMatchObject({ enabled: true, ok: false });
      expect(c.flatten({ symbol: 'ETH' })).toMatchObject({ enabled: true, ok: true, symbol: 'ETH' });
      expect(c.flatten({ symbol: 'XXX' })).toMatchObject({ enabled: true, ok: false });
    });
    it('halt latches the desk', () => {
      expect(c.halt()).toMatchObject({ enabled: true, ok: true, halted: true });
    });
  });
});
