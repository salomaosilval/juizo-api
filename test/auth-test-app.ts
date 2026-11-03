import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Env } from '../src/config/env.js';
import { createDatabaseClient } from '../src/shared/database/prisma-client.js';
import type { DatabaseClient } from '../src/shared/database/prisma-client.js';
import type { EmailMessage } from '../src/shared/email/email-sender.js';
import type { GoogleProfile } from '../src/modules/auth/google-identity-provider.js';
import { createBackgroundTasks } from '../src/shared/tasks/background-tasks.js';
import { buildTestEnv } from './env.fixture.js';

export const SESSION_COOKIE_NAME = 'juizo_session';
export const TEST_START_TIME = new Date('2026-11-01T12:00:00.000Z');
export const TEST_PASSWORD = 'correct horse battery';

export const TEST_EMAIL = 'rafael@example.com';

export const TEST_PROFILE = {
  name: 'Rafael',
  password: TEST_PASSWORD,
  hasAcceptedTerms: true,
  hasConsentedToAiDataProcessing: true,
};

export const DEFAULT_GOOGLE_PROFILE: GoogleProfile = {
  subject: 'google-subject',
  email: TEST_EMAIL,
  isEmailVerified: true,
  isGoogleAuthoritativeForEmail: true,
  name: 'Rafael do Google',
};

export interface AuthTestApp {
  app: FastifyInstance;
  database: DatabaseClient;
  sentEmails: EmailMessage[];
  backgroundFailures: object[];
  failEmails(shouldFail: boolean): void;
  drainBackgroundTasks(): Promise<void>;
  googleProfile: GoogleProfile;
  advanceTime(milliseconds: number): void;
  reset(): Promise<void>;
  post(url: string, payload?: object, options?: InjectOptions): Promise<LightMyRequestResponse>;
  login(overrides?: object, options?: InjectOptions): Promise<LightMyRequestResponse>;
  getMe(token: string): Promise<LightMyRequestResponse>;
  tokenFromLastEmail(): string;
  createVerifiedUser(overrides?: { email?: string; name?: string }): Promise<void>;
  sessionCookieOf(response: LightMyRequestResponse): { value: string; maxAge?: number };
  close(): Promise<void>;
}

export async function createAuthTestApp(
  databaseUrl: string,
  envOverrides: Partial<Env> = {},
): Promise<AuthTestApp> {
  const env = buildTestEnv({
    DATABASE_URL: databaseUrl,
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URL: 'https://api.juizo.test/auth/google/callback',
    ...envOverrides,
  });
  const database = createDatabaseClient(env.DATABASE_URL);
  const sentEmails: EmailMessage[] = [];
  const backgroundFailures: object[] = [];
  const backgroundTasks = createBackgroundTasks({
    error: (context) => backgroundFailures.push(context),
  });
  let currentTime = TEST_START_TIME;
  let shouldFailEmails = false;
  const googleProfileHolder = { profile: DEFAULT_GOOGLE_PROFILE };

  const app = await buildApp({
    env,
    database,
    clock: { now: () => currentTime },
    backgroundTasks,
    googleIdentityProvider: {
      createAuthorizationRequest: () =>
        Promise.resolve({
          url: 'https://accounts.google.test/authorize',
          checks: {
            state: 'expected-state',
            nonce: 'expected-nonce',
            codeVerifier: 'expected-verifier',
          },
        }),
      exchangeCode(callbackUrl, checks) {
        if (callbackUrl.searchParams.get('state') !== checks.state) {
          return Promise.reject(new Error('State mismatch.'));
        }
        return Promise.resolve(googleProfileHolder.profile);
      },
    },
    emailSender: {
      send(message) {
        if (shouldFailEmails) {
          return Promise.reject(new Error('The email provider is down.'));
        }
        sentEmails.push(message);
        return Promise.resolve();
      },
    },
  });

  async function post(url: string, payload?: object, options: InjectOptions = {}) {
    const response = await app.inject({
      method: 'POST',
      url,
      ...(payload ? { payload } : {}),
      ...options,
    });
    await backgroundTasks.drain();
    return response;
  }

  function tokenFromLastEmail(): string {
    const token = /#token=([\w-]+)/.exec(sentEmails.at(-1)?.text ?? '')?.[1];
    if (!token) {
      throw new Error('The last email has no token.');
    }
    return token;
  }

  return {
    app,
    database,
    sentEmails,
    backgroundFailures,
    post,
    tokenFromLastEmail,
    get googleProfile() {
      return googleProfileHolder.profile;
    },
    set googleProfile(profile) {
      googleProfileHolder.profile = profile;
    },
    drainBackgroundTasks: () => backgroundTasks.drain(),
    failEmails(shouldFail) {
      shouldFailEmails = shouldFail;
    },
    advanceTime(milliseconds) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
    async reset() {
      currentTime = TEST_START_TIME;
      shouldFailEmails = false;
      googleProfileHolder.profile = DEFAULT_GOOGLE_PROFILE;
      sentEmails.length = 0;
      backgroundFailures.length = 0;
      await database.$executeRaw`TRUNCATE users, attempt_counters, registration_tokens, google_signup_tokens CASCADE`;
    },
    login(overrides = {}, options = {}) {
      return post(
        '/auth/login',
        { email: TEST_EMAIL, password: TEST_PASSWORD, ...overrides },
        options,
      );
    },
    getMe(token) {
      return app.inject({ url: '/auth/me', cookies: { [SESSION_COOKIE_NAME]: token } });
    },
    async createVerifiedUser({ email = TEST_EMAIL, name = TEST_PROFILE.name } = {}) {
      await post('/auth/register', { email });
      await post('/auth/register/complete', {
        ...TEST_PROFILE,
        name,
        token: tokenFromLastEmail(),
      });
      await database.attemptCounter.deleteMany();
      await database.session.deleteMany({ where: { user: { email } } });
    },
    sessionCookieOf(response) {
      const cookie = response.cookies.find(({ name }) => name === SESSION_COOKIE_NAME);
      if (!cookie) {
        throw new Error('The response did not set the session cookie.');
      }
      return cookie;
    },
    close: () => app.close(),
  };
}
