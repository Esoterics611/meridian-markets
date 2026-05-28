import { GateDecision, GateEvent } from './gate';
import { DrawdownGate, DrawdownState } from './drawdown-gate';
import { VenueCapGate, VenueCapState } from './venue-cap';
import { ExposureCapsGate, ExposureState } from './exposure-caps';
import { CorrelationCapGate, CorrelationState } from './correlation-cap';

// IRiskEngine — the composed pre-trade check used by BacktestRunner. Same
// shape as HedgeCircuitBreaker but a positive-allow check (the hedge breaker
// throws; the risk engine returns a decision so the runner can keep counters).

export interface RiskCheckContext {
  barIndex: number;
  drawdown?: DrawdownState;
  venueCap?: VenueCapState;
  exposure?: ExposureState;
  correlation?: CorrelationState;
}

export interface IRiskEngine {
  preTradeCheck(ctx: RiskCheckContext): GateDecision[];
  /** Flush + read accumulated gate events. */
  drainEvents(): GateEvent[];
}

export interface RiskEngineConfig {
  drawdown?: DrawdownGate;
  venueCap?: VenueCapGate;
  exposure?: ExposureCapsGate;
  correlation?: CorrelationCapGate;
}

export class RiskEngine implements IRiskEngine {
  private events: GateEvent[] = [];

  constructor(private readonly cfg: RiskEngineConfig) {}

  preTradeCheck(ctx: RiskCheckContext): GateDecision[] {
    const decisions: GateDecision[] = [];
    if (this.cfg.drawdown && ctx.drawdown) {
      const d = this.cfg.drawdown.check(ctx.drawdown);
      decisions.push(d);
      if (!d.allow) this.events.push({ kind: 'DRAWDOWN', barIndex: ctx.barIndex, reason: d.reason!, detail: d.detail });
    }
    if (this.cfg.venueCap && ctx.venueCap) {
      const d = this.cfg.venueCap.check(ctx.venueCap);
      decisions.push(d);
      if (!d.allow) this.events.push({ kind: 'VENUE_CAP', barIndex: ctx.barIndex, reason: d.reason!, detail: d.detail });
    }
    if (this.cfg.exposure && ctx.exposure) {
      const d = this.cfg.exposure.check(ctx.exposure);
      decisions.push(d);
      if (!d.allow) {
        // Reuse the reason prefix to figure out which sub-gate fired.
        const kind = d.reason?.startsWith('gross') ? 'EXPOSURE_GROSS'
          : d.reason?.startsWith('net') ? 'EXPOSURE_NET'
          : 'EXPOSURE_PAIR';
        this.events.push({ kind, barIndex: ctx.barIndex, reason: d.reason!, detail: d.detail });
      }
    }
    if (this.cfg.correlation && ctx.correlation) {
      const d = this.cfg.correlation.check(ctx.correlation);
      decisions.push(d);
      if (!d.allow) this.events.push({ kind: 'CORRELATION', barIndex: ctx.barIndex, reason: d.reason!, detail: d.detail });
    }
    return decisions;
  }

  drainEvents(): GateEvent[] {
    return this.events.slice();
  }
}

/** True iff every decision allows. Useful at call sites. */
export function allAllow(decisions: GateDecision[]): boolean {
  return decisions.every((d) => d.allow);
}
