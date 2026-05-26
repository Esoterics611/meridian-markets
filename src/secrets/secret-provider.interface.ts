export const SECRET_PROVIDER = Symbol('SECRET_PROVIDER');

export interface ISecretProvider {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<void>;
}
