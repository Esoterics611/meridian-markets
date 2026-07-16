import { HyperliquidSpotClient, resolveSpotPairFromMeta } from './hyperliquid-spot-client';
import { RefHttpPost } from './reference-source.interface';

// HL spot — offline specs against a spotMeta fixture shaped like the live payload
// (probed 2026-07-16: HYPE token index 150, HYPE/USDC pair "@107"; PURR/USDC is
// the canonical named pair).

const META_FIXTURE = {
  tokens: [
    { name: 'USDC', index: 0, szDecimals: 8 },
    { name: 'PURR', index: 1, szDecimals: 0 },
    { name: 'HYPE', index: 150, szDecimals: 2 },
  ],
  universe: [
    { tokens: [1, 0], name: 'PURR/USDC', index: 0, isCanonical: true },
    { tokens: [150, 0], name: '@107', index: 107, isCanonical: false },
  ],
};

const L2_FIXTURE = {
  coin: '@107',
  time: 1_752_680_000_000,
  levels: [
    [{ px: '64.029', sz: '212.59', n: 7 }],
    [{ px: '64.032', sz: '12.57', n: 1 }],
  ],
};

describe('resolveSpotPairFromMeta', () => {
  it('maps a token name to its @-indexed USDC pair', () => {
    expect(resolveSpotPairFromMeta('HYPE', META_FIXTURE)).toEqual({ coin: '@107', pairIndex: 107 });
  });

  it('canonical pairs keep their readable name', () => {
    expect(resolveSpotPairFromMeta('PURR', META_FIXTURE)).toEqual({ coin: 'PURR/USDC', pairIndex: 0 });
  });

  it('throws for a token with no USDC spot pair (and for unknown tokens)', () => {
    expect(() => resolveSpotPairFromMeta('USDC', META_FIXTURE)).toThrow(/no USDC\/USDC pair|no.*pair/);
    expect(() => resolveSpotPairFromMeta('NOPE', META_FIXTURE)).toThrow(/not in spotMeta/);
  });
});

describe('HyperliquidSpotClient', () => {
  function client(): { c: HyperliquidSpotClient; calls: { url: string; body: unknown }[] } {
    const calls: { url: string; body: unknown }[] = [];
    const httpPost: RefHttpPost = async (url, body) => {
      calls.push({ url, body });
      const b = body as { type?: string };
      if (b?.type === 'spotMeta') return META_FIXTURE;
      if (b?.type === 'l2Book') return L2_FIXTURE;
      throw new Error(`unexpected request ${JSON.stringify(body)}`);
    };
    return { c: new HyperliquidSpotClient({ httpPost }), calls };
  }

  it('l2Snapshot resolves the pair then fetches the book with the @-coin; parses to micros', async () => {
    const { c, calls } = client();
    const snap = await c.l2Snapshot('HYPE');
    expect(calls.map((x) => (x.body as { type: string }).type)).toEqual(['spotMeta', 'l2Book']);
    expect((calls[1].body as { coin: string }).coin).toBe('@107');
    expect(snap.bids[0].priceMicros).toBe(64_029_000n);
    expect(snap.asks[0].priceMicros).toBe(64_032_000n);
  });

  it('caches spotMeta across resolutions (one meta fetch for repeated snapshots)', async () => {
    const { c, calls } = client();
    await c.l2Snapshot('HYPE');
    await c.l2Snapshot('HYPE');
    expect(calls.filter((x) => (x.body as { type: string }).type === 'spotMeta')).toHaveLength(1);
    expect(calls.filter((x) => (x.body as { type: string }).type === 'l2Book')).toHaveLength(2);
  });
});
