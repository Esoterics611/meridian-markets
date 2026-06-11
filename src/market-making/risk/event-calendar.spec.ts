import { EventCalendar } from './event-calendar';

describe('EventCalendar', () => {
  const cal = new EventCalendar();

  it('surfaces the daily US open/macro slot inside the horizon', () => {
    const now = Date.UTC(2026, 5, 12, 13, 20); // 13:20Z
    const ev = cal.upcoming(now, 15 * 60_000);
    expect(ev.some((e) => e.key === 'us-open:2026-06-12')).toBe(true);
  });

  it('crosses midnight for tomorrow morning events and stays empty off-horizon', () => {
    const now = Date.UTC(2026, 5, 12, 23, 50);
    expect(cal.upcoming(now, 60_000)).toHaveLength(0);
    const ev = cal.upcoming(now, 14 * 3_600_000); // through tomorrow 13:50Z
    expect(ev.some((e) => e.key === 'us-open:2026-06-13')).toBe(true);
  });

  it('knows the 2026 FOMC decision days (whole-desk warning)', () => {
    const now = Date.UTC(2026, 5, 17, 17, 50); // 2026-06-17 is an FOMC day
    const ev = cal.upcoming(now, 15 * 60_000);
    expect(ev.some((e) => e.key === 'fomc:2026-06-17' && e.booksHint === '')).toBe(true);
  });
});
