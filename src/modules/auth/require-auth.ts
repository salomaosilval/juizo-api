import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors/app-error.js';
import type { UserRecord } from './auth.repository.js';
import type { AuthService } from './auth.service.js';
import type { SessionCookie } from './session-cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser: UserRecord | null;
  }
}

export type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function createRequireAuth(
  authService: AuthService,
  sessionCookie: SessionCookie,
): RequireAuth {
  return async (request, reply) => {
    const token = sessionCookie.read(request);
    if (token === undefined) {
      throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
    }

    try {
      const { user, renewedExpiresAt } = await authService.authenticate(token);
      request.authenticatedUser = user;
      if (renewedExpiresAt) {
        sessionCookie.write(reply, token, renewedExpiresAt);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'UNAUTHENTICATED') {
        sessionCookie.clear(reply);
      }
      throw error;
    }
  };
}

export function getAuthenticatedUser(request: FastifyRequest): UserRecord {
  if (!request.authenticatedUser) {
    throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
  }
  return request.authenticatedUser;
}
