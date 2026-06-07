import { BiasContext, BiasReading, IBiasSource, clampBias } from './bias-source.interface';

// ManualBiasSource — the house-view override (DIRECTIONAL_MM_STRATEGY.md §4, the
// long-term/analyst horizon): a per-symbol directional call set BEFORE the run (the
// pre-run decision; settable via the control plane). It is the "view" layer of the
// systematic + house-view design.
//
// Two non-negotiable safety rails, both enforced here:
//  • DECAY — a view is time-stamped and decays linearly to 0 over its TTL, so a stale
//    call fades to neutral instead of being ridden forever ("no signal ⇒ q*→0").
//  • VALIDATED — a view sizes carry only if explicitly marked validated (bounded by
//    the analyst's own conviction); an unvalidated view reports validated=false and
//    the runtime sizes no carry from it.
// The data-vs-view conflict cap lives in CompositeBiasSource, not here.

export interface ManualView {
  /** Raw directional call in [−1,+1] (clamped on set). */
  readonly bias: number;
  /** When the view was set (ms epoch). */
  readonly setAtMs: number;
  /** Linear decay-to-zero window (ms). After this the view is fully expired (0). */
  readonly ttlMs: number;
  /** The view may size carry only if validated (bounded + OOS-sane). */
  readonly validated: boolean;
  /** Optional human note (e.g. 'DAO thesis: accumulate ETH'). */
  readonly reason?: string;
}

export class ManualBiasSource implements IBiasSource {
  private readonly views = new Map<string, ManualView>();

  /** Set/replace the house view for a symbol (the pre-run decision / control plane). */
  setView(symbol: string, view: ManualView): void {
    this.views.set(symbol.toUpperCase(), { ...view, bias: clampBias(view.bias) });
  }

  /** Drop a symbol's view (flatten the target back to neutral). */
  clearView(symbol: string): void {
    this.views.delete(symbol.toUpperCase());
  }

  /** Current views (for the control-plane read / UI). */
  list(): ReadonlyMap<string, ManualView> {
    return this.views;
  }

  bias(symbol: string, ctx: BiasContext): BiasReading {
    const v = this.views.get(symbol.toUpperCase());
    if (!v) return { bias: 0, validated: true, reason: 'no view' };
    const age = ctx.nowMs - v.setAtMs;
    // Linear decay to 0 over the TTL; before setAt → full, after → expired.
    const decay = v.ttlMs > 0 ? Math.max(0, Math.min(1, 1 - age / v.ttlMs)) : age <= 0 ? 1 : 0;
    const b = clampBias(v.bias * decay);
    return { bias: b, validated: v.validated, reason: v.reason ?? 'house view' };
  }
}
