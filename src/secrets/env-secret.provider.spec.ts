import { EnvSecretProvider } from './env-secret.provider';

describe('EnvSecretProvider', () => {
  let provider: EnvSecretProvider;
  const TEST_KEY = '__MERIDIAN_TEST_SECRET_KEY__';

  beforeEach(() => {
    provider = new EnvSecretProvider();
    delete process.env[TEST_KEY];
  });

  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  describe('get()', () => {
    it('returns the value when the env var is set', async () => {
      process.env[TEST_KEY] = 'my-secret-value';
      await expect(provider.get(TEST_KEY)).resolves.toBe('my-secret-value');
    });

    it('throws (not returns undefined) when the env var is missing', async () => {
      await expect(provider.get(TEST_KEY)).rejects.toThrow();
    });

    it('throws when the env var is an empty string', async () => {
      process.env[TEST_KEY] = '';
      await expect(provider.get(TEST_KEY)).rejects.toThrow();
    });

    it('does not expose the secret value in the error message', async () => {
      process.env[TEST_KEY] = 'super-secret';
      // Whichever code-path it hit, the value itself must never appear.
      try {
        process.env[TEST_KEY] = '';
        await provider.get(TEST_KEY);
        throw new Error('expected provider.get to throw');
      } catch (err) {
        expect((err as Error).message).not.toContain('super-secret');
      }
    });

    it('includes the key name in the error so the caller can debug', async () => {
      await expect(provider.get(TEST_KEY)).rejects.toThrow(TEST_KEY);
    });
  });

  describe('set()', () => {
    it('writes the value to process.env in-process', async () => {
      await provider.set(TEST_KEY, 'written-value');
      expect(process.env[TEST_KEY]).toBe('written-value');
    });

    it('a value written via set() is returned by a subsequent get()', async () => {
      await provider.set(TEST_KEY, 'set-then-get');
      await expect(provider.get(TEST_KEY)).resolves.toBe('set-then-get');
    });

    it('overwrites an existing env var', async () => {
      process.env[TEST_KEY] = 'original';
      await provider.set(TEST_KEY, 'overwritten');
      await expect(provider.get(TEST_KEY)).resolves.toBe('overwritten');
    });
  });
});
