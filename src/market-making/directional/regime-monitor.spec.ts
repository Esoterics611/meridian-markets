import {
  RegimeMonitor,
  RegimeTransition,
  RegimeMonitorConfig,
  REGIME_LEVEL_COLOR,
  REGIME_OVERALL_COLOR,
  regimeChangeEvent,
} from './regime-monitor';

const DWELL = 60_000;

/** A monitor whose transitions are captured for assertion. */
function mk(symbol = 'BTC', cfg: Partial<RegimeMonitorConfig> = {}) {
  const events: RegimeTransition[] = [];
  const monitor = new RegimeMonitor(symbol, { onRegimeChange: (t) => events.push(t), ...cfg });
  return { monitor, events };
}

describe('the color law (exported once, reused by the UI)', () => {
  it('maps levels and overall states to green/amber/red consistently', () => {
    expect(REGIME_LEVEL_COLOR).toEqual({ FAVORABLE: 'green', NEUTRAL: 'amber', ADVERSE: 'red' });
    expect(REGIME_OVERALL_COLOR).toEqual({ TRADEABLE: 'green', HOLD_ONLY: 'amber', STAND_ASIDE: 'red' });
  });
});

describe('funding sub-regime (a tailwind read, never a hazard)', () => {
  it('classifies side + level at the boundaries', () => {
    expect(mk().monitor.update({ nowMs: 0, fundingRatePerHour: 2e-5 }).funding).toMatchObject({ side: 'paid-short', level: 'FAVORABLE' });
    expect(mk().monitor.update({ nowMs: 0, fundingRatePerHour: 5e-6 }).funding).toMatchObject({ side: 'paid-short', level: 'NEUTRAL' });
    expect(mk().monitor.update({ nowMs: 0, fundingRatePerHour: 1e-6 }).funding).toMatchObject({ side: 'flat', level: 'NEUTRAL' });
    expect(mk().monitor.update({ nowMs: 0, fundingRatePerHour: -2e-5 }).funding).toMatchObject({ side: 'paid-long', level: 'FAVORABLE' });
  });

  it('a paid + calm market is TRADEABLE (funding alone never stands the book aside)', () => {
    const s = mk().monitor.update({ nowMs: 0, fundingRatePerHour: -2e-5, basisBps: 2, ret: 0.001 });
    expect(s.overall).toBe('TRADEABLE');
    expect(s.standAside).toBe(false);
  });

  it('fires exactly one event on a side flip — and only after the dwell', () => {
    const { monitor, events } = mk();
    monitor.update({ nowMs: 0, fundingRatePerHour: 2e-5 }); // baseline paid-short (silent)
    monitor.update({ nowMs: 10_000, fundingRatePerHour: -2e-5 }); // flip inside dwell ⇒ suppressed
    expect(events).toHaveLength(0);
    const s = monitor.update({ nowMs: 70_000, fundingRatePerHour: -2e-5 }); // dwell cleared ⇒ fires once
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ dimension: 'funding', from: 'paid-short', to: 'paid-long' });
    expect(events[0].detail).toContain('funding flipped paid-short → paid-long');
    expect(s.funding.side).toBe('paid-long');
  });
});

describe('basis sub-regime (the hazard the book stands aside for)', () => {
  it('classifies calm / widening / blowout at the boundaries', () => {
    expect(mk().monitor.update({ nowMs: 0, basisBps: 9 }).basis.level).toBe('FAVORABLE');
    expect(mk().monitor.update({ nowMs: 0, basisBps: 10 }).basis.level).toBe('NEUTRAL');
    expect(mk().monitor.update({ nowMs: 0, basisBps: -25 }).basis.level).toBe('ADVERSE'); // |basis|, sign-agnostic
  });

  it('a blowout ⇒ STAND_ASIDE, escalates immediately (no dwell on the way in), one event', () => {
    const { monitor, events } = mk();
    monitor.update({ nowMs: 0, basisBps: 1 }); // baseline calm
    const s = monitor.update({ nowMs: 1_000, basisBps: 25 }); // blowout 1s later
    expect(s.overall).toBe('STAND_ASIDE');
    expect(s.standAside).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ dimension: 'basis', to: 'ADVERSE' });
    expect(events[0].detail).toContain('BLEW OUT');
  });

  it('widening (not blowout) ⇒ HOLD_ONLY, not STAND_ASIDE', () => {
    const { monitor } = mk();
    monitor.update({ nowMs: 0, basisBps: 1 });
    const s = monitor.update({ nowMs: 1_000, basisBps: 12 });
    expect(s.basis.level).toBe('NEUTRAL');
    expect(s.overall).toBe('HOLD_ONLY');
    expect(s.standAside).toBe(false);
  });

  it('de-escalation waits out the dwell (no chatter): a blowout that eases stays adverse until dwell', () => {
    const { monitor, events } = mk();
    monitor.update({ nowMs: 0, basisBps: 1 }); // baseline calm
    monitor.update({ nowMs: 1_000, basisBps: 25 }); // blowout (event #1)
    const mid = monitor.update({ nowMs: 2_000, basisBps: 2 }); // calm again, but inside dwell
    expect(mid.basis.level).toBe('ADVERSE'); // held — no premature re-entry
    expect(mid.standAside).toBe(true);
    const out = monitor.update({ nowMs: 1_000 + DWELL + 1, basisBps: 2 }); // dwell cleared
    expect(out.basis.level).toBe('FAVORABLE');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ dimension: 'basis', from: 'ADVERSE' });
  });
});

describe('vol sub-regime (a relative realised-vol SPIKE detector)', () => {
  function warm(monitor: RegimeMonitor, ticks = 12) {
    for (let i = 0; i < ticks; i++) monitor.update({ nowMs: i * 1000, ret: 0.001 });
  }
  it('a calm baseline is not a spike; a sudden large return SPIKES ⇒ STAND_ASIDE', () => {
    const { monitor, events } = mk();
    warm(monitor);
    expect(monitor.state().vol.level).not.toBe('ADVERSE');
    const s = monitor.update({ nowMs: 999_000, ret: 0.05 }); // ~50x the calm move
    expect(s.vol.level).toBe('ADVERSE');
    expect(s.overall).toBe('STAND_ASIDE');
    expect(events.some((e) => e.dimension === 'vol' && e.detail.includes('SPIKE'))).toBe(true);
  });

  it('does not declare a SPIKE during warm-up (cold-start guard)', () => {
    const { monitor } = mk();
    // The very first return is "huge" relative to nothing — must NOT spike before warm.
    const s = monitor.update({ nowMs: 0, ret: 0.2 });
    expect(s.vol.level).not.toBe('ADVERSE');
    expect(s.standAside).toBe(false);
  });
});

describe('the STAND_ASIDE invariant + feed staleness', () => {
  it('STAND_ASIDE is reachable only from a real adverse read or a stale feed', () => {
    // calm everything ⇒ tradeable
    expect(mk().monitor.update({ nowMs: 0, fundingRatePerHour: 0, basisBps: 0, ret: 0.001 }).standAside).toBe(false);
    // widening basis is a watch, not a stand-aside
    expect(mk().monitor.update({ nowMs: 0, basisBps: 12 }).standAside).toBe(false);
    // a blowout IS
    expect(mk().monitor.update({ nowMs: 0, basisBps: 30 }).standAside).toBe(true);
    // a stale feed forces it regardless of calm reads
    const s = mk().monitor.update({ nowMs: 0, basisBps: 0, ret: 0.001, feedStale: true });
    expect(s.overall).toBe('STAND_ASIDE');
  });

  it('feed staleness does not emit a regime event (the feed watchdog owns that trigger)', () => {
    const { monitor, events } = mk();
    monitor.update({ nowMs: 0, basisBps: 1, feedStale: true });
    expect(events).toHaveLength(0);
  });
});

describe('regimeChangeEvent → the desk-event tape', () => {
  it('renders a fired transition as a REGIME ▸ <symbol> line of kind "regime"', () => {
    const { monitor, events } = mk('ETH');
    monitor.update({ nowMs: 0, basisBps: 1 });
    monitor.update({ nowMs: 1_000, basisBps: 25 });
    const ev = regimeChangeEvent(events[0]);
    expect(ev.kind).toBe('regime');
    expect(ev.book).toBe('ETH');
    expect(ev.message.startsWith('REGIME ▸ ETH ')).toBe(true);
    expect(ev.message).toContain('BLEW OUT');
  });
});
