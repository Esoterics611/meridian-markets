// Cross-venue normalised symbol. The string form is:
//   <BASE>-<QUOTE>.<kind>.<venue>
// e.g. "BTC-USDT.spot.binance" → { base: "BTC", quote: "USDT", kind: "spot", venue: "binance" }
//
// Every market-data table key is keyed on (venue, symbol) where `symbol` is
// the normalised string. The repo never re-parses; downstream code reads
// {base, quote, kind} from the parser when it needs to filter or display.

export type InstrumentKind = 'spot' | 'perp' | 'future';

export const INSTRUMENT_KINDS: readonly InstrumentKind[] = ['spot', 'perp', 'future'];

export interface NormalisedSymbol {
  /** Original input string, normalised to upper-case-base/quote, lower-case kind/venue. */
  raw: string;
  base: string;
  quote: string;
  kind: InstrumentKind;
  venue: string;
}

const PATTERN = /^([A-Za-z0-9]{2,10})-([A-Za-z0-9]{2,10})\.([a-z]+)\.([a-z0-9_-]+)$/;

export function parseSymbol(input: string): NormalisedSymbol {
  if (typeof input !== 'string') {
    throw new Error('parseSymbol: input must be a string');
  }
  const trimmed = input.trim();
  const m = PATTERN.exec(trimmed);
  if (!m) {
    throw new Error(`parseSymbol: malformed symbol '${input}' (expected BASE-QUOTE.kind.venue)`);
  }
  const [, base, quote, kind, venue] = m;
  if (!(INSTRUMENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`parseSymbol: unknown instrument kind '${kind}'`);
  }
  return {
    raw: `${base.toUpperCase()}-${quote.toUpperCase()}.${kind}.${venue}`,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    kind: kind as InstrumentKind,
    venue,
  };
}

export function formatSymbol(s: Omit<NormalisedSymbol, 'raw'>): string {
  return `${s.base.toUpperCase()}-${s.quote.toUpperCase()}.${s.kind}.${s.venue}`;
}

/** True when the candidate string parses cleanly. Used by ingest validators. */
export function isValidSymbol(input: string): boolean {
  try {
    parseSymbol(input);
    return true;
  } catch {
    return false;
  }
}
