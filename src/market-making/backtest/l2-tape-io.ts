import { OrderBook, OrderBookLevel } from '../microstructure/order-book';
import { L2TapeStep } from './l2-tape';

// l2-tape-io — serialise / parse an L2 tape so a LIVE capture (the expensive part:
// scripts/mm-l2-tune.ts polls Hyperliquid's l2Book for minutes/hours) becomes a
// reusable fixture. The γ/κ sweep is deterministic over a fixed tape, so you
// capture once and replay the SAME flow against every grid point — an apples-to-
// apples A/B instead of noise between live windows.
//
// JSON can't carry bigint, so every micros/units field is a decimal STRING and
// every level a [price, size, count] tuple; timestamps are ISO. The round-trip is
// exact (bigint → string → bigint), unit-tested. Format is versioned so a future
// shape change is detectable rather than silently mis-parsed.

const TAPE_FORMAT_VERSION = 1;

type LevelTuple = [string, string, number]; // [priceMicros, sizeUnits, orderCount]

interface SerializedStep {
  ts: string;
  bids: LevelTuple[];
  asks: LevelTuple[];
  aggBuy: string;
  aggSell: string;
  high: string | null;
  low: string | null;
}

interface SerializedTape {
  version: number;
  symbol: string;
  capturedAt: string;
  steps: SerializedStep[];
}

function levelOut(l: OrderBookLevel): LevelTuple {
  return [l.priceMicros.toString(), l.sizeUnits.toString(), l.orderCount];
}

function levelIn(t: LevelTuple): OrderBookLevel {
  return { priceMicros: BigInt(t[0]), sizeUnits: BigInt(t[1]), orderCount: Number(t[2]) };
}

/** Serialise an L2 tape to a JSON string (bigint → decimal strings, ts → ISO). */
export function serializeTape(tape: L2TapeStep[], symbol = tape[0]?.book.symbol ?? 'UNKNOWN'): string {
  const out: SerializedTape = {
    version: TAPE_FORMAT_VERSION,
    symbol,
    capturedAt: new Date().toISOString(),
    steps: tape.map((s) => ({
      ts: s.book.ts.toISOString(),
      bids: s.book.bids.map(levelOut),
      asks: s.book.asks.map(levelOut),
      aggBuy: s.aggressiveBuyUnits.toString(),
      aggSell: s.aggressiveSellUnits.toString(),
      high: s.tradedHighMicros !== undefined ? s.tradedHighMicros.toString() : null,
      low: s.tradedLowMicros !== undefined ? s.tradedLowMicros.toString() : null,
    })),
  };
  return JSON.stringify(out);
}

/** Parse a tape JSON string back into L2TapeStep[] (exact bigint round-trip). */
export function parseTape(json: string): L2TapeStep[] {
  const data = JSON.parse(json) as SerializedTape;
  if (data?.version !== TAPE_FORMAT_VERSION) {
    throw new Error(`l2-tape-io: unsupported tape version ${data?.version} (expected ${TAPE_FORMAT_VERSION})`);
  }
  return data.steps.map((s): L2TapeStep => {
    const book: OrderBook = {
      symbol: data.symbol,
      ts: new Date(s.ts),
      bids: s.bids.map(levelIn),
      asks: s.asks.map(levelIn),
    };
    return {
      book,
      aggressiveBuyUnits: BigInt(s.aggBuy),
      aggressiveSellUnits: BigInt(s.aggSell),
      ...(s.high !== null ? { tradedHighMicros: BigInt(s.high) } : {}),
      ...(s.low !== null ? { tradedLowMicros: BigInt(s.low) } : {}),
    };
  });
}
