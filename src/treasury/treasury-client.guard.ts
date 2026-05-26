import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AppConfig } from '@config/app-config.interface';

// Single shared-secret header (`x-meridian-client-key`) — the v1 cross-service
// auth contract between Lira-Bridge and Markets. Replace with mTLS or a signed
// JWT before either side handles real money; documented in
// docs/INTEGRATION_WITH_LIRA_BRIDGE.md.
const HEADER = 'x-meridian-client-key';

@Injectable()
export class TreasuryClientGuard implements CanActivate {
  constructor(private readonly cfg: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.cfg.getOrThrow<AppConfig>('app').meridianClientKey;
    if (!expected) {
      throw new UnauthorizedException('meridian client key not configured');
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const presented = req.header(HEADER);
    if (!presented || !constantTimeEquals(presented, expected)) {
      throw new UnauthorizedException('invalid meridian client key');
    }
    return true;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
