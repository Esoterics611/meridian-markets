import { Bar } from './bar';

// SyntheticFeed — generates N bars of correlated mock price series for two
// symbols whose log-spread is a clean sine wave. This is the deterministic
// foundation for the demo: same N and seed → same bars → same trades →
// same metrics, every run. No RNG; everything is a closed-form function of i.

export interface SyntheticFeedConfig {
  symbolA: string;
  symbolB: string;
  /** Number of bars to generate. */
  barCount: number;
  /** Spread sine period in bars (e.g. 30 → one full cycle every 30 bars). */
  spreadPeriodBars: number;
  /** Half-amplitude of the log-spread oscillation. 0.05 → ±5% spread swings. */
  spreadAmplitude: number;
  /** Base price for symbol B (e.g. 2000). symbol A tracks B times exp(spread). */
  basePriceB: number;
  /** Multiplier relating symbol A to symbol B at spread=0 (e.g. 25 means BTC ≈ 25×ETH). */
  aOverBRatio: number;
  /** Bar interval, ms. */
  barIntervalMs: number;
  /** First bar's timestamp. */
  startAt: Date;
}

export function generateSyntheticFeed(cfg: SyntheticFeedConfig): { a: Bar[]; b: Bar[] } {
  const aBars: Bar[] = [];
  const bBars: Bar[] = [];
  for (let i = 0; i < cfg.barCount; i++) {
    // Smooth random-walk-like drift on logB so the absolute prices wander
    // without the spread doing so. The "noise" here is a higher-frequency
    // cosine — still deterministic, but breaks perfect periodicity.
    const driftLogB = 0.0005 * i + 0.002 * Math.cos((2 * Math.PI * i) / 17);
    const logSpread =
      cfg.spreadAmplitude * Math.sin((2 * Math.PI * i) / cfg.spreadPeriodBars) +
      0.003 * Math.cos((2 * Math.PI * i) / 7);
    const logB = Math.log(cfg.basePriceB) + driftLogB;
    const logA = Math.log(cfg.basePriceB * cfg.aOverBRatio) + driftLogB + logSpread;
    const pa = Math.exp(logA);
    const pb = Math.exp(logB);
    const ts = new Date(cfg.startAt.getTime() + i * cfg.barIntervalMs);
    aBars.push({
      symbol: cfg.symbolA,
      timestamp: ts,
      open: pa,
      high: pa * 1.001,
      low: pa * 0.999,
      close: pa,
      volume: 100,
    });
    bBars.push({
      symbol: cfg.symbolB,
      timestamp: ts,
      open: pb,
      high: pb * 1.001,
      low: pb * 0.999,
      close: pb,
      volume: 100,
    });
  }
  return { a: aBars, b: bBars };
}
