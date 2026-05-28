import { Injectable } from '@nestjs/common';
import {
  CloseShortRequest,
  CloseShortResult,
  HedgePosition,
  HedgePositionNotFoundError,
  IHedgeVenue,
  OpenShortRequest,
  OpenShortResult,
  VenueHealth,
} from './hedge-venue.interface';

// Deterministic mock — simulates a short-ILS perp position with configurable
// FX drift and a constant 10bps/day funding placeholder. No external calls.
// Same swap-seam pattern as MockYieldProvider; flipping to a real venue is a
// one-line factory change in HedgeModule.
//
// Sign convention (documented because it's easy to get wrong):
//   We are short ILS vs USD. entry / mark are quoted in ILS-per-USD micros.
//   When ILS weakens (mark > entry), our short profits in USDC terms.
//   PnL formula: pnl = notional * (mark - entry) / entry
//   pnl is signed BigInt in 6-decimal USDC units.

const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_PARITY_MICROS = 1_000_000n; // mock entry; real venue would report.
const FUNDING_BPS_PER_DAY = 10n; // placeholder; real venues vary minute-by-minute.

interface StoredPosition {
  notionalUnits: bigint;
  entryPriceMicros: bigint;
  openedMs: number;
}

@Injectable()
export class MockHedgeVenue implements IHedgeVenue {
  readonly venueId = 'mock';

  private readonly positions = new Map<string, StoredPosition>();
  private readonly seenOpenKeys = new Map<string, OpenShortResult>();
  private readonly seenCloseKeys = new Map<string, CloseShortResult>();
  private refNonce = 0;

  constructor(
    /** Linear ILS drift, basis points per day. Positive = ILS weakens (short wins). */
    private readonly fxDriftBpsPerDay: number,
    private readonly settleMs: number,
    /** Injectable clock — tests fake time without jest fake timers. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async openShort(req: OpenShortRequest): Promise<OpenShortResult> {
    const cached = this.seenOpenKeys.get(req.idempotencyKey);
    if (cached) return cached;

    if (req.notionalUnits <= 0n) {
      throw new Error(`notionalUnits must be > 0; got ${req.notionalUnits}`);
    }

    await this.simulateLatency();
    // Prefix with venueId so int-specs that randomise venueId per test get
    // unique position refs across runs (avoids PK conflicts on hedge_positions
    // when prior test rows linger). Default venueId is 'mock' so unit specs
    // continue to see 'mock-pos-N'.
    const positionRef = `${this.venueId}-pos-${++this.refNonce}`;
    this.positions.set(positionRef, {
      notionalUnits: req.notionalUnits,
      entryPriceMicros: PRICE_PARITY_MICROS,
      openedMs: this.now().getTime(),
    });

    const result: OpenShortResult = {
      externalRef: positionRef,
      filledNotionalUnits: req.notionalUnits,
      entryPriceMicros: PRICE_PARITY_MICROS,
    };
    this.seenOpenKeys.set(req.idempotencyKey, result);
    return result;
  }

  async closeShort(req: CloseShortRequest): Promise<CloseShortResult> {
    const cached = this.seenCloseKeys.get(req.idempotencyKey);
    if (cached) return cached;

    const pos = this.positions.get(req.positionRef);
    if (!pos) throw new HedgePositionNotFoundError(req.positionRef);

    await this.simulateLatency();
    const markMicros = this.markFor(pos);
    const pnl = (pos.notionalUnits * (markMicros - pos.entryPriceMicros)) / pos.entryPriceMicros;
    this.positions.delete(req.positionRef);

    const result: CloseShortResult = {
      externalRef: `${this.venueId}-close-${++this.refNonce}`,
      pnlUnits: pnl,
    };
    this.seenCloseKeys.set(req.idempotencyKey, result);
    return result;
  }

  async fetchPosition(positionRef: string): Promise<HedgePosition> {
    const pos = this.positions.get(positionRef);
    if (!pos) throw new HedgePositionNotFoundError(positionRef);

    const now = this.now();
    const markMicros = this.markFor(pos, now.getTime());
    const unrealized = (pos.notionalUnits * (markMicros - pos.entryPriceMicros)) / pos.entryPriceMicros;
    const daysOpen = BigInt(Math.floor((now.getTime() - pos.openedMs) / DAY_MS));
    const funding = (pos.notionalUnits * daysOpen * FUNDING_BPS_PER_DAY) / 10_000n;

    return {
      positionRef,
      notionalUnits: pos.notionalUnits,
      entryPriceMicros: pos.entryPriceMicros,
      markPriceMicros: markMicros,
      unrealizedPnlUnits: unrealized,
      fundingPaidUnits: funding,
      asOf: now,
    };
  }

  async fetchHealth(): Promise<VenueHealth> {
    return { healthy: true, lastFundingBps: Number(FUNDING_BPS_PER_DAY), lastUpdate: this.now() };
  }

  private markFor(pos: StoredPosition, nowMs?: number): bigint {
    const elapsedMs = (nowMs ?? this.now().getTime()) - pos.openedMs;
    if (elapsedMs <= 0) return pos.entryPriceMicros;
    // drift = entry * (fxDriftBpsPerDay/10000) * (elapsedMs/DAY_MS)
    // Compute exactly in BigInt: scale bps by 1e6 to keep precision on sub-day windows.
    const driftScaled = BigInt(Math.round(this.fxDriftBpsPerDay * 1_000_000));
    const elapsed = BigInt(elapsedMs);
    const day = BigInt(DAY_MS);
    const delta = (pos.entryPriceMicros * driftScaled * elapsed) / (10_000n * 1_000_000n * day);
    return pos.entryPriceMicros + delta;
  }

  private async simulateLatency(): Promise<void> {
    if (this.settleMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.settleMs));
  }
}
