import { Bar } from '../../stat-arb/backtest/bar';
import { RollingVolatility } from '../quote/volatility';
import { scoreMmSuitability, MmSuitabilityScore } from './mm-suitability-scorer';

// MmScreener — the maker's "where should we quote?" board. Sweeps the MM
// instrument presets and ranks each instrument by expected market-making profit
// per day (mm-suitability-scorer): tight natural spread vs. the rebate, low vol
// (low inventory risk + low adverse selection), enough range to actually fill.
// Same DB-free, injected-loader shape as the stat-arb OpportunityScanner.
//
// Inputs from OHLCV are proxies (no L2 book / flow tape yet) — honest enough to
// rank a calm stablecoin with a rebate above a volatile major, not a fill
// forecast. Symbols are deduped across presets (suitability is instrument-level).

export type MmBarLoader = (symbol: string) => Promise<Bar[]>;

export interface MmScreenPreset {
  id: string;
  label: string;
  assetClass: string;
  symbols: string[];
}

export interface MmScreenerConfig {
  /** Half-spread we'd post, bps of mid. */
  quoteHalfSpreadBps: number;
  /** Maker fee in bps (signed; negative = rebate). */
  makerFeeBps: number;
  barsPerDay: number;
  volWindowBars: number;
  /** Adverse selection per fill as a multiple of σ_bar. */
  adverseCoef: number;
  barsToLoad: number;
}

export interface ScoredInstrument extends MmSuitabilityScore {
  symbol: string;
  presetId: string;
  assetClass: string;
  avgRangeBps: number;
}

export interface MmScreenBoard {
  generatedAt: string;
  instrumentsScored: number;
  attractive: number;
  instruments: ScoredInstrument[];
}

export class MmScreener {
  constructor(
    private readonly loadBars: MmBarLoader,
    private readonly presets: MmScreenPreset[],
    private readonly cfg: MmScreenerConfig,
  ) {}

  /** Screen all presets, or only those whose id is in `filterPresetIds`. */
  async screen(filterPresetIds?: string[]): Promise<MmScreenBoard> {
    const presets =
      filterPresetIds && filterPresetIds.length
        ? this.presets.filter((p) => filterPresetIds.includes(p.id))
        : this.presets;
    // Dedup symbols across presets, remembering the first preset that named one.
    const origin = new Map<string, { presetId: string; assetClass: string }>();
    for (const p of presets) {
      for (const s of p.symbols) {
        if (!origin.has(s)) origin.set(s, { presetId: p.id, assetClass: p.assetClass });
      }
    }

    const rebateBps = this.cfg.makerFeeBps < 0 ? -this.cfg.makerFeeBps : 0;
    const instruments: ScoredInstrument[] = [];

    for (const [symbol, where] of origin) {
      const bars = await this.loadBars(symbol).catch(() => [] as Bar[]);
      if (bars.length < this.cfg.volWindowBars + 1) continue;

      const vol = new RollingVolatility(this.cfg.volWindowBars);
      let rangeSum = 0;
      let rangeN = 0;
      for (const b of bars) {
        vol.push(b.close);
        if (b.close > 0) {
          rangeSum += ((b.high - b.low) / b.close) * 10_000;
          rangeN += 1;
        }
      }
      const volatility = vol.valueOr(1e-6);
      const avgRangeBps = rangeN > 0 ? rangeSum / rangeN : 0;

      const score = scoreMmSuitability({
        volatility,
        avgRangeBps,
        rebateBps,
        quoteHalfSpreadBps: this.cfg.quoteHalfSpreadBps,
        barsPerDay: this.cfg.barsPerDay,
        adverseCoef: this.cfg.adverseCoef,
      });

      instruments.push({ symbol, presetId: where.presetId, assetClass: where.assetClass, avgRangeBps, ...score });
    }

    instruments.sort((a, b) => b.scorePerDayBps - a.scorePerDayBps);
    return {
      generatedAt: new Date().toISOString(),
      instrumentsScored: instruments.length,
      attractive: instruments.filter((i) => i.attractive).length,
      instruments,
    };
  }
}
