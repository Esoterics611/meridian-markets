import { AlpacaPaperVenue, AlpacaHttpPost } from './alpaca-paper-venue';
import { PlaceOrderRequest } from '../../trading-venue.interface';

const PRICE = 185_500_000n; // $185.50 in 6-dec micros
const NOTIONAL = 100_000_000_000n; // $100k / leg in 6-dec units

function venue(httpPost: AlpacaHttpPost, price: bigint = PRICE) {
  return new AlpacaPaperVenue({
    keyId: 'k',
    secret: 's',
    priceMicros: async () => price,
    httpPost,
  });
}

const req = (over: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  symbol: 'AAPL',
  side: 'BUY',
  notionalUnits: NOTIONAL,
  idempotencyKey: 'k-1',
  ...over,
});

describe('AlpacaPaperVenue', () => {
  it('submits a whole-share market DAY order with auth + idempotency, ties the fill out', async () => {
    let seenBody: any;
    let seenHeaders: Record<string, string> = {};
    const v = venue(async (url, headers, body) => {
      expect(url).toContain('/v2/orders');
      seenBody = body;
      seenHeaders = headers;
      return { id: 'ord-1', status: 'accepted' }; // no synchronous fill price
    });
    const fill = await v.placeOrder(req());

    expect(seenHeaders['APCA-API-KEY-ID']).toBe('k');
    expect(seenHeaders['APCA-API-SECRET-KEY']).toBe('s');
    expect(seenBody).toMatchObject({
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
      client_order_id: 'k-1',
    });
    // whole shares: 100_000_000_000 / 185_500_000 = 539
    expect(seenBody.qty).toBe('539');
    // fill reported at last price (no filled_avg_price), notional ties to qty×price
    expect(fill.priceMicros).toBe(PRICE);
    expect(fill.filledUnits).toBe(539n * PRICE);
    expect(fill.feesUnits).toBe(0n); // commission-free
    expect(fill.orderId).toBe('ord-1');
  });

  it("uses Alpaca's realised filled_avg_price when the order filled synchronously", async () => {
    const v = venue(async () => ({
      id: 'ord-2',
      status: 'filled',
      filled_qty: '539',
      filled_avg_price: '185.60',
    }));
    const fill = await v.placeOrder(req());
    expect(fill.priceMicros).toBe(185_600_000n);
    expect(fill.filledUnits).toBe(539n * 185_600_000n);
  });

  it('maps SELL (the short leg) to a sell order', async () => {
    let seenBody: any;
    const v = venue(async (_u, _h, body) => {
      seenBody = body;
      return { id: 'ord-3' };
    });
    await v.placeOrder(req({ side: 'SELL' }));
    expect(seenBody.side).toBe('sell');
  });

  it('fetchPrice returns the price-source micros', async () => {
    const v = venue(async () => ({ id: 'x' }));
    expect(await v.fetchPrice('AAPL')).toBe(PRICE);
  });

  it('throws unkeyed, on non-positive notional, and when notional is below one share', async () => {
    const unkeyed = new AlpacaPaperVenue({ keyId: '', secret: '', priceMicros: async () => PRICE, httpPost: async () => ({}) });
    await expect(unkeyed.placeOrder(req())).rejects.toThrow(/not configured/);

    const v = venue(async () => ({ id: 'x' }));
    await expect(v.placeOrder(req({ notionalUnits: 0n }))).rejects.toThrow(/must be > 0/);
    await expect(v.placeOrder(req({ notionalUnits: 1_000_000n }))).rejects.toThrow(/too small for one share/);
  });
});
