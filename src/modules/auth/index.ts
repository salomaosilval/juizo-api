import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';
import type { Clock } from '../../shared/time/clock.js';
import { createAuthRepository } from './auth.repository.js';
import { authRoutes } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createPasswordHasher } from './password-hasher.js';
import { createRequireAuth } from './require-auth.js';
import { generateSessionToken } from './session-token.js';
import type { RequireAuth } from './require-auth.js';
import { createSessionCookie } from './session-cookie.js';

export { getAuthenticatedUser } from './require-auth.js';
export type { RequireAuth } from './require-auth.js';

interface AuthModuleDependencies {
  database: DatabaseClient;
  clock: Clock;
  useSecureCookies: boolean;
}

export async function registerAuthModule(
  app: FastifyInstance,
  { database, clock, useSecureCookies }: AuthModuleDependencies,
): Promise<RequireAuth> {
  await app.register(cookie);
  app.decorateRequest('authenticatedUser', null);

  const passwordHasher = createPasswordHasher();
  const authService = createAuthService({
    repository: createAuthRepository(database),
    passwordHasher,
    clock,
    decoyPasswordHash: await passwordHasher.hash(generateSessionToken()),
  });
  const sessionCookie = createSessionCookie(useSecureCookies, clock);
  const requireAuth = createRequireAuth(authService, sessionCookie);

  await app.register(authRoutes, { authService, requireAuth, sessionCookie });

  return requireAuth;
}
