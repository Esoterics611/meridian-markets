// RegimeTcaAttributor — transaction-cost / P&L attribution for the "take sides" desk
// (Playbook II P10). It is the PnlAttributor analogue for the directional book: where the
// market-maker's attributor splits a fill into spread / adverse / carry / fees, this splits
// each directional book's realised-first P&L into the five things a directional desk earns or
// pays:
//   • directional (idiosyncratic) — the signal's OWN edge: the clean trading P&L at the fair
//                                   mid, with the market-factor (beta) move removed.
//   • beta                        — the P&L explained by the crypto market factor (the move in
//                                   the hedge instrument). HEDGED-away in market-neutral mode,
//                                   CARRIED in outright mode.
//   • funding                     — perp funding accrued on the held position (signed).
//   • fees                        — taker fees paid (signed; + cost, − rebate).
//   • slippage                    — the cost of crossing on a taker fill (≥ 0).
//
// THE INVARIANT (asserted): the five components reconcile to the book's realised-first total
// to the cent —
//     total = idiosyncratic + beta + funding − fees − slippage
// where total = realised − fees + funding + unrealised (the same number the verdict reports).
//
// The key algebra: the InventoryBook's realised+unrealised already has slippage baked in (the
// fill executed at a WORSE price), so the "clean" directional edge at the mid is
//     directionalGross = realised + unrealised + slippage      (add the slippage back)
// and the idiosyncratic piece is the residual after the supplied market-factor (beta) P&L:
//     idiosyncratic    = directionalGross − betaPnl
// Because idiosyncratic is DEFINED as the residual, the reconciliation holds exactly for ANY
// beta estimate — the beta/idio split is a modelling choice; the TOTAL is invariant. All
// arithmetic is bigint USDC-units, so "to the cent" is exact, not approximate.

const MICROS = 1_000_000n;

/** One book's raw P&L ledger (straight from RegimeBookSnapshot) + its market-factor P&L. */
export interface BookTcaInput {
  readonly symbol: string;
  /** InventoryBook realised P&L, EXCLUDING fees (USDC-units). */
  readonly realisedUnits: bigint;
  /** Signed fees (USDC-units; + cost, − rebate). */
  readonly feesUnits: bigint;
  /** Funding accrued on the held position (signed USDC-units). */
  readonly fundingUnits: bigint;
  /** Mark-to-market on the open position at the current mid (signed USDC-units). */
  readonly unrealisedUnits: bigint;
  /** Cumulative slippage cost (≥ 0 USDC-units) — already inside realised/unrealised. */
  readonly slippageUnits: bigint;
  /** P&L explained by the market factor (signed USDC-units); 0 when no factor view is supplied. */
  readonly betaPnlUnits: bigint;
}

/** The decomposition of one book's realised-first P&L. Components reconcile to `totalUnits`. */
export interface BookTca {
  readonly symbol: string;
  /** The signal's own edge: directionalGross − beta (signed). */
  readonly idiosyncraticUnits: bigint;
  /** Market-factor P&L (signed) — hedged-away in neutral mode, carried in outright. */
  readonly betaUnits: bigint;
  readonly fundingUnits: bigint;
  /** Fees as stored (signed; + cost). The total SUBTRACTS this. */
  readonly feesUnits: bigint;
  /** Slippage cost (≥ 0). The total SUBTRACTS this. */
  readonly slippageUnits: bigint;
  /** The clean trading edge at the mid = idiosyncratic + beta = realised + unrealised + slippage. */
  readonly directionalGrossUnits: bigint;
  /** realised − fees + funding + unrealised — the realised-first total the verdict reports. */
  readonly totalUnits: bigint;
}

export interface DeskTca {
  readonly perBook: readonly BookTca[];
  readonly idiosyncraticUnits: bigint;
  readonly betaUnits: bigint;
  readonly fundingUnits: bigint;
  readonly feesUnits: bigint;
  readonly slippageUnits: bigint;
  readonly directionalGrossUnits: bigint;
  readonly totalUnits: bigint;
}

/** Attribute one book's realised-first P&L into idiosyncratic / beta / funding / fees / slippage. */
export function attributeBook(input: BookTcaInput): BookTca {
  // The clean trading edge at the mid: realised+unrealised carries the slippage drag (worse
  // fills), so add it back to recover what the edge WOULD have been at the fair mid.
  const directionalGross = input.realisedUnits + input.unrealisedUnits + input.slippageUnits;
  // Idiosyncratic is the residual after removing the market-factor (beta) P&L.
  const idiosyncratic = directionalGross - input.betaPnlUnits;
  const total = input.realisedUnits - input.feesUnits + input.fundingUnits + input.unrealisedUnits;
  return {
    symbol: input.symbol,
    idiosyncraticUnits: idiosyncratic,
    betaUnits: input.betaPnlUnits,
    fundingUnits: input.fundingUnits,
    feesUnits: input.feesUnits,
    slippageUnits: input.slippageUnits,
    directionalGrossUnits: directionalGross,
    totalUnits: total,
  };
}

/** Attribute the whole desk: per-book breakdowns + the summed components. */
export function attributeDesk(inputs: readonly BookTcaInput[]): DeskTca {
  const perBook = inputs.map(attributeBook);
  return perBook.reduce<DeskTca>(
    (acc, b) => ({
      perBook: acc.perBook,
      idiosyncraticUnits: acc.idiosyncraticUnits + b.idiosyncraticUnits,
      betaUnits: acc.betaUnits + b.betaUnits,
      fundingUnits: acc.fundingUnits + b.fundingUnits,
      feesUnits: acc.feesUnits + b.feesUnits,
      slippageUnits: acc.slippageUnits + b.slippageUnits,
      directionalGrossUnits: acc.directionalGrossUnits + b.directionalGrossUnits,
      totalUnits: acc.totalUnits + b.totalUnits,
    }),
    {
      perBook,
      idiosyncraticUnits: 0n,
      betaUnits: 0n,
      fundingUnits: 0n,
      feesUnits: 0n,
      slippageUnits: 0n,
      directionalGrossUnits: 0n,
      totalUnits: 0n,
    },
  );
}

/**
 * The exact reconciliation residual (USDC-units): how far the five components miss the total.
 * MUST be 0n for every honest attribution — it is the assertable invariant. Surfaced as a
 * function (not a hidden throw) so callers can assert it in tests and the runner can refuse
 * to print a TCA that doesn't balance.
 */
export function reconciliationResidual(b: BookTca): bigint {
  const recomposed = b.idiosyncraticUnits + b.betaUnits + b.fundingUnits - b.feesUnits - b.slippageUnits;
  return recomposed - b.totalUnits;
}

/** Throw if a book TCA fails to reconcile to the cent. The defensive guard around the invariant. */
export function assertReconciles(b: BookTca): void {
  const r = reconciliationResidual(b);
  if (r !== 0n) {
    throw new Error(`RegimeTca: ${b.symbol} attribution off by ${Number(r) / Number(MICROS)} — does not reconcile to realised total`);
  }
}
