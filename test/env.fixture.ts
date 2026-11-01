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
    TRUSTED_PROXY_HOPS: 0,
    WEB_APP_URL: 'https://app.juizo.test',
    EMAIL_PROVIDER: 'mailpit',
    EMAIL_FROM_NAME: 'Juízo',
    EMAIL_FROM_ADDRESS: 'ola@juizo.test',
    MAILPIT_URL: 'http://127.0.0.1:1',
    RESEND_API_KEY: undefined,
    ...overrides,
  };
}
