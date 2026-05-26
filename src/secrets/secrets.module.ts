import { Global, Module } from '@nestjs/common';
import { SECRET_PROVIDER } from './secret-provider.interface';
import { EnvSecretProvider } from './env-secret.provider';

@Global()
@Module({
  providers: [{ provide: SECRET_PROVIDER, useClass: EnvSecretProvider }],
  exports: [SECRET_PROVIDER],
})
export class SecretsModule {}
