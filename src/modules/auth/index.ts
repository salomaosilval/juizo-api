import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';
import type { EmailSender } from '../../shared/email/email-sender.js';
import type { BackgroundTasks } from '../../shared/tasks/background-tasks.js';
import type { Clock } from '../../shared/time/clock.js';
import { createAttemptLimiter } from './attempt-limiter.js';
import { createAttemptRepository } from './attempt.repository.js';
import { createAuthRepository } from './auth.repository.js';
import { authRoutes } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { googleAuthRoutes } from './google-auth.routes.js';
import { createGoogleAuthRepository } from './google-auth.repository.js';
import { createGoogleAuthService } from './google-auth.service.js';
import { createGoogleFlowCookie } from './google-flow-cookie.js';
import type { GoogleIdentityProvider } from './google-identity-provider.js';
import { createPasswordHasher } from './password-hasher.js';
import { createPasswordRecoveryRepository } from './password-recovery.repository.js';
import { createPasswordRecoveryService } from './password-recovery.service.js';
import { createRegistrationRepository } from './registration.repository.js';
import { createRegistrationService } from './registration.service.js';
import { createRequireAuth } from './require-auth.js';
import type { RequireAuth } from './require-auth.js';
import { generateSecretToken } from './secret-token.js';
import { createSessionCookie } from './session-cookie.js';

export { getAuthenticatedUser } from './require-auth.js';
export { createGoogleIdentityProvider } from './google-identity-provider.js';
export type { GoogleIdentityProvider } from './google-identity-provider.js';
export type { RequireAuth } from './require-auth.js';

interface AuthModuleDependencies {
  database: DatabaseClient;
  clock: Clock;
  useSecureCookies: boolean;
  emailSender: EmailSender;
  backgroundTasks: BackgroundTasks;
  webAppUrl: string;
  google: { identityProvider: GoogleIdentityProvider; redirectUrl: string } | null;
}

export async function registerAuthModule(
  app: FastifyInstance,
  {
    database,
    clock,
    useSecureCookies,
    emailSender,
    backgroundTasks,
    webAppUrl,
    google,
  }: AuthModuleDependencies,
): Promise<RequireAuth> {
  await app.register(cookie);
  app.decorateRequest('authenticatedUser', null);

  const passwordHasher = createPasswordHasher();
  const attemptLimiter = createAttemptLimiter(createAttemptRepository(database), clock);
  const emailDependencies = {
    attemptLimiter,
    passwordHasher,
    emailSender,
    backgroundTasks,
    clock,
    webAppUrl,
  };

  const authService = createAuthService({
    repository: createAuthRepository(database),
    attemptLimiter,
    passwordHasher,
    clock,
    decoyPasswordHash: await passwordHasher.hash(generateSecretToken()),
  });
  const registrationService = createRegistrationService({
    ...emailDependencies,
    repository: createRegistrationRepository(database),
  });
  const passwordRecoveryService = createPasswordRecoveryService({
    ...emailDependencies,
    repository: createPasswordRecoveryRepository(database),
  });

  const sessionCookie = createSessionCookie(useSecureCookies, clock);
  const requireAuth = createRequireAuth(authService, sessionCookie);

  await app.register(authRoutes, {
    authService,
    registrationService,
    passwordRecoveryService,
    requireAuth,
    sessionCookie,
  });

  if (google) {
    await app.register(googleAuthRoutes, {
      authService,
      googleAuthService: createGoogleAuthService({
        repository: createGoogleAuthRepository(database),
        attemptLimiter,
        emailSender,
        backgroundTasks,
        clock,
        webAppUrl,
      }),
      identityProvider: google.identityProvider,
      flowCookie: createGoogleFlowCookie(useSecureCookies),
      sessionCookie,
      webAppUrl,
      redirectUrl: google.redirectUrl,
    });
  }

  return requireAuth;
}
