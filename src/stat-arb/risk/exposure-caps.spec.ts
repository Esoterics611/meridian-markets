import { ExposureCapsGate } from './exposure-caps';

const cfg = {
  maxGrossUnits: 10_000_000n,
  maxNetUnits: 3_000_000n,
  maxPairUnits: 4_000_000n,
};
const gate = new ExposureCapsGate(cfg);

describe('ExposureCapsGate', () => {
  it('allows an empty book + small order', () => {
    expect(gate.check({ positions: [], intent: { pairId: 'btc/eth', longUnits: 1_000_000n, shortUnits: 1_000_000n } }).allow).toBe(true);
  });

  it('blocks on gross overflow', () => {
    const d = gate.check({
      positions: [{ pairId: 'x/y', longUnits: 5_000_000n, shortUnits: 4_000_000n }],
      intent: { pairId: 'btc/eth', longUnits: 1_000_000n, shortUnits: 1_000_000n },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/gross/);
  });

  it('blocks on net overflow even when gross is fine', () => {
    const d = gate.check({
      positions: [{ pairId: 'x/y', longUnits: 3_000_000n, shortUnits: 0n }],
      intent: { pairId: 'btc/eth', longUnits: 1_000_000n, shortUnits: 0n },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/net/);
  });

  it('blocks on pair overflow when the same pair has an existing position', () => {
    const d = gate.check({
      positions: [{ pairId: 'btc/eth', longUnits: 2_000_000n, shortUnits: 1_500_000n }],
      intent: { pairId: 'btc/eth', longUnits: 500_000n, shortUnits: 500_000n },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/btc\/eth/);
  });

  it('does not double-count an unrelated pair against pair cap', () => {
    expect(gate.check({
      positions: [{ pairId: 'sol/usdc', longUnits: 2_000_000n, shortUnits: 1_000_000n }],
      intent: { pairId: 'btc/eth', longUnits: 1_500_000n, shortUnits: 1_500_000n },
    }).allow).toBe(true);
  });

  it('treats net as absolute value', () => {
    const d = gate.check({
      positions: [{ pairId: 'x/y', longUnits: 0n, shortUnits: 4_000_000n }],
      intent: { pairId: 'btc/eth', longUnits: 0n, shortUnits: 1_000_000n },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/net/);
  });

  it('surfaces detail payload for gross breach', () => {
    const d = gate.check({
      positions: [{ pairId: 'x/y', longUnits: 9_000_000n, shortUnits: 0n }],
      intent: { pairId: 'btc/eth', longUnits: 2_000_000n, shortUnits: 0n },
    });
    expect(d.detail?.gross).toBeDefined();
    expect(d.detail?.cap).toBe('10000000');
  });

  it('handles a long-only book correctly', () => {
    expect(gate.check({
      positions: [{ pairId: 'a', longUnits: 1_000_000n, shortUnits: 0n }],
      intent: { pairId: 'b', longUnits: 1_000_000n, shortUnits: 1_000_000n },
    }).allow).toBe(true);
  });
});
