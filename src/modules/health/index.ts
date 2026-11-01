import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';
import { createHealthRepository } from './health.repository.js';
import { healthRoutes } from './health.routes.js';
import { createHealthService } from './health.service.js';

export async function registerHealthModule(
  app: FastifyInstance,
  database: DatabaseClient,
): Promise<void> {
  const healthService = createHealthService(createHealthRepository(database));
  await app.register(healthRoutes, { healthService });
}
