import { BiasContext, BiasReading, IBiasSource, NEUTRAL_BIAS } from './bias-source.interface';

// NullBiasSource — the default: always neutral (b=0). A directional book wired to
// this behaves EXACTLY like today's neutral GLFT (q* = 0), so nothing regresses
// until a real bias source is chosen. The swap-seam safe default (CLAUDE.md §7).
export class NullBiasSource implements IBiasSource {
  bias(_symbol: string, _ctx: BiasContext): BiasReading {
    return NEUTRAL_BIAS;
  }
}
