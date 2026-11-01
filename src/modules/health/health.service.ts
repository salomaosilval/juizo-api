import { AppError } from '../../shared/errors/app-error.js';
import type { HealthRepository } from './health.repository.js';

export interface HealthService {
  assertReady(): Promise<void>;
}

export function createHealthService(repository: HealthRepository): HealthService {
  return {
    async assertReady() {
      try {
        await repository.pingDatabase();
      } catch (cause) {
        throw new AppError('SERVICE_UNAVAILABLE', 'The database is unreachable.', { cause });
      }
    },
  };
}
