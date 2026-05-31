import { passiveFills } from './fill-model';

const BID = 999_500n; // 0.9995
const ASK = 1_000_500n; // 1.0005

describe('passiveFills (bar-approximation, fill-on-touch)', () => {
  it('fills neither side when the bar range stays inside the quotes', () => {
    const r = passiveFills({ high: 1.0003, low: 0.9997 }, BID, ASK);
    expect(r.bidFilled).toBe(false);
    expect(r.askFilled).toBe(false);
  });

  it('fills the bid when the low trades down to it (we buy)', () => {
    const r = passiveFills({ high: 1.0002, low: 0.9994 }, BID, ASK);
    expect(r.bidFilled).toBe(true);
    expect(r.askFilled).toBe(false);
  });

  it('fills both sides when the bar straddles the quotes (captured round-trip)', () => {
    const r = passiveFills({ high: 1.0006, low: 0.9994 }, BID, ASK);
    expect(r.bidFilled).toBe(true);
    expect(r.askFilled).toBe(true);
  });
});
