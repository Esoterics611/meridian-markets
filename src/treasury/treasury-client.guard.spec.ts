import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TreasuryClientGuard } from './treasury-client.guard';

function ctxWithHeader(value: string | undefined): ExecutionContext {
  const req = {
    header: (name: string) =>
      name.toLowerCase() === 'x-meridian-client-key' ? value : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function cfgWith(key: string): ConfigService {
  return {
    getOrThrow: () => ({ meridianClientKey: key }),
  } as unknown as ConfigService;
}

describe('TreasuryClientGuard', () => {
  it('rejects when no header is present', () => {
    const guard = new TreasuryClientGuard(cfgWith('expected-key'));
    expect(() => guard.canActivate(ctxWithHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when the header is wrong', () => {
    const guard = new TreasuryClientGuard(cfgWith('expected-key'));
    expect(() => guard.canActivate(ctxWithHeader('wrong-key'))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts when the header matches exactly', () => {
    const guard = new TreasuryClientGuard(cfgWith('expected-key'));
    expect(guard.canActivate(ctxWithHeader('expected-key'))).toBe(true);
  });

  it('rejects when the configured key is empty (mis-configuration)', () => {
    const guard = new TreasuryClientGuard(cfgWith(''));
    expect(() => guard.canActivate(ctxWithHeader('anything'))).toThrow(
      UnauthorizedException,
    );
  });

  it('header comparison is length-strict (prefix is not enough)', () => {
    const guard = new TreasuryClientGuard(cfgWith('expected-key'));
    expect(() => guard.canActivate(ctxWithHeader('expected-key-extra'))).toThrow(
      UnauthorizedException,
    );
  });
});
