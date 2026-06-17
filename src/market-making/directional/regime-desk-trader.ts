import { RegimeDirectionalBook } from './regime-directional-book';
import { RegimeMonitor, RegimeState, RegimeColor, REGIME_OVERALL_COLOR } from './regime-monitor';
import { RegimeDeskRisk, RegimeDeskRiskConfig, BookRiskInput, DeskRiskAssessment } from './regime-desk-risk';
import { attributeDesk, BookTcaInput } from './regime-tca';
import { aggregatePortfolioRisk, betaPnlIncrementUnits, BookRiskRead, PortfolioRisk } from './regime-portfolio-risk';
import { estimateBeta } from './regime-beta-hedge';
import { BiasReading, effectiveBias } from '../bias/bias-source.interface';
import { DeskEventInput, controlEvent } from '../events/desk-event';

// RegimeDeskTrader — the in-process host of the standalone "take sides" desk (Playbook II P13),
// the analogue of MmPortfolioTrader for the directional book. It owns the seated books + their
// monitors + the desk-risk spine, and turns one round of fresh ticks into the same PASS sequence
// the terminal runner (scripts/regime-book-live.ts) runs: weather → desk-risk assess → beta-P&L
// accrual + portfolio risk read → book updates → snapshot. The /api/regime/* controller drives it
// and reads `snapshot()`; the live driver feeds it ticks. Behind the REGIME_DESK flag, OFF by
// default (nothing about existing runs changes).
//
// TICK-DRIVEN + network-free: the caller fetches data; the trader just orchestrates the pure
// engine. That keeps it fully unit-testable (feed synthetic ticks, assert the snapshot / controls)
// exactly like the stress harness, with no I/O inside.

const MICROS = 1_000_000;
const toUsd = (units: bigint) => Number(units) / MICROS;

/** A seated, funded book — built by the driver (gate → allocate → consensus) and handed to the trader. */
export interface SeatedRegimeBook {
  readonly symbol: string;
  readonly ic: number;
  readonly signalName: string;
  /** Allocated notional budget (USD) from the cross-sectional allocator (P12). */
  readonly allocNotionalUsd: number;
  readonly book: RegimeDirectionalBook;
  readonly monitor: RegimeMonitor;
}

/** One symbol's fresh data for a tick (driver-computed; the trader does the rest). */
export interface RegimeSymbolTick {
  readonly nowMs: number;
  readonly midMicros: bigint;
  /** Current funding/hr (accrual + monitor). */
  readonly fundingRatePerHour: number;
  /** Trailing-mean funding for the monitor (defaults to current). */
  readonly fundingForSignal?: number;
  readonly basisBps?: number;
  /** Latest per-bar log return (monitor vol). */
  readonly ret?: number;
  /** The consensus bias reading (driver-built from validated sources). */
  readonly reading: BiasReading;
  /** Recent per-bar log returns (risk-read vol + beta). */
  readonly recentReturns: readonly number[];
}

/** The market-factor leg for the risk read (the hedge instrument, default BTC). */
export interface RegimeMarketTick {
  readonly symbol: string;
  readonly midUsd: number;
  readonly returns: readonly number[];
}

export interface RegimeDeskTraderConfig {
  readonly deskRisk: RegimeDeskRiskConfig;
  /** Market factor symbol for beta/VaR. Default 'BTC'. */
  readonly marketSymbol?: string;
  /** Parametric-VaR horizon (bars). Default 24. */
  readonly varHorizonBars?: number;
  readonly onEvent?: (e: DeskEventInput) => void;
}

export interface PositionCard {
  readonly symbol: string;
  readonly signalName: string;
  readonly ic: number;
  readonly side: 'LONG' | 'SHORT' | 'FLAT';
  readonly notionalUsd: number;
  readonly entryUsd: number | null;
  readonly markUsd: number;
  readonly unrealisedUsd: number;
  readonly realisedUsd: number;
  readonly fundingUsd: number;
  readonly bias: number;
  /** Distance-to-stop ∈ [0,1] (the hero gauge): 0 far, 1 at the stop. */
  readonly stopGaugeFrac: number;
  readonly allocNotionalUsd: number;
}

export interface WeatherCard {
  readonly symbol: string;
  readonly overall: RegimeState['overall'];
  readonly color: RegimeColor;
  readonly fundingSide: string;
  readonly basisBps: number;
  readonly volRatio: number;
  readonly standAside: boolean;
}

export interface RegimeDeskSnapshot {
  readonly running: boolean;
  readonly halted: boolean;
  readonly haltReason: string | null;
  readonly polls: number;
  readonly desk: {
    readonly realisedUsd: number; // realised − fees + funding
    readonly unrealisedUsd: number;
    readonly fundingUsd: number;
    readonly totalUsd: number;
    readonly maxDrawdownUsd: number;
    readonly grossUsd: number;
    readonly netUsd: number;
    readonly live: number;
    readonly aside: number;
  };
  readonly risk: PortfolioRisk | null;
  readonly attribution: {
    readonly idiosyncraticUsd: number;
    readonly betaUsd: number;
    readonly fundingUsd: number;
    readonly feesUsd: number;
    readonly slippageUsd: number;
    readonly totalUsd: number;
  };
  readonly positions: readonly PositionCard[];
  readonly weather: readonly WeatherCard[];
}

interface BookEntry {
  seat: SeatedRegimeBook;
  lastMidMicros: bigint;
  lastState: RegimeState | null;
  lastBias: number;
  entryMidMicros: bigint | null;
  betaPnlAccrued: bigint;
  betaForRisk: number;
}

export class RegimeDeskTrader {
  private readonly books = new Map<string, BookEntry>();
  private readonly deskRisk: RegimeDeskRisk;
  private readonly marketSymbol: string;
  private readonly varHorizonBars: number;
  private readonly onEvent?: (e: DeskEventInput) => void;
  private running = false;
  private polls = 0;
  private peakTotalUsd = 0;
  private maxDrawdownUsd = 0;
  private lastRisk: PortfolioRisk | null = null;
  private lastMarketMidUsd: number | null = null;
  private lastAssessment: DeskRiskAssessment | null = null;

  constructor(private readonly cfg: RegimeDeskTraderConfig) {
    this.deskRisk = new RegimeDeskRisk(cfg.deskRisk);
    this.marketSymbol = cfg.marketSymbol ?? 'BTC';
    this.varHorizonBars = cfg.varHorizonBars ?? 24;
    this.onEvent = cfg.onEvent;
  }

  /** Seat the funded books (driver builds them from the gate + allocator). Resets running state. */
  seat(books: readonly SeatedRegimeBook[]): void {
    this.books.clear();
    for (const s of books) {
      this.books.set(s.symbol, { seat: s, lastMidMicros: 0n, lastState: null, lastBias: 0, entryMidMicros: null, betaPnlAccrued: 0n, betaForRisk: 0 });
    }
  }

  start(): void { this.running = true; }
  stop(): void { this.running = false; }
  isRunning(): boolean { return this.running; }
  bookCount(): number { return this.books.size; }

  /** Manual desk kill-switch (latches; every book flattens next tick). */
  halt(reason = 'manual kill switch (cockpit)'): void {
    this.deskRisk.manualHalt(reason);
    this.emit(`DESK HALT — ${reason}`);
  }
  /** Flatten ONE book at its last mid (books the realised exit next tick via stand-aside). */
  flatten(symbol: string): boolean {
    const e = this.books.get(symbol.toUpperCase());
    if (!e) return false;
    this.deskRisk.manualFlatten(symbol.toUpperCase());
    this.emit(`FLATTEN ${symbol.toUpperCase()} — cockpit`);
    return true;
  }

  /**
   * One round: weather → desk-risk → beta-P&L accrual + risk read → book updates.
   * `ticks` keyed by symbol; `market` carries the factor leg for VaR/beta (optional).
   */
  tick(ticks: Map<string, RegimeSymbolTick>, market?: RegimeMarketTick): void {
    this.polls++;
    // 1. weather per symbol (pre-update positions).
    for (const [sym, e] of this.books) {
      const t = ticks.get(sym);
      if (!t) continue;
      e.lastMidMicros = t.midMicros;
      e.lastState = e.seat.monitor.update({ nowMs: t.nowMs, fundingRatePerHour: t.fundingForSignal ?? t.fundingRatePerHour, basisBps: t.basisBps, ret: t.ret });
    }
    // 2. desk-risk assess on the whole pre-update snapshot.
    this.lastAssessment = this.deskRisk.assess([...this.books.values()].map((e) => this.riskInput(e)));
    // 3. beta-P&L accrual + portfolio risk read (pre-update held positions).
    this.riskRead(ticks, market);
    // 4. update each book under its weather + desk-risk verdict.
    for (const [sym, e] of this.books) {
      const t = ticks.get(sym);
      if (!t) continue;
      const verdict = this.lastAssessment.perBook.get(sym);
      const flatten = this.lastAssessment.desk.kind === 'Halt' || verdict?.kind === 'FlattenNow';
      e.lastBias = effectiveBias(t.reading);
      const action = e.seat.book.update({ nowMs: t.nowMs, midMicros: t.midMicros, reading: t.reading, ic: e.seat.ic, fundingRatePerHour: t.fundingRatePerHour, standAside: (e.lastState?.standAside ?? false) || flatten });
      if (action.action === 'open' || action.action === 'flip') e.entryMidMicros = t.midMicros;
      if (action.action === 'close') e.entryMidMicros = null;
    }
    // 5. desk maxDD (realised + open mark).
    const total = this.deskTotalUsd();
    if (total > this.peakTotalUsd) this.peakTotalUsd = total;
    const dd = this.peakTotalUsd - total;
    if (dd > this.maxDrawdownUsd) this.maxDrawdownUsd = dd;
  }

  private riskRead(ticks: Map<string, RegimeSymbolTick>, market?: RegimeMarketTick): void {
    if (!market) return;
    const marketReturn = this.lastMarketMidUsd && this.lastMarketMidUsd > 0 ? Math.log(market.midUsd / this.lastMarketMidUsd) : 0;
    const riskBooks: BookRiskRead[] = [];
    for (const [sym, e] of this.books) {
      const t = ticks.get(sym);
      if (!t) continue;
      const beta = sym === this.marketSymbol ? 1 : estimateBeta(t.recentReturns, market.returns);
      e.betaForRisk = beta;
      const n = this.signedNotionalUsd(e);
      e.betaPnlAccrued += betaPnlIncrementUnits(n, beta, marketReturn);
      riskBooks.push({ symbol: sym, signedNotionalUsd: n, beta, returns: t.recentReturns });
    }
    this.lastRisk = aggregatePortfolioRisk(riskBooks, market.returns, { capitalUsd: this.cfg.deskRisk.capitalUsd, horizonBars: this.varHorizonBars });
    this.lastMarketMidUsd = market.midUsd;
  }

  private signedNotionalUsd(e: BookEntry): number {
    const inv = e.seat.book.inventoryUnits();
    if (inv === 0n || e.lastMidMicros === 0n) return 0;
    return Number((inv * e.lastMidMicros) / BigInt(MICROS)) / MICROS;
  }

  private riskInput(e: BookEntry): BookRiskInput {
    if (e.lastMidMicros === 0n) return { symbol: e.seat.symbol, notionalUsd: 0, side: 'FLAT', realisedPnlUsd: 0, unrealisedPnlUsd: 0 };
    const snap = e.seat.book.snapshot(e.lastMidMicros);
    const inv = snap.inventoryUnits;
    const absInv = inv < 0n ? -inv : inv;
    return {
      symbol: e.seat.symbol,
      notionalUsd: Number((absInv * e.lastMidMicros) / BigInt(MICROS)) / MICROS,
      side: inv > 0n ? 'LONG' : inv < 0n ? 'SHORT' : 'FLAT',
      realisedPnlUsd: toUsd(snap.realisedUnits - snap.feesUnits + snap.fundingUnits),
      unrealisedPnlUsd: toUsd(snap.unrealisedUnits),
    };
  }

  private deskTotalUsd(): number {
    let total = 0;
    for (const e of this.books.values()) {
      if (e.lastMidMicros === 0n) continue;
      total += toUsd(e.seat.book.totalPnlUnits(e.lastMidMicros));
    }
    return total;
  }

  private tcaInputs(): BookTcaInput[] {
    const out: BookTcaInput[] = [];
    for (const e of this.books.values()) {
      if (e.lastMidMicros === 0n) continue;
      const s = e.seat.book.snapshot(e.lastMidMicros);
      out.push({ symbol: e.seat.symbol, realisedUnits: s.realisedUnits, feesUnits: s.feesUnits, fundingUnits: s.fundingUnits, unrealisedUnits: s.unrealisedUnits, slippageUnits: s.slippageUnits, betaPnlUnits: e.betaPnlAccrued });
    }
    return out;
  }

  private emit(detail: string): void {
    if (!this.onEvent) return;
    try {
      // a control event on the shared desk tape (the cockpit Activity feed).
      this.onEvent(controlEvent({ ts: Date.now(), book: 'REGIME-DESK', detail }));
    } catch { /* observability must never break the desk */ }
  }

  /** The cockpit DTO: weather + position cards (+ stop gauge) + risk + TCA + desk totals. */
  snapshot(): RegimeDeskSnapshot {
    let realised = 0n, unreal = 0n, funding = 0n, gross = 0, net = 0, live = 0, aside = 0;
    const positions: PositionCard[] = [];
    const weather: WeatherCard[] = [];
    for (const e of this.books.values()) {
      const mid = e.lastMidMicros;
      const snap = mid === 0n ? null : e.seat.book.snapshot(mid);
      const inv = e.seat.book.inventoryUnits();
      const side = inv > 0n ? 'LONG' : inv < 0n ? 'SHORT' : 'FLAT';
      const notionalUsd = mid === 0n ? 0 : Number(((inv < 0n ? -inv : inv) * mid) / BigInt(MICROS)) / MICROS;
      if (snap) {
        realised += snap.realisedUnits - snap.feesUnits;
        unreal += snap.unrealisedUnits;
        funding += snap.fundingUnits;
        gross += notionalUsd;
        net += side === 'LONG' ? notionalUsd : side === 'SHORT' ? -notionalUsd : 0;
      }
      if (inv !== 0n) live++;
      if (e.lastState?.standAside) aside++;
      // distance-to-stop: |unrealised loss| / (stopFrac · notional) — but stopFrac is private to the
      // book; approximate the gauge from the unrealised drawdown vs notional (UI shows the trend).
      const unrealUsd = snap ? toUsd(snap.unrealisedUnits) : 0;
      const ddFrac = notionalUsd > 0 && unrealUsd < 0 ? Math.min(1, -unrealUsd / (0.02 * notionalUsd)) : 0;
      positions.push({
        symbol: e.seat.symbol,
        signalName: e.seat.signalName,
        ic: e.seat.ic,
        side,
        notionalUsd,
        entryUsd: e.entryMidMicros ? Number(e.entryMidMicros) / MICROS : null,
        markUsd: mid === 0n ? 0 : Number(mid) / MICROS,
        unrealisedUsd: unrealUsd,
        realisedUsd: snap ? toUsd(snap.realisedUnits - snap.feesUnits) : 0,
        fundingUsd: snap ? toUsd(snap.fundingUnits) : 0,
        bias: e.lastBias,
        stopGaugeFrac: ddFrac,
        allocNotionalUsd: e.seat.allocNotionalUsd,
      });
      if (e.lastState) {
        weather.push({
          symbol: e.seat.symbol,
          overall: e.lastState.overall,
          color: REGIME_OVERALL_COLOR[e.lastState.overall],
          fundingSide: e.lastState.funding.side,
          basisBps: e.lastState.basis.basisBps,
          volRatio: e.lastState.vol.ratio,
          standAside: e.lastState.standAside,
        });
      }
    }
    const tca = attributeDesk(this.tcaInputs());
    const totalUsd = toUsd(realised + funding + unreal);
    return {
      running: this.running,
      halted: this.deskRisk.isHalted(),
      haltReason: this.deskRisk.haltReason(),
      polls: this.polls,
      desk: {
        realisedUsd: toUsd(realised + funding),
        unrealisedUsd: toUsd(unreal),
        fundingUsd: toUsd(funding),
        totalUsd,
        maxDrawdownUsd: this.maxDrawdownUsd,
        grossUsd: gross,
        netUsd: net,
        live,
        aside,
      },
      risk: this.lastRisk,
      attribution: {
        idiosyncraticUsd: toUsd(tca.idiosyncraticUnits),
        betaUsd: toUsd(tca.betaUnits),
        fundingUsd: toUsd(tca.fundingUnits),
        feesUsd: toUsd(tca.feesUnits),
        slippageUsd: toUsd(tca.slippageUnits),
        totalUsd: toUsd(tca.totalUnits),
      },
      positions,
      weather,
    };
  }
}
