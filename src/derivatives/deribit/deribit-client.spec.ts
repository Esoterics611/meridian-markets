import { DeribitClient, parseInstrumentName, DrbHttpGet } from './deribit-client';

describe('parseInstrumentName', () => {
  it('parses a call', () => {
    const p = parseInstrumentName('BTC-4JUN26-79000-C');
    expect(p).toEqual({ currency: 'BTC', type: 'CALL', strike: 79000, expiryMs: Date.UTC(2026, 5, 4, 8, 0, 0) });
  });
  it('parses a put with ETH', () => {
    const p = parseInstrumentName('ETH-25DEC26-2000-P');
    expect(p?.type).toBe('PUT');
    expect(p?.strike).toBe(2000);
    expect(p?.expiryMs).toBe(Date.UTC(2026, 11, 25, 8, 0, 0));
  });
  it('rejects non-option names', () => {
    expect(parseInstrumentName('BTC-PERPETUAL')).toBeNull();
    expect(parseInstrumentName('garbage')).toBeNull();
  });
});

describe('DeribitClient', () => {
  it('maps the chain, converts IV % → fraction, drops unparseable/empty rows', async () => {
    const httpGet: DrbHttpGet = async (url) => {
      expect(url).toContain('get_book_summary_by_currency');
      expect(url).toContain('currency=BTC');
      return {
        result: [
          { instrument_name: 'BTC-4JUN26-79000-C', mark_iv: 58.79, underlying_price: 70304.3, mark_price: 6.271e-5, open_interest: 53.1, volume: 62.4 },
          { instrument_name: 'BTC-PERPETUAL', mark_iv: 0, underlying_price: 70000 }, // not an option → dropped
          { instrument_name: 'BTC-25DEC26-56000-P', underlying_price: 70000 }, // no mark_iv → dropped
        ],
      };
    };
    const chain = await new DeribitClient({ httpGet }).optionChain('BTC');
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ type: 'CALL', strike: 79000, markIv: 0.5879, underlyingPrice: 70304.3 });
  });

  it('reads a ticker with venue greeks', async () => {
    const httpGet: DrbHttpGet = async () => ({
      result: { mark_iv: 88.5, underlying_price: 70269.66, mark_price: 0.0749, greeks: { delta: 0.5, gamma: 0.00002, vega: 50, theta: -30, rho: 0.14 } },
    });
    const t = await new DeribitClient({ httpGet }).ticker('BTC-2JUN26-65000-C');
    expect(t.markIv).toBeCloseTo(0.885, 4);
    expect(t.greeks?.delta).toBe(0.5);
  });
});
