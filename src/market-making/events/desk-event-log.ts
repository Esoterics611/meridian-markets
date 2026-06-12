import { Logger } from '@nestjs/common';
import { DeskEvent, DeskEventInput } from './desk-event';
import { IDeskEventSink } from './desk-event-sink';

// DeskEventLog — the live business-event sink. Every emitted event is rendered
// TWICE from one call (the requirement: "I need to see every trade enter/exit in
// the log, not just the DB transactions"):
//   1. a NestJS log line at the right level — so the operator tailing the server
//      sees every fill / verdict change / launch scroll past (warn for a risk
//      block, log otherwise); and
//   2. an append into a bounded ring buffer the GET /api/market-making/events
//      endpoint serves to the /demo activity feed.
//
// The buffer is intentionally in-memory + bounded (the durable multi-day record
// is the append-only mm_nav table, Telemetry P3 — this is the live "what just
// happened" tape, not the ledger). `seq` is monotonic so the UI can long-poll
// with `?since=<lastSeq>` and never miss or double-count an event, even when two
// fills share a millisecond.

const DEFAULT_CAPACITY = 2000;

export interface DeskEventQuery {
  /** Only events with seq > this (the UI's polling cursor). */
  sinceSeq?: number;
  /** Cap the number returned (newest kept when truncating). */
  limit?: number;
  /** Restrict to one book/symbol. */
  book?: string;
}

export class DeskEventLog implements IDeskEventSink {
  private readonly logger = new Logger('DeskEvents');
  private readonly capacity: number;
  private readonly buffer: DeskEvent[] = [];
  private seq = 0;

  constructor(
    capacity: number = DEFAULT_CAPACITY,
    // F0 (PART V observability req #8): optional durable sink — every event is ALSO enqueued
    // for the mm_desk_event table, so a finished run's decision tape is auditable from SQL.
    // Synchronous + best-effort (a BufferedSink in the live wiring); undefined ⇒ in-memory only.
    private readonly persistSink?: { enqueue(e: DeskEvent): void },
  ) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  emit(input: DeskEventInput): void {
    try {
      const event: DeskEvent = { ...input, seq: ++this.seq };
      this.buffer.push(event);
      if (this.buffer.length > this.capacity) this.buffer.shift();
      this.persistSink?.enqueue(event);
      // Risk blocks (a Pause/Deny verdict, never the resume) are the one thing an
      // operator wants louder than the steady fill scroll; everything else is log.
      if (event.kind === 'verdict' && event.verdict !== 'Allow') this.logger.warn(event.message);
      else this.logger.log(event.message);
    } catch (e) {
      // Best-effort (DC-5): an event-log failure must never break a tick.
      this.logger.error(`desk event emit failed: ${(e as Error).message}`);
    }
  }

  /** The highest seq assigned so far (the UI's initial cursor). */
  lastSeq(): number {
    return this.seq;
  }

  /** Read recent events oldest-first (chart/feed order), filtered + bounded. */
  recent(query: DeskEventQuery = {}): DeskEvent[] {
    const { sinceSeq, limit, book } = query;
    let out = this.buffer;
    if (sinceSeq !== undefined) out = out.filter((e) => e.seq > sinceSeq);
    if (book) out = out.filter((e) => e.book === book);
    if (limit !== undefined && limit >= 0 && out.length > limit) out = out.slice(out.length - limit);
    return [...out];
  }
}
