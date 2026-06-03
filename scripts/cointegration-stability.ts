/**
 * Cointegration-stability map — the "is this spread real, or a short-window
 * artifact?" probe across the whole tradeable universe.
 *
 * Motivation (Journal Entry #5): the ai-data z-score candidate found 19
 * "cointegrated" pairs over 30 days, 4 over 90 days, and ZERO over 180/365 days
 * — i.e. the cointegration that the scanner reports on a short window largely
 * evaporates as the window grows. A spread you only see for a few weeks is not a
 * spread; trading it is trading transient correlation. This script makes that
 * cliff visible for every asset-class preset at once, so the desk can tell which
 * classes (if any) carry cointegration that PERSISTS long enough to trust.
 *
 * For each preset × horizon it pulls real Binance klines, aligns on common
 * timestamps, runs the same discoverPairs() gate the scanner/OOS harness use
 * (pValueCutoff 0.6, maxHalfLifeBars 240), and reports the surviving pair count.
 * A class whose count holds up across horizons is a candidate for the OOS gate
 * (scripts/oos-candidates.ts); a class whose count collapses to 0 is noise.
 *
 * DB-free, no server, no API key — same path as scripts/quant-research.ts.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts
 *   STAB_HORIZONS=30,90,180 STAB_INTERVAL=15m \
 *     STAB_PRESETS=ai-data,l1-smart-contract,eth-ecosystem \
 *     npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts
 *
 * Writes the full result to docs/research/<ts>-cointegration-stability.json.
 */
import 'dotenv/config'; // load .env so ALPACA_*/STAB_* work without manual export
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Bar } from '../src/stat-arb/backtest/bar';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { AlpacaDataClient } from '../src/stat-arb/feed/alpaca/alpaca-data-client';
import { YahooDailyClient } from '../src/stat-arb/feed/yahoo/yahoo-daily-client';
import { discoverPairs } from '../src/stat-arb/discovery/pair-discovery';
import { getAnyPreset, EQUITY_PRESETS, MarketPreset } from '../src/stat-arb/markets/market-presets';

// STAB_SOURCE=binance (default, crypto) | alpaca (US equities, ~2016+) | yahoo
// (US equities, decades of split/div-adjusted DAILY history — the cliff test over
// the longest window). Does a same-sector basket HOLD cointegration across decades
// where crypto collapsed to 0 in months (Journal #5, the cliff)?
const SOURCE = (process.env.STAB_SOURCE ?? 'binance').trim().toLowerCase();
const IS_YAHOO = SOURCE === 'yahoo';
const IS_EQUITY = SOURCE === 'alpaca' || IS_YAHOO;

const CRYPTO_PRESETS = [
  'crypto-majors', 'ai-data', 'l1-smart-contract', 'eth-ecosystem',
  'gaming-meta', 'defi-bluechip', 'payments-sov', 'fx-stables', 'stablecoin-peg',
];
const EQUITY_PRESET_IDS = EQUITY_PRESETS.map((p) => p.id);
const ALL_PRESETS = IS_EQUITY ? EQUITY_PRESET_IDS : CRYPTO_PRESETS;
const PRESETS = (process.env.STAB_PRESETS ?? ALL_PRESETS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const HORIZONS = (process.env.STAB_HORIZONS ?? '30,90,180').split(',').map(Number);
const INTERVAL = process.env.STAB_INTERVAL ?? '15m';
const P_CUTOFF = Number(process.env.STAB_PVALUE ?? 0.6);
const MAX_HALFLIFE = Number(process.env.STAB_MAX_HALFLIFE ?? 240);
const MIN_BARS = Number(process.env.STAB_MIN_BARS ?? 400);

const IV_MIN: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };

function alignMany(bySymbol: Map<string, Bar[]>): Map<string, Bar[]> {
  const symbols = [...bySymbol.keys()];
  if (!symbols.length) return new Map();
  const counts = new Map<number, number>();
  for (const bars of bySymbol.values()) {
    const seen = new Set<number>();
    for (const b of bars) seen.add(b.timestamp.getTime());
    for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const common = new Set<number>();
  for (const [t, n] of counts) if (n === symbols.length) common.add(t);
  const out = new Map<string, Bar[]>();
  for (const [sym, bars] of bySymbol) out.set(sym, bars.filter((b) => common.has(b.timestamp.getTime())));
  return out;
}

interface CellResult {
  preset: string;
  horizonDays: number;
  alignedSymbols: number;
  commonBars: number;
  pairs: number;
  topPairs: Array<{ pair: string; pValue: number; halfLifeBars: number; beta: number }>;
}

async function main() {
  const isAlpaca = SOURCE === 'alpaca';
  const binance = new BinancePublicClient({ quote: 'USDT' });
  const alpaca = isAlpaca
    ? new AlpacaDataClient({
        keyId: process.env.ALPACA_KEY_ID ?? '',
        secret: process.env.ALPACA_SECRET ?? '',
        dataBaseUrl: process.env.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets',
        feed: process.env.ALPACA_DATA_FEED ?? 'iex',
      })
    : undefined;
  const yahoo = IS_YAHOO ? new YahooDailyClient() : undefined;
  if (isAlpaca && (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET)) {
    console.error('STAB_SOURCE=alpaca requires ALPACA_KEY_ID and ALPACA_SECRET in the environment.');
    process.exit(1);
  }

  // Source-agnostic bar loader: the discovery gate downstream is identical.
  const load = (preset: MarketPreset, sym: string, fromMs: number, toMs: number): Promise<Bar[]> => {
    if (IS_YAHOO) return yahoo!.historicalBars(sym, INTERVAL, fromMs, toMs);
    if (isAlpaca) return alpaca!.historicalBars(sym, INTERVAL, fromMs, toMs);
    const cli = preset.quote && preset.quote !== 'USDT' ? new BinancePublicClient({ quote: preset.quote }) : binance;
    return cli.historicalKlines(sym, INTERVAL, fromMs, toMs);
  };

  const toMs = Date.now();
  const results: CellResult[] = [];

  console.log(`\n=== Cointegration-stability map · source=${SOURCE} · ${INTERVAL} · pCutoff<${P_CUTOFF} · maxHalfLife=${MAX_HALFLIFE} bars ===`);
  console.log(`presets: ${PRESETS.join(', ')}`);
  console.log(`horizons (days): ${HORIZONS.join(', ')}\n`);
  console.log('preset'.padEnd(20) + HORIZONS.map((h) => `${h}d`.padEnd(9)).join('') + 'note');

  for (const presetId of PRESETS) {
    const preset = getAnyPreset(presetId);
    if (!preset) { console.log(presetId.padEnd(20) + 'unknown preset'); continue; }
    const cells: Record<number, CellResult> = {};
    for (const days of HORIZONS) {
      const fromMs = toMs - days * 86_400_000;
      const bySymbol = new Map<string, Bar[]>();
      for (const sym of preset.symbols) {
        try {
          const bars = await load(preset, sym, fromMs, toMs);
          if (bars.length > 0) bySymbol.set(sym, bars);
        } catch { /* skip unlisted/sparse symbol */ }
      }
      const aligned = alignMany(bySymbol);
      const lens = [...aligned.values()].map((b) => b.length);
      const minLen = lens.length ? Math.min(...lens) : 0;
      let pairs: CellResult['topPairs'] = [];
      let count = 0;
      if (aligned.size >= 2 && minLen >= MIN_BARS) {
        const cands = discoverPairs(aligned, { minBars: MIN_BARS, pValueCutoff: P_CUTOFF, maxHalfLifeBars: MAX_HALFLIFE });
        count = cands.length;
        pairs = cands.slice(0, 5).map((c) => ({
          pair: `${c.symbolA}/${c.symbolB}`, pValue: Number(c.pValue.toFixed(3)),
          halfLifeBars: Number(c.halfLifeBars.toFixed(1)), beta: Number(c.beta.toFixed(3)),
        }));
      }
      cells[days] = { preset: presetId, horizonDays: days, alignedSymbols: aligned.size, commonBars: minLen, pairs: count, topPairs: pairs };
      results.push(cells[days]);
    }
    const note = `${cells[HORIZONS[0]].alignedSymbols} sym, ${cells[HORIZONS[HORIZONS.length - 1]].commonBars} bars @ ${HORIZONS[HORIZONS.length - 1]}d`;
    console.log(presetId.padEnd(20) + HORIZONS.map((h) => String(cells[h].pairs).padEnd(9)).join('') + note);
  }

  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const outPath = join('docs', 'research', `${ts}-cointegration-stability.json`);
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(), source: SOURCE, interval: INTERVAL, pValueCutoff: P_CUTOFF,
    maxHalfLifeBars: MAX_HALFLIFE, minBars: MIN_BARS, horizonsDays: HORIZONS, presets: PRESETS, results,
  }, null, 2));
  console.log(`\nThe count is the # of pairs passing cointegration (p<${P_CUTOFF}) on the FULL window of that length.`);
  console.log(`A count that holds across horizons = persistent spread (gate it). A count that collapses to 0 = short-window artifact (do not trade).`);
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
