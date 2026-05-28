import { ALLOW, deny, GateDecision } from './gate';

// DrawdownGate — blocks new entries when the running drawdown percentage
// exceeds the configured limit. State is computed from the equity curve;
// the gate itself is stateless.

export interface DrawdownGateConfig {
  /** Drawdown percentage above which new entries are blocked (e.g. 5 for 5%). */
  maxDrawdownPct: number;
}

export interface DrawdownState {
  /** Most recent NAV ratio (1.0 = no P&L). */
  navRatio: number;
  /** Running peak of navRatio. */
  peakNav: number;
}

export class DrawdownGate {
  constructor(private readonly cfg: DrawdownGateConfig) {}

  check(state: DrawdownState): GateDecision {
    if (state.peakNav <= 0) return ALLOW;
    const ddPct = ((state.peakNav - state.navRatio) / state.peakNav) * 100;
    if (ddPct >= this.cfg.maxDrawdownPct) {
      return deny(`drawdown ${ddPct.toFixed(2)}% >= gate ${this.cfg.maxDrawdownPct}%`, {
        ddPct,
        maxPct: this.cfg.maxDrawdownPct,
      });
    }
    return ALLOW;
  }
}
