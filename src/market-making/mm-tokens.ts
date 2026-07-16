// DI tokens shared between MarketMakingModule and the controllers it declares.
// A controller file must not import the module file for a token (circular import
// — the Symbol would be undefined at decorator evaluation), so tokens live here.

/** The MM desk's shared Binance public REST client (no key, market data only). */
export const MM_BINANCE_CLIENT = Symbol('MM_BINANCE_CLIENT');
