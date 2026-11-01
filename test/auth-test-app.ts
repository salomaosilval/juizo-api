import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Env } from '../src/config/env.js';
import { createDatabaseClient } from '../src/shared/database/prisma-client.js';
import type { DatabaseClient } from '../src/shared/database/prisma-client.js';
import type { EmailMessage } from '../src/shared/email/email-sender.js';
import { createBackgroundTasks } from '../src/shared/tasks/background-tasks.js';
import { buildTestEnv } from './env.fixture.js';

export const SESSION_COOKIE_NAME = 'juizo_session';
export const TEST_START_TIME = new Date('2026-11-01T12:00:00.000Z');
export const TEST_PASSWORD = 'correct horse battery';

export const TEST_REGISTRATION = {
  name: 'Rafael',
  email: 'rafael@example.com',
  password: TEST_PASSWORD,
  hasAcceptedTerms: true,
  hasConsentedToAiDataProcessing: true,
};

export interface AuthTestApp {
  app: FastifyInstance;
  database: DatabaseClient;
  sentEmails: EmailMessage[];
  backgroundFailures: object[];
  failEmails(shouldFail: boolean): void;
  advanceTime(milliseconds: number): void;
  reset(): Promise<void>;
  post(url: string, payload?: object, options?: InjectOptions): Promise<LightMyRequestResponse>;
  login(overrides?: object, options?: InjectOptions): Promise<LightMyRequestResponse>;
  getMe(token: string): Promise<LightMyRequestResponse>;
  tokenFromLastEmail(): string;
  createVerifiedUser(overrides?: object): Promise<void>;
  sessionCookieOf(response: LightMyRequestResponse): { value: string; maxAge?: number };
  close(): Promise<void>;
}

export async function createAuthTestApp(
  databaseUrl: string,
  envOverrides: Partial<Env> = {},
): Promise<AuthTestApp> {
  const env = buildTestEnv({ DATABASE_URL: databaseUrl, ...envOverrides });
  const database = createDatabaseClient(env.DATABASE_URL);
  const sentEmails: EmailMessage[] = [];
  const backgroundFailures: object[] = [];
  const backgroundTasks = createBackgroundTasks({
    error: (context) => backgroundFailures.push(context),
  });
  let currentTime = TEST_START_TIME;
  let shouldFailEmails = false;

  const app = await buildApp({
    env,
    database,
    clock: { now: () => currentTime },
    backgroundTasks,
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
    failEmails(shouldFail) {
      shouldFailEmails = shouldFail;
    },
    advanceTime(milliseconds) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
    async reset() {
      currentTime = TEST_START_TIME;
      shouldFailEmails = false;
      sentEmails.length = 0;
      backgroundFailures.length = 0;
      await database.$executeRaw`TRUNCATE users, attempt_counters, pending_registrations CASCADE`;
    },
    login(overrides = {}, options = {}) {
      return post(
        '/auth/login',
        { email: TEST_REGISTRATION.email, password: TEST_PASSWORD, ...overrides },
        options,
      );
    },
    getMe(token) {
      return app.inject({ url: '/auth/me', cookies: { [SESSION_COOKIE_NAME]: token } });
    },
    async createVerifiedUser(overrides = {}) {
      await post('/auth/register', { ...TEST_REGISTRATION, ...overrides });
      await post('/auth/email-verification/confirm', { token: tokenFromLastEmail() });
      await database.attemptCounter.deleteMany();
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
