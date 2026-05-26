export class InsufficientPrincipalError extends Error {
  constructor(provider: string, requested: bigint, available: bigint) {
    super(
      `treasury: cannot withdraw ${requested} from ${provider} — only ${available} available`,
    );
    this.name = 'InsufficientPrincipalError';
  }
}

export class InvalidAmountError extends Error {
  constructor(amount: bigint) {
    super(`treasury: amount must be > 0 (got ${amount})`);
    this.name = 'InvalidAmountError';
  }
}
