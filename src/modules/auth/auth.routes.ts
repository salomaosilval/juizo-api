import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/error-response.js';
import type { AuthService } from './auth.service.js';
import type { PasswordRecoveryService } from './password-recovery.service.js';
import type { RegistrationService } from './registration.service.js';
import { getAuthenticatedUser } from './require-auth.js';
import type { RequireAuth } from './require-auth.js';
import type { SessionCookie } from './session-cookie.js';

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;
const MAX_TOKEN_LENGTH = 128;
const CONTROL_CHARACTERS = /\p{Cc}/u;

const emailSchema = z.string().trim().toLowerCase().max(MAX_EMAIL_LENGTH).pipe(z.email());
const newPasswordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);
const tokenSchema = z.string().min(1).max(MAX_TOKEN_LENGTH);

const registrationCompletionBodySchema = z.object({
  token: tokenSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine((name) => !CONTROL_CHARACTERS.test(name)),
  password: newPasswordSchema,
  hasAcceptedTerms: z.literal(true),
  hasConsentedToAiDataProcessing: z.boolean(),
});

const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  rememberMe: z.boolean().default(false),
});

const userResponseSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.email() }),
});

const acceptedResponseSchema = z.object({ status: z.literal('accepted') });

interface AuthRoutesOptions {
  authService: AuthService;
  registrationService: RegistrationService;
  passwordRecoveryService: PasswordRecoveryService;
  requireAuth: RequireAuth;
  sessionCookie: SessionCookie;
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = (
  app,
  { authService, registrationService, passwordRecoveryService, requireAuth, sessionCookie },
) => {
  app.addHook('onSend', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
  });

  app.post(
    '/auth/register',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sends the registration link, answering the same for any email',
        body: z.object({ email: emailSchema }),
        response: {
          202: acceptedResponseSchema,
          400: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async ({ body: { email }, ip }, reply) => {
      await registrationService.start(email, ip);
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post(
    '/auth/register/token',
    {
      schema: {
        tags: ['auth'],
        summary: 'Returns the email of a valid registration link',
        body: z.object({ token: tokenSchema }),
        response: { 200: z.object({ email: z.email() }), 400: errorResponseSchema },
      },
    },
    async ({ body: { token } }) => ({ email: await registrationService.findEmailForToken(token) }),
  );

  app.post(
    '/auth/register/complete',
    {
      schema: {
        tags: ['auth'],
        summary: 'Creates the account from a valid link and starts a session',
        body: registrationCompletionBodySchema,
        response: { 201: userResponseSchema, 400: errorResponseSchema, 429: errorResponseSchema },
      },
    },
    async ({ body, ip }, reply) => {
      const user = await registrationService.complete({ ...body, clientIp: ip });
      const session = await authService.startSession(user.id);
      sessionCookie.write(reply, session.token, session.expiresAt);
      return reply.status(201).send({ user });
    },
  );

  app.post(
    '/auth/password-reset/request',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sends a password reset link, answering the same for any email',
        body: z.object({ email: emailSchema }),
        response: {
          202: acceptedResponseSchema,
          400: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async ({ body: { email }, ip }, reply) => {
      await passwordRecoveryService.requestReset(email, ip);
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post(
    '/auth/password-reset/confirm',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sets a new password and ends every session of the account',
        body: z.object({ token: tokenSchema, password: newPasswordSchema }),
        response: {
          200: z.object({ status: z.literal('password_updated') }),
          400: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async ({ body: { token, password }, ip }) => {
      await passwordRecoveryService.resetPassword(token, password, ip);
      return { status: 'password_updated' as const };
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Starts a session',
        body: loginBodySchema,
        response: {
          200: userResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async ({ body, ip }, reply) => {
      const { user, session } = await authService.login({ ...body, clientIp: ip });
      sessionCookie.write(reply, session.token, session.expiresAt);
      return { user };
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Ends the current session',
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const token = sessionCookie.read(request);
      if (token !== undefined) {
        await authService.logout(token);
      }
      sessionCookie.clear(reply);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Returns the authenticated user',
        response: { 200: userResponseSchema, 401: errorResponseSchema },
      },
    },
    (request) => ({ user: getAuthenticatedUser(request) }),
  );

  return Promise.resolve();
};
