import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { InvalidEnvError, parseEnv } from './env.js';

const validSource = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/juizo',
  CORS_ALLOWED_ORIGINS: 'https://app.juizo.com, https://juizo.com',
  WEB_APP_URL: 'https://app.juizo.com',
  EMAIL_PROVIDER: 'resend',
  EMAIL_FROM_ADDRESS: 'ola@juizo.com',
  RESEND_API_KEY: 're_secret',
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

  it('accepts the documented .env.example as it is', () => {
    const example = parseDotenv(readFileSync('.env.example', 'utf8'));

    expect(() => parseEnv(example)).not.toThrow();
  });

  it('treats an empty Resend key as missing', () => {
    expect(() => parseEnv({ ...validSource, RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY/);
  });

  it('requires the Resend key when Resend is the provider', () => {
    expect(() => parseEnv({ ...validSource, RESEND_API_KEY: undefined })).toThrow(/RESEND_API_KEY/);
  });

  it('refuses a local email provider in production', () => {
    expect(() => parseEnv({ ...validSource, EMAIL_PROVIDER: 'mailpit' })).toThrow(/EMAIL_PROVIDER/);
  });

  it('refuses an email link base that is not http', () => {
    expect(() =>
      parseEnv({ ...validSource, NODE_ENV: 'development', WEB_APP_URL: 'javascript:alert(1)' }),
    ).toThrow(/WEB_APP_URL/);
  });

  it('refuses email links without https in production', () => {
    expect(() => parseEnv({ ...validSource, WEB_APP_URL: 'http://app.juizo.com' })).toThrow(
      /WEB_APP_URL/,
    );
  });

  it('allows the local email provider outside production', () => {
    const env = parseEnv({
      ...validSource,
      NODE_ENV: 'development',
      EMAIL_PROVIDER: 'mailpit',
      RESEND_API_KEY: undefined,
      WEB_APP_URL: 'http://localhost:5173',
    });

    expect(env.MAILPIT_URL).toBe('http://localhost:8025');
  });

  it('names the invalid keys without exposing their values', () => {
    const parse = () => parseEnv({ ...validSource, DATABASE_URL: 'not-a-url-with-secret' });

    expect(parse).toThrow(/DATABASE_URL/);
    expect(parse).not.toThrow(/not-a-url-with-secret/);
  });
});
