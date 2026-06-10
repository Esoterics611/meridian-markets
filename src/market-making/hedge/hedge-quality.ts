import { BookDelta, HedgeConfig, bookDeltaUsd } from './desk-delta-hedger';

// HedgeQualityTracker — the §0 KPI of docs/residual_mm_risk_study.md.
//
// The hedger's headline ("neutralises 99.8% of gross delta") is a DELTA residual, and delta is
// not what bleeds the desk: a beta hedge cannot touch the (1−ρ²)·σ² basis term, so with hedge
// betas fit at R²=0.5–0.8, 45–71% of an alt's volatility is still live on the book after a
// "perfect" hedge. This tracker measures the thing itself: the marked-P&L variance of held
// inventory, decomposed per tick into
//   factor_i = q_usd · β_i · r_underlying   (what the delta hedge can suppress)
//   basis_i  = q_usd · r_book − factor_i    (what it cannot — the carry cost of warehousing i)
// plus a live realized β and R² per book (return-based, inventory-independent) to hold against
// the configured beta map. Desk-level series are summed per tick BEFORE squaring, so cross-book
// netting (long ETH-beta here, short there) shows up in the desk numbers — the WP3 prize,
// measured before it is built.
//
// Mechanics: time-decayed EWMA second moments of dt-normalised rates (x²/dt → USD²/hour;
// uncentered — drift ≪ vol at hedge-tick cadence), so irregular tick spacing is handled and the
// outputs read as USD vol per √hour. Floats throughout: this is a diagnostic, not accounting.

/** Time-decayed EWMA of a rate, robust to irregular sampling. */
class TimeEwma {
  private value = 0;
  private weight = 0; // → 1 as samples accumulate; used to de-bias the early window

  constructor(private readonly halfLifeHours: number) {}

  update(x: number, dtHours: number): void {
    const decay = Math.exp((-Math.LN2 * dtHours) / this.halfLifeHours);
    this.value = this.value * decay + x * (1 - decay);
    this.weight = this.weight * decay + (1 - decay);
  }

  /** De-biased mean; null until the first sample lands. */
  mean(): number | null {
    return this.weight > 0 ? this.value / this.weight : null;
  }
}

interface BookState {
  lastMidMicros: bigint;
  /** USD value of the inventory held BEFORE the current tick (prev units at prev mark). */
  lastQtyUsd: number;
  pnlVar: TimeEwma; // E[pnl²/dt]   USD²/hour
  factorVar: TimeEwma;
  basisVar: TimeEwma;
  covIU: TimeEwma; // E[r_i·r_u/dt] — return moments for live beta / R²
  varI: TimeEwma;
  varU: TimeEwma;
  samples: number;
}

export interface BookHedgeQuality {
  symbol: string;
  underlying: string;
  betaCfg: number;
  /** Realized EWMA beta of the book's mid to its hedge underlying; null until measurable. */
  betaLive: number | null;
  /** Realized ρ² of the book's returns vs the hedge underlying — the hedgeable share. */
  r2: number | null;
  /** Vol of the book's marked inventory P&L, USD per √hour. */
  pnlVolUsdPerHour: number;
  /** The part a beta hedge can suppress. */
  factorVolUsdPerHour: number;
  /** The (1−ρ²) part the hedge cannot touch — the basis leak. */
  basisVolUsdPerHour: number;
  /** basisVar / pnlVar in [0,1]; the fraction of this book's risk the delta hedge misses. */
  basisShare: number | null;
  samples: number;
}

export interface HedgeQualitySnapshot {
  samples: number;
  /** Vol of the desk's summed marked-P&L increments, USD per √hour (netting included). */
  deskPnlVolUsdPerHour: number;
  /** Desk factor vol — ≈ what the delta hedge suppresses. */
  deskFactorVolUsdPerHour: number;
  /** Desk basis vol — the unhedgeable residual; THE number to drive down per $ of spread. */
  deskBasisVolUsdPerHour: number;
  perBook: BookHedgeQuality[];
}

export class HedgeQualityTracker {
  private readonly books = new Map<string, BookState>();
  private readonly lastMark = new Map<string, bigint>();
  private lastTsMs: number | null = null;
  private deskSamples = 0;
  private readonly deskPnlVar: TimeEwma;
  private readonly deskFactorVar: TimeEwma;
  private readonly deskBasisVar: TimeEwma;

  constructor(
    private readonly betaMap: HedgeConfig['betaMap'],
    private readonly halfLifeHours = 0.5,
  ) {
    this.deskPnlVar = new TimeEwma(halfLifeHours);
    this.deskFactorVar = new TimeEwma(halfLifeHours);
    this.deskBasisVar = new TimeEwma(halfLifeHours);
  }

  private mapOf(symbol: string): { underlying: string; beta: number } {
    return this.betaMap[symbol] ?? { underlying: symbol, beta: 1 };
  }

  /**
   * One sample, fed with exactly what the hedger already resolves each tick: the live book deltas
   * and the consistent per-underlying marks. The first tick (and any dt≤0 tick) only primes state.
   */
  update(books: BookDelta[], marks: Record<string, bigint>, tsMs: number): void {
    const dtHours = this.lastTsMs === null ? 0 : (tsMs - this.lastTsMs) / 3_600_000;
    if (this.lastTsMs !== null && dtHours <= 0) return;
    this.lastTsMs = tsMs;

    let deskPnl = 0;
    let deskFactor = 0;
    let deskMeasured = false;

    for (const b of books) {
      if (b.midMicros <= 0n) continue;
      const { underlying, beta } = this.mapOf(b.symbol);
      const mark = marks[underlying];
      const st = this.books.get(b.symbol);
      const lastMark = this.lastMark.get(underlying);

      if (st && dtHours > 0 && st.lastMidMicros > 0n && lastMark !== undefined && lastMark > 0n && mark !== undefined && mark > 0n) {
        const rI = Number(b.midMicros) / Number(st.lastMidMicros) - 1;
        const rU = Number(mark) / Number(lastMark) - 1;
        const pnl = st.lastQtyUsd * rI;
        const factor = st.lastQtyUsd * beta * rU;
        const basis = pnl - factor;
        st.pnlVar.update((pnl * pnl) / dtHours, dtHours);
        st.factorVar.update((factor * factor) / dtHours, dtHours);
        st.basisVar.update((basis * basis) / dtHours, dtHours);
        st.covIU.update((rI * rU) / dtHours, dtHours);
        st.varI.update((rI * rI) / dtHours, dtHours);
        st.varU.update((rU * rU) / dtHours, dtHours);
        st.samples += 1;
        deskPnl += pnl;
        deskFactor += factor;
        deskMeasured = true;
      }

      const next: BookState = st ?? {
        lastMidMicros: 0n,
        lastQtyUsd: 0,
        pnlVar: new TimeEwma(this.halfLifeHours),
        factorVar: new TimeEwma(this.halfLifeHours),
        basisVar: new TimeEwma(this.halfLifeHours),
        covIU: new TimeEwma(this.halfLifeHours),
        varI: new TimeEwma(this.halfLifeHours),
        varU: new TimeEwma(this.halfLifeHours),
        samples: 0,
      };
      next.lastMidMicros = b.midMicros;
      next.lastQtyUsd = bookDeltaUsd(b);
      this.books.set(b.symbol, next);
    }

    for (const [u, p] of Object.entries(marks)) if (p && p > 0n) this.lastMark.set(u, p);

    if (deskMeasured && dtHours > 0) {
      const deskBasis = deskPnl - deskFactor;
      this.deskPnlVar.update((deskPnl * deskPnl) / dtHours, dtHours);
      this.deskFactorVar.update((deskFactor * deskFactor) / dtHours, dtHours);
      this.deskBasisVar.update((deskBasis * deskBasis) / dtHours, dtHours);
      this.deskSamples += 1;
    }
  }

  private static vol(e: TimeEwma): number {
    const m = e.mean();
    return m !== null && m > 0 ? Math.sqrt(m) : 0;
  }

  snapshot(): HedgeQualitySnapshot {
    const perBook: BookHedgeQuality[] = [];
    for (const [symbol, st] of [...this.books.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const { underlying, beta } = this.mapOf(symbol);
      const cov = st.covIU.mean();
      const vI = st.varI.mean();
      const vU = st.varU.mean();
      const betaLive = cov !== null && vU !== null && vU > 0 ? cov / vU : null;
      const r2 = cov !== null && vI !== null && vU !== null && vI > 0 && vU > 0 ? Math.min(1, (cov * cov) / (vI * vU)) : null;
      const pnlVar = st.pnlVar.mean() ?? 0;
      const basisVar = st.basisVar.mean() ?? 0;
      perBook.push({
        symbol,
        underlying,
        betaCfg: beta,
        betaLive,
        r2,
        pnlVolUsdPerHour: HedgeQualityTracker.vol(st.pnlVar),
        factorVolUsdPerHour: HedgeQualityTracker.vol(st.factorVar),
        basisVolUsdPerHour: HedgeQualityTracker.vol(st.basisVar),
        basisShare: pnlVar > 0 ? Math.min(1, basisVar / pnlVar) : null,
        samples: st.samples,
      });
    }
    return {
      samples: this.deskSamples,
      deskPnlVolUsdPerHour: HedgeQualityTracker.vol(this.deskPnlVar),
      deskFactorVolUsdPerHour: HedgeQualityTracker.vol(this.deskFactorVar),
      deskBasisVolUsdPerHour: HedgeQualityTracker.vol(this.deskBasisVar),
      perBook,
    };
  }
}
