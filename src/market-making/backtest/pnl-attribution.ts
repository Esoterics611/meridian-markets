import { FillSide } from '../inventory/inventory-book';

// PnlAttributor — splits each fill's P&L into the four components a market
// maker actually has (course §6.5, Appendix A.11):
//   - spread captured   : gross revenue vs the fair mid at fill time.
//   - adverse selection : how far the mid moved against the new position over a
//                         mark-out horizon (loss = the informed-flow tax).
//   - inventory carry   : mark-to-market drift on the inventory we were already
//                         holding, over the same horizon.
//   - fees              : signed; maker rebate is positive revenue (negative cost).
// Net alone hides the case where you earn X+ε in spread while paying X in
// adverse selection — a different (worse) business from earning X+ε on clean
// flow. The attribution is the only honest read on whether a quoter has edge.
//
// USDC-units throughout; value(q,Δprice) = q·Δprice/1e6 keeps both legs exact.

const MICROS = 1_000_000n;

function valueUnits(qtyUnits: bigint, dPriceMicros: bigint): bigint {
  return (qtyUnits * dPriceMicros) / MICROS;
}

export interface AttributableFill {
  side: FillSide;
  sizeUnits: bigint;
  priceMicros: bigint;
  feeUnits: bigint; // signed; + cost, − rebate
}

export interface PnlComponent {
  spreadCapturedUnits: bigint;
  adverseSelectionUnits: bigint; // + = loss to us
  inventoryCarryUnits: bigint; // signed mark-to-market drift on prior inventory
  feesUnits: bigint; // signed; + cost, − rebate
}

/**
 * Attribute one fill.
 * @param fairMidMicros   mid at fill time (the fair value the spread is measured against)
 * @param markoutMidMicros mid at fill time + horizon (the adverse-selection reference)
 * @param inventoryBeforeUnits signed inventory held *before* this fill (for carry)
 */
export function attributeFill(
  fill: AttributableFill,
  fairMidMicros: bigint,
  markoutMidMicros: bigint,
  inventoryBeforeUnits: bigint,
): PnlComponent {
  const spread =
    fill.side === 'SELL'
      ? valueUnits(fill.sizeUnits, fill.priceMicros - fairMidMicros)
      : valueUnits(fill.sizeUnits, fairMidMicros - fill.priceMicros);
  // After a SELL we are shorter, so a *rising* mid is adverse; after a BUY we
  // are longer, so a *falling* mid is adverse.
  const adverse =
    fill.side === 'SELL'
      ? valueUnits(fill.sizeUnits, markoutMidMicros - fairMidMicros)
      : valueUnits(fill.sizeUnits, fairMidMicros - markoutMidMicros);
  const inventoryCarry = valueUnits(inventoryBeforeUnits, markoutMidMicros - fairMidMicros);
  return {
    spreadCapturedUnits: spread,
    adverseSelectionUnits: adverse,
    inventoryCarryUnits: inventoryCarry,
    feesUnits: fill.feeUnits,
  };
}

export interface AttributionSummary {
  spreadCapturedUnits: bigint;
  adverseSelectionUnits: bigint;
  inventoryCarryUnits: bigint;
  feesUnits: bigint;
}

export function sumComponents(components: PnlComponent[]): AttributionSummary {
  return components.reduce<AttributionSummary>(
    (acc, c) => ({
      spreadCapturedUnits: acc.spreadCapturedUnits + c.spreadCapturedUnits,
      adverseSelectionUnits: acc.adverseSelectionUnits + c.adverseSelectionUnits,
      inventoryCarryUnits: acc.inventoryCarryUnits + c.inventoryCarryUnits,
      feesUnits: acc.feesUnits + c.feesUnits,
    }),
    { spreadCapturedUnits: 0n, adverseSelectionUnits: 0n, inventoryCarryUnits: 0n, feesUnits: 0n },
  );
}
