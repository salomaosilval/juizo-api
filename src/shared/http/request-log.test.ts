import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { serializeRequestForLog } from './request-log.js';

describe('serializeRequestForLog', () => {
  it('drops the query string, which can carry authorization codes', () => {
    const request = {
      id: 'request-id',
      method: 'GET',
      url: '/auth/google/callback?code=secret&state=secret',
    } as FastifyRequest;

    expect(JSON.stringify(serializeRequestForLog(request))).not.toContain('secret');
    expect(serializeRequestForLog(request).url).toBe('/auth/google/callback');
  });
});
