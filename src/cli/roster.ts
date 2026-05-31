/**
 * desk/roster.yaml loader for the `mq` quant terminal. The roster is the manifest
 * of trading stations the supervisor + tooling read (docs/AGENTIC_HEDGE_FUND_DESIGN.md
 * §2). Rather than pull in a YAML dependency (none is declared, and js-yaml ships
 * no types here), we parse the small, fixed subset the roster uses — documented in
 * desk/STATION_BRIEF.md and enforced below — so the format stays predictable and
 * the parser stays pure + jest-exercisable (rootDir src). bin/mq.ts is the thin
 * shell that reads the file and dispatches.
 *
 * Supported subset (full-line `#` comments and blank lines ignored):
 *
 *   stations:
 *     - id: l1-ou
 *       owner: quant-a
 *       preset: l1-smart-contract        # a market-preset id (alias: assetClass)
 *       pairs: [[SOL, AVAX]]             # flow-style; [[A, B], [C, D]] for a basket
 *       strategy: ou-bertram
 *       capitalUsdc: 33000
 *       status: paper                    # draft | validated | paper | stopped
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export const STATION_STATUSES = ['draft', 'validated', 'paper', 'stopped'] as const;
export type StationStatus = (typeof STATION_STATUSES)[number];

export interface Station {
  id: string;
  owner?: string;
  /** A market-preset id (src/stat-arb/markets/market-presets.ts) — used as the
   *  discovery universe for `mq validate`'s cointegration p-value check. */
  preset?: string;
  pairs: Array<[string, string]>;
  strategy?: string;
  capitalUsdc?: number;
  status: StationStatus;
}

export interface Roster {
  stations: Station[];
}

export const DEFAULT_ROSTER_PATH = 'desk/roster.yaml';

/** Strip one layer of matching single/double quotes from a scalar. */
function unquote(value: string): string {
  const s = value.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Drop a YAML inline comment: a `#` preceded by whitespace (values never contain
 *  `#` in this subset, so this is safe and keeps `[[A, B]]` intact). */
function stripInlineComment(line: string): string {
  const m = line.match(/\s#/);
  return m ? line.slice(0, m.index) : line;
}

/** Parse flow-style pairs: `[[ETH, BTC], [SOL, AVAX]]` or a single `[ETH, BTC]`. */
function parsePairs(raw: string): Array<[string, string]> {
  const groups = [...raw.matchAll(/\[([^[\]]+)\]/g)];
  if (groups.length === 0) {
    throw new Error(`pairs must be flow-style like [[ETH, BTC]] — got: ${raw.trim()}`);
  }
  return groups.map((g) => {
    const syms = g[1].split(',').map(unquote).filter((s) => s.length > 0);
    if (syms.length !== 2) {
      throw new Error(`each pair needs exactly two symbols — got: [${g[1].trim()}]`);
    }
    return [syms[0], syms[1]] as [string, string];
  });
}

/** Assign one `key: value` onto the station under construction. Unknown keys are
 *  ignored (forward-compatible); `assetClass` is accepted as an alias for `preset`. */
function assignField(st: Partial<Station>, key: string, value: string, lineNo: number): void {
  const v = value.trim();
  switch (key) {
    case 'id': st.id = unquote(v); break;
    case 'owner': st.owner = unquote(v); break;
    case 'preset':
    case 'assetClass': st.preset = unquote(v); break;
    case 'strategy': st.strategy = unquote(v); break;
    case 'pairs': st.pairs = parsePairs(v); break;
    case 'capitalUsdc': {
      const n = Number(unquote(v).replace(/[_,]/g, ''));
      if (!Number.isFinite(n)) throw new Error(`roster line ${lineNo}: capitalUsdc is not a number: ${v}`);
      st.capitalUsdc = n;
      break;
    }
    case 'status': {
      const s = unquote(v) as StationStatus;
      if (!STATION_STATUSES.includes(s)) {
        throw new Error(`roster line ${lineNo}: status must be one of ${STATION_STATUSES.join('|')} — got '${v}'`);
      }
      st.status = s;
      break;
    }
    default: break; // ignore unknown keys
  }
}

/** Parse roster text into a validated {@link Roster}. Pure — no filesystem. */
export function parseRoster(text: string): Roster {
  const lines = text.split(/\r?\n/);
  const stations: Station[] = [];
  let current: Partial<Station> | null = null;
  let sawStationsKey = false;

  const commit = (): void => {
    if (!current) return;
    if (!current.id) throw new Error('a station is missing its required `id`');
    if (!current.pairs || current.pairs.length === 0) {
      throw new Error(`station '${current.id}' has no pairs`);
    }
    if (stations.some((s) => s.id === current!.id)) {
      throw new Error(`duplicate station id: ${current.id}`);
    }
    stations.push({
      id: current.id,
      owner: current.owner,
      preset: current.preset,
      pairs: current.pairs,
      strategy: current.strategy,
      capitalUsdc: current.capitalUsdc,
      status: current.status ?? 'draft',
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = stripInlineComment(lines[i]).trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^stations\s*:/.test(trimmed)) { sawStationsKey = true; continue; }
    if (!sawStationsKey) throw new Error('roster must have a top-level `stations:` key');

    const itemMatch = trimmed.match(/^-\s+(\w+)\s*:\s*(.*)$/);
    const keyMatch = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (itemMatch) {
      commit();
      current = {};
      assignField(current, itemMatch[1], itemMatch[2], i + 1);
    } else if (keyMatch && current) {
      assignField(current, keyMatch[1], keyMatch[2], i + 1);
    } else {
      throw new Error(`roster line ${i + 1}: cannot parse "${trimmed}"`);
    }
  }
  commit();

  if (!sawStationsKey) throw new Error('roster must have a top-level `stations:` key');
  return { stations };
}

/** Read + parse desk/roster.yaml (path relative to cwd). Throws if absent. */
export function loadRoster(path: string = DEFAULT_ROSTER_PATH): Roster {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    throw new Error(`roster not found at ${abs} — create desk/roster.yaml (see desk/STATION_BRIEF.md)`);
  }
  return parseRoster(readFileSync(abs, 'utf8'));
}

export function findStation(roster: Roster, id: string): Station | undefined {
  return roster.stations.find((s) => s.id === id);
}
