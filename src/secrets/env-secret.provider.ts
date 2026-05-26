import { Injectable } from '@nestjs/common';
import { ISecretProvider } from './secret-provider.interface';

@Injectable()
export class EnvSecretProvider implements ISecretProvider {
  async get(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined || value === '') {
      throw new Error(`Required secret "${key}" is not set in environment`);
    }
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    process.env[key] = value;
  }
}
