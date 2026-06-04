import { classifyFill, fillEvent, fmtMoney, fmtPrice, fmtQty, verdictEvent } from './desk-event';

describe('desk-event — classification + formatting', () => {
  describe('classifyFill', () => {
    it('from flat → open', () => {
      expect(classifyFill(0n, 500_000n)).toBe('open');
      expect(classifyFill(0n, -500_000n)).toBe('open');
    });
    it('extends the same side → add', () => {
      expect(classifyFill(500_000n, 1_000_000n)).toBe('add');
      expect(classifyFill(-500_000n, -1_000_000n)).toBe('add');
    });
    it('partial unwind of the same side → reduce', () => {
      expect(classifyFill(1_000_000n, 500_000n)).toBe('reduce');
      expect(classifyFill(-1_000_000n, -500_000n)).toBe('reduce');
    });
    it('back to flat → close', () => {
      expect(classifyFill(500_000n, 0n)).toBe('close');
    });
    it('crossing through zero → flip', () => {
      expect(classifyFill(500_000n, -300_000n)).toBe('flip');
      expect(classifyFill(-500_000n, 300_000n)).toBe('flip');
    });
  });

  describe('formatters', () => {
    it('fmtQty trims trailing zeros', () => {
      expect(fmtQty(500_000n)).toBe('0.5');
      expect(fmtQty(1_200_000n)).toBe('1.2');
      expect(fmtQty(2_000_000n)).toBe('2');
    });
    it('fmtPrice groups + fixes 2dp', () => {
      expect(fmtPrice(63_801_500_000n)).toBe('63,801.50');
    });
    it('fmtMoney shows a signed dollar amount with a unicode minus', () => {
      expect(fmtMoney(12_400_000n)).toBe('+$12.40');
      expect(fmtMoney(-60_000n)).toBe('−$0.06');
    });
  });

  describe('fillEvent messages — the enter/exit the operator asked for', () => {
    it('an opening BUY reads "opened long" and shows the rebate as a + fee', () => {
      const e = fillEvent({
        ts: 1, book: 'BTC', source: 'hyperliquid', side: 'BUY', action: 'open',
        sizeUnits: 500_000n, priceMicros: 63_700_000_000n, inventoryUnits: 500_000n,
        realisedDeltaUnits: 0n, feeUnits: -120_000n, // a maker rebate (negative cost)
      });
      expect(e.kind).toBe('fill');
      expect(e.message).toContain('BTC ▸ BUY 0.5 @ 63,700.00');
      expect(e.message).toContain('opened long → inv 0.5');
      expect(e.message).toContain('fee +$0.12'); // rebate reads as positive P&L
      expect(e.realisedDeltaUnits).toBe('0');
    });

    it('a closing SELL reads "closed long flat" with the realised P&L', () => {
      const e = fillEvent({
        ts: 2, book: 'BTC', source: 'hyperliquid', side: 'SELL', action: 'close',
        sizeUnits: 500_000n, priceMicros: 63_900_000_000n, inventoryUnits: 0n,
        realisedDeltaUnits: 100_000n, feeUnits: -120_000n,
      });
      expect(e.message).toContain('closed long flat → inv 0');
      expect(e.message).toContain('realised +$0.10');
    });
  });

  describe('verdictEvent', () => {
    it('a transition into a block reads "blocked", a return to Allow reads "resumed"', () => {
      expect(verdictEvent({ ts: 1, book: 'ETH', source: 'hyperliquid', prev: 'Allow', next: 'Pause' }).message).toContain('Allow → Pause (quoting blocked)');
      expect(verdictEvent({ ts: 2, book: 'ETH', source: 'hyperliquid', prev: 'Pause', next: 'Allow' }).message).toContain('Pause → Allow (resumed quoting)');
    });
  });
});
