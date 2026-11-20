import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('PR-01 worker DATABASE_URL default', () => {
  it('defaults to the local database outside production, like the API', () => {
    expect(loadConfig({}).databaseUrl).toBe('postgres://postgres:postgres@localhost:5432/hqms');
    expect(loadConfig({ NODE_ENV: 'development' }).databaseUrl).toBe('postgres://postgres:postgres@localhost:5432/hqms');
    expect(loadConfig({ DATABASE_URL: '' }).databaseUrl).toBe('postgres://postgres:postgres@localhost:5432/hqms');
  });
  it('uses DATABASE_URL when set', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x@h/db' }).databaseUrl).toBe('postgres://x@h/db');
  });
  it('still refuses to start in production without DATABASE_URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is not set/);
    expect(loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x@h/db' }).databaseUrl).toBe('postgres://x@h/db');
  });
});
