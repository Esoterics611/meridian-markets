/**
 * md-plant — the market-data service (TECHNOLOGY_OVERVIEW §3.1; Phase A slice 1).
 *
 * Owns venue connectivity and publishes normalized, sequenced streams on the IBus.
 * Consumers (desks, collectors, views) NEVER hit venue APIs — the plant owns the rate
 * budget, the staleness stamps (tsVenue where the feed provides one), and the topic set.
 * v0 scope: the HIP-4/Deribit vertical (mids, binary meta, YES-side books, option
 * chains) — enough to run scripts/orv-calibration.ts in bus mode for the Phase-A
 * acceptance A/B. Binance/funding/candle feeds migrate next.
 *
 * Pure publisher: tape capture is a bus SUBSCRIBER (the runner script), not plant logic.
 * Fetch failures increment stats.errors and never kill the cycle — partial data beats
 * no data, and consumers enforce their own staleness (bus law #2).
 */
import { DeribitOption } from '../../derivatives/deribit/deribit-client';
import { PriceBinarySpec } from '../../prediction/binary-market.types';
import { IBus, TOPICS } from '../../bus/bus.interface';

/** Structural subset of HyperliquidOutcomeClient the plant consumes. */
export interface OutcomeFeed {
  listPriceBinarySpecs(): Promise<PriceBinarySpec[]>;
  mids(): Promise<Record<string, number>>;
  bookDepth(
    marketId: string,
    sideIdx: 0 | 1,
    depth: number,
  ): Promise<{ bids: [number, number][]; asks: [number, number][]; serverTimeMs: number | null }>;
}

export interface OptionChainFeed {
  optionChain(currency: string): Promise<DeribitOption[]>;
}

export interface MdPlantConfig {
  /** Underlyings the desk can price — meta is filtered to these; chains fetched for these. */
  priceableUnderlyings: string[];
  midsMs: number;
  bookMs: number;
  metaMs: number;
  chainMs: number;
  bookDepth: number;
  /**
   * Slow snapshot topics (meta, chains) are re-published from cache at this cadence so
   * late joiners sync fast — NATS core has no replay (bus law #4), so the plant provides
   * the snapshot itself. Re-publishing cached data costs zero venue calls.
   */
  snapshotRepubMs: number;
}

export const DEFAULT_MD_PLANT: MdPlantConfig = {
  priceableUnderlyings: ['BTC', 'ETH'],
  midsMs: 1_000,
  bookMs: 1_000,
  metaMs: 60_000,
  chainMs: 60_000,
  bookDepth: 5,
  snapshotRepubMs: 5_000,
};

export interface Hip4BookPayload {
  marketId: string;
  bids: [number, number][];
  asks: [number, number][];
  serverTimeMs: number | null;
}

export class MdPlant {
  readonly stats = { published: 0, errors: 0, lastError: '' };
  private lastMetaFetch = -Infinity;
  private lastMetaPub = -Infinity;
  private lastMids = -Infinity;
  private lastBooks = -Infinity;
  private readonly lastChainFetch = new Map<string, number>();
  private readonly lastChainPub = new Map<string, number>();
  private readonly cachedChains = new Map<string, DeribitOption[]>();
  private cachedMeta: PriceBinarySpec[] | null = null;
  private activeMarkets: PriceBinarySpec[] = [];

  constructor(
    private readonly bus: IBus,
    private readonly feeds: { outcome: OutcomeFeed; chain: OptionChainFeed },
    private readonly cfg: MdPlantConfig = DEFAULT_MD_PLANT,
  ) {}

  /** One scheduler pass: fetch+publish whatever is due at nowMs. Never throws. */
  async cycle(nowMs: number): Promise<void> {
    if (nowMs - this.lastMetaFetch >= this.cfg.metaMs) {
      this.lastMetaFetch = nowMs;
      await this.guard('meta', async () => {
        const all = await this.feeds.outcome.listPriceBinarySpecs();
        this.activeMarkets = all.filter(
          (s) =>
            this.cfg.priceableUnderlyings.includes(s.underlying.toUpperCase()) &&
            s.expiryMs > nowMs,
        );
        this.cachedMeta = this.activeMarkets;
        this.lastMetaPub = nowMs;
        await this.pub(TOPICS.hip4Meta, this.activeMarkets);
      });
    } else if (this.cachedMeta && nowMs - this.lastMetaPub >= this.cfg.snapshotRepubMs) {
      this.lastMetaPub = nowMs;
      await this.pub(TOPICS.hip4Meta, this.cachedMeta); // late-joiner snapshot, no fetch
    }

    for (const ccy of this.cfg.priceableUnderlyings) {
      if (nowMs - (this.lastChainFetch.get(ccy) ?? -Infinity) >= this.cfg.chainMs) {
        this.lastChainFetch.set(ccy, nowMs);
        await this.guard(`chain:${ccy}`, async () => {
          const chain = await this.feeds.chain.optionChain(ccy);
          this.cachedChains.set(ccy, chain);
          this.lastChainPub.set(ccy, nowMs);
          await this.pub(TOPICS.deribitChain(ccy), chain);
        });
      } else if (
        this.cachedChains.has(ccy) &&
        nowMs - (this.lastChainPub.get(ccy) ?? -Infinity) >= this.cfg.snapshotRepubMs
      ) {
        this.lastChainPub.set(ccy, nowMs);
        await this.pub(TOPICS.deribitChain(ccy), this.cachedChains.get(ccy)!);
      }
    }

    if (nowMs - this.lastMids >= this.cfg.midsMs) {
      this.lastMids = nowMs;
      await this.guard('mids', async () => {
        const mids = await this.feeds.outcome.mids();
        await this.pub(TOPICS.hlMids, mids);
      });
    }

    if (nowMs - this.lastBooks >= this.cfg.bookMs) {
      this.lastBooks = nowMs;
      await Promise.all(
        this.activeMarkets.map((s) =>
          this.guard(`book:${s.marketId}`, async () => {
            const b = await this.feeds.outcome.bookDepth(s.marketId, 0, this.cfg.bookDepth);
            const payload: Hip4BookPayload = { marketId: s.marketId, ...b };
            await this.pub(TOPICS.hip4Book(s.marketId), payload, b.serverTimeMs);
          }),
        ),
      );
    }
  }

  private async pub<T>(topic: string, payload: T, tsVenue: number | null = null): Promise<void> {
    await this.bus.publish(topic, payload, tsVenue);
    this.stats.published++;
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = `${what}: ${(err as Error).message}`;
    }
  }
}
