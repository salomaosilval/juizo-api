import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/error-response.js';
import type { AuthService } from './auth.service.js';
import { getAuthenticatedUser } from './require-auth.js';
import type { RequireAuth } from './require-auth.js';
import type { SessionCookie } from './session-cookie.js';

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;
const CONTROL_CHARACTERS = /\p{Cc}/u;

const emailSchema = z.string().trim().toLowerCase().max(MAX_EMAIL_LENGTH).pipe(z.email());

const registrationBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine((name) => !CONTROL_CHARACTERS.test(name)),
  email: emailSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
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

interface AuthRoutesOptions {
  authService: AuthService;
  requireAuth: RequireAuth;
  sessionCookie: SessionCookie;
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = (
  app,
  { authService, requireAuth, sessionCookie },
) => {
  app.addHook('onSend', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
  });

  app.post(
    '/auth/register',
    {
      schema: {
        tags: ['auth'],
        summary: 'Registers an account, answering the same whether or not the email is in use',
        body: registrationBodySchema,
        response: {
          202: z.object({ status: z.literal('accepted') }),
          400: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async ({ body, ip }, reply) => {
      await authService.register({ ...body, clientIp: ip });
      return reply.status(202).send({ status: 'accepted' });
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
