import { parsePriceBinaryDescription } from './binary-market.types';
import { HyperliquidOutcomeClient } from './hyperliquid-outcome-client';

describe('parsePriceBinaryDescription', () => {
  it('parses the live HIP-4 recurring BTC daily (probed 2026-07-13)', () => {
    const s = parsePriceBinaryDescription(
      'class:priceBinary|underlying:BTC|expiry:20260714-0600|targetPrice:62814|period:1d',
    )!;
    expect(s.underlying).toBe('BTC');
    expect(s.targetPrice).toBe(62814);
    expect(s.expiryMs).toBe(Date.UTC(2026, 6, 14, 6, 0));
    expect(s.period).toBe('1d');
  });

  it('rejects event markets and malformed specs', () => {
    expect(parsePriceBinaryDescription('This outcome resolves to Yes if Argentina wins')).toBeNull();
    expect(parsePriceBinaryDescription('class:priceBinary|underlying:BTC|expiry:garbage|targetPrice:1')).toBeNull();
    expect(parsePriceBinaryDescription('class:priceBinary|underlying:BTC|expiry:20260714-0600|targetPrice:-5')).toBeNull();
  });
});

describe('HyperliquidOutcomeClient', () => {
  const outcomeMeta = {
    outcomes: [
      {
        outcome: 823,
        name: 'Recurring',
        description: 'class:priceBinary|underlying:BTC|expiry:20260714-0600|targetPrice:62814|period:1d',
        sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
      },
      { outcome: 173, name: 'Argentina', description: 'This outcome resolves to Yes if…', sideSpecs: [{ name: 'Yes' }, { name: 'No' }] },
      {
        outcome: 900,
        name: 'Reordered',
        description: 'class:priceBinary|underlying:ETH|expiry:20260714-0600|targetPrice:3000|period:1d',
        sideSpecs: [{ name: 'No' }, { name: 'Yes' }], // side 0 ≠ Yes → must be skipped, never guessed
      },
    ],
  };
  const l2 = {
    coin: '#8230',
    time: 1,
    levels: [
      [{ px: '0.153', sz: '1000.0', n: 1 }],
      [{ px: '0.18', sz: '200.0', n: 1 }],
    ],
  };

  function client(bodies: Record<string, unknown>) {
    return new HyperliquidOutcomeClient({
      httpPost: async (body) => {
        const key = body.type === 'l2Book' ? `l2:${body.coin}` : String(body.type);
        if (!(key in bodies)) throw new Error(`unexpected ${key}`);
        return bodies[key];
      },
    });
  }

  it('lists only Yes-first price binaries with two-sided books', async () => {
    const c = client({ outcomeMeta, 'l2:#8230': l2 });
    const qs = await c.listPriceBinaries();
    expect(qs.length).toBe(1);
    expect(qs[0].marketId).toBe('823');
    expect(qs[0].yesBid).toBe(0.153);
    expect(qs[0].yesAsk).toBe(0.18);
    expect(qs[0].yesAskSize).toBe(200);
    expect(qs[0].targetPrice).toBe(62814);
  });

  it('skips markets with a null/empty book', async () => {
    const c = client({ outcomeMeta, 'l2:#8230': null });
    expect((await c.listPriceBinaries()).length).toBe(0);
  });

  it('underlyingMid reads allMids and rejects garbage', async () => {
    const c = client({ allMids: { BTC: '61943.5' } });
    expect(await c.underlyingMid('btc')).toBe(61943.5);
    await expect(c.underlyingMid('ETH')).rejects.toThrow(/no mid/);
  });
});
