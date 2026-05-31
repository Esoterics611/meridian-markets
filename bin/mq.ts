#!/usr/bin/env ts-node
/**
 * mq — the Meridian quant terminal. A thin, scriptable CLI over the engine's
 * HTTP control plane (see docs/QUANT_TERMINAL_SPEC.md). The engine is already
 * headless and terminal-drivable; this is the ergonomic front door a quant —
 * or a quant *agent* (docs/AGENTIC_HEDGE_FUND_DESIGN.md) — uses instead of curl.
 *
 * Talks to http://localhost:3100 by default; set MQ_HOST to override. Every
 * command takes --json for machine-parseable output (so an agent can consume
 * it); otherwise it prints a human table.
 *
 * Run:
 *   npm run mq -- <command> [args] [--flags]
 *   npm run mq -- discover crypto-majors --hours 72
 *   npm run mq -- sweep ETH BTC --hours 72
 *   npm run mq -- arm ETH BTC --strategy ou-bertram --capital 100000 --beta 1.07
 *   npm run mq -- status --json
 *
 * The server must be running in paper mode for live/monitor commands:
 *   FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
 *     LIVE_AUTOSTART=false npm run start:dev
 * Research/backtest/sweep/session also need Postgres on :5433 + migrations.
 */
import { spawnSync } from 'child_process';
import { parseArgs, numFlag, fmtUnits, usdcToUnits, table, rankSweep, SweepRow } from '../src/cli/mq-lib';
import { evaluateGate, thresholdsFor, RISK_GATES, RiskProfileId, GateInput } from '../src/cli/validate-gate';
import { loadRoster, findStation, Station } from '../src/cli/roster';

const BASE = process.env.MQ_HOST ?? 'http://localhost:3100';
const LIVE = '/api/stat-arb/live';
const MD = '/api/market-data';

type Query = Record<string, string | number | boolean | undefined>;

/** One HTTP round-trip to the control plane. Uses global fetch (Node 20+), the
 *  same client the live process itself uses. Surfaces unreachable-server and
 *  non-2xx responses as clear errors. */
async function api<T = any>(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Query; body?: unknown } = {},
): Promise<T> {
  const url = new URL(BASE + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `cannot reach ${url.href} — is the server running in paper mode? (${(e as Error).message})`,
    );
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 400)}`);
  return data as T;
}

const out = (s: string): void => console.log(s);
const printJson = (v: unknown): void => out(JSON.stringify(v, null, 2));

/** Print a labelled key/value block (for snapshots). */
function kv(pairs: Array<[string, string | number]>): void {
  const w = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) out(`  ${k.padEnd(w)}  ${v}`);
}

// --- commands ---------------------------------------------------------------

async function cmdPresets(json: boolean): Promise<void> {
  const r = await api('GET', `${MD}/presets`);
  if (json) return printJson(r);
  out(table(
    ['ID', 'ASSET CLASS', 'SYMBOLS', 'DEFAULT', 'LABEL'],
    r.presets.map((p: any) => [p.id, p.assetClass, p.symbols.length, (p.defaultPair ?? []).join('/'), p.label]),
  ));
}

async function cmdStrategies(json: boolean): Promise<void> {
  const r = await api('GET', `${LIVE}/strategies`);
  if (json) return printJson(r);
  out(table(
    ['ID', 'FAMILY', 'RISK', 'LABEL'],
    r.strategies.map((s: any) => [s.id, s.family, s.riskProfile, s.label]),
  ));
}

async function cmdBackfill(preset: string, hours: number, venue: string | undefined, json: boolean): Promise<void> {
  const r = await api('POST', `${MD}/backfill-preset`, { body: { presetId: preset, lookbackHours: hours, venue } });
  if (json) return printJson(r);
  if (r.error) return out(`error: ${r.error}${r.known ? ` (known: ${r.known.join(', ')})` : ''}`);
  out(`backfilled ${r.presetId}: ${r.totalBarsInserted} bars across ${r.symbols} symbols`);
  out(`window ${r.from} → ${r.to}`);
}

async function cmdDiscover(preset: string, hours: number, venue: string | undefined, json: boolean): Promise<void> {
  const r = await api('GET', `${MD}/universe`, { query: { presetId: preset, hours, venue } });
  if (json) return printJson(r);
  if (r.error) {
    out(`error: ${r.error}`);
    if (r.needsBackfill) out(`  → run: mq backfill ${preset} --hours ${hours}`);
    if (r.dropped?.length) out(`  dropped (too few bars): ${r.dropped.join(', ')}`);
    return;
  }
  const rows = (r.topPairs ?? []).map((p: any) => [
    `${p.symbolA}/${p.symbolB}`, p.beta.toFixed(3), p.pValue.toFixed(3),
    p.halfLifeBars.toFixed(0), p.score.toFixed(3), p.regime?.vol ?? '—',
  ]);
  out(table(['PAIR', 'BETA', 'P-VALUE', 'HALF-LIFE', 'SCORE', 'VOL'], rows));
  out(`\n${rows.length} cointegrated pairs (source: ${r.source})`);
}

/** Backtest one pair on one strategy over real stored bars. */
async function backtestOne(symbolA: string, symbolB: string, strategyId: string | undefined, hours: number, beta: number): Promise<any> {
  return api('POST', `${MD}/backtest`, {
    body: { symbolA, symbolB, strategyId, lookbackHours: hours, beta },
  });
}

async function cmdBacktest(a: string, b: string, strategy: string | undefined, hours: number, beta: number, json: boolean): Promise<void> {
  const r = await backtestOne(a, b, strategy, hours, beta);
  if (json) return printJson(r);
  if (r.error) return out(`error: ${r.error}`);
  const m = r.metrics;
  out(`${r.pair} · ${r.strategy} · ${r.window.bars} bars (${r.source})`);
  kv([
    ['trades', r.tradeCount],
    ['net pnl', fmtUnits(m.totalPnlUnits)],
    ['sharpe', m.sharpeRatio.toFixed(2)],
    ['max dd', `${m.maxDrawdownPct.toFixed(2)}%`],
    ['win rate', `${(m.winRate * 100).toFixed(1)}%`],
  ]);
}

/** Run every live-capable strategy on the pair and rank by Sharpe — the
 *  quant-session "backtest-all" step packaged (spec §1, Backtest). */
async function cmdSweep(a: string, b: string, hours: number, beta: number, json: boolean): Promise<void> {
  const cat = await api('GET', `${LIVE}/strategies`);
  const ids: string[] = cat.strategies.map((s: any) => s.id);
  const results: SweepRow[] = [];
  for (const id of ids) {
    try {
      const r = await backtestOne(a, b, id, hours, beta);
      if (r.error) {
        results.push({ strategy: id, tradeCount: 0, sharpe: 0, pnlUnits: '0', maxDdPct: 0, winRate: 0, error: r.error });
      } else {
        results.push({
          strategy: id, tradeCount: r.tradeCount, sharpe: r.metrics.sharpeRatio,
          pnlUnits: r.metrics.totalPnlUnits, maxDdPct: r.metrics.maxDrawdownPct, winRate: r.metrics.winRate,
        });
      }
    } catch (e) {
      results.push({ strategy: id, tradeCount: 0, sharpe: 0, pnlUnits: '0', maxDdPct: 0, winRate: 0, error: (e as Error).message });
    }
  }
  const ranked = rankSweep(results);
  if (json) return printJson({ pair: `${a}/${b}`, hours, ranked });
  out(`sweep ${a}/${b} over ${hours}h — ranked by Sharpe\n`);
  out(table(
    ['STRATEGY', 'TRADES', 'SHARPE', 'NET PNL', 'MAX DD', 'WIN%', 'NOTE'],
    ranked.map((r) => [
      r.strategy, r.tradeCount, r.sharpe.toFixed(2), r.error ? '—' : fmtUnits(r.pnlUnits),
      r.error ? '—' : `${r.maxDdPct.toFixed(1)}%`, r.error ? '—' : `${(r.winRate * 100).toFixed(0)}%`,
      r.error ? r.error.slice(0, 40) : '',
    ]),
  ));
  const winner = ranked.find((r) => !r.error && r.tradeCount > 0);
  if (winner) out(`\nwinner: ${winner.strategy} (sharpe ${winner.sharpe.toFixed(2)}, ${winner.tradeCount} trades)`);
  else out('\nno strategy produced trades on this window — try more --hours or another pair');
}

/**
 * The promotion gate (docs/AGENTIC_HEDGE_FUND_DESIGN.md §3): backtest the pair on
 * real history, resolve its risk profile, optionally re-check cointegration, then
 * run the pass/fail checklist in src/cli/validate-gate.ts. Exit 0 = cleared the
 * gate (flip the station to `paper` and arm it); exit 1 = do not promote.
 * `--preset` turns on the cointegration p-value check against the latest discovery.
 */
async function cmdValidate(
  a: string,
  b: string,
  opts: {
    strategy?: string; hours: number; beta: number;
    profile?: string; preset?: string;
    minSharpe?: number; minTrades?: number; maxPValue?: number;
  },
  json: boolean,
): Promise<number> {
  const r = await backtestOne(a, b, opts.strategy, opts.hours, opts.beta);
  if (r.error) {
    if (json) printJson({ error: r.error });
    else out(`error: ${r.error}`);
    return 1;
  }

  // Risk profile: explicit --profile wins; else the one the chosen strategy
  // declares in the catalogue; else fall back to 'balanced'.
  let profile: RiskProfileId = 'balanced';
  if (opts.profile && opts.profile in RISK_GATES) {
    profile = opts.profile as RiskProfileId;
  } else {
    try {
      const cat = await api('GET', `${LIVE}/strategies`);
      const def = (cat.strategies ?? []).find((s: any) => s.id === r.strategy);
      if (def && def.riskProfile in RISK_GATES) profile = def.riskProfile;
    } catch {
      /* catalogue unreachable — keep the 'balanced' default */
    }
  }

  // Cointegration p-value: only when --preset is given; otherwise the gate skips
  // the check (and says so). A pair absent from the discovery list is reported,
  // not silently failed — discovery truncates to the top N.
  let pValue: number | null | undefined;
  let pValueNote = '';
  if (opts.preset) {
    try {
      const u = await api('GET', `${MD}/universe`, { query: { presetId: opts.preset, hours: opts.hours } });
      const pair = (u.topPairs ?? []).find(
        (p: any) => (p.symbolA === a && p.symbolB === b) || (p.symbolA === b && p.symbolB === a),
      );
      if (pair) pValue = pair.pValue;
      else pValueNote = `pair not in '${opts.preset}' discovery top list — p-value check skipped`;
    } catch (e) {
      pValueNote = `discovery unavailable (${(e as Error).message.slice(0, 60)}) — p-value check skipped`;
    }
  }

  const thresholds = thresholdsFor(profile, {
    ...(opts.minSharpe !== undefined ? { minSharpe: opts.minSharpe } : {}),
    ...(opts.minTrades !== undefined ? { minTrades: opts.minTrades } : {}),
    ...(opts.maxPValue !== undefined ? { maxPValue: opts.maxPValue } : {}),
  });
  const m = r.metrics;
  const input: GateInput = {
    tradeCount: r.tradeCount,
    sharpe: m.sharpeRatio,
    maxDrawdownPct: m.maxDrawdownPct,
    netPnlUnits: BigInt(m.totalPnlUnits),
    pValue,
  };
  const result = evaluateGate(input, thresholds);

  if (json) {
    printJson({
      pair: r.pair, strategy: r.strategy, profile,
      window: r.window, source: r.source,
      pass: result.pass, checks: result.checks,
    });
    return result.pass ? 0 : 1;
  }

  out(`validate ${r.pair} · ${r.strategy} · profile ${profile} · ${r.window.bars} bars (${r.source})\n`);
  out(table(
    ['CHECK', 'ACTUAL', 'THRESHOLD', 'RESULT'],
    result.checks.map((c) => [
      c.name, c.actual, c.threshold,
      c.skipped ? 'SKIP' : c.pass ? 'PASS' : 'FAIL',
    ]),
  ));
  if (pValueNote) out(`\nnote: ${pValueNote}`);
  out(
    `\n${result.pass
      ? '✓ PASS — cleared the promotion gate; flip status: paper and arm it'
      : '✗ FAIL — do not promote; address the failing checks above'}`,
  );
  return result.pass ? 0 : 1;
}

/** Resolve a single positional arg against desk/roster.yaml. Returns the station
 *  for `mq <cmd> <station-id>`, null for the two-symbol pair form, and throws a
 *  clear error if a lone arg names no station. */
function resolveStation(positionals: string[], rosterPath: string | undefined): Station | null {
  if (positionals.length !== 1) return null;
  const id = positionals[0];
  const roster = loadRoster(rosterPath);
  const st = findStation(roster, id);
  if (!st) {
    const ids = roster.stations.map((s) => s.id).join(', ') || 'none';
    throw new Error(`no station '${id}' in roster (have: ${ids}) — or pass two symbols for an ad-hoc pair`);
  }
  return st;
}

/** `mq roster` — the station manifest the supervisor + tooling read. */
function cmdRoster(json: boolean, rosterPath: string | undefined): void {
  const roster = loadRoster(rosterPath);
  if (json) return printJson(roster);
  if (!roster.stations.length) return out('roster is empty — add stations to desk/roster.yaml');
  out(table(
    ['ID', 'OWNER', 'PRESET', 'PAIRS', 'STRATEGY', 'CAPITAL', 'STATUS'],
    roster.stations.map((s) => [
      s.id, s.owner ?? '—', s.preset ?? '—',
      s.pairs.map((p) => p.join('/')).join(' '),
      s.strategy ?? '—',
      s.capitalUsdc !== undefined ? `$${s.capitalUsdc.toLocaleString()}` : '—',
      s.status,
    ]),
  ));
  const paper = roster.stations.filter((s) => s.status === 'paper').length;
  out(`\n${roster.stations.length} stations · ${paper} in paper`);
}

/** Arm a roster station's book in paper. One pair → single book; a basket → portfolio. */
async function cmdArmStation(
  st: Station,
  strategyFlag: string | undefined,
  capitalFlag: number | undefined,
  beta: number | undefined,
  json: boolean,
): Promise<void> {
  const strategy = strategyFlag ?? st.strategy;
  const capital = capitalFlag ?? st.capitalUsdc ?? 100_000;
  if (!json) out(`arming station ${st.id}${st.owner ? ` · owner ${st.owner}` : ''} (was ${st.status})\n`);
  if (st.pairs.length === 1) {
    await cmdArm(st.pairs[0][0], st.pairs[0][1], strategy, capital, beta, json);
  } else {
    const pairs = st.pairs.map(([symbolA, symbolB]) => ({ symbolA, symbolB }));
    const cfg = await api('POST', `${LIVE}/portfolio`, { body: { pairs, capitalUsdc: capital, strategyId: strategy } });
    if (cfg.error) return out(`error: ${cfg.error}`);
    const snap = await api('POST', `${LIVE}/portfolio/start`);
    if (json) return printJson(snap);
    out(`armed ${st.pairs.length}-pair basket on $${capital.toLocaleString()}\n`);
    printPortfolio(snap);
  }
  if (!json) out(`\n→ set status: paper for '${st.id}' in desk/roster.yaml`);
}

function printSingleSnapshot(s: any): void {
  kv([
    ['pair', `${s.symbolA}/${s.symbolB}`],
    ['strategy', s.strategyId],
    ['running', s.running],
    ['regime', s.regime],
    ['z', s.lastZ?.toFixed?.(3) ?? s.lastZ],
    ['beta', s.beta?.toFixed?.(4) ?? s.beta],
    ['position', s.openPosition ? `${s.openPosition.side} (entry z ${s.openPosition.entryZ?.toFixed?.(2)})` : 'FLAT'],
    ['capital', fmtUnits(s.capitalUnits)],
    ['equity', fmtUnits(s.equityUnits)],
    ['realised', fmtUnits(s.realisedPnlUnits)],
    ['unrealised', fmtUnits(s.unrealisedPnlUnits)],
    ['bars seen', s.barsSeen],
    ['closed trades', s.closedTradeCount],
    ['feed/venue', `${s.feedId} / ${s.venueId}`],
  ]);
}

function printPortfolio(s: any): void {
  out(`portfolio: ${s.pairCount} books · running ${s.running} · ${s.feedId}/${s.venueId}`);
  kv([
    ['capital', fmtUnits(s.capitalUnits)],
    ['equity', fmtUnits(s.equityUnits)],
    ['realised', fmtUnits(s.realisedPnlUnits)],
    ['unrealised', fmtUnits(s.unrealisedPnlUnits)],
  ]);
  if (s.books?.length) {
    out('');
    out(table(
      ['PAIR', 'STRATEGY', 'Z', 'REGIME', 'POS', 'EQUITY', 'REAL', 'UNREAL', 'BARS'],
      s.books.map((b: any) => [
        b.pair, b.strategyId, b.lastZ?.toFixed?.(2) ?? '—', b.regime, b.position ?? 'FLAT',
        fmtUnits(b.equityUnits), fmtUnits(b.realisedPnlUnits), fmtUnits(b.unrealisedPnlUnits), b.barsSeen,
      ]),
    ));
  }
}

async function cmdArm(a: string, b: string, strategy: string | undefined, capital: number, beta: number | undefined, json: boolean): Promise<void> {
  const cfg = await api('POST', `${LIVE}/configure`, {
    body: { symbolA: a, symbolB: b, beta, strategyId: strategy, startingCapitalUsdc: capital },
  });
  if (cfg.error) return out(`error: ${cfg.error}${cfg.known ? ` (known: ${cfg.known.join(', ')})` : ''}`);
  const snap = await api('POST', `${LIVE}/start`);
  if (json) return printJson(snap);
  out(`armed ${a}/${b}${strategy ? ` · ${strategy}` : ''} on $${capital.toLocaleString()}\n`);
  printSingleSnapshot(snap);
}

async function cmdStatus(json: boolean): Promise<void> {
  const s = await api('GET', `${LIVE}/snapshot`);
  if (json) return printJson(s);
  printSingleSnapshot(s);
}

async function cmdTrades(venue: string | undefined, limit: number, json: boolean): Promise<void> {
  const r = await api('GET', `${LIVE}/trades`, { query: { venue, limit } });
  if (json) return printJson(r);
  if (!r.trades?.length) return out(`no persisted trades on venue '${r.venue}'`);
  out(table(
    ['PAIR', 'SIDE', 'ENTRY Z', 'EXIT Z', 'NOTIONAL', 'PNL', 'CLOSED'],
    r.trades.map((t: any) => [
      t.pair, t.side, t.entryZ?.toFixed?.(2), t.exitZ?.toFixed?.(2),
      fmtUnits(t.notionalUnits), fmtUnits(t.pnlUnits), t.closedAt.replace('T', ' ').slice(0, 19),
    ]),
  ));
  out(`\n${r.count} trades on venue '${r.venue}'`);
}

async function cmdBook(args: string[], flags: Record<string, string | boolean>, json: boolean): Promise<void> {
  const sub = args[0];
  if (!sub) {
    const s = await api('GET', `${LIVE}/portfolio`);
    return json ? printJson(s) : printPortfolio(s);
  }
  if (sub === 'add') {
    const syms = args.slice(1);
    if (syms.length < 2 || syms.length % 2 !== 0) {
      return out('book add takes pairs of symbols: mq book add ETH BTC SOL AVAX --capital 90000');
    }
    const pairs = [];
    for (let i = 0; i < syms.length; i += 2) pairs.push({ symbolA: syms[i], symbolB: syms[i + 1] });
    const s = await api('POST', `${LIVE}/portfolio`, {
      body: { pairs, capitalUsdc: numFlag(flags, 'capital', 100_000), strategyId: flags.strategy },
    });
    if (json) return printJson(s);
    if (s.error) return out(`error: ${s.error}`);
    printPortfolio(s);
    out('\n→ start it with: mq book start');
    return;
  }
  const route: Record<string, string> = { start: 'portfolio/start', stop: 'portfolio/stop', flatten: 'portfolio/flatten', tick: 'portfolio/tick' };
  if (route[sub]) {
    const s = await api('POST', `${LIVE}/${route[sub]}`);
    return json ? printJson(s) : printPortfolio(s);
  }
  if (sub === 'remove') {
    if (!args[1]) return out('book remove needs a pair: mq book remove ETH/BTC');
    const s = await api('POST', `${LIVE}/portfolio/remove`, { body: { pair: args[1] } });
    return json ? printJson(s) : printPortfolio(s);
  }
  out(`unknown book subcommand: ${sub} (add|start|stop|flatten|remove)`);
}

async function cmdSimplePost(path: string, json: boolean, render: (s: any) => void): Promise<void> {
  const s = await api('POST', path);
  return json ? printJson(s) : render(s);
}

/** Wrap scripts/quant-session.ts — the full headless runbook (catalogue →
 *  backfill → discover → backtest-all → drive each strategy through the real
 *  LivePaperTrader → arm the winner). Boots its own Nest context; needs only
 *  Postgres + Binance public REST, not a running server. */
function cmdSession(flags: Record<string, string | boolean>): number {
  const env = {
    ...process.env,
    QS_PRESET: String(flags.preset ?? process.env.QS_PRESET ?? 'crypto-majors'),
    QS_HOURS: String(numFlag(flags, 'hours', Number(process.env.QS_HOURS ?? 24))),
    QS_CAPITAL: String(numFlag(flags, 'capital', Number(process.env.QS_CAPITAL ?? 100_000))),
    FEED_SOURCE: process.env.FEED_SOURCE ?? 'binance',
    EXECUTION_MODE: process.env.EXECUTION_MODE ?? 'paper',
    MOCK_TRADING_ENABLED: process.env.MOCK_TRADING_ENABLED ?? 'false',
    LIVE_AUTOSTART: process.env.LIVE_AUTOSTART ?? 'false',
  };
  out(`running quant-session: preset=${env.QS_PRESET} hours=${env.QS_HOURS} capital=${env.QS_CAPITAL}\n`);
  const r = spawnSync('npx', ['ts-node', '-r', 'tsconfig-paths/register', 'scripts/quant-session.ts'], {
    stdio: 'inherit',
    env,
  });
  return r.status ?? 1;
}

function usage(): void {
  out(`mq — Meridian quant terminal (host: ${BASE})

research:
  mq presets                          asset-class market sets
  mq strategies                       the deployable catalogue
  mq backfill <preset> [--hours 72]   pull real Binance history into market_bars
  mq discover <preset> [--hours 72]   cointegrated pairs over stored bars

backtest:
  mq backtest <A> <B> [--strategy id] [--hours 72] [--beta n]
  mq sweep    <A> <B> [--hours 72] [--beta n]    every strategy, ranked by Sharpe
  mq validate <A> <B> [--strategy id] [--profile balanced] [--preset id]
                                      promotion gate — PASS/FAIL per check (exit 0=pass)

deploy (live paper):
  mq arm <A> <B> [--strategy id] [--capital 100000] [--beta n]
  mq stop | mq tick | mq flatten | mq kill
  mq book add <A> <B> [<A2> <B2> …] [--strategy id] [--capital n]
  mq book start | stop | flatten | remove <PAIR>

monitor:
  mq status                           single-book snapshot
  mq book                             portfolio snapshot
  mq trades [--venue paper] [--limit 50]   persisted blotter

desk (agentic hedge fund — docs/AGENTIC_HEDGE_FUND_DESIGN.md):
  mq roster                           the station manifest (desk/roster.yaml)
  mq validate <station-id>            run the promotion gate for a station
  mq arm <station-id>                 arm a station's book in paper
  (validate/arm also take <A> <B> for an ad-hoc pair instead of a station)

runbook:
  mq session [--preset crypto-majors] [--hours 24] [--capital 100000]

global: --json (machine output) · --roster <path> · MQ_HOST overrides ${BASE}`);
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const { positionals, flags } = parseArgs(rest);
  const json = flags.json === true;
  const hours = numFlag(flags, 'hours', 72);
  const beta = flags.beta !== undefined ? numFlag(flags, 'beta', 1) : undefined;
  const strategy = typeof flags.strategy === 'string' ? flags.strategy : undefined;
  const venue = typeof flags.venue === 'string' ? flags.venue : undefined;
  const profile = typeof flags.profile === 'string' ? flags.profile : undefined;
  const preset = typeof flags.preset === 'string' ? flags.preset : undefined;
  const rosterPath = typeof flags.roster === 'string' ? flags.roster : undefined;
  const gateOverrides = {
    minSharpe: flags['min-sharpe'] !== undefined ? numFlag(flags, 'min-sharpe', 0.5) : undefined,
    minTrades: flags['min-trades'] !== undefined ? numFlag(flags, 'min-trades', 5) : undefined,
    maxPValue: flags['max-pvalue'] !== undefined ? numFlag(flags, 'max-pvalue', 0.2) : undefined,
  };

  switch (command) {
    case 'presets': await cmdPresets(json); break;
    case 'strategies': await cmdStrategies(json); break;
    case 'backfill': await cmdBackfill(positionals[0], hours, venue, json); break;
    case 'discover': await cmdDiscover(positionals[0], hours, venue, json); break;
    case 'backtest': await cmdBacktest(positionals[0], positionals[1], strategy, hours, beta ?? 1, json); break;
    case 'sweep': await cmdSweep(positionals[0], positionals[1], hours, beta ?? 1, json); break;
    case 'validate': {
      const st = resolveStation(positionals, rosterPath);
      if (st) {
        if (!json) {
          out(`station ${st.id}${st.owner ? ` · owner ${st.owner}` : ''} · status ${st.status}`);
          if (st.pairs.length > 1) {
            out(`(basket of ${st.pairs.length}; validating the first pair ${st.pairs[0].join('/')} — run the rest per-pair)`);
          }
        }
        return cmdValidate(st.pairs[0][0], st.pairs[0][1], {
          strategy: strategy ?? st.strategy, hours, beta: beta ?? 1,
          profile, preset: preset ?? st.preset, ...gateOverrides,
        }, json);
      }
      return cmdValidate(positionals[0], positionals[1], {
        strategy, hours, beta: beta ?? 1, profile, preset, ...gateOverrides,
      }, json);
    }
    case 'arm': {
      const st = resolveStation(positionals, rosterPath);
      if (st) {
        const capFlag = flags.capital !== undefined ? numFlag(flags, 'capital', 100_000) : undefined;
        await cmdArmStation(st, strategy, capFlag, beta, json);
        break;
      }
      await cmdArm(positionals[0], positionals[1], strategy, numFlag(flags, 'capital', 100_000), beta, json);
      break;
    }
    case 'roster': cmdRoster(json, rosterPath); break;
    case 'stop': await cmdSimplePost(`${LIVE}/stop`, json, printSingleSnapshot); break;
    case 'tick': await cmdSimplePost(`${LIVE}/tick`, json, printSingleSnapshot); break;
    case 'flatten': await cmdSimplePost(`${LIVE}/flatten`, json, printSingleSnapshot); break;
    case 'kill': await cmdSimplePost(`${LIVE}/kill`, json, (s) => out(`killed — single running: ${s.single}, portfolio running: ${s.portfolio}`)); break;
    case 'status': await cmdStatus(json); break;
    case 'book': await cmdBook(positionals, flags, json); break;
    case 'trades': await cmdTrades(venue, numFlag(flags, 'limit', 50), json); break;
    case 'session': return cmdSession(flags);
    case undefined:
    case 'help':
    case '--help':
    case '-h': usage(); break;
    default:
      out(`unknown command: ${command}\n`);
      usage();
      return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`mq: ${(e as Error).message}`);
    process.exit(1);
  });
