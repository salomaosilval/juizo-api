import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/error-response.js';
import { displayNameSchema, tokenSchema, userResponseSchema } from './auth.schemas.js';
import type { AuthService } from './auth.service.js';
import type { GoogleAuthService } from './google-auth.service.js';
import type { GoogleFlowCookie } from './google-flow-cookie.js';
import type { GoogleIdentityProvider } from './google-identity-provider.js';
import type { SessionCookie } from './session-cookie.js';

interface GoogleAuthRoutesOptions {
  authService: AuthService;
  googleAuthService: GoogleAuthService;
  identityProvider: GoogleIdentityProvider;
  flowCookie: GoogleFlowCookie;
  sessionCookie: SessionCookie;
  webAppUrl: string;
  redirectUrl: string;
}

export const googleAuthRoutes: FastifyPluginAsyncZod<GoogleAuthRoutesOptions> = (
  app,
  {
    authService,
    googleAuthService,
    identityProvider,
    flowCookie,
    sessionCookie,
    webAppUrl,
    redirectUrl,
  },
) => {
  const failureUrl = new URL('/entrar?erro=google', webAppUrl).toString();

  app.addHook('onSend', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
  });

  app.get(
    '/auth/google/start',
    {
      schema: {
        tags: ['auth'],
        summary: 'Redirects to Google',
        querystring: z.object({ rememberMe: z.stringbool().default(false) }),
      },
    },
    async ({ query: { rememberMe }, log }, reply) => {
      try {
        const { url, checks } = await identityProvider.createAuthorizationRequest();
        flowCookie.write(reply, { ...checks, rememberMe });
        return await reply.redirect(url);
      } catch (error) {
        log.error({ err: error }, 'Could not start the Google sign-in');
        return await reply.redirect(failureUrl);
      }
    },
  );

  app.get(
    '/auth/google/callback',
    { schema: { tags: ['auth'], summary: 'Finishes the sign-in that Google redirected back' } },
    async (request, reply) => {
      const flow = flowCookie.read(request);
      flowCookie.clear(reply);
      if (!flow) {
        return reply.redirect(failureUrl);
      }

      const callbackUrl = new URL(redirectUrl);
      callbackUrl.search = new URL(request.url, redirectUrl).search;

      try {
        const profile = await identityProvider.exchangeCode(callbackUrl, flow);
        const result = await googleAuthService.signIn(profile);

        if (result.outcome === 'rejected') {
          return await reply.redirect(failureUrl);
        }
        if (result.outcome === 'signup_required') {
          return await reply.redirect(
            new URL(`/finalizar-cadastro-google#token=${result.token}`, webAppUrl).toString(),
          );
        }

        if (result.outcome === 'mailbox_confirmation_required') {
          return await reply.redirect(new URL('/cadastro/confira-seu-email', webAppUrl).toString());
        }
        if (result.outcome === 'password_required') {
          return await reply.redirect(
            new URL('/entrar?erro=google-use-senha', webAppUrl).toString(),
          );
        }

        const session = await authService.startGoogleSession(
          result.user.id,
          profile.subject,
          flow.rememberMe,
        );
        if (!session) {
          return await reply.redirect(failureUrl);
        }
        sessionCookie.write(reply, session.token, session.expiresAt);
        return await reply.redirect(new URL('/', webAppUrl).toString());
      } catch (error) {
        request.log.warn({ err: error }, 'Google sign-in failed');
        return await reply.redirect(failureUrl);
      }
    },
  );

  app.post(
    '/auth/google/signup/token',
    {
      schema: {
        tags: ['auth'],
        summary: 'Returns what Google shared for a valid signup link',
        body: z.object({ token: tokenSchema }),
        response: {
          200: z.object({ email: z.email(), name: z.string() }),
          400: errorResponseSchema,
        },
      },
    },
    ({ body: { token } }) => googleAuthService.findSignupDetails(token),
  );

  app.post(
    '/auth/google/signup/complete',
    {
      schema: {
        tags: ['auth'],
        summary: 'Creates the account after the terms are accepted and starts a session',
        body: z.object({
          token: tokenSchema,
          name: displayNameSchema,
          hasAcceptedTerms: z.literal(true),
          hasConsentedToAiDataProcessing: z.boolean(),
        }),
        response: { 201: userResponseSchema, 400: errorResponseSchema, 429: errorResponseSchema },
      },
    },
    async ({ body, ip }, reply) => {
      const user = await googleAuthService.completeSignup({ ...body, clientIp: ip });
      const session = await authService.startSession(user.id, false);
      sessionCookie.write(reply, session.token, session.expiresAt);
      return reply.status(201).send({ user });
    },
  );

  return Promise.resolve();
};
