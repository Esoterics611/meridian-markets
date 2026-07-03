import { InventoryBook, InventoryBookState } from '../inventory/inventory-book';
import { FillCostModel, NoSlippageModel } from '../directional/fill-cost-model';
import { CarryDirection } from '../../market-data/funding/funding-carry-discovery';
import { DeskEventInput, fillEvent } from '../events/desk-event';

// FundingCarryBook — the delta-neutral funding-carry position as a real BOOK
// (PROFIT_PIVOT_II P0 / PROFIT_PIVOT T2). Two equal-quantity legs on the same
// underlying: a SPOT leg (marked at the Binance mid — the leading fair value) and a
// PERP leg (marked at the HL mid). SHORT_PERP = long spot / short perp, collecting
// positive funding; LONG_PERP is the mirror for persistently negative funding.
//
// P&L model (identical to staticCarry, now as a live avg-cost ledger):
//   funding  — accrued TIME-WEIGHTED: rate × (Δt / fundingPeriodMs) × leg notional.
//              Never per-poll (the #72 tracker bug accrued one full hourly period per
//              60s poll — a 60× overstatement; the regression spec locks this).
//   basis    — the two legs' unrealised sum: directional moves wash out, what remains
//              is the perp-vs-spot basis change over the hold.
//   fees     — bps per side per leg, charged on the mid notional (slippage is
//              separate, mirroring the P7 convention so TCA can split them). On the
//              mid-based open/close path this is the config taker fee; on the E2
//              executions path it is the fee the executor actually paid — SIGNED,
//              so an HL maker rebate (−0.2bps) is revenue.
//   slippage — SIGNED implementation shortfall vs the reference mid, accumulated as
//              a TCA diagnostic (+ = paid worse than mid, − = maker price
//              improvement). The taker path's FillCostModel always worsens the
//              price, so its reads are unchanged from the old absolute convention.
//
// Margin honesty (PROFIT_PIVOT_II R9a): "paper can hold forever" overstates capacity —
// a real venue margins EACH leg separately, and the losing leg can be liquidated even
// when the pair is delta-neutral. Each leg posts notional/maxLeverage of margin;
// wouldLiquidate() trips when either leg's unrealised loss reaches maintenanceFrac of
// its margin. The runner treats that as a forced flatten, so the demo's holding
// capacity is bounded the way a real position's would be.
//
// Pure + clock-free (caller passes nowMs); money in USDC-units (6-dec) bigint, prices
// in micros — repo-wide convention. Judged realised-first: realised − fees + funding.

const MICROS = 1_000_000n;

function valueUnits(qtyUnits: bigint, priceMicros: bigint): bigint {
  return (qtyUnits * priceMicros) / MICROS;
}

function round(x: number): bigint {
  return BigInt(Math.round(x));
}

export interface FundingCarryBookConfig {
  symbol: string;
  direction: CarryDirection;
  /** Per-leg target notional, USD (both legs sized to equal quantity off the perp mid). */
  notionalUsd: number;
  /** Taker fee per side, bps, spot leg — the mid-based open/close path (E2 executions carry their own fee). */
  spotFeeBps: number;
  /** Taker fee per side, bps, perp leg — the mid-based path (route via E2 acquireFill for maker entry). */
  perpFeeBps: number;
  /** Funding settlement period, ms (Hyperliquid: 3_600_000 — hourly). */
  fundingPeriodMs: number;
  /** Margin honesty: each leg posts notional/maxLeverage (default 3×). */
  maxLeverage?: number;
  /** Either leg's unrealised loss ≥ this fraction of its margin ⇒ wouldLiquidate (default 0.8). */
  maintenanceFrac?: number;
  /** Execution-cost model for both legs (default frictionless, mirroring P7). */
  fillModel?: FillCostModel;
  /** Desk-event tape sink (optional — silent by default, the repo-wide no-op posture). */
  onEvent?: (e: DeskEventInput) => void;
}

/**
 * One externally executed leg (the E2 maker-execution path): the executed price, the
 * fee actually charged (signed bps — a maker rebate is negative), and the reference
 * mid it is judged against (basis baseline + signed shortfall diagnostic).
 */
export interface LegExecution {
  priceMicros: bigint;
  feeBps: number;
  midMicros: bigint;
}

/** The durable blob — bigints as decimal strings (JSONB/BIGINT round-trip safe). */
export interface FundingCarryBookState {
  symbol: string;
  direction: CarryDirection;
  spotLeg: InventoryBookState;
  perpLeg: InventoryBookState;
  qtyUnits: string;
  fundingUnits: string;
  slippageUnits: string;
  /** Funding accrual clock — the #47 rehydrate-trap field: drop it and a revived book
   *  double- or mis-accrues over the restart gap. The restore spec locks it. */
  lastAccrualMs: number | null;
  openedMs: number | null;
  entrySpotMidMicros: string | null;
  entryPerpMidMicros: string | null;
}

export interface CarryBookSnapshot {
  symbol: string;
  direction: CarryDirection;
  isOpen: boolean;
  qtyUnits: bigint;
  /** Current per-leg notional at the perp mark. */
  legNotionalUnits: bigint;
  fundingUnits: bigint;
  realisedUnits: bigint;
  feesUnits: bigint;
  slippageUnits: bigint;
  /** Both legs' unrealised sum = the basis P&L on the open position. */
  basisUnrealisedUnits: bigint;
  /** realised − fees + funding — THE judged number (realised-first). */
  realisedFirstUnits: bigint;
  /** realisedFirst + basisUnrealised — the total mark. */
  netUnits: bigint;
  entryBasisBps: number | null;
  currentBasisBps: number;
  ageMs: number | null;
  marginPerLegUnits: bigint;
  spotMarginUtil: number;
  perpMarginUtil: number;
  wouldLiquidate: boolean;
}

export class FundingCarryBook {
  private readonly spotLeg = new InventoryBook();
  private readonly perpLeg = new InventoryBook();
  private readonly fillModel: FillCostModel;
  private readonly notionalUnits: bigint;
  private readonly maxLeverage: number;
  private readonly maintenanceFrac: number;

  private qty = 0n;
  private funding = 0n;
  private slippage = 0n;
  private lastAccrualMs: number | null = null;
  private openedMs: number | null = null;
  private entrySpotMid: bigint | null = null;
  private entryPerpMid: bigint | null = null;

  constructor(private readonly cfg: FundingCarryBookConfig) {
    if (cfg.notionalUsd <= 0) throw new Error('FundingCarryBook: notionalUsd must be > 0');
    if (cfg.fundingPeriodMs <= 0) throw new Error('FundingCarryBook: fundingPeriodMs must be > 0');
    this.fillModel = cfg.fillModel ?? new NoSlippageModel();
    this.notionalUnits = BigInt(Math.round(cfg.notionalUsd * 1_000_000));
    this.maxLeverage = cfg.maxLeverage ?? 3;
    this.maintenanceFrac = cfg.maintenanceFrac ?? 0.8;
    if (this.maxLeverage <= 0) throw new Error('FundingCarryBook: maxLeverage must be > 0');
  }

  isOpen(): boolean {
    return this.qty > 0n;
  }

  /** Open both legs at the given mids. Throws if already open. */
  open(nowMs: number, spotMidMicros: bigint, perpMidMicros: bigint): void {
    if (this.isOpen()) throw new Error(`FundingCarryBook ${this.cfg.symbol}: already open`);
    if (spotMidMicros <= 0n || perpMidMicros <= 0n) throw new Error('FundingCarryBook.open: mids must be > 0');
    this.qty = (this.notionalUnits * MICROS) / perpMidMicros;
    if (this.qty <= 0n) throw new Error('FundingCarryBook.open: sized to zero quantity');

    const spotSide = this.cfg.direction === 'SHORT_PERP' ? 'BUY' : 'SELL';
    const perpSide = this.cfg.direction === 'SHORT_PERP' ? 'SELL' : 'BUY';
    this.fillLeg(this.spotLeg, 'spot', spotSide, spotMidMicros, this.cfg.spotFeeBps, nowMs);
    this.fillLeg(this.perpLeg, 'perp', perpSide, perpMidMicros, this.cfg.perpFeeBps, nowMs);

    this.lastAccrualMs = nowMs;
    this.openedMs = nowMs;
    this.entrySpotMid = spotMidMicros;
    this.entryPerpMid = perpMidMicros;
  }

  /** Close both legs at the given mids, realising the basis P&L. Throws if flat. */
  close(nowMs: number, spotMidMicros: bigint, perpMidMicros: bigint): void {
    if (!this.isOpen()) throw new Error(`FundingCarryBook ${this.cfg.symbol}: not open`);
    const spotSide = this.cfg.direction === 'SHORT_PERP' ? 'SELL' : 'BUY';
    const perpSide = this.cfg.direction === 'SHORT_PERP' ? 'BUY' : 'SELL';
    this.fillLeg(this.spotLeg, 'spot', spotSide, spotMidMicros, this.cfg.spotFeeBps, nowMs);
    this.fillLeg(this.perpLeg, 'perp', perpSide, perpMidMicros, this.cfg.perpFeeBps, nowMs);
    this.qty = 0n;
    this.entrySpotMid = null;
    this.entryPerpMid = null;
  }

  /**
   * Open both legs at externally executed prices (the E2 maker-execution path).
   * Quantity is sized off the perp REFERENCE mid (same rule as open()); the ledger
   * takes the executed prices, the fee each leg actually paid (signed bps — a maker
   * rebate is negative), and the mids anchor the basis baseline + signed shortfall.
   */
  openWithExecutions(nowMs: number, spot: LegExecution, perp: LegExecution): void {
    if (this.isOpen()) throw new Error(`FundingCarryBook ${this.cfg.symbol}: already open`);
    if (spot.midMicros <= 0n || perp.midMicros <= 0n || spot.priceMicros <= 0n || perp.priceMicros <= 0n) {
      throw new Error('FundingCarryBook.openWithExecutions: prices and mids must be > 0');
    }
    this.qty = (this.notionalUnits * MICROS) / perp.midMicros;
    if (this.qty <= 0n) throw new Error('FundingCarryBook.openWithExecutions: sized to zero quantity');

    const spotSide = this.cfg.direction === 'SHORT_PERP' ? 'BUY' : 'SELL';
    const perpSide = this.cfg.direction === 'SHORT_PERP' ? 'SELL' : 'BUY';
    this.fillLegAt(this.spotLeg, 'spot', spotSide, spot.priceMicros, spot.midMicros, spot.feeBps, nowMs);
    this.fillLegAt(this.perpLeg, 'perp', perpSide, perp.priceMicros, perp.midMicros, perp.feeBps, nowMs);

    this.lastAccrualMs = nowMs;
    this.openedMs = nowMs;
    this.entrySpotMid = spot.midMicros;
    this.entryPerpMid = perp.midMicros;
  }

  /** Close both legs at externally executed prices (the E2 path). Throws if flat. */
  closeWithExecutions(nowMs: number, spot: LegExecution, perp: LegExecution): void {
    if (!this.isOpen()) throw new Error(`FundingCarryBook ${this.cfg.symbol}: not open`);
    if (spot.midMicros <= 0n || perp.midMicros <= 0n || spot.priceMicros <= 0n || perp.priceMicros <= 0n) {
      throw new Error('FundingCarryBook.closeWithExecutions: prices and mids must be > 0');
    }
    const spotSide = this.cfg.direction === 'SHORT_PERP' ? 'SELL' : 'BUY';
    const perpSide = this.cfg.direction === 'SHORT_PERP' ? 'BUY' : 'SELL';
    this.fillLegAt(this.spotLeg, 'spot', spotSide, spot.priceMicros, spot.midMicros, spot.feeBps, nowMs);
    this.fillLegAt(this.perpLeg, 'perp', perpSide, perp.priceMicros, perp.midMicros, perp.feeBps, nowMs);
    this.qty = 0n;
    this.entrySpotMid = null;
    this.entryPerpMid = null;
  }

  /**
   * Accrue funding for the elapsed time at the current rate — TIME-WEIGHTED:
   * rate × (Δt / fundingPeriodMs) × leg notional at the perp mark. Returns the
   * accrued delta (signed: + = the carry side received). No-op when flat.
   */
  accrueFunding(nowMs: number, ratePerPeriod: number, perpMarkMicros: bigint): bigint {
    if (!this.isOpen() || this.lastAccrualMs === null) return 0n;
    const dtMs = nowMs - this.lastAccrualMs;
    if (dtMs <= 0) return 0n;
    this.lastAccrualMs = nowMs;
    const periods = dtMs / this.cfg.fundingPeriodMs;
    const legNotional = Number(valueUnits(this.qty, perpMarkMicros));
    const signedRate = this.cfg.direction === 'SHORT_PERP' ? ratePerPeriod : -ratePerPeriod;
    const delta = round(signedRate * periods * legNotional);
    this.funding += delta;
    return delta;
  }

  snapshot(spotMidMicros: bigint, perpMidMicros: bigint, nowMs?: number): CarryBookSnapshot {
    const basisUnreal = this.spotLeg.unrealisedUnits(spotMidMicros) + this.perpLeg.unrealisedUnits(perpMidMicros);
    const realised = this.spotLeg.realisedUnits() + this.perpLeg.realisedUnits();
    const fees = this.spotLeg.feesUnits() + this.perpLeg.feesUnits();
    const realisedFirst = realised - fees + this.funding;
    const marginPerLeg = (this.notionalUnits * MICROS) / BigInt(Math.round(this.maxLeverage * 1_000_000));
    const spotUtil = this.legMarginUtil(this.spotLeg.unrealisedUnits(spotMidMicros), marginPerLeg);
    const perpUtil = this.legMarginUtil(this.perpLeg.unrealisedUnits(perpMidMicros), marginPerLeg);
    const entryBasisBps =
      this.entrySpotMid !== null && this.entryPerpMid !== null && this.entrySpotMid > 0n
        ? (Number(this.entryPerpMid - this.entrySpotMid) / Number(this.entrySpotMid)) * 10_000
        : null;
    return {
      symbol: this.cfg.symbol,
      direction: this.cfg.direction,
      isOpen: this.isOpen(),
      qtyUnits: this.qty,
      legNotionalUnits: valueUnits(this.qty, perpMidMicros),
      fundingUnits: this.funding,
      realisedUnits: realised,
      feesUnits: fees,
      slippageUnits: this.slippage,
      basisUnrealisedUnits: basisUnreal,
      realisedFirstUnits: realisedFirst,
      netUnits: realisedFirst + basisUnreal,
      entryBasisBps,
      currentBasisBps: spotMidMicros > 0n ? (Number(perpMidMicros - spotMidMicros) / Number(spotMidMicros)) * 10_000 : 0,
      ageMs: this.isOpen() && this.openedMs !== null && nowMs !== undefined ? nowMs - this.openedMs : null,
      marginPerLegUnits: marginPerLeg,
      spotMarginUtil: spotUtil,
      perpMarginUtil: perpUtil,
      wouldLiquidate: this.isOpen() && (spotUtil >= this.maintenanceFrac || perpUtil >= this.maintenanceFrac),
    };
  }

  serializeState(): FundingCarryBookState {
    return {
      symbol: this.cfg.symbol,
      direction: this.cfg.direction,
      spotLeg: this.spotLeg.serialize(),
      perpLeg: this.perpLeg.serialize(),
      qtyUnits: this.qty.toString(),
      fundingUnits: this.funding.toString(),
      slippageUnits: this.slippage.toString(),
      lastAccrualMs: this.lastAccrualMs,
      openedMs: this.openedMs,
      entrySpotMidMicros: this.entrySpotMid?.toString() ?? null,
      entryPerpMidMicros: this.entryPerpMid?.toString() ?? null,
    };
  }

  restoreState(s: FundingCarryBookState): void {
    if (s.symbol !== this.cfg.symbol || s.direction !== this.cfg.direction) {
      throw new Error(
        `FundingCarryBook.restoreState: ${s.symbol}/${s.direction} does not match book ${this.cfg.symbol}/${this.cfg.direction}`,
      );
    }
    this.spotLeg.restore(s.spotLeg);
    this.perpLeg.restore(s.perpLeg);
    this.qty = BigInt(s.qtyUnits);
    this.funding = BigInt(s.fundingUnits);
    this.slippage = BigInt(s.slippageUnits);
    this.lastAccrualMs = s.lastAccrualMs;
    this.openedMs = s.openedMs;
    this.entrySpotMid = s.entrySpotMidMicros === null ? null : BigInt(s.entrySpotMidMicros);
    this.entryPerpMid = s.entryPerpMidMicros === null ? null : BigInt(s.entryPerpMidMicros);
  }

  private legMarginUtil(unrealised: bigint, marginPerLeg: bigint): number {
    if (!this.isOpen() || marginPerLeg <= 0n) return 0;
    const loss = unrealised < 0n ? -unrealised : 0n;
    return Number(loss) / Number(marginPerLeg);
  }

  /** The mid-based path: the FillCostModel worsens the price, the config fee applies. */
  private fillLeg(
    leg: InventoryBook,
    legName: 'spot' | 'perp',
    side: 'BUY' | 'SELL',
    midMicros: bigint,
    feeBps: number,
    nowMs: number,
  ): void {
    const fillPrice = this.fillModel.fillPrice(side, this.qty, midMicros);
    this.fillLegAt(leg, legName, side, fillPrice, midMicros, feeBps, nowMs);
  }

  /** Ledger one leg at an explicit executed price; slippage accrues SIGNED vs the mid. */
  private fillLegAt(
    leg: InventoryBook,
    legName: 'spot' | 'perp',
    side: 'BUY' | 'SELL',
    fillPrice: bigint,
    midMicros: bigint,
    feeBps: number,
    nowMs: number,
  ): void {
    const feeUnits = round((Number(valueUnits(this.qty, midMicros)) * feeBps) / 10_000);
    const before = leg.inventoryUnits();
    const realisedBefore = leg.realisedUnits();
    leg.apply({ side, sizeUnits: this.qty, priceMicros: fillPrice, feeUnits });
    const shortfallMicros = side === 'BUY' ? fillPrice - midMicros : midMicros - fillPrice;
    this.slippage += (this.qty * shortfallMicros) / MICROS;
    this.cfg.onEvent?.(
      fillEvent({
        ts: nowMs,
        book: `${this.cfg.symbol}·${legName}`,
        source: 'carry',
        side,
        action: before === 0n ? 'open' : 'close',
        sizeUnits: this.qty,
        priceMicros: fillPrice,
        inventoryUnits: leg.inventoryUnits(),
        realisedDeltaUnits: leg.realisedUnits() - realisedBefore,
        feeUnits,
      }),
    );
  }
}
