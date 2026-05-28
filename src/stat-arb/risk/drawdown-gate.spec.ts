import { DrawdownGate } from './drawdown-gate';

describe('DrawdownGate', () => {
  const gate = new DrawdownGate({ maxDrawdownPct: 5 });

  it('allows when there is no drawdown', () => {
    expect(gate.check({ navRatio: 1.05, peakNav: 1.05 }).allow).toBe(true);
  });

  it('allows when drawdown is below the gate', () => {
    expect(gate.check({ navRatio: 0.97, peakNav: 1.00 }).allow).toBe(true);
  });

  it('blocks at or above the gate and includes a detail payload', () => {
    const d = gate.check({ navRatio: 0.95, peakNav: 1.00 });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/drawdown/);
    expect(d.detail?.ddPct).toBeCloseTo(5);
  });

  it('treats zero peak as a no-op (allow)', () => {
    expect(gate.check({ navRatio: 0, peakNav: 0 }).allow).toBe(true);
  });

  it('triggers exactly at the boundary', () => {
    const d = gate.check({ navRatio: 0.95, peakNav: 1.0 });
    expect(d.allow).toBe(false);
  });
});
