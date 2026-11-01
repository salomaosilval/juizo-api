import type { Env } from '../src/config/env.js';

export function buildTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    CORS_ALLOWED_ORIGINS: ['http://localhost:5173'],
    RATE_LIMIT_MAX_PER_MINUTE: 1000,
    ...overrides,
  };
}
