import { Logger } from '@nestjs/common';
import { HyperliquidClient } from '../../market-data/reference/hyperliquid-client';
import { HyperliquidFundingClient } from '../../market-data/funding/hyperliquid-funding-client';
import { FundingPoint } from '../../market-data/funding/funding-source.interface';
import { defaultRegimeSignalSpecs, trailingFundingPerHour } from './regime-signals';
import { scoreRegimeBoard, bestPerSymbol, validatedSignalsPerSymbol } from './regime-board';
import { allocateUniverse, AllocationCandidate } from './regime-universe-allocator';
import { RegimeDirectionalBook } from './regime-directional-book';
import { RegimeMonitor, regimeChangeEvent } from './regime-monitor';
import { ConsensusBiasSource } from './consensus-bias-source';
import { FundingBiasSource } from '../bias/funding-bias-source';
import { MomentumBiasSource } from '../bias/momentum-bias-source';
import { ReversalBiasSource, VolScaledMomentumBiasSource } from '../bias/trend-variant-bias-sources';
import { IBiasSource } from '../bias/bias-source.interface';
import { biasMagnitudeCap } from '../bias/oos/forward-return-ic';
import { DeskEventInput } from '../events/desk-event';
import { RegimeDeskTrader, SeatedRegimeBook, RegimeSymbolTick, RegimeMarketTick } from './regime-desk-trader';

// RegimeLiveDriver — the NETWORK leg behind the P13 cockpit. When REGIME_DESK is on, it runs the
// SAME gate-first sequence as scripts/regime-book-live.ts (OOS gate → cross-sectional allocator →
// seat the top-N validated books), then polls HL public candles + funding and feeds the trader
// one coherent tick each interval. It is deliberately thin + fully guarded (a fetch error never
// crashes boot) — the heavy, tested logic lives in the pure modules + RegimeDeskTrader.
//
// NOTE: this is real-data network code; it cannot run in the offline test sandbox. The trader it
// drives + the controller are unit-tested; this driver is verified by a local `npm run start:dev`
// with REGIME_DESK=true (handed to the operator, P16).

const MICROS = 1_000_000;
const toMicros = (x: number) => BigInt(Math.round(x * MICROS));

export interface RegimeLiveDriverConfig {
  symbols: string[];
  gateDays: number;
  interval: string;
  baseNotionalUsd: number;
  topN: number;
  pollMs: number;
  marketSymbol: string;
}

export class RegimeLiveDriver {
  private readonly log = new Logger('RegimeLiveDriver');
  private readonly hlPx = new HyperliquidClient();
  private readonly hlFund = new HyperliquidFundingClient();
  private timer: NodeJS.Timeout | null = null;
  private readonly consensus = new Map<string, ConsensusBiasSource>();
  private readonly fundingBuf = new Map<string, FundingPoint[]>();

  constructor(
    private readonly trader: RegimeDeskTrader,
    private readonly cfg: RegimeLiveDriverConfig,
    private readonly onEvent?: (e: DeskEventInput) => void,
  ) {}

  /** Gate + seat + start polling. Fire-and-forget; guarded so a network miss never crashes boot. */
  async start(): Promise<void> {
    try {
      const seated = await this.gateAndSeat();
      if (!seated.length) {
        this.log.warn('Regime Desk: 0 symbols validated today — nothing seated (correct outcome; re-gate next session).');
        return;
      }
      this.trader.seat(seated);
      this.trader.start();
      this.log.log(`Regime Desk LIVE: seated ${seated.map((s) => s.symbol).join(', ')} — polling every ${this.cfg.pollMs / 1000}s.`);
      this.timer = setInterval(() => void this.poll().catch((e) => this.log.warn(`poll err ${(e as Error).message}`)), this.cfg.pollMs);
    } catch (e) {
      this.log.warn(`Regime Desk failed to start (${(e as Error).message}) — cockpit will show empty.`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.trader.stop();
  }

  private async gateAndSeat(): Promise<SeatedRegimeBook[]> {
    const toMs = Date.now();
    const fromMs = toMs - this.cfg.gateDays * 86_400_000;
    const ivHours = /^(\d+)h$/.test(this.cfg.interval) ? Number(this.cfg.interval.replace('h', '')) : 1;
    const wantBars = Math.ceil((this.cfg.gateDays * 24) / ivHours) + 16;
    const loaded: { symbol: string; series: { prices: number[]; barTimesMs: number[]; funding: FundingPoint[] } }[] = [];
    for (const sym of this.cfg.symbols) {
      const bars = (await this.hlPx.klines(sym, this.cfg.interval, wantBars)).filter((b) => b.timestamp.getTime() >= fromMs);
      if (bars.length < 20) continue;
      const funding = await this.hlFund.fundingHistory(sym, fromMs, toMs).catch(() => [] as FundingPoint[]);
      loaded.push({ symbol: sym, series: { prices: bars.map((b) => b.close), barTimesMs: bars.map((b) => b.timestamp.getTime()), funding } });
      this.fundingBuf.set(sym, funding.filter((f) => f.fundingTimeMs >= toMs - 3 * 86_400_000));
    }
    if (!loaded.length) return [];
    const specs = defaultRegimeSignalSpecs({ intervalHours: ivHours });
    const board = scoreRegimeBoard(loaded, specs, { fwdHours: [8, 24, 72], ivHours, folds: 5, embargoFrac: 0.01 });
    const eligible = bestPerSymbol(board).filter((r) => r.eligible);
    const validatedMap = validatedSignalsPerSymbol(board);
    const candidates: AllocationCandidate[] = eligible.map((r) => ({ symbol: r.symbol, side: 1, conviction: biasMagnitudeCap(r.oosIc), ic: r.oosIc }));
    const alloc = allocateUniverse(candidates, { topN: this.cfg.topN, baseNotionalUsd: this.cfg.baseNotionalUsd, perSymbolMaxUsd: this.cfg.baseNotionalUsd, maxGrossUsd: this.cfg.baseNotionalUsd * this.cfg.topN, maxNetUsd: Number.MAX_SAFE_INTEGER });
    const allocBySymbol = new Map(alloc.allocations.map((a) => [a.symbol, a]));

    const seated: SeatedRegimeBook[] = [];
    for (const r of eligible) {
      const a = allocBySymbol.get(r.symbol);
      if (!a) continue;
      const validated = (validatedMap.get(r.symbol) ?? []).map((t) => ({ kind: t.spec.kind, lookbackBars: t.spec.lookbackBars }));
      const ic = Math.max(...(validatedMap.get(r.symbol) ?? [{ oosIc: r.oosIc }]).map((t) => t.oosIc));
      seated.push({
        symbol: r.symbol,
        ic,
        signalName: r.spec.name,
        allocNotionalUsd: a.notionalUsd,
        book: new RegimeDirectionalBook({ baseNotionalUsd: this.cfg.baseNotionalUsd, maxNotionalUsd: a.notionalUsd, book: r.symbol, source: 'regime-directional', onEvent: this.onEvent }),
        monitor: new RegimeMonitor(r.symbol, { onRegimeChange: (tr) => this.onEvent?.(regimeChangeEvent(tr)) }),
      });
      this.consensus.set(r.symbol, this.buildConsensus(validated));
    }
    return seated;
  }

  private buildConsensus(validated: { kind: string; lookbackBars?: number }[]): ConsensusBiasSource {
    const sources: IBiasSource[] = [];
    for (const v of validated) {
      if (v.kind === 'funding-paid-side') sources.push(new FundingBiasSource({ fullBiasRatePerHour: 1.25e-5, validated: true }));
      else if (v.kind === 'momentum') sources.push(new MomentumBiasSource({ fullBiasReturn: 0.05, lookback: v.lookbackBars, validated: true }));
      else if (v.kind === 'reversal') sources.push(new ReversalBiasSource({ fullBiasReturn: 0.03, lookback: v.lookbackBars, validated: true }));
      else if (v.kind === 'vol-scaled-momentum') sources.push(new VolScaledMomentumBiasSource({ fullBiasZ: 1.5, lookback: v.lookbackBars, validated: true }));
    }
    return new ConsensusBiasSource(sources, { minAgree: 1 });
  }

  private async poll(): Promise<void> {
    const ticks = new Map<string, RegimeSymbolTick>();
    let market: RegimeMarketTick | undefined;
    for (const sym of this.consensus.keys()) {
      const bars = await this.hlPx.klines(sym, this.cfg.interval, 80);
      if (bars.length < 2) continue;
      const closes = bars.map((b) => b.close);
      const mid = closes[closes.length - 1];
      const recentReturns: number[] = [];
      for (let i = 1; i < closes.length; i++) recentReturns.push(Math.log(closes[i] / closes[i - 1]));
      const now = Date.now();
      const snapF = await this.hlFund.currentFunding(sym).catch(() => null);
      const curRate = snapF?.lastFundingRate ?? 0;
      const buf = this.fundingBuf.get(sym) ?? [];
      buf.push({ symbol: sym, fundingTimeMs: now, fundingRate: curRate, markPrice: mid });
      this.fundingBuf.set(sym, buf.filter((f) => f.fundingTimeMs >= now - 25 * 3_600_000));
      const trail = trailingFundingPerHour([now], this.fundingBuf.get(sym)!, 24)[0];
      const reading = this.consensus.get(sym)!.bias(sym, { fundingRatePerHour: Number.isFinite(trail) ? trail : curRate, recentReturns, nowMs: now, midMicros: toMicros(mid) });
      ticks.set(sym, { nowMs: now, midMicros: toMicros(mid), fundingRatePerHour: curRate, fundingForSignal: Number.isFinite(trail) ? trail : curRate, ret: recentReturns[recentReturns.length - 1], reading, recentReturns });
      if (sym === this.cfg.marketSymbol) market = { symbol: sym, midUsd: mid, returns: recentReturns };
    }
    if (!market) {
      const bars = await this.hlPx.klines(this.cfg.marketSymbol, this.cfg.interval, 80).catch(() => []);
      if (bars.length >= 2) {
        const closes = bars.map((b) => b.close);
        const r: number[] = [];
        for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
        market = { symbol: this.cfg.marketSymbol, midUsd: closes[closes.length - 1], returns: r };
      }
    }
    this.trader.tick(ticks, market);
  }
}
