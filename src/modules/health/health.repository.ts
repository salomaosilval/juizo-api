import type { DatabaseClient } from '../../shared/database/prisma-client.js';

export interface HealthRepository {
  pingDatabase(): Promise<void>;
}

export function createHealthRepository(database: DatabaseClient): HealthRepository {
  return {
    async pingDatabase() {
      await database.$queryRaw`SELECT 1`;
    },
  };
}
