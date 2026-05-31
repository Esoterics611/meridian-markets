import { CompositeRiskGate, RiskState } from './risk-gate';
import { SymmetricQuoter } from '../quote/symmetric-quoter';
import { QuoteContext } from '../quote/quote-pair';

const QUOTE = new SymmetricQuoter({ halfSpreadBps: 5, quoteSizeUnits: 1_000_000n }).quote(
  {
    inventoryUnits: 0n,
    midMicros: 1_000_000n,
    volatility: 0.0002,
    riskAversion: 0.0025,
    arrivalDecay: 2,
    horizonBars: 1,
    schemaVersion: 1,
  } as QuoteContext,
  'USDC',
);

const gate = new CompositeRiskGate({
  maxInventoryUnits: 5_000_000n,
  minNavRatio: 0.9,
  vpinPauseThreshold: 0.8,
  vpinPauseMs: 30_000,
  maxAdverseUnits: 1_000_000n,
  adversePauseMs: 30_000,
});

const base: RiskState = { inventoryUnits: 0n, navRatio: 1, vpin: 0, recentAdverseUnits: 0n, killed: false };

describe('CompositeRiskGate', () => {
  it('allows a healthy book', () => {
    expect(gate.check(QUOTE, base).kind).toBe('Allow');
  });

  it('denies on the manual kill switch', () => {
    const v = gate.check(QUOTE, { ...base, killed: true });
    expect(v.kind).toBe('Deny');
    if (v.kind === 'Deny') expect(v.component).toBe('kill-switch');
  });

  it('denies on a drawdown breach', () => {
    const v = gate.check(QUOTE, { ...base, navRatio: 0.85 });
    expect(v.kind).toBe('Deny');
    if (v.kind === 'Deny') expect(v.component).toBe('drawdown-gate');
  });

  it('denies on an inventory-cap breach', () => {
    const v = gate.check(QUOTE, { ...base, inventoryUnits: 5_000_000n });
    expect(v.kind).toBe('Deny');
    if (v.kind === 'Deny') expect(v.component).toBe('inventory-cap');
  });

  it('PAUSES (not denies) on a VPIN spike', () => {
    const v = gate.check(QUOTE, { ...base, vpin: 0.92 });
    expect(v.kind).toBe('Pause');
    if (v.kind === 'Pause') {
      expect(v.component).toBe('vpin-toxicity');
      expect(v.durationMs).toBe(30_000);
    }
  });

  it('PAUSES on an adverse-selection burst', () => {
    const v = gate.check(QUOTE, { ...base, recentAdverseUnits: 2_000_000n });
    expect(v.kind).toBe('Pause');
    if (v.kind === 'Pause') expect(v.component).toBe('adverse-selection-burst');
  });
});
