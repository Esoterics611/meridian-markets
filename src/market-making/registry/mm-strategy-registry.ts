import { IQuoter } from '../quote/quoter.interface';
import { SymmetricQuoter } from '../quote/symmetric-quoter';
import { AvellanedaStoikovQuoter } from '../quote/avellaneda-stoikov';
import { GlftQuoter } from '../quote/glft-quoter';

// MmStrategyRegistry — the desk's catalogue of tradeable market-making
// strategies, the direct analogue of stat-arb's StrategyRegistry. Each entry is
// a self-contained MmStrategyDefinition: an id, the course family, a human
// label, the course chapter it's drawn from, its frozen default tuning, and a
// build() that produces a fresh IQuoter for a book. Everything registered here
// satisfies the IQuoter contract, so any entry drops into the bar backtest
// (MmBacktestRunner) AND the live paper book (MmBook) unchanged — the same swap
// seam stat-arb is built around.

export type MmFamily = 'symmetric' | 'avellaneda-stoikov' | 'glft';

/** Book-level structure the desk supplies per deployment; `params` overrides frozen tuning. */
export interface MmStrategyBuildOpts {
  /** Asset units quoted per side. */
  quoteSizeUnits: bigint;
  /** Half-spread floor in bps of mid (venue tick / fee floor). */
  minHalfSpreadBps: number;
  /** Half-spread cap in bps of mid (safety rail). */
  maxHalfSpreadBps: number;
  /** Saturation cap on |inventory|, in lots (one lot = one quote size). */
  maxInventoryLots: number;
  /** Per-launch overrides of the frozen defaultParams (e.g. { gamma, kappa }). */
  params?: Record<string, number>;
}

export interface MmStrategyDefinition {
  id: string;
  family: MmFamily;
  label: string;
  description: string;
  courseRef: string;
  /** Whether this quoter runs in the live paper book today. */
  liveCapable: boolean;
  /** Frozen default tuning, surfaced to the UI for transparency. */
  defaultParams: Record<string, number>;
  build(opts: MmStrategyBuildOpts): IQuoter;
}

const SYMMETRIC: MmStrategyDefinition = {
  id: 'mm-symmetric',
  family: 'symmetric',
  label: 'Symmetric — fixed half-spread',
  description:
    'Baseline (§3): bid/ask equidistant from mid at a fixed half-spread, no inventory skew. The control AS/GLFT are measured against — it visibly accumulates one-sided inventory in a trend.',
  courseRef: '§3 Symmetric baseline',
  liveCapable: true,
  defaultParams: { halfSpreadBps: 4 },
  build: ({ quoteSizeUnits, minHalfSpreadBps, params }) => {
    const p = { halfSpreadBps: 4, ...params };
    return new SymmetricQuoter({ halfSpreadBps: Math.max(p.halfSpreadBps, minHalfSpreadBps), quoteSizeUnits });
  },
};

const AVELLANEDA_STOIKOV: MmStrategyDefinition = {
  id: 'mm-avellaneda-stoikov',
  family: 'avellaneda-stoikov',
  label: 'Avellaneda-Stoikov — inventory-aware',
  description:
    'AS08 (§3): reservation price r=s−qγσ²(T−t) skews both quotes to shed inventory, optimal half-spread γσ²(T−t)+(2/γ)ln(1+γ/κ). The core inventory-aware quoter.',
  courseRef: '§3 Avellaneda-Stoikov',
  liveCapable: true,
  defaultParams: { gamma: 0.0025, kappa: 2, horizonBars: 1 },
  build: ({ quoteSizeUnits, minHalfSpreadBps, maxHalfSpreadBps, maxInventoryLots, params }) => {
    const p = { gamma: 0.0025, kappa: 2, ...params };
    return new AvellanedaStoikovQuoter({
      gamma: p.gamma,
      kappa: p.kappa,
      quoteSizeUnits,
      minHalfSpreadBps,
      maxHalfSpreadBps,
      maxInventoryLots,
    });
  },
};

const GLFT: MmStrategyDefinition = {
  id: 'mm-glft',
  family: 'glft',
  label: 'GLFT — steady-state quoting',
  description:
    'Guéant-Lehalle-Fernández-Tapia (§3.5): the infinite-horizon limit of AS — inventory skew and half-spread don\'t decay as a session clock runs out, the right choice for a continuously-running book.',
  courseRef: '§3.5 GLFT steady state',
  liveCapable: true,
  defaultParams: { gamma: 0.0025, kappa: 2, steadyHorizonBars: 1 },
  build: ({ quoteSizeUnits, minHalfSpreadBps, maxHalfSpreadBps, maxInventoryLots, params }) => {
    const p = { gamma: 0.0025, kappa: 2, steadyHorizonBars: 1, ...params };
    return new GlftQuoter({
      gamma: p.gamma,
      kappa: p.kappa,
      quoteSizeUnits,
      minHalfSpreadBps,
      maxHalfSpreadBps,
      maxInventoryLots,
      steadyHorizonBars: p.steadyHorizonBars,
    });
  },
};

const DEFINITIONS: MmStrategyDefinition[] = [SYMMETRIC, AVELLANEDA_STOIKOV, GLFT];

export class MmStrategyRegistry {
  private readonly byId = new Map<string, MmStrategyDefinition>();

  constructor(defs: MmStrategyDefinition[] = DEFINITIONS) {
    for (const d of defs) this.register(d);
  }

  register(def: MmStrategyDefinition): void {
    if (this.byId.has(def.id)) throw new Error(`duplicate mm strategy id: ${def.id}`);
    this.byId.set(def.id, def);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): MmStrategyDefinition {
    const d = this.byId.get(id);
    if (!d) throw new Error(`unknown mm strategy id: ${id}`);
    return d;
  }

  liveCapable(): MmStrategyDefinition[] {
    return [...this.byId.values()].filter((d) => d.liveCapable);
  }

  all(): MmStrategyDefinition[] {
    return [...this.byId.values()];
  }

  build(id: string, opts: MmStrategyBuildOpts): IQuoter {
    return this.get(id).build(opts);
  }
}

/** Process-wide default registry. */
export const mmStrategyRegistry = new MmStrategyRegistry();
