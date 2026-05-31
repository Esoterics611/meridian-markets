import { IQuoter } from './quoter.interface';
import { QuoteContext, QuotePair, buildQuotePair } from './quote-pair';

// SymmetricQuoter — the textbook baseline from course §3: post a bid and an ask
// equidistant from mid at a fixed half-spread, ignore inventory entirely. It is
// the control the inventory-aware quoters are measured against — a symmetric
// quoter accumulates one-sided inventory in any trending tape because it never
// skews to shed it. We keep it deployable so a desk can A/B it against AS/GLFT
// on the same pair and *see* the inventory blow-up the skew is there to prevent.
//
// The half-spread is in basis points of mid — the asset-class-agnostic unit (a
// stablecoin and BTC both want their spread expressed as bps, not absolute
// micros). buildQuotePair enforces the ≥1-micro tick floor.

export interface SymmetricQuoterParams {
  /** Fixed half-spread in basis points of mid. */
  halfSpreadBps: number;
  /** Asset units quoted on each side. */
  quoteSizeUnits: bigint;
}

export class SymmetricQuoter implements IQuoter {
  readonly familyId = 'symmetric';
  private tickSeq = 0;

  constructor(
    private readonly p: SymmetricQuoterParams,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  quote(ctx: QuoteContext, symbol: string): QuotePair {
    const halfSpreadMicros = (ctx.midMicros * BigInt(Math.round(this.p.halfSpreadBps * 100))) / 1_000_000n;
    return buildQuotePair({
      symbol,
      reservationMicros: ctx.midMicros, // no inventory skew — this is the point
      halfSpreadMicros,
      sizeUnits: this.p.quoteSizeUnits,
      ctx,
      strategyId: this.familyId,
      tickSeq: this.tickSeq++,
      clock: this.clock,
    });
  }
}
