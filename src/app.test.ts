import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { buildTestEnv } from '../test/env.fixture.js';
import { buildApp } from './app.js';
import { createDatabaseClient } from './shared/database/prisma-client.js';
import { AppError } from './shared/errors/app-error.js';

describe('app', () => {
  let app: FastifyInstance;

  async function startApp(overrides: Parameters<typeof buildTestEnv>[0] = {}) {
    const env = buildTestEnv(overrides);
    app = await buildApp({ env, database: createDatabaseClient(env.DATABASE_URL) });
    return app;
  }

  afterEach(async () => {
    await app.close();
  });

  it('answers liveness without touching the database', async () => {
    await startApp();

    const response = await app.inject({ url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 on readiness when the database is unreachable', async () => {
    await startApp();

    const response = await app.inject({ url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers unknown routes with the standard error shape', async () => {
    await startApp();

    const response = await app.inject({ url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers invalid input with the failing fields', async () => {
    await startApp();
    app
      .withTypeProvider<ZodTypeProvider>()
      .post(
        '/echo',
        { schema: { body: z.object({ amountInCents: z.number().int() }) } },
        ({ body }) => body,
      );

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { amountInCents: 'many' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      issues: [{ path: '/amountInCents' }],
    });
  });

  it('hides the details of unexpected errors', async () => {
    await startApp();
    app.get('/boom', () => {
      throw new Error('secret database detail');
    });

    const response = await app.inject({ url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  });

  it('answers malformed JSON as a client error', async () => {
    await startApp();
    app.post('/echo', ({ body }) => body);

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('answers application errors with their own code and status', async () => {
    await startApp();
    app.get('/missing-resource', () => {
      throw new AppError('NOT_FOUND', 'Transaction not found.');
    });

    const response = await app.inject({ url: '/missing-resource' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'NOT_FOUND', message: 'Transaction not found.' });
  });

  it('falls back to a generic code for unmapped client errors', async () => {
    await startApp();
    app.get('/teapot', () => {
      throw Object.assign(new Error('short and stout'), { statusCode: 418 });
    });

    const response = await app.inject({ url: '/teapot' });

    expect(response.statusCode).toBe(418);
    expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('limits requests and answers with the standard error shape', async () => {
    await startApp({ RATE_LIMIT_MAX_PER_MINUTE: 1 });
    app.get('/limited', () => ({ ok: true }));

    await app.inject({ url: '/limited' });
    const response = await app.inject({ url: '/limited' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('never rate limits health checks', async () => {
    await startApp({ RATE_LIMIT_MAX_PER_MINUTE: 1 });

    await app.inject({ url: '/health/live' });
    const response = await app.inject({ url: '/health/live' });

    expect(response.statusCode).toBe(200);
  });

  it('allows only the configured origins', async () => {
    await startApp({ CORS_ALLOWED_ORIGINS: ['https://app.juizo.com'] });

    const allowed = await app.inject({
      url: '/health/live',
      headers: { origin: 'https://app.juizo.com' },
    });
    const denied = await app.inject({
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.juizo.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes the API documentation outside production only', async () => {
    await startApp({ NODE_ENV: 'development', LOG_LEVEL: 'silent' });
    const documented = await app.inject({ url: '/docs/' });
    await app.close();

    await startApp({ NODE_ENV: 'production' });
    const hidden = await app.inject({ url: '/docs/' });

    expect(documented.statusCode).toBe(200);
    expect(hidden.statusCode).toBe(404);
  });
});
