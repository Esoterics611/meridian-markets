import { DeskEventInput } from './desk-event';

// IDeskEventSink — the one-line seam every business event flows through. Like the
// telemetry seam (CLAUDE.md §7), it has a no-op default (NULL_DESK_EVENT_SINK) so
// the unit tests that build an MmBook / MmPortfolioTrader directly stay unchanged
// and pay nothing; the MarketMakingModule injects the real DeskEventLog (logs +
// buffers). Best-effort: emit MUST NOT throw into a tick.
export interface IDeskEventSink {
  /** Record one business event. The sink assigns the monotonic `seq`. */
  emit(event: DeskEventInput): void;
}

/** No-op sink — the default everywhere a real one isn't injected. */
export const NULL_DESK_EVENT_SINK: IDeskEventSink = {
  emit(): void {
    /* no-op */
  },
};
