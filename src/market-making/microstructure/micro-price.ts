import { OrderBook } from './order-book';

// MicroPriceCalculator — the size-weighted micro price across N levels (course
// §2.4, Appendix A.2). The textbook micro price
//   p_micro = (a·v_b + b·v_a) / (v_a + v_b)
// overweights the side with *less* resting size, on the theory that the thinner
// side is closer to depleting and so the "true" price is closer to it. The
// AS/GLFT quoters can anchor to this instead of the raw mid as a practitioner
// refinement (course §3.4); float arithmetic is fine here because the result is
// bigint-rounded by the quoter before any order is placed.

export interface MicroPriceConfig {
  /** Levels per side to weight; typically 1–5. */
  readonly depth: number;
}

export class MicroPriceCalculator {
  constructor(private readonly cfg: MicroPriceConfig) {}

  /** Micro price in micros (float), or undefined if either side is empty. */
  compute(book: OrderBook): number | undefined {
    const bids = book.bids.slice(0, this.cfg.depth);
    const asks = book.asks.slice(0, this.cfg.depth);
    if (bids.length === 0 || asks.length === 0) return undefined;

    let bidNotional = 0;
    let bidSize = 0;
    let askNotional = 0;
    let askSize = 0;
    for (const lvl of bids) {
      bidNotional += Number(lvl.priceMicros) * Number(lvl.sizeUnits);
      bidSize += Number(lvl.sizeUnits);
    }
    for (const lvl of asks) {
      askNotional += Number(lvl.priceMicros) * Number(lvl.sizeUnits);
      askSize += Number(lvl.sizeUnits);
    }
    if (bidSize === 0 || askSize === 0) return undefined;
    const bidVwap = bidNotional / bidSize;
    const askVwap = askNotional / askSize;
    // Overweight the thinner side: weight each side's VWAP by the *opposite* size.
    return (askVwap * bidSize + bidVwap * askSize) / (bidSize + askSize);
  }
}
