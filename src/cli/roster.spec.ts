import { parseRoster, findStation, STATION_STATUSES } from './roster';

const SAMPLE = `
# the desk
stations:
  - id: majors-zscore
    owner: quant-a
    preset: crypto-majors
    pairs: [[ETH, BTC]]
    strategy: pairs-zscore
    capitalUsdc: 40000
    status: paper

  - id: l1-ou
    owner: quant-b
    assetClass: l1-smart-contract   # alias for preset
    pairs: [[SOL, AVAX]]
    strategy: ou-bertram
    capitalUsdc: 33_000
    # status omitted on purpose -> defaults to draft
`;

describe('parseRoster', () => {
  it('parses every field of a well-formed station', () => {
    const { stations } = parseRoster(SAMPLE);
    expect(stations).toHaveLength(2);
    const m = stations[0];
    expect(m.id).toBe('majors-zscore');
    expect(m.owner).toBe('quant-a');
    expect(m.preset).toBe('crypto-majors');
    expect(m.pairs).toEqual([['ETH', 'BTC']]);
    expect(m.strategy).toBe('pairs-zscore');
    expect(m.capitalUsdc).toBe(40000);
    expect(m.status).toBe('paper');
  });

  it('treats assetClass as an alias for preset', () => {
    const { stations } = parseRoster(SAMPLE);
    expect(stations[1].preset).toBe('l1-smart-contract');
  });

  it('defaults status to draft when omitted', () => {
    const { stations } = parseRoster(SAMPLE);
    expect(stations[1].status).toBe('draft');
  });

  it('strips underscores from capitalUsdc', () => {
    const { stations } = parseRoster(SAMPLE);
    expect(stations[1].capitalUsdc).toBe(33000);
  });

  it('ignores comments and blank lines', () => {
    expect(parseRoster(SAMPLE).stations).toHaveLength(2);
  });

  it('parses a multi-pair (basket) station', () => {
    const r = parseRoster(`stations:
  - id: basket
    pairs: [[ETH, BTC], [SOL, AVAX], [ARB, OP]]
`);
    expect(r.stations[0].pairs).toEqual([['ETH', 'BTC'], ['SOL', 'AVAX'], ['ARB', 'OP']]);
  });

  it('accepts a single-bracket pair form', () => {
    const r = parseRoster(`stations:
  - id: solo
    pairs: [LTC, BCH]
`);
    expect(r.stations[0].pairs).toEqual([['LTC', 'BCH']]);
  });

  it('strips quotes from scalars', () => {
    const r = parseRoster(`stations:
  - id: "q1"
    strategy: 'ou-bertram-fast'
    pairs: [[ETH, BTC]]
`);
    expect(r.stations[0].id).toBe('q1');
    expect(r.stations[0].strategy).toBe('ou-bertram-fast');
  });

  it('rejects a roster with no stations: key', () => {
    expect(() => parseRoster('foo: bar')).toThrow(/top-level `stations:`/);
  });

  it('rejects a station with no id', () => {
    expect(() => parseRoster(`stations:
  - owner: nobody
    pairs: [[ETH, BTC]]
`)).toThrow(/missing its required `id`/);
  });

  it('rejects a station with no pairs', () => {
    expect(() => parseRoster(`stations:
  - id: empty
    owner: x
`)).toThrow(/has no pairs/);
  });

  it('rejects a malformed pair', () => {
    expect(() => parseRoster(`stations:
  - id: bad
    pairs: [[ETH, BTC, SOL]]
`)).toThrow(/exactly two symbols/);
  });

  it('rejects an unknown status', () => {
    expect(() => parseRoster(`stations:
  - id: x
    pairs: [[ETH, BTC]]
    status: live
`)).toThrow(/status must be one of/);
  });

  it('rejects duplicate station ids', () => {
    expect(() => parseRoster(`stations:
  - id: dup
    pairs: [[ETH, BTC]]
  - id: dup
    pairs: [[SOL, AVAX]]
`)).toThrow(/duplicate station id/);
  });

  it('exposes the four canonical statuses', () => {
    expect([...STATION_STATUSES]).toEqual(['draft', 'validated', 'paper', 'stopped']);
  });
});

describe('findStation', () => {
  it('finds by id and returns undefined when absent', () => {
    const roster = parseRoster(SAMPLE);
    expect(findStation(roster, 'l1-ou')?.strategy).toBe('ou-bertram');
    expect(findStation(roster, 'nope')).toBeUndefined();
  });
});
