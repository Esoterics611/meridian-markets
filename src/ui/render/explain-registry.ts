// The explain registry (UI_REWRITE_PLAN_III P3, §6) — every term the UI can explain
// on demand, in one typed const. Content is CURATED from docs/DESK_GLOSSARY.md (the
// intuition-first phrasing is the glossary's; this is a projection, not a fork — if
// a definition changes, change the glossary first, then mirror it here) plus a
// "read more" link into the served course chapter (D2: /courses/* same-origin).
//
// The ids are a STABLE TEACHING SURFACE (docs/TEACHING_SURFACE.md): mendy-hq prompt
// seeds and the tours reference them. Rename = a breaking change; add freely.
//
// A spec (explain-registry.spec.ts) asserts every course href maps to a tracked
// markdown chapter, so a dead "read more" cannot ship.

export interface ExplainEntry {
  /** Display term (short). */
  term: string;
  /** The plain-English intuition — 1–3 sentences, glossary voice, no formulas. */
  oneLiner: string;
  /** Grouping for the /learn glossary listing. */
  group: 'market basics' | 'market making' | 'stat-arb' | 'risk & P&L' | 'carry & funding';
  /** Optional "read more" — a served course chapter or a live page. */
  more?: { href: string; label: string };
}

const MM = (file: string, label: string) => ({ href: `/courses/market-making/${file}`, label: `MM course · ${label}` });
const SA = (file: string, label: string) => ({ href: `/courses/stat-arb/${file}`, label: `stat-arb course · ${label}` });

export const EXPLAIN_REGISTRY: Record<string, ExplainEntry> = {
  // ── market basics (the /markets page vocabulary) ────────────────────────────
  bid: {
    term: 'bid',
    group: 'market basics',
    oneLiner:
      'The price someone is willing to BUY at right now. The best (highest) bid is the top of the green side of the book — sell instantly and this is what you get.',
    more: MM('02-microstructure.html', 'ch.2 Microstructure'),
  },
  ask: {
    term: 'ask',
    group: 'market basics',
    oneLiner:
      'The price someone is willing to SELL at right now. The best (lowest) ask is the top of the red side of the book — buy instantly and this is what you pay.',
    more: MM('02-microstructure.html', 'ch.2 Microstructure'),
  },
  spread: {
    term: 'spread',
    group: 'market basics',
    oneLiner:
      'The gap between the best bid and the best ask — there is no single "the price". The spread is what a market maker earns for standing in the middle, and what everyone else pays to trade instantly.',
    more: MM('02-microstructure.html', 'ch.2 Microstructure'),
  },
  mid: {
    term: 'mid price',
    group: 'market basics',
    oneLiner:
      'The midpoint between best bid and best ask — the usual stand-in for "the price". It is a convention, not a law: the micro-price (size-weighted) is often a better guess at where the next trade will print.',
    more: MM('02-microstructure.html', 'ch.2 Microstructure'),
  },
  'order-book': {
    term: 'order book (L2 depth)',
    group: 'market basics',
    oneLiner:
      'The queue of everyone’s resting buy and sell orders, stacked by price. Bar length = how much size rests at each level. The book IS the market — every chart is just its history.',
    more: MM('02-microstructure.html', 'ch.2 Microstructure'),
  },
  'micro-price': {
    term: 'micro-price',
    group: 'market basics',
    oneLiner:
      'A fair-value estimate that weights bid and ask by the size resting on each side: a heavy bid pushes fair value up. Quoting off the micro-price instead of a stale mid cut our adverse selection ~21% — the desk’s central finding.',
    more: MM('10-the-fair-value-engine.html', 'ch.10 The fair-value engine'),
  },

  // ── market making ───────────────────────────────────────────────────────────
  'reservation-price': {
    term: 'reservation price',
    group: 'market making',
    oneLiner:
      'The book’s inventory-adjusted center: fair value, shifted away from the side we are already loaded on. Long inventory pushes it down (keener to sell), short pushes it up. Quotes straddle THIS, not the mid.',
    more: MM('03-avellaneda-stoikov.html', 'ch.3 Avellaneda–Stoikov'),
  },
  'half-spread': {
    term: '½-spread',
    group: 'market making',
    oneLiner:
      'How far each quote sits from the reservation price — the width we demand for taking the other side. Wider = fewer fills but more earned per fill; the σ/γ/κ dials set it, floored at fee break-even.',
    more: MM('03-avellaneda-stoikov.html', 'ch.3 Avellaneda–Stoikov'),
  },
  inventory: {
    term: 'inventory',
    group: 'market making',
    oneLiner:
      'What the book is currently holding (signed: + long, − short). A market maker wants to be a shopkeeper, not an investor — inventory is unsold stock, and the skew works to shed it back toward flat.',
    more: MM('03-avellaneda-stoikov.html', 'ch.3 Avellaneda–Stoikov'),
  },
  'adverse-selection': {
    term: 'adverse selection',
    group: 'market making',
    oneLiner:
      'Getting picked off: the price moves against you right after your fill, because whoever hit your quote knew more than your quote did. The maker’s biggest leak — fixed by fresher fair value and fast re-quoting, NOT by quoting wider.',
    more: MM('09-the-fair-value-result.html', 'ch.9 The fair-value result'),
  },
  'spread-captured': {
    term: 'spread captured',
    group: 'market making',
    oneLiner:
      'The gross edge earned at the moment of each fill, measured against fair mid — the shopkeeper’s markup, before the market gets a chance to move against the position.',
    more: MM('08-the-meridian-desk-stack.html', 'ch.8 The Meridian desk stack'),
  },
  'inventory-carry': {
    term: 'inventory carry / warehouse',
    group: 'market making',
    oneLiner:
      'Mark-to-market drift on what the book was already holding — the "warehouse" P&L. A book can look green on unrealised warehouse while its realised spread business bleeds; that is why the desk judges realised-first.',
    more: MM('08-the-meridian-desk-stack.html', 'ch.8 The Meridian desk stack'),
  },
  'fees-rebate': {
    term: 'fees (maker rebate)',
    group: 'market making',
    oneLiner:
      'What the venue charges — or PAYS. A maker rebate (negative fee) means the venue pays us for resting liquidity; a taker cross pays the fee and the spread. We colour fees by their contribution to net: rebate green, cost red.',
    more: MM('04-execution.html', 'ch.4 Execution'),
  },
  funding: {
    term: 'funding',
    group: 'market making',
    oneLiner:
      'The periodic payment perp longs and shorts exchange to keep the perp glued to spot. It accrues to whichever side is less crowded — a cost or an income stream for any book holding perp inventory.',
    more: MM('08-the-meridian-desk-stack.html', 'ch.8 The Meridian desk stack'),
  },
  markout: {
    term: 'markout',
    group: 'market making',
    oneLiner:
      'Where the price stands N seconds after your fill, versus your fill price. Negative markouts on your fills = you are being picked off (adverse selection made measurable). The desk’s per-book markout curves live on /desk/markout.',
    more: MM('09-the-fair-value-result.html', 'ch.9 The fair-value result'),
  },

  // ── stat-arb ────────────────────────────────────────────────────────────────
  'z-score': {
    term: 'z-score',
    group: 'stat-arb',
    oneLiner:
      'How stretched the pair’s spread is right now, in standard deviations from its recent mean. z = +2 means "unusually wide — bet on the snap-back"; back near 0 means the stretch resolved and the trade exits.',
    more: SA('03-ou-process.html', 'ch.3 The OU process'),
  },
  beta: {
    term: 'β (hedge ratio)',
    group: 'stat-arb',
    oneLiner:
      'How many units of leg B offset one unit of leg A, so the combined spread is stable. Get β from history (discovery); get it wrong and your "market-neutral" spread is secretly a directional bet.',
    more: SA('02-cointegration.html', 'ch.2 Cointegration'),
  },
  cointegration: {
    term: 'cointegration',
    group: 'stat-arb',
    oneLiner:
      'Two prices that wander, but wander TOGETHER — some combination of them stays range-bound. That stable combination is what a pairs trade actually trades. Honest caveat: in crypto it decays fast (our own finding killed taker stat-arb).',
    more: SA('02-cointegration.html', 'ch.2 Cointegration'),
  },
  'pair-regime': {
    term: 'regime (pair)',
    group: 'stat-arb',
    oneLiner:
      'The pair’s current statistical weather: mean-reverting (tradeable) or trending/broken (stand aside). The engine re-tests it as data arrives — a pair that stops reverting stops being traded.',
    more: SA('03-ou-process.html', 'ch.3 The OU process'),
  },

  // ── risk & P&L ──────────────────────────────────────────────────────────────
  nav: {
    term: 'NAV / equity',
    group: 'risk & P&L',
    oneLiner:
      'The book’s total value: capital + P&L + funding. The equity curve is NAV over time — the mission is a steady, low-drawdown curve, not a spiky one.',
    more: MM('05-risk.html', 'ch.5 Risk'),
  },
  drawdown: {
    term: 'drawdown vs budget',
    group: 'risk & P&L',
    oneLiner:
      'How far equity has fallen from its peak, as a % — the mission metric (minimise it). Each desk pre-registers a budget (2% MM, 0.5% carry); breaching it is a kill signal, not a suggestion.',
    more: MM('05-risk.html', 'ch.5 Risk'),
  },
  exposure: {
    term: 'net / gross exposure',
    group: 'risk & P&L',
    oneLiner:
      'Inventory × price, summed signed (net) and absolute (gross). Net ≈ 0 with big gross = market-neutral but busy; big net = a directional bet, hedged or not. Exposure is direction, not good/bad — so it stays uncoloured.',
    more: MM('05-risk.html', 'ch.5 Risk'),
  },
  'risk-verdict': {
    term: 'risk verdict',
    group: 'risk & P&L',
    oneLiner:
      'The composite gate’s live call per book: Allow = quote; Pause = hold quotes briefly (toxic burst); Deny = pull quotes / flatten (cap breach, drawdown kill). The gate is the engine’s, not the UI’s — the page only reports it.',
    more: MM('05-risk.html', 'ch.5 Risk'),
  },
  attribution: {
    term: 'P&L attribution',
    group: 'risk & P&L',
    oneLiner:
      'Net P&L split into WHERE it came from: spread captured, adverse selection, inventory carry, fees, funding. Two books can show the same net while one runs a clean spread business and the other bleeds — always read the split.',
    more: MM('08-the-meridian-desk-stack.html', 'ch.8 The Meridian desk stack'),
  },

  // ── carry & funding ─────────────────────────────────────────────────────────
  'funding-carry': {
    term: 'funding carry',
    group: 'carry & funding',
    oneLiner:
      'Hold spot, short the perp (or vice versa), collect the funding payments while price risk nets out. The earn is slow and steady — the risk is the basis moving and the legs not netting when you need them to.',
    more: SA('08-more-strategies.html', 'ch.8 More strategies'),
  },
  basis: {
    term: 'basis',
    group: 'carry & funding',
    oneLiner:
      'The gap between the perp (or future) price and spot. A carry position’s mark-to-market breathes with the basis — which is why the carry desk reports basis MTM but judges itself realised-first.',
    more: SA('08-more-strategies.html', 'ch.8 More strategies'),
  },
  'realised-first': {
    term: 'realised-first',
    group: 'carry & funding',
    oneLiner:
      'The judged number: funding actually received + realised P&L − fees actually paid. Unrealised marks are reported, not judged — a green mark you have not banked is a hope, not a result.',
    more: { href: '/desk/carry', label: 'the carry desk (live)' },
  },
};

/** Lookup (undefined for unknown ids — callers 404, never fabricate). */
export function explainEntry(id: string): ExplainEntry | undefined {
  return EXPLAIN_REGISTRY[id];
}

export const EXPLAIN_GROUPS: ExplainEntry['group'][] = ['market basics', 'market making', 'stat-arb', 'risk & P&L', 'carry & funding'];
