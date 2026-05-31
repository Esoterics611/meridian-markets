import { parseArgs, numFlag, fmtUnits, usdcToUnits, table, rankSweep, SweepRow } from './mq-lib';

describe('mq-lib parseArgs', () => {
  it('separates positionals from --flag value pairs', () => {
    const { positionals, flags } = parseArgs(['ETH', 'BTC', '--strategy', 'ou-bertram', '--hours', '72']);
    expect(positionals).toEqual(['ETH', 'BTC']);
    expect(flags).toEqual({ strategy: 'ou-bertram', hours: '72' });
  });

  it('supports --flag=value form', () => {
    const { flags } = parseArgs(['--capital=100000', '--beta=1.07']);
    expect(flags).toEqual({ capital: '100000', beta: '1.07' });
  });

  it('treats known boolean flags as true without consuming the next token', () => {
    const { positionals, flags } = parseArgs(['discover', '--json', 'crypto-majors']);
    expect(flags.json).toBe(true);
    expect(positionals).toEqual(['discover', 'crypto-majors']);
  });

  it('treats a trailing value-flag with no value as boolean true', () => {
    const { flags } = parseArgs(['--start']);
    expect(flags.start).toBe(true);
  });

  it('collects multiple positionals for book add', () => {
    const { positionals, flags } = parseArgs(['ETH', 'BTC', 'SOL', 'AVAX', '--capital', '90000']);
    expect(positionals).toEqual(['ETH', 'BTC', 'SOL', 'AVAX']);
    expect(flags.capital).toBe('90000');
  });
});

describe('mq-lib numFlag', () => {
  it('parses a numeric flag', () => {
    expect(numFlag({ hours: '72' }, 'hours', 24)).toBe(72);
  });
  it('falls back when absent, boolean, or unparseable', () => {
    expect(numFlag({}, 'hours', 24)).toBe(24);
    expect(numFlag({ hours: true }, 'hours', 24)).toBe(24);
    expect(numFlag({ hours: 'abc' }, 'hours', 24)).toBe(24);
  });
});

describe('mq-lib fmtUnits', () => {
  it('formats 6-decimal units with thousands separators and 2dp', () => {
    expect(fmtUnits('100000000000')).toBe('$100,000.00'); // 100k USDC
    expect(fmtUnits('1234567890')).toBe('$1,234.56');
    expect(fmtUnits(0n)).toBe('$0.00');
  });
  it('handles negatives (a losing book)', () => {
    expect(fmtUnits('-50000000')).toBe('-$50.00');
  });
  it('round-trips with usdcToUnits', () => {
    expect(fmtUnits(usdcToUnits(100_000))).toBe('$100,000.00');
  });
});

describe('mq-lib table', () => {
  it('renders aligned columns with a separator row', () => {
    const out = table(['PAIR', 'Z'], [['ETH/BTC', 2.13], ['SOL/AVAX', -0.4]]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^PAIR/);
    expect(lines[1]).toMatch(/^-+/); // dash separator
    expect(lines).toHaveLength(4); // header + sep + 2 rows
    expect(lines[2]).toContain('ETH/BTC');
  });
});

describe('mq-lib rankSweep', () => {
  const mk = (strategy: string, sharpe: number, error?: string): SweepRow => ({
    strategy, sharpe, tradeCount: 5, pnlUnits: '0', maxDdPct: 1, winRate: 0.5, error,
  });

  it('ranks best-first by Sharpe', () => {
    const ranked = rankSweep([mk('a', 0.4), mk('b', 2.1), mk('c', 1.0)]);
    expect(ranked.map((r) => r.strategy)).toEqual(['b', 'c', 'a']);
  });

  it('sinks errored rows to the bottom regardless of Sharpe', () => {
    const ranked = rankSweep([mk('boom', 9.9, 'not enough bars'), mk('ok', 0.1)]);
    expect(ranked.map((r) => r.strategy)).toEqual(['ok', 'boom']);
  });

  it('does not mutate the input', () => {
    const input = [mk('a', 0.4), mk('b', 2.1)];
    rankSweep(input);
    expect(input.map((r) => r.strategy)).toEqual(['a', 'b']);
  });
});
