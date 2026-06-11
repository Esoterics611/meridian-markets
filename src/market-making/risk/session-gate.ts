// Session-gate config parser (Journal #55). The desk quotes xyz equity-linked perps whose
// REFERENCE market keeps US hours — quoting them off-RTH means pricing against a stale/closed
// underlying, which run53 measured as pure pick-off (SKHX fillEdge −$632, all pre-US-open).
// MM_SESSION_GATE declares which symbols may only quote inside a UTC window:
//
//   MM_SESSION_GATE="xyz:NVDA,xyz:TSLA,xyz:SKHX=1330-2000"          (one rule)
//   MM_SESSION_GATE="xyz:NVDA=1330-2000;xyz:JP225=0000-0600"        (';'-separated rules)
//
// Symbols are matched EXACT-CASE (the xyz: coin-key rule). A symbol with no rule quotes 24h.

export interface SessionWindowUtc {
  /** Quoting allowed in [openMin, closeMin) minutes of the UTC day. */
  openMin: number;
  closeMin: number;
}

export interface SessionGateRule extends SessionWindowUtc {
  symbols: string[];
}

/** Parse MM_SESSION_GATE. Malformed rules are SKIPPED (a typo must not kill the desk boot);
 *  the caller logs what parsed. */
export function parseSessionGate(raw: string | undefined): SessionGateRule[] {
  if (!raw || raw.trim() === '') return [];
  const rules: SessionGateRule[] = [];
  for (const part of raw.split(';')) {
    const eq = part.lastIndexOf('=');
    if (eq <= 0) continue;
    const symbols = part
      .slice(0, eq)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const m = part.slice(eq + 1).trim().match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (!m || symbols.length === 0) continue;
    const openMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const closeMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    if (openMin >= 1440 || closeMin > 1440 || openMin >= closeMin) continue; // no overnight windows (yet)
    rules.push({ symbols, openMin, closeMin });
  }
  return rules;
}

/** The window for `symbol`, or undefined (quote 24h). First matching rule wins. */
export function sessionForSymbol(rules: SessionGateRule[], symbol: string): SessionWindowUtc | undefined {
  for (const r of rules) {
    if (r.symbols.includes(symbol)) return { openMin: r.openMin, closeMin: r.closeMin };
  }
  return undefined;
}
