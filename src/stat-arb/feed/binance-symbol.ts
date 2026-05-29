// Symbol mapping between the engine's internal short symbols ('BTC', 'ETH')
// and Binance's concatenated market symbols ('BTCUSDT'). The engine quotes
// everything against a single quote asset (USDT by default); the venue
// boundary is the only place that needs the exchange-native form.

const KNOWN_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];

/**
 * Map an internal symbol to a Binance market symbol.
 *   toBinanceSymbol('BTC')            -> 'BTCUSDT'
 *   toBinanceSymbol('BTC', 'USDC')    -> 'BTCUSDC'
 *   toBinanceSymbol('BTCUSDT')        -> 'BTCUSDT'  (already concatenated)
 *   toBinanceSymbol('btc')            -> 'BTCUSDT'
 */
export function toBinanceSymbol(symbol: string, quote = 'USDT'): string {
  const s = symbol.trim().toUpperCase();
  const q = quote.trim().toUpperCase();
  if (KNOWN_QUOTES.some((known) => s.endsWith(known) && s.length > known.length)) {
    return s; // already a full market symbol
  }
  return `${s}${q}`;
}
