import { BookDelta, HedgeConfig, bookDeltaUsd } from './desk-delta-hedger';

// HedgeQualityTracker — the §0 KPI of docs/residual_mm_risk_study.md.
//
// The hedger's headline ("neutralises 99.8% of gross delta") is a DELTA residual, and delta is
// not what bleeds the desk: a beta hedge cannot touch the (1−ρ²)·σ² basis term, so with hedge
// betas fit at R²=0.5–0.8, 45–71% of an alt's volatility is still live on the book after a
// "perfect" hedge. This tracker measures the thing itself: the marked-P&L variance of held
// inventory, decomposed into
//   factor_i = q_usd · β_i · r_underlying   (what the delta hedge can suppress)
//   basis_i  = q_usd · r_book − factor_i    (what it cannot — the carry cost of warehousing i)
// plus a live realized β and R² per book (return-based, inventory-independent) to hold against
// the configured beta map. Desk-level series are summed per bucket BEFORE squaring, so cross-book
// netting (long ETH-beta here, short there) shows up in the desk numbers — the WP3 prize,
// measured before it is built.
//
// Sampling is BUCKETED, not per hedge tick (WP1.1): at the 100ms hedge cadence alt/major returns
// decorrelate mechanically (the Epps effect — the first live read printed ADA β_live −29 at
// R² 0.002 against a 30d×1h OLS of ~1.0), which over-attributes variance to basis. Inventory-carry
// risk lives at seconds-to-minutes, so the tracker compounds returns over `bucketMs` (default 60s)
// buckets — feed it every tick, it closes a bucket once enough time has elapsed. Inventory is
// valued at bucket OPEN (the position carried through the bucket).
//
// Mechanics: time-decayed EWMA second moments of dt-normalised rates (x²/dt → USD²/hour;
// uncentered — drift ≪ vol at these horizons), so irregular bucket lengths are handled and the
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

/** The persistent moment accumulators for one book (survive across buckets). */
interface BookMoments {
  pnlVar: TimeEwma; // E[pnl²/dt]   USD²/hour
  factorVar: TimeEwma;
  basisVar: TimeEwma;
  covIU: TimeEwma; // E[r_i·r_u/dt] — return moments for live beta / R²
  varI: TimeEwma;
  varU: TimeEwma;
  samples: number;
}

/** What a book looked like when the current bucket opened. */
interface BucketOpen {
  midMicros: bigint;
  qtyUsd: number;
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
  /** The measurement horizon: returns are compounded over buckets of this length (WP1.1). */
  bucketMs: number;
  /** Vol of the desk's summed marked-P&L increments, USD per √hour (netting included). */
  deskPnlVolUsdPerHour: number;
  /** Desk factor vol — ≈ what the delta hedge suppresses. */
  deskFactorVolUsdPerHour: number;
  /** Desk basis vol — the unhedgeable residual; THE number to drive down per $ of spread. */
  deskBasisVolUsdPerHour: number;
  perBook: BookHedgeQuality[];
}

export class HedgeQualityTracker {
  private readonly moments = new Map<string, BookMoments>();
  private bucketOpenTs: number | null = null;
  private readonly bucketBooks = new Map<string, BucketOpen>();
  private readonly bucketMarks = new Map<string, bigint>();
  private deskSamples = 0;
  private readonly deskPnlVar: TimeEwma;
  private readonly deskFactorVar: TimeEwma;
  private readonly deskBasisVar: TimeEwma;

  constructor(
    private readonly betaMap: HedgeConfig['betaMap'],
    private readonly halfLifeHours = 0.5,
    private readonly bucketMs = 60_000,
  ) {
    this.deskPnlVar = new TimeEwma(halfLifeHours);
    this.deskFactorVar = new TimeEwma(halfLifeHours);
    this.deskBasisVar = new TimeEwma(halfLifeHours);
  }

  private mapOf(symbol: string): { underlying: string; beta: number } {
    return this.betaMap[symbol] ?? { underlying: symbol, beta: 1 };
  }

  private momentsOf(symbol: string): BookMoments {
    let m = this.moments.get(symbol);
    if (!m) {
      m = {
        pnlVar: new TimeEwma(this.halfLifeHours),
        factorVar: new TimeEwma(this.halfLifeHours),
        basisVar: new TimeEwma(this.halfLifeHours),
        covIU: new TimeEwma(this.halfLifeHours),
        varI: new TimeEwma(this.halfLifeHours),
        varU: new TimeEwma(this.halfLifeHours),
        samples: 0,
      };
      this.moments.set(symbol, m);
    }
    return m;
  }

  /** Open a fresh bucket at the current books/marks. */
  private openBucket(books: BookDelta[], marks: Record<string, bigint>, tsMs: number): void {
    this.bucketOpenTs = tsMs;
    this.bucketBooks.clear();
    this.bucketMarks.clear();
    for (const b of books) {
      if (b.midMicros > 0n) this.bucketBooks.set(b.symbol, { midMicros: b.midMicros, qtyUsd: bookDeltaUsd(b) });
    }
    for (const [u, p] of Object.entries(marks)) if (p && p > 0n) this.bucketMarks.set(u, p);
  }

  /**
   * Feed once per hedge tick with exactly what the hedger already resolves: the live book deltas
   * and the consistent per-underlying marks. Ticks inside the current bucket are free (no work);
   * the tick that crosses the bucket boundary closes it — compounded open→close returns, inventory
   * valued at bucket open — and opens the next one.
   */
  update(books: BookDelta[], marks: Record<string, bigint>, tsMs: number): void {
    if (this.bucketOpenTs === null) {
      this.openBucket(books, marks, tsMs);
      return;
    }
    const elapsedMs = tsMs - this.bucketOpenTs;
    if (elapsedMs < this.bucketMs) return;
    const dtHours = elapsedMs / 3_600_000;

    let deskPnl = 0;
    let deskFactor = 0;
    let deskMeasured = false;

    for (const b of books) {
      if (b.midMicros <= 0n) continue;
      const open = this.bucketBooks.get(b.symbol);
      if (!open || open.midMicros <= 0n) continue;
      const { underlying, beta } = this.mapOf(b.symbol);
      const openMark = this.bucketMarks.get(underlying);
      const closeMark = marks[underlying];
      if (openMark === undefined || openMark <= 0n || closeMark === undefined || closeMark <= 0n) continue;

      const rI = Number(b.midMicros) / Number(open.midMicros) - 1;
      const rU = Number(closeMark) / Number(openMark) - 1;
      const pnl = open.qtyUsd * rI;
      const factor = open.qtyUsd * beta * rU;
      const basis = pnl - factor;
      const m = this.momentsOf(b.symbol);
      m.pnlVar.update((pnl * pnl) / dtHours, dtHours);
      m.factorVar.update((factor * factor) / dtHours, dtHours);
      m.basisVar.update((basis * basis) / dtHours, dtHours);
      m.covIU.update((rI * rU) / dtHours, dtHours);
      m.varI.update((rI * rI) / dtHours, dtHours);
      m.varU.update((rU * rU) / dtHours, dtHours);
      m.samples += 1;
      deskPnl += pnl;
      deskFactor += factor;
      deskMeasured = true;
    }

    if (deskMeasured) {
      const deskBasis = deskPnl - deskFactor;
      this.deskPnlVar.update((deskPnl * deskPnl) / dtHours, dtHours);
      this.deskFactorVar.update((deskFactor * deskFactor) / dtHours, dtHours);
      this.deskBasisVar.update((deskBasis * deskBasis) / dtHours, dtHours);
      this.deskSamples += 1;
    }

    this.openBucket(books, marks, tsMs);
  }

  private static vol(e: TimeEwma): number {
    const m = e.mean();
    return m !== null && m > 0 ? Math.sqrt(m) : 0;
  }

  snapshot(): HedgeQualitySnapshot {
    const perBook: BookHedgeQuality[] = [];
    for (const [symbol, m] of [...this.moments.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const { underlying, beta } = this.mapOf(symbol);
      const cov = m.covIU.mean();
      const vI = m.varI.mean();
      const vU = m.varU.mean();
      const betaLive = cov !== null && vU !== null && vU > 0 ? cov / vU : null;
      const r2 = cov !== null && vI !== null && vU !== null && vI > 0 && vU > 0 ? Math.min(1, (cov * cov) / (vI * vU)) : null;
      const pnlVar = m.pnlVar.mean() ?? 0;
      const basisVar = m.basisVar.mean() ?? 0;
      perBook.push({
        symbol,
        underlying,
        betaCfg: beta,
        betaLive,
        r2,
        pnlVolUsdPerHour: HedgeQualityTracker.vol(m.pnlVar),
        factorVolUsdPerHour: HedgeQualityTracker.vol(m.factorVar),
        basisVolUsdPerHour: HedgeQualityTracker.vol(m.basisVar),
        basisShare: pnlVar > 0 ? Math.min(1, basisVar / pnlVar) : null,
        samples: m.samples,
      });
    }
    return {
      samples: this.deskSamples,
      bucketMs: this.bucketMs,
      deskPnlVolUsdPerHour: HedgeQualityTracker.vol(this.deskPnlVar),
      deskFactorVolUsdPerHour: HedgeQualityTracker.vol(this.deskFactorVar),
      deskBasisVolUsdPerHour: HedgeQualityTracker.vol(this.deskBasisVar),
      perBook,
    };
  }
}
