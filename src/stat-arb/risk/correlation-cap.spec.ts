import { CorrelationCapGate } from './correlation-cap';

const gate = new CorrelationCapGate({ maxAbsCorrelation: 0.7, minOverlapBars: 5 });

describe('CorrelationCapGate', () => {
  it('allows when there are no open legs', () => {
    expect(gate.check({ candidate: [1, 2, 3, 4, 5, 6], openLegs: [] }).allow).toBe(true);
  });

  it('allows when overlap is below the minimum bars', () => {
    expect(gate.check({
      candidate: [1, 2],
      openLegs: [{ id: 'a', returns: [1, 2] }],
    }).allow).toBe(true);
  });

  it('blocks when correlation with an open leg is ~1', () => {
    const c = [1, 2, 3, 4, 5, 6, 7];
    const d = gate.check({ candidate: c, openLegs: [{ id: 'a', returns: c.slice() }] });
    expect(d.allow).toBe(false);
    expect(d.detail?.legId).toBe('a');
  });

  it('blocks on strong negative correlation too (|r| > cap)', () => {
    const c = [1, 2, 3, 4, 5, 6, 7];
    const opp = c.map((v) => -v);
    const d = gate.check({ candidate: c, openLegs: [{ id: 'a', returns: opp }] });
    expect(d.allow).toBe(false);
  });

  it('allows when correlation is below the cap', () => {
    // Two series whose Pearson correlation is below 0.7.
    const candidate = [1, 2, 3, 4, 5, 6, 7];
    const lowCorr = [3, 1, 4, 1, 5, 9, 2];
    expect(gate.check({ candidate, openLegs: [{ id: 'a', returns: lowCorr }] }).allow).toBe(true);
  });

  it('picks the worst correlation across multiple open legs', () => {
    const c = [1, 2, 3, 4, 5, 6, 7];
    const d = gate.check({
      candidate: c,
      openLegs: [
        { id: 'a', returns: [3, 1, 4, 1, 5, 9, 2] },
        { id: 'b', returns: c.slice() },
      ],
    });
    expect(d.allow).toBe(false);
    expect(d.detail?.legId).toBe('b');
  });
});
