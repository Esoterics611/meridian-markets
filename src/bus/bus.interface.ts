/**
 * bus.interface — the IBus seam (TECHNOLOGY_OVERVIEW §3.2, adopted 2026-07-14).
 *
 * One publish/subscribe contract, three impls selected by config (BUS=inproc|nats):
 *   - InProcBus  — in-process; the default. Tests and single-process sessions run the
 *                  ENTIRE plant on it, offline (§10 discipline unchanged).
 *   - NatsBus    — NATS core over the docker-compose broker; the multi-process desk.
 *   - (specs)    — InProcBus doubles as the scripted mock; see bus.spec.ts helpers.
 *
 * Bus laws (binding for every producer/consumer):
 *   1. SINGLE WRITER PER TOPIC. seq is assigned by the publishing bus instance and is
 *      monotonic per topic; two writers on one topic is a defect.
 *   2. Consumers detect gaps (seq jump) and staleness (tsPlant age / heartbeat loss) and
 *      go to their SAFE STATE: md consumers quote-off, desks stop opening. Fail closed.
 *   3. Every message carries schemaVersion; readers refuse versions they don't know.
 *   4. Durability lives in tapes/Postgres, never in the broker (no JetStream).
 *
 * Topic grammar is NATS-compatible: dot-separated tokens; subscriptions may use
 * '*' (exactly one token) and a trailing '>' (one or more tokens).
 */

export const BUS_SCHEMA_VERSION = 1;

export interface BusMessage<T = unknown> {
  topic: string;
  /** Monotonic per topic, assigned at publish. Gap ⇒ consumer goes safe. */
  seq: number;
  /** Publisher wall clock, ms. */
  tsPlant: number;
  /** Venue's own timestamp where the feed provides one (staleness accounting). */
  tsVenue: number | null;
  schemaVersion: number;
  payload: T;
}

export type BusHandler = (msg: BusMessage) => void;

export interface IBus {
  /** Fire-and-forget publish; the bus stamps seq/tsPlant/schemaVersion. */
  publish<T>(topic: string, payload: T, tsVenue?: number | null): Promise<void>;
  /** NATS-style pattern subscribe. Returns an unsubscribe function. */
  subscribe(pattern: string, handler: BusHandler): () => void;
  close(): Promise<void>;
}

/** Topics published by md-plant v0 (Phase A slice 1 — the HIP-4/Deribit vertical). */
export const TOPICS = {
  /** Record<string, number> — HL allMids parsed (perp mids + every outcome side). */
  hlMids: 'md.mids.hyperliquid',
  /** PriceBinarySpec[] — live HIP-4 price binaries (meta-only discovery). */
  hip4Meta: 'md.outcome.meta.hyperliquid',
  /** { marketId, bids, asks, serverTimeMs } — YES-side depth for one binary. */
  hip4Book: (marketId: string) => `md.book.hip4.${marketId}`,
  /** DeribitOption[] — full option chain for a currency. */
  deribitChain: (ccy: string) => `md.chain.deribit.${ccy.toUpperCase()}`,
} as const;

/** NATS-compatible pattern match: '*' = one token, trailing '>' = one-or-more. */
export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.split('.');
  const t = topic.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return i < t.length; // '>' must match at least one token
    if (i >= t.length) return false;
    if (p[i] !== '*' && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
