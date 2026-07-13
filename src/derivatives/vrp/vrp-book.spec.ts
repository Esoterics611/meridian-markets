import { blackScholes } from '../greeks/black-scholes';
import { VrpBook, VrpBookConfig } from './vrp-book';

const CFG: VrpBookConfig = {
  minVrpPts: 0.03,
  contractsCoin: 0.1,
  hedgeBandFrac: 0.25,
  hedgeFeeBps: 3.5,
  maxLossBudgetUsd: 400,
  minHoursToExpiry: 6,
};

const NOW = Date.UTC(2026, 6, 13, 18, 0);
const EXPIRY = Date.UTC(2026, 6, 14, 8, 0); // 14h out
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

function straddlePremium(spot: number, strike: number, iv: number, tYears: number): number {
  const c = blackScholes({ type: 'CALL', spot, strike, tYears, iv, rate: 0 });
  const p = blackScholes({ type: 'PUT', spot, strike, tYears, iv, rate: 0 });
  return c.price + p.price;
}

function openDefault(book: VrpBook, over: Partial<Parameters<VrpBook['tryOpen']>[0]> = {}) {
  const tYears = (EXPIRY - NOW) / YEAR_MS;
  const premium = straddlePremium(62000, 62000, 0.36, tYears);
  return book.tryOpen({
    underlying: 'BTC',
    spot: 62000,
    strike: 62000,
    expiryMs: EXPIRY,
    markIv: 0.36,
    realizedVol: 0.3, // VRP = 6pts, gate open (the #12 BTC read)
    straddlePremiumUsd: premium,
    nowMs: NOW,
    ...over,
  });
}

describe('VrpBook gate (doctrine #5: no edge → no position)', () => {
  it('opens when iv − rv clears the measured-premium gate', () => {
    const book = new VrpBook(CFG);
    const { pos, reason } = openDefault(book);
    expect(reason).toBeUndefined();
    expect(pos!.premiumUsd).toBeGreaterThan(0);
    expect(pos!.contracts).toBe(0.1);
  });

  it('sits out when the VRP gate is closed', () => {
    const book = new VrpBook(CFG);
    const { pos, reason } = openDefault(book, { realizedVol: 0.35 });
    expect(pos).toBeNull();
    expect(reason).toMatch(/VRP gate closed/);
  });

  it('refuses entries too close to expiry and double-opens', () => {
    const book = new VrpBook(CFG);
    expect(openDefault(book, { nowMs: EXPIRY - 3_600_000 }).reason).toMatch(/to expiry/);
    openDefault(book);
    expect(openDefault(book).reason).toBe('position-open');
  });
});

describe('VrpBook lifecycle', () => {
  it('pin at the strike: settles ≈ full premium minus hedge fees (the VRP win case)', () => {
    const book = new VrpBook(CFG);
    const { pos } = openDefault(book);
    book.step(62000, NOW + 3_600_000); // ATM, |delta| small → no hedge
    const settled = book.settle(62000, EXPIRY)!;
    expect(settled.status).toBe('SETTLED');
    expect(settled.realisedUsd!).toBeGreaterThan(0);
    expect(settled.realisedUsd!).toBeLessThanOrEqual(pos!.premiumUsd);
    expect(book.snapshot().wins).toBe(1);
  });

  it('a big gap through the stop closes the position at the loss budget (the tail control)', () => {
    const book = new VrpBook(CFG);
    openDefault(book);
    // 15% gap up, unhedged → short straddle mark loss blows the $400 budget on 0.1 BTC
    const r = book.step(62000 * 1.15, NOW + 3_600_000);
    expect(r.stoppedOut).toBeDefined();
    expect(r.stoppedOut!.status).toBe('STOPPED');
    expect(r.stoppedOut!.realisedUsd!).toBeLessThan(0);
    expect(book.snapshot().stopped).toBe(1);
    // stop keeps the realised loss the same order as the budget (band, not cliff)
    expect(r.stoppedOut!.realisedUsd!).toBeGreaterThan(-3 * CFG.maxLossBudgetUsd);
  });

  it('rehedges when delta drifts past the band and pays the fee', () => {
    const book = new VrpBook({ ...CFG, maxLossBudgetUsd: 100_000 });
    openDefault(book);
    // 4% rally: short straddle goes short-delta beyond 0.25×contracts → buy hedge
    const r = book.step(62000 * 1.04, NOW + 3_600_000);
    expect(r.rehedged).toBeDefined();
    expect(r.rehedged!.qty).toBeGreaterThan(0); // long perp against short-call delta
    const pos = book.position()!;
    expect(pos.hedgeQty).toBeCloseTo(r.rehedged!.qty, 12);
    expect(pos.hedgeFeesUsd).toBeGreaterThan(0);
    // after the hedge, net delta ≈ 0
    expect(Math.abs(book.netDelta(62000 * 1.04, NOW + 3_600_000))).toBeLessThan(1e-9);
  });

  it('hedge round-trip realises P&L against average cost', () => {
    const book = new VrpBook({ ...CFG, maxLossBudgetUsd: 100_000, hedgeBandFrac: 0.1 });
    openDefault(book);
    book.step(64500, NOW + 3_600_000); // rally → long hedge
    const upQty = book.position()!.hedgeQty;
    expect(upQty).toBeGreaterThan(0);
    book.step(60000, NOW + 7_200_000); // slam back → sell hedge below avg → realised loss on hedge
    const pos = book.position()!;
    expect(pos.rehedges).toBe(2);
    expect(pos.hedgeRealisedUsd).toBeLessThan(0); // bought high, sold low: the gamma bill
  });

  it('realised total accumulates across the book snapshot', () => {
    const book = new VrpBook(CFG);
    openDefault(book);
    book.settle(62000, EXPIRY);
    const s = book.snapshot();
    expect(s.realisedTotalUsd).toBeCloseTo(book.position()!.realisedUsd!, 9);
    expect(s.premiumCollectedUsd).toBeGreaterThan(0);
  });
});
