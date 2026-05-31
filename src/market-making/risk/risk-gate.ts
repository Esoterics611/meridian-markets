import { QuotePair } from '../quote/quote-pair';

// RiskGate — the pre-quote risk check (course §5, Appendix A.8). Same role as
// stat-arb's RiskEngine, specialised for market making's failure modes. Three
// verdicts:
//   - Allow : place the quote.
//   - Deny  : do not place new quotes AND flatten / pull resting ones (hard cap
//             breach, kill switch).
//   - Pause : do not place new quotes, but leave resting quotes alone, for N ms.
//             The MM-specific verdict — the right response to a VPIN spike where
//             neither aggressive re-quoting nor a panicked flatten helps; you
//             stand still until the toxic burst passes (course §5.2).
//
// Each component is a named string so the production stack can route an alert
// per component (course §7.6). CompositeRiskGate runs them in priority order and
// returns the first non-Allow verdict.

export type RiskComponent =
  | 'inventory-cap'
  | 'drawdown-gate'
  | 'vpin-toxicity'
  | 'adverse-selection-burst'
  | 'kill-switch';

export type RiskVerdict =
  | { kind: 'Allow' }
  | { kind: 'Deny'; reason: string; component: RiskComponent }
  | { kind: 'Pause'; reason: string; component: RiskComponent; durationMs: number };

export interface RiskState {
  /** Signed inventory in asset units. */
  readonly inventoryUnits: bigint;
  /** NAV ÷ peak NAV; 1.0 at the high-water mark, < 1 in drawdown. */
  readonly navRatio: number;
  /** Current VPIN in [0,1]. */
  readonly vpin: number;
  /** Rolling adverse-selection score (USDC-units of mark-out loss/window); + = leaking. */
  readonly recentAdverseUnits: bigint;
  /** Hard manual halt. */
  readonly killed: boolean;
}

export interface RiskGate {
  check(quote: QuotePair, state: RiskState): RiskVerdict;
}

export interface CompositeRiskGateConfig {
  /** |inventory| beyond this denies new quotes that would extend it (asset units). */
  maxInventoryUnits: bigint;
  /** navRatio below this denies all quoting (drawdown kill). e.g. 0.90 = 10% DD. */
  minNavRatio: number;
  /** VPIN at/above this pauses quoting. */
  vpinPauseThreshold: number;
  /** How long a VPIN pause lasts (ms). */
  vpinPauseMs: number;
  /** Rolling adverse-selection loss beyond this pauses quoting (USDC-units). */
  maxAdverseUnits: bigint;
  /** How long an adverse-selection pause lasts (ms). */
  adversePauseMs: number;
}

export const ALLOW: RiskVerdict = { kind: 'Allow' };

export class CompositeRiskGate implements RiskGate {
  constructor(private readonly cfg: CompositeRiskGateConfig) {}

  check(quote: QuotePair, state: RiskState): RiskVerdict {
    if (state.killed) {
      return { kind: 'Deny', reason: 'manual kill switch', component: 'kill-switch' };
    }
    if (state.navRatio < this.cfg.minNavRatio) {
      return {
        kind: 'Deny',
        reason: `navRatio ${state.navRatio.toFixed(4)} < ${this.cfg.minNavRatio}`,
        component: 'drawdown-gate',
      };
    }
    // Inventory cap: deny only the side that would *extend* an over-limit book,
    // so the skewed quote that sheds inventory still goes out.
    const inv = state.inventoryUnits;
    if (inv >= this.cfg.maxInventoryUnits || inv <= -this.cfg.maxInventoryUnits) {
      const extendingSide = inv > 0n ? 'bid' : 'ask';
      return {
        kind: 'Deny',
        reason: `inventory ${inv} at cap ${this.cfg.maxInventoryUnits}; blocking ${extendingSide}`,
        component: 'inventory-cap',
      };
    }
    if (state.vpin >= this.cfg.vpinPauseThreshold) {
      return {
        kind: 'Pause',
        reason: `vpin ${state.vpin.toFixed(3)} >= ${this.cfg.vpinPauseThreshold}`,
        component: 'vpin-toxicity',
        durationMs: this.cfg.vpinPauseMs,
      };
    }
    if (state.recentAdverseUnits >= this.cfg.maxAdverseUnits) {
      return {
        kind: 'Pause',
        reason: `adverse ${state.recentAdverseUnits} >= ${this.cfg.maxAdverseUnits}`,
        component: 'adverse-selection-burst',
        durationMs: this.cfg.adversePauseMs,
      };
    }
    return ALLOW;
  }
}
