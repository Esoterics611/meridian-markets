import { InsufficientPrincipalError, InvalidAmountError } from './treasury.errors';

describe('treasury errors', () => {
  it('InvalidAmountError carries the offending amount in the message', () => {
    const err = new InvalidAmountError(0n);
    expect(err.name).toBe('InvalidAmountError');
    expect(err.message).toContain('0');
  });

  it('InsufficientPrincipalError carries provider, requested, and available', () => {
    const err = new InsufficientPrincipalError('mock', 100n, 50n);
    expect(err.name).toBe('InsufficientPrincipalError');
    expect(err.message).toContain('mock');
    expect(err.message).toContain('100');
    expect(err.message).toContain('50');
  });
});
