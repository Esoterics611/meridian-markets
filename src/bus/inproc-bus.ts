/**
 * inproc-bus — the in-process IBus. Default; tests and single-process sessions run the
 * whole plant on it, offline. Semantics deliberately mirror NATS (topic grammar, at-most-
 * once delivery, no replay) so flipping BUS=nats never changes behavior (§3.2).
 */
import { BUS_SCHEMA_VERSION, BusHandler, BusMessage, IBus, topicMatches } from './bus.interface';

interface Sub {
  pattern: string;
  handler: BusHandler;
}

export class InProcBus implements IBus {
  private readonly seqByTopic = new Map<string, number>();
  private readonly subs = new Set<Sub>();
  /** Every message ever published — spec/assertion support (the “mock bus” role). */
  readonly published: BusMessage[] = [];
  private readonly keepHistory: boolean;

  constructor(opts: { keepHistory?: boolean } = {}) {
    this.keepHistory = opts.keepHistory ?? false;
  }

  async publish<T>(topic: string, payload: T, tsVenue: number | null = null): Promise<void> {
    const seq = (this.seqByTopic.get(topic) ?? 0) + 1;
    this.seqByTopic.set(topic, seq);
    const msg: BusMessage<T> = {
      topic,
      seq,
      tsPlant: Date.now(),
      tsVenue,
      schemaVersion: BUS_SCHEMA_VERSION,
      payload,
    };
    if (this.keepHistory) this.published.push(msg);
    for (const s of this.subs) {
      if (topicMatches(s.pattern, topic)) {
        try {
          s.handler(msg);
        } catch {
          // a consumer's bug must never break the producer or other consumers
        }
      }
    }
  }

  subscribe(pattern: string, handler: BusHandler): () => void {
    const sub: Sub = { pattern, handler };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}
