import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/error-response.js';
import type { HealthService } from './health.service.js';

const healthyResponseSchema = z.object({ status: z.literal('ok') });

interface HealthRoutesOptions {
  healthService: HealthService;
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = (
  app,
  { healthService },
) => {
  app.get(
    '/health/live',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Reports that the process is running',
        response: { 200: healthyResponseSchema },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Reports that the API can serve traffic',
        response: { 200: healthyResponseSchema, 503: errorResponseSchema },
      },
    },
    async () => {
      await healthService.assertReady();
      return { status: 'ok' as const };
    },
  );

  return Promise.resolve();
};
