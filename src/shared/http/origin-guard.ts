import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createOriginGuard(
  allowedOrigins: readonly string[],
): (request: FastifyRequest) => Promise<void> {
  return ({ method, headers: { origin } }) => {
    if (!SAFE_METHODS.has(method) && origin !== undefined && !allowedOrigins.includes(origin)) {
      return Promise.reject(new AppError('FORBIDDEN_ORIGIN', 'This origin is not allowed.'));
    }
    return Promise.resolve();
  };
}
