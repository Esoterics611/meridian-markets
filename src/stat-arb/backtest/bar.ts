// OHLCV bar. Prices are stored as floats here (not bigints) because the
// backtest's signal layer operates on log-prices and z-scores — float
// precision is the right currency for that math. The venue boundary still
// uses bigint micros for any actual order placement.

export interface Bar {
  symbol: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
