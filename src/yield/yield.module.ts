import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MockYieldProvider } from './mock-yield-provider';
import { RealOndoYieldProvider } from './real-ondo-yield-provider';
import { IYieldProvider, YIELD_PROVIDER } from './yield-provider.interface';

@Module({
  providers: [
    {
      provide: YIELD_PROVIDER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): IYieldProvider => {
        const app = cfg.getOrThrow<AppConfig>('app');
        if (app.yield.mockEnabled) {
          return new MockYieldProvider(app.yield.mockApr, app.yield.mockSettleMs);
        }
        return new RealOndoYieldProvider();
      },
    },
  ],
  exports: [YIELD_PROVIDER],
})
export class YieldModule {}
