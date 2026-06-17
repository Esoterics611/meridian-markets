import { FeedWatchdog, AlertDispatcher, NoopAlertSink, WebhookAlertSink, buildAlertSink, Alert, IAlertSink } from './feed-watchdog';

class CapturingSink implements IAlertSink {
  readonly alerts: Alert[] = [];
  fire(a: Alert): void { this.alerts.push(a); }
}

describe('FeedWatchdog (P15)', () => {
  it('flags a STALE feed when no update lands within maxStaleMs', () => {
    const w = new FeedWatchdog({ maxStaleMs: 120_000 });
    w.check('BTC', { nowMs: 0, price: 100 }); // seed
    expect(w.check('BTC', { nowMs: 60_000, price: 100 }).stale).toBe(false); // 60s < 120s
    expect(w.check('BTC', { nowMs: 300_000, price: 100 }).stale).toBe(true); // 240s gap > 120s
  });

  it('flags a price GAP/outlier past the band and does NOT adopt it as the baseline', () => {
    const w = new FeedWatchdog({ maxGapFrac: 0.1 });
    w.check('BTC', { nowMs: 0, price: 100 });
    const h = w.check('BTC', { nowMs: 1000, price: 130 }); // +30% jump
    expect(h.gap).toBe(true);
    expect(h.feedStale).toBe(true);
    // baseline stayed at 100 ⇒ a return to 101 is fine (not measured off the bad 130 print).
    expect(w.check('BTC', { nowMs: 2000, price: 101 }).gap).toBe(false);
  });

  it('flags cross-venue DIVERGENCE past the band', () => {
    const w = new FeedWatchdog({ maxDivergenceFrac: 0.02 });
    w.check('BTC', { nowMs: 0, price: 100 });
    expect(w.check('BTC', { nowMs: 1000, price: 100, crossVenuePrice: 100.5 }).divergence).toBe(false); // 0.5%
    expect(w.check('BTC', { nowMs: 2000, price: 100, crossVenuePrice: 103 }).divergence).toBe(true); // ~3%
  });

  it('is healthy (ok) on a normal tick stream', () => {
    const w = new FeedWatchdog();
    w.check('BTC', { nowMs: 0, price: 100 });
    const h = w.check('BTC', { nowMs: 60_000, price: 100.5, crossVenuePrice: 100.4 });
    expect(h.feedStale).toBe(false);
    expect(h.detail).toBe('ok');
  });
});

describe('AlertDispatcher (P15)', () => {
  it('fires desk-halt EXACTLY once (the kill-switch latches)', () => {
    const sink = new CapturingSink();
    const d = new AlertDispatcher(sink);
    expect(d.deskHalt('maxDD breach')).toBe(true);
    expect(d.deskHalt('maxDD breach')).toBe(false); // suppressed
    expect(sink.alerts.filter((a) => a.kind === 'desk-halt')).toHaveLength(1);
  });

  it('fires dd-breach exactly once', () => {
    const sink = new CapturingSink();
    const d = new AlertDispatcher(sink);
    expect(d.drawdownBreach(0.025, 0.02)).toBe(true);
    expect(d.drawdownBreach(0.03, 0.02)).toBe(false);
    expect(sink.alerts.filter((a) => a.kind === 'dd-breach')).toHaveLength(1);
  });

  it('fires feed-stale on the false→true transition and re-arms after recovery', () => {
    const sink = new CapturingSink();
    const d = new AlertDispatcher(sink);
    expect(d.feedStale('BTC', true, 'stale 200s')).toBe(true);
    expect(d.feedStale('BTC', true)).toBe(false); // still stale ⇒ no re-fire
    expect(d.feedStale('BTC', false)).toBe(false); // recovered ⇒ re-arm (no alert)
    expect(d.feedStale('BTC', true)).toBe(true); // stale again ⇒ fires
    expect(sink.alerts.filter((a) => a.kind === 'feed-stale')).toHaveLength(2);
  });

  it('fires a stop-hit per distinct loss-stop', () => {
    const sink = new CapturingSink();
    const d = new AlertDispatcher(sink);
    d.lossStop('ETH');
    d.lossStop('SOL');
    expect(sink.alerts.filter((a) => a.kind === 'stop-hit')).toHaveLength(2);
  });

  it('no-op sink default = no behavior change (nothing throws, nothing recorded)', () => {
    const d = new AlertDispatcher(); // NoopAlertSink default
    expect(() => { d.deskHalt('x'); d.lossStop('ETH'); d.feedStale('BTC', true); d.drawdownBreach(0.05, 0.02); }).not.toThrow();
  });
});

describe('alert sinks', () => {
  it('NoopAlertSink drops everything', () => {
    expect(() => new NoopAlertSink().fire({ kind: 'desk-halt', severity: 'critical', message: 'x', ts: 0 })).not.toThrow();
  });

  it('WebhookAlertSink posts a Slack-style payload to the URL', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const sink = new WebhookAlertSink('https://hooks.example/abc', async (url, body) => { posted.push({ url, body }); });
    sink.fire({ kind: 'stop-hit', severity: 'warn', symbol: 'ETH', message: 'stop fired', ts: 0 });
    await new Promise((r) => setImmediate(r));
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('https://hooks.example/abc');
    expect((posted[0].body as { text: string }).text).toContain('ETH');
  });

  it('buildAlertSink returns Webhook when a URL is given, Noop otherwise', () => {
    expect(buildAlertSink('https://x') instanceof WebhookAlertSink).toBe(true);
    expect(buildAlertSink('') instanceof NoopAlertSink).toBe(true);
    expect(buildAlertSink(undefined) instanceof NoopAlertSink).toBe(true);
  });
});
