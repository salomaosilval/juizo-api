import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildTestEnv } from '../../../test/env.fixture.js';
import { buildApp } from '../../app.js';
import { createDatabaseClient } from '../../shared/database/prisma-client.js';

describe('GET /health/ready with a real database', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = buildTestEnv({ DATABASE_URL: inject('databaseUrl') });
    app = await buildApp({ env, database: createDatabaseClient(env.DATABASE_URL) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers ok when the database responds', async () => {
    const response = await app.inject({ url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
