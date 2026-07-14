/**
 * nats-bus — IBus over NATS core (the docker-compose broker, TECHNOLOGY_OVERVIEW §3.2).
 *
 * Deliberate scope: core pub/sub ONLY — no JetStream (durability lives in tapes/Postgres,
 * bus law #4). seq is stamped by THIS publisher per topic (bus law #1: single writer per
 * topic), so consumers can detect gaps even though NATS core is at-most-once.
 */
import { connect, NatsConnection, StringCodec } from 'nats';
import { BUS_SCHEMA_VERSION, BusHandler, BusMessage, IBus } from './bus.interface';

const sc = StringCodec();

export class NatsBus implements IBus {
  private readonly seqByTopic = new Map<string, number>();

  private constructor(private readonly nc: NatsConnection) {}

  static async connect(url = process.env.NATS_URL ?? 'nats://127.0.0.1:4222'): Promise<NatsBus> {
    // Fail fast: a dead broker must surface at boot, not hang a service (bus law #2).
    const nc = await connect({ servers: url, name: 'meridian', timeout: 2_000, maxReconnectAttempts: -1 });
    return new NatsBus(nc);
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
    this.nc.publish(topic, sc.encode(JSON.stringify(msg)));
  }

  subscribe(pattern: string, handler: BusHandler): () => void {
    const sub = this.nc.subscribe(pattern);
    void (async () => {
      for await (const m of sub) {
        try {
          const parsed = JSON.parse(sc.decode(m.data)) as BusMessage;
          if (parsed.schemaVersion !== BUS_SCHEMA_VERSION) continue; // bus law #3
          handler(parsed);
        } catch {
          // malformed message or consumer bug — never kill the subscription loop
        }
      }
    })();
    return () => sub.unsubscribe();
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
