import { YahooDailyClient, toYahooSymbol } from './yahoo-daily-client';

// A minimal chart v8 payload: 3 daily bars, the middle one a holiday gap (nulls).
function fakeChart() {
  const day = 86_400;
  const base = Math.floor(Date.UTC(2020, 0, 2) / 1000);
  return {
    chart: {
      result: [
        {
          timestamp: [base, base + day, base + 2 * day],
          indicators: {
            quote: [{
              open: [100, null, 110],
              high: [101, null, 111],
              low: [99, null, 109],
              close: [100, null, 110],
              volume: [1000, null, 1200],
            }],
            // adjclose halves the raw close → dividend/split factor 0.5.
            adjclose: [{ adjclose: [50, null, 55] }],
          },
        },
      ],
    },
  };
}

describe('YahooDailyClient', () => {
  it('returns split/div-adjusted bars, scaling OHL by adjclose/close and dropping gap rows', async () => {
    let seenUrl = '';
    let seenUa = '';
    const client = new YahooDailyClient({
      httpGet: async (url, headers) => { seenUrl = url; seenUa = headers['User-Agent'] ?? ''; return fakeChart(); },
    });
    const bars = await client.historicalBars('JPM', '1d', Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 5));

    expect(bars.length).toBe(2); // the null/holiday bar is dropped
    expect(bars[0].close).toBe(50); // adjclose used as close
    expect(bars[0].open).toBeCloseTo(50, 6); // 100 * (50/100)
    expect(bars[0].high).toBeCloseTo(50.5, 6); // 101 * 0.5
    expect(bars[1].close).toBe(55);
    expect(bars[0].volume).toBe(1000);
    expect(seenUrl).toContain('/v8/finance/chart/JPM');
    expect(seenUa.length).toBeGreaterThan(0); // a browser UA is sent
  });

  it('honours the [start,end) window', async () => {
    const client = new YahooDailyClient({ httpGet: async () => fakeChart() });
    // end just after the first bar → only bar 0 survives.
    const bars = await client.historicalBars('JPM', '1d', Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 2, 12));
    expect(bars.map((b) => b.close)).toEqual([50]);
  });

  it('rejects non-daily intervals (adjclose is daily-only)', async () => {
    const client = new YahooDailyClient({ httpGet: async () => fakeChart() });
    await expect(client.historicalBars('JPM', '15m', 0, 1)).rejects.toThrow(/daily-only/);
  });

  it('maps class shares to Yahoo dash form', () => {
    expect(toYahooSymbol('brk.b')).toBe('BRK-B');
    expect(toYahooSymbol('JPM')).toBe('JPM');
  });
});
