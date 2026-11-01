import { describe, expect, it } from 'vitest';
import { InvalidEnvError, parseEnv } from './env.js';

const validSource = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/juizo',
  CORS_ALLOWED_ORIGINS: 'https://app.juizo.com, https://juizo.com',
};

describe('parseEnv', () => {
  it('applies defaults for optional variables', () => {
    const env = parseEnv(validSource);

    expect(env).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 3333,
      LOG_LEVEL: 'info',
      RATE_LIMIT_MAX_PER_MINUTE: 120,
    });
  });

  it('splits the allowed origins into a trimmed list', () => {
    const env = parseEnv(validSource);

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://app.juizo.com', 'https://juizo.com']);
  });

  it('coerces numeric variables', () => {
    const env = parseEnv({ ...validSource, PORT: '8080' });

    expect(env.PORT).toBe(8080);
  });

  it('rejects a database url that is not postgres', () => {
    expect(() => parseEnv({ ...validSource, DATABASE_URL: 'mysql://localhost/juizo' })).toThrow(
      InvalidEnvError,
    );
  });

  it('names the invalid keys without exposing their values', () => {
    const parse = () => parseEnv({ ...validSource, DATABASE_URL: 'not-a-url-with-secret' });

    expect(parse).toThrow(/DATABASE_URL/);
    expect(parse).not.toThrow(/not-a-url-with-secret/);
  });
});
