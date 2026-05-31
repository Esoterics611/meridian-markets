import { QuoteContext, QuotePair } from './quote-pair';

// IQuoter is the market-making analogue of stat-arb's IStrategy: the seam
// between the book runtime (backtest harness OR live paper book) and the
// quoting logic. A quoter is a pure function of a QuoteContext — given the
// current inventory, mid, vol and risk params, it returns the bid/ask it wants
// resting in the book *right now*. It never sees the future and holds no
// position state of its own (inventory lives in the InventoryBook the runtime
// owns), so two runs on the same context stream produce identical quotes.
//
// SymmetricQuoter, AvellanedaStoikovQuoter and GlftQuoter all satisfy it; the
// MmStrategyRegistry catalogues them so any one can be dropped into the bar
// backtest and the live book unchanged — the same swap seam stat-arb uses.

export interface IQuoter {
  /** Catalogue family id (e.g. 'avellaneda-stoikov'). For attribution + the UI. */
  readonly familyId: string;
  quote(ctx: QuoteContext, symbol: string): QuotePair;
}
