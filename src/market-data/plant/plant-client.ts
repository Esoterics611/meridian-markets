/**
 * plant-client — a bus consumer that serves the venue-client surface from cached
 * plant streams (TECHNOLOGY_OVERVIEW §3.1: desks consume via adapters implementing the
 * EXISTING interfaces — zero strategy-code changes).
 *
 * Implements the plant's OutcomeFeed + OptionChainFeed shapes, so anything built on
 * HyperliquidOutcomeClient/DeribitClient method signatures can swap in a PlantClient.
 * Fail-closed (bus law #2): missing or stale topics THROW — callers' existing error
 * paths (NOPRICE, absorbed-cycle) handle it exactly like a venue outage. Snapshot
 * topics are latest-wins, so a seq gap is equivalent to staleness and needs no
 * special handling here.
 */
import { DeribitOption } from '../../derivatives/deribit/deribit-client';
import { PriceBinarySpec } from '../../prediction/binary-market.types';
import { BusMessage, IBus, TOPICS } from '../../bus/bus.interface';
import { Hip4BookPayload, OptionChainFeed, OutcomeFeed } from './md-plant';

export interface PlantClientMaxAges {
  midsMs: number;
  bookMs: number;
  metaMs: number;
  chainMs: number;
}

export const DEFAULT_PLANT_MAX_AGES: PlantClientMaxAges = {
  midsMs: 10_000,
  bookMs: 10_000,
  metaMs: 5 * 60_000,
  chainMs: 5 * 60_000,
};

export class PlantClient implements OutcomeFeed, OptionChainFeed {
  private readonly cache = new Map<string, BusMessage>();
  private readonly unsub: () => void;

  constructor(
    bus: IBus,
    private readonly maxAges: PlantClientMaxAges = DEFAULT_PLANT_MAX_AGES,
    private readonly now: () => number = Date.now,
  ) {
    this.unsub = bus.subscribe('md.>', (m) => this.cache.set(m.topic, m));
  }

  private fresh<T>(topic: string, maxAgeMs: number): T {
    const m = this.cache.get(topic);
    if (!m) throw new Error(`plant: no data yet on ${topic}`);
    const age = this.now() - m.tsPlant;
    if (age > maxAgeMs) throw new Error(`plant: ${topic} stale (${age}ms > ${maxAgeMs}ms)`);
    return m.payload as T;
  }

  async listPriceBinarySpecs(): Promise<PriceBinarySpec[]> {
    return this.fresh<PriceBinarySpec[]>(TOPICS.hip4Meta, this.maxAges.metaMs);
  }

  async mids(): Promise<Record<string, number>> {
    return this.fresh<Record<string, number>>(TOPICS.hlMids, this.maxAges.midsMs);
  }

  async underlyingMid(underlying: string): Promise<number> {
    const px = (await this.mids())[underlying.toUpperCase()];
    if (!Number.isFinite(px) || px <= 0) throw new Error(`plant: no mid for ${underlying}`);
    return px;
  }

  async bookDepth(
    marketId: string,
    sideIdx: 0 | 1,
    depth: number,
  ): Promise<{ bids: [number, number][]; asks: [number, number][]; serverTimeMs: number | null }> {
    if (sideIdx !== 0) throw new Error('plant v0 publishes the YES side only');
    const b = this.fresh<Hip4BookPayload>(TOPICS.hip4Book(marketId), this.maxAges.bookMs);
    return { bids: b.bids.slice(0, depth), asks: b.asks.slice(0, depth), serverTimeMs: b.serverTimeMs };
  }

  async optionChain(currency: string): Promise<DeribitOption[]> {
    return this.fresh<DeribitOption[]>(
      TOPICS.deribitChain(currency),
      this.maxAges.chainMs,
    );
  }

  close(): void {
    this.unsub();
  }
}
