/**
 * hyperliquid-outcome-client — HIP-4 outcome markets over the public info API.
 *
 * Discovered live 2026-07-13 (no official docs in-repo yet, shapes verified by probe):
 *   POST /info {"type":"outcomeMeta"} → { outcomes: [{ outcome, name, description,
 *     sideSpecs: [{name:'Yes'},{name:'No'}], quoteToken }], questions: [...] }
 *   Each outcome side trades as coin '#<outcomeId><sideIdx>' (side 0 = sideSpecs[0] = Yes):
 *     POST /info {"type":"l2Book","coin":"#8230"} → standard 20×20 book, prices in [0,1].
 *     allMids carries the same '#<id><side>' keys; YES+NO mids sum to 1.0 (verified).
 *   Recurring price binaries carry a machine-readable description (see
 *   parsePriceBinaryDescription). Everything else (sports, macro events) is skipped.
 *
 * Read-only; paper execution happens in OutcomeRvBook. No API key.
 */
import {
  BinaryQuote,
  IBinaryMarketSource,
  parsePriceBinaryDescription,
} from './binary-market.types';

export type HlHttpPost = (body: Record<string, unknown>) => Promise<unknown>;

const defaultHttpPost =
  (baseUrl: string): HlHttpPost =>
  async (body) => {
    const res = await fetch(`${baseUrl}/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HL info ${JSON.stringify(body)} -> HTTP ${res.status}`);
    return res.json();
  };

interface RawOutcome {
  outcome: number;
  name?: string;
  description?: string;
  sideSpecs?: { name?: string }[];
}

interface RawL2 {
  levels?: [{ px: string; sz: string }[], { px: string; sz: string }[]];
}

export interface HyperliquidOutcomeClientOptions {
  baseUrl?: string;
  httpPost?: HlHttpPost;
}

export class HyperliquidOutcomeClient implements IBinaryMarketSource {
  readonly venue = 'hyperliquid-hip4';
  private readonly httpPost: HlHttpPost;

  constructor(opts: HyperliquidOutcomeClientOptions = {}) {
    const base = (opts.baseUrl ?? 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
    this.httpPost = opts.httpPost ?? defaultHttpPost(base);
  }

  async listPriceBinaries(): Promise<BinaryQuote[]> {
    const meta = (await this.httpPost({ type: 'outcomeMeta' })) as { outcomes?: RawOutcome[] };
    if (!Array.isArray(meta?.outcomes)) throw new Error('HL outcomeMeta: bad response');
    const out: BinaryQuote[] = [];
    for (const o of meta.outcomes) {
      const spec = o.description ? parsePriceBinaryDescription(o.description) : null;
      if (!spec) continue;
      // Side 0 must actually be the Yes side — refuse to guess if the venue reorders.
      const side0 = o.sideSpecs?.[0]?.name?.toLowerCase();
      if (side0 !== 'yes') continue;
      const book = (await this.httpPost({ type: 'l2Book', coin: `#${o.outcome}0` })) as RawL2 | null;
      const bid = book?.levels?.[0]?.[0];
      const ask = book?.levels?.[1]?.[0];
      if (!bid || !ask) continue; // no two-sided book → not executable, skip
      const yesBid = Number(bid.px);
      const yesAsk = Number(ask.px);
      if (!(yesBid >= 0 && yesAsk <= 1 && yesBid < yesAsk)) continue;
      out.push({
        venue: this.venue,
        marketId: String(o.outcome),
        ...spec,
        yesBid,
        yesAsk,
        yesBidSize: Number(bid.sz),
        yesAskSize: Number(ask.sz),
        timeMs: Date.now(),
      });
    }
    return out;
  }

  async underlyingMid(underlying: string): Promise<number> {
    const mids = (await this.httpPost({ type: 'allMids' })) as Record<string, string>;
    const px = Number(mids?.[underlying.toUpperCase()]);
    if (!Number.isFinite(px) || px <= 0) throw new Error(`HL allMids: no mid for ${underlying}`);
    return px;
  }
}
