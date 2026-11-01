import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/errors/app-error.js';
import { createHealthService } from './health.service.js';

describe('HealthService.assertReady', () => {
  it('resolves when the database responds', async () => {
    const service = createHealthService({ pingDatabase: () => Promise.resolve() });

    await expect(service.assertReady()).resolves.toBeUndefined();
  });

  it('reports the service as unavailable and keeps the cause when the database fails', async () => {
    const connectionFailure = new Error('connection refused');
    const service = createHealthService({ pingDatabase: () => Promise.reject(connectionFailure) });

    const error: unknown = await service.assertReady().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', cause: connectionFailure });
  });
});
