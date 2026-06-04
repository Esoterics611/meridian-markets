// InventoryBook — real-time inventory + P&L accounting for a single MM book.
// A market maker's position is *involuntary* (the flow chooses it), so the book
// has to know its inventory and mark every quote tick (course §1.2). This is
// the shared accounting engine both the bar backtest and the live paper book
// use, so their P&L is computed identically.
//
// Average-cost convention. A fill on the side that *extends* the position
// updates the volume-weighted average cost; a fill that *reduces* it realises
// (fillPrice − avgCost)·closedQty against the open side. Crossing through zero
// realises the whole old side and opens a fresh position at the fill price.
//
// Units (CLAUDE.md §3): inventory in asset units (6-dec), price in micros,
// all P&L in USDC-units (6-dec). value(qtyUnits, priceMicros) =
// qtyUnits·priceMicros/1e6 keeps both legs exact in bigint.
//
// Fees are signed and accumulated separately: a positive feeUnits is a cost
// (taker), a negative one is a maker rebate (revenue). Net P&L = realised −
// fees + unrealised(mark).

export type FillSide = 'BUY' | 'SELL';

export interface InventoryFill {
  side: FillSide;
  sizeUnits: bigint; // asset units, > 0
  priceMicros: bigint;
  feeUnits: bigint; // signed: + cost, − rebate
}

/**
 * The full ledger state, with bigints as decimal STRINGS so it survives JSON +
 * a Postgres BIGINT round-trip. The book is exactly reconstructable from this —
 * persistence (restart-safe books) serialises this and restores it on boot.
 */
export interface InventoryBookState {
  inventoryUnits: string;
  avgCostMicros: string;
  realisedUnits: string;
  feesUnits: string;
  fillCount: number;
}

const MICROS = 1_000_000n;

function valueUnits(qtyUnits: bigint, priceMicros: bigint): bigint {
  return (qtyUnits * priceMicros) / MICROS;
}

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export class InventoryBook {
  /** Signed inventory in asset units; + = long. */
  private inventory = 0n;
  /** Volume-weighted average cost of the OPEN side, in micros. 0 when flat. */
  private avgCostMicros = 0n;
  /** Cumulative realised P&L (excl. fees), USDC-units. */
  private realised = 0n;
  /** Cumulative signed fees, USDC-units (+ cost, − rebate). */
  private fees = 0n;
  private fillCount = 0;

  apply(fill: InventoryFill): void {
    if (fill.sizeUnits <= 0n) throw new Error('InventoryBook.apply: sizeUnits must be > 0');
    this.fees += fill.feeUnits;
    this.fillCount += 1;
    const signed = fill.side === 'BUY' ? fill.sizeUnits : -fill.sizeUnits;

    const flat = this.inventory === 0n;
    const sameSide = (this.inventory > 0n && signed > 0n) || (this.inventory < 0n && signed < 0n);

    if (flat || sameSide) {
      // Extend the position: roll the average cost.
      const oldQty = bigAbs(this.inventory);
      const addQty = bigAbs(signed);
      const newQty = oldQty + addQty;
      this.avgCostMicros = (this.avgCostMicros * oldQty + fill.priceMicros * addQty) / newQty;
      this.inventory += signed;
      return;
    }

    // Reducing / crossing the position.
    const openQty = bigAbs(this.inventory);
    const closeQty = bigAbs(signed) < openQty ? bigAbs(signed) : openQty;
    // Realise P&L on the closed quantity, signed by which side we were on.
    if (this.inventory > 0n) {
      // Long closed by a SELL: profit when sell price > avg cost.
      this.realised += valueUnits(closeQty, fill.priceMicros - this.avgCostMicros);
    } else {
      // Short closed by a BUY: profit when avg cost > buy price.
      this.realised += valueUnits(closeQty, this.avgCostMicros - fill.priceMicros);
    }
    this.inventory += signed;
    if (this.inventory === 0n) {
      this.avgCostMicros = 0n; // closed flat
    } else if (bigAbs(signed) > openQty) {
      // Overshot through zero: the remainder opens a fresh position at fill price.
      this.avgCostMicros = fill.priceMicros;
    }
    // else: partial reduce — avgCost of the surviving open side is unchanged.
  }

  inventoryUnits(): bigint {
    return this.inventory;
  }

  avgCost(): bigint {
    return this.avgCostMicros;
  }

  realisedUnits(): bigint {
    return this.realised;
  }

  feesUnits(): bigint {
    return this.fees;
  }

  fills(): number {
    return this.fillCount;
  }

  /** Mark-to-market P&L on the open position at `midMicros`, USDC-units. */
  unrealisedUnits(midMicros: bigint): bigint {
    if (this.inventory === 0n) return 0n;
    return valueUnits(this.inventory, midMicros - this.avgCostMicros);
  }

  /** Total P&L: realised − fees + unrealised. */
  totalPnlUnits(midMicros: bigint): bigint {
    return this.realised - this.fees + this.unrealisedUnits(midMicros);
  }

  /** Equity = capital + total P&L. */
  equityUnits(capitalUnits: bigint, midMicros: bigint): bigint {
    return capitalUnits + this.totalPnlUnits(midMicros);
  }

  reset(): void {
    this.inventory = 0n;
    this.avgCostMicros = 0n;
    this.realised = 0n;
    this.fees = 0n;
    this.fillCount = 0;
  }

  /** Snapshot the full ledger state for persistence (restart-safe books). */
  serialize(): InventoryBookState {
    return {
      inventoryUnits: this.inventory.toString(),
      avgCostMicros: this.avgCostMicros.toString(),
      realisedUnits: this.realised.toString(),
      feesUnits: this.fees.toString(),
      fillCount: this.fillCount,
    };
  }

  /** Restore a previously-serialised ledger state (overwrites current state). */
  restore(s: InventoryBookState): void {
    this.inventory = BigInt(s.inventoryUnits);
    this.avgCostMicros = BigInt(s.avgCostMicros);
    this.realised = BigInt(s.realisedUnits);
    this.fees = BigInt(s.feesUnits);
    this.fillCount = s.fillCount;
  }
}
