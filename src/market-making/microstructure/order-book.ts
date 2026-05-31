// OrderBook — an immutable snapshot of the visible limit order book (course
// Appendix A.1). Bids descend by price, asks ascend; best() is O(1). The bar
// backtest and live book don't need L2 depth (they quote off the bar mid), but
// the LOB-replay path (backtest/lob-replay.ts) and the micro-price refinement
// (micro-price.ts) read this shape, and pinning it now keeps the honest
// tick-data upgrade a drop-in rather than a rewrite.
//
// readonly everywhere is deliberate: a quoter that mutates the book it was
// handed corrupts the simulator's next tick — a day to find under shadow mode,
// ten minutes to find under TypeScript.

export interface OrderBookLevel {
  readonly priceMicros: bigint;
  readonly sizeUnits: bigint;
  readonly orderCount: number;
}

export interface OrderBook {
  readonly symbol: string;
  readonly ts: Date;
  readonly bids: readonly OrderBookLevel[]; // descending by price
  readonly asks: readonly OrderBookLevel[]; // ascending by price
}

export function bestBid(book: OrderBook): OrderBookLevel | undefined {
  return book.bids[0];
}

export function bestAsk(book: OrderBook): OrderBookLevel | undefined {
  return book.asks[0];
}

export function midMicros(book: OrderBook): bigint | undefined {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (!b || !a) return undefined;
  return (b.priceMicros + a.priceMicros) / 2n;
}

export function quotedSpreadMicros(book: OrderBook): bigint | undefined {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (!b || !a) return undefined;
  return a.priceMicros - b.priceMicros;
}
