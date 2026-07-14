import { DeribitClient, DeribitOption } from '../derivatives/deribit/deribit-client';
import { DeribitDigitalSource } from './deribit-digital-source';

const NOW = Date.UTC(2026, 6, 13, 18, 8);
const BINARY_EXPIRY = Date.UTC(2026, 6, 14, 6, 0);
const OPT_EXPIRY = Date.UTC(2026, 6, 14, 8, 0); // Deribit daily settles 08:00 UTC

function opt(strike: number, iv: number, over: Partial<DeribitOption> = {}): DeribitOption {
  return {
    instrumentName: `BTC-14JUL26-${strike}-C`,
    currency: 'BTC',
    type: 'CALL',
    strike,
    expiryMs: OPT_EXPIRY,
    markIv: iv,
    underlyingPrice: 61943.38,
    markPriceCoin: 0.001,
    openInterest: 10,
    volume: 5,
    ...over,
  };
}

// The 2026-07-13 live smile around the HIP-4 strike.
const CHAIN = [opt(62000, 0.3624), opt(62500, 0.3517), opt(63000, 0.3604), opt(63500, 0.3843)];

function source(chain: DeribitOption[]) {
  const stub = { optionChain: async () => chain } as unknown as DeribitClient;
  return new DeribitDigitalSource(stub);
}

describe('DeribitDigitalSource.fairYes', () => {
  it('prices the founding live read: fair 0.1334 with the 06:00-binary T against the 08:00 smile', async () => {
    const { fair, reason } = await source(CHAIN).fairYes('BTC', 62814, BINARY_EXPIRY, NOW);
    expect(reason).toBeUndefined();
    expect(fair!.fairYes).toBeCloseTo(0.1334, 3);
    expect(fair!.naive).toBeCloseTo(0.1425, 3);
    expect(fair!.optionExpiryMs).toBe(OPT_EXPIRY);
    expect(fair!.nPoints).toBe(4);
  });

  it('refuses when no option expiry covers the binary', async () => {
    const past = CHAIN.map((o) => ({ ...o, expiryMs: BINARY_EXPIRY - 3_600_000 }));
    const { fair, reason } = await source(past).fairYes('BTC', 62814, BINARY_EXPIRY, NOW);
    expect(fair).toBeNull();
    expect(reason).toMatch(/no BTC option expiry/);
  });

  it('refuses when the nearest expiry overhangs by more than a day', async () => {
    const far = CHAIN.map((o) => ({ ...o, expiryMs: BINARY_EXPIRY + 48 * 3_600_000 }));
    const { fair, reason } = await source(far).fairYes('BTC', 62814, BINARY_EXPIRY, NOW);
    expect(fair).toBeNull();
    expect(reason).toMatch(/too far/);
  });

  it('refuses a one-point smile', async () => {
    const { fair, reason } = await source([opt(62500, 0.35)]).fairYes('BTC', 62814, BINARY_EXPIRY, NOW);
    expect(fair).toBeNull();
    expect(reason).toMatch(/smile point/);
  });

  it('applies the #92 same-underlying guard when venue and Deribit spots disagree', async () => {
    const { fair, reason } = await source(CHAIN).fairYes('BTC', 62814, BINARY_EXPIRY, NOW, 61943 * 1.08);
    expect(fair).toBeNull();
    expect(reason).toMatch(/#92 guard/);
    const ok = await source(CHAIN).fairYes('BTC', 62814, BINARY_EXPIRY, NOW, 61900);
    expect(ok.fair).not.toBeNull();
  });

  it('refuses an already-expired binary', async () => {
    const { fair, reason } = await source(CHAIN).fairYes('BTC', 62814, BINARY_EXPIRY, BINARY_EXPIRY + 1);
    expect(fair).toBeNull();
    expect(reason).toMatch(/expired/);
  });
});
