import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { buildTestEnv } from '../../../test/env.fixture.js';
import { buildApp } from '../../app.js';
import { createDatabaseClient } from '../../shared/database/prisma-client.js';
import { createAuthRepository } from './auth.repository.js';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';

const COOKIE_NAME = 'juizo_session';
const PASSWORD = 'correct horse battery';
const START = new Date('2026-11-01T12:00:00.000Z');
const HOUR_IN_MS = 3_600_000;
const DAY_IN_MS = 24 * HOUR_IN_MS;

const registration = {
  name: 'Rafael',
  email: 'rafael@example.com',
  password: PASSWORD,
  hasAcceptedTerms: true,
  hasConsentedToAiDataProcessing: true,
};

describe('auth', () => {
  let app: FastifyInstance;
  let database: DatabaseClient;
  let currentTime: Date;

  function advanceTime(milliseconds: number): void {
    currentTime = new Date(currentTime.getTime() + milliseconds);
  }

  function post(url: string, payload?: object, options: Partial<InjectOptions> = {}) {
    return app.inject({
      method: 'POST',
      url,
      ...(payload ? { payload } : {}),
      ...options,
    });
  }

  async function login(overrides: object = {}) {
    return post('/auth/login', { email: registration.email, password: PASSWORD, ...overrides });
  }

  function sessionCookieOf(response: Awaited<ReturnType<typeof login>>) {
    const cookie = response.cookies.find(({ name }) => name === COOKIE_NAME);
    if (!cookie) {
      throw new Error('The response did not set the session cookie.');
    }
    return cookie;
  }

  function getMe(token: string) {
    return app.inject({ url: '/auth/me', cookies: { [COOKIE_NAME]: token } });
  }

  beforeAll(async () => {
    const env = buildTestEnv({ DATABASE_URL: inject('databaseUrl') });
    database = createDatabaseClient(env.DATABASE_URL);
    app = await buildApp({ env, database, clock: { now: () => currentTime } });
  });

  beforeEach(async () => {
    currentTime = START;
    await database.$executeRaw`TRUNCATE users, attempt_counters CASCADE`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/register', () => {
    it('creates the user with a hashed password and normalized email', async () => {
      const response = await post('/auth/register', {
        ...registration,
        email: '  Rafael@Example.COM ',
      });

      expect(response.statusCode).toBe(202);
      const user = await database.user.findUniqueOrThrow({
        where: { email: 'rafael@example.com' },
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);
    });

    it('does not sign the user in', async () => {
      const response = await post('/auth/register', registration);

      expect(response.cookies).toHaveLength(0);
    });

    it('records terms, privacy and AI consents with version and date', async () => {
      await post('/auth/register', registration);

      const consents = await database.consent.findMany({ orderBy: { type: 'asc' } });
      expect(consents.map(({ type }) => type)).toEqual([
        'TERMS_OF_USE',
        'PRIVACY_POLICY',
        'AI_DATA_PROCESSING',
      ]);
      expect(consents[0]).toMatchObject({ version: '1', grantedAt: START });
    });

    it('does not record AI consent when the user declines it', async () => {
      await post('/auth/register', { ...registration, hasConsentedToAiDataProcessing: false });

      const consents = await database.consent.findMany();
      expect(consents.map(({ type }) => type)).not.toContain('AI_DATA_PROCESSING');
    });

    it('rejects a registration that did not accept the terms', async () => {
      const response = await post('/auth/register', { ...registration, hasAcceptedTerms: false });

      expect(response.statusCode).toBe(400);
      expect(await database.user.count()).toBe(0);
    });

    it.each([
      ['a short password', { password: 'too-short' }],
      ['an oversized password', { password: 'x'.repeat(129) }],
      ['an invalid email', { email: 'not-an-email' }],
      ['a blank name', { name: '   ' }],
    ])('rejects %s', async (_description, override) => {
      const response = await post('/auth/register', { ...registration, ...override });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('never echoes the password in a validation error', async () => {
      const response = await post('/auth/register', { ...registration, password: 'tiny-pw' });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('tiny-pw');
    });

    it('rejects control characters in the name', async () => {
      const response = await post('/auth/register', { ...registration, name: 'Ra\u0000fael' });

      expect(response.statusCode).toBe(400);
      expect(await database.user.count()).toBe(0);
    });

    it('answers identically for an email already in use and keeps the original account', async () => {
      const first = await post('/auth/register', registration);
      const second = await post('/auth/register', {
        ...registration,
        name: 'Attacker',
        password: 'attacker-password',
      });

      expect(second.statusCode).toBe(first.statusCode);
      expect(second.body).toBe(first.body);
      expect((await login()).statusCode).toBe(200);
      expect((await login({ password: 'attacker-password' })).statusCode).toBe(401);
      await expect(database.user.count()).resolves.toBe(1);
    });

    it('creates one account when the same email registers concurrently', async () => {
      const responses = await Promise.all([
        post('/auth/register', registration),
        post('/auth/register', registration),
        post('/auth/register', registration),
      ]);

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([202, 202, 202]);
      await expect(database.user.count()).resolves.toBe(1);
    });

    it('limits registrations per IP', async () => {
      const attempts = Array.from({ length: 10 }, (_, index) =>
        post('/auth/register', { ...registration, email: `user${index}@example.com` }),
      );
      await Promise.all(attempts);

      const response = await post('/auth/register', {
        ...registration,
        email: 'one-more@example.com',
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await post('/auth/register', registration);
    });

    it('returns the user without any sensitive field', async () => {
      const response = await login();

      expect(response.statusCode).toBe(200);
      const user = await database.user.findUniqueOrThrow({
        where: { email: registration.email },
      });
      expect(response.json()).toEqual({
        user: { id: user.id, name: 'Rafael', email: 'rafael@example.com' },
      });
    });

    it('accepts the email regardless of its case', async () => {
      const response = await login({ email: 'RAFAEL@example.com' });

      expect(response.statusCode).toBe(200);
    });

    it('sets a cookie scripts cannot read', async () => {
      const cookie = sessionCookieOf(await login());

      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    });

    it('stores only the hash of the session token', async () => {
      const { value: token } = sessionCookieOf(await login());

      const session = await database.session.findFirstOrThrow();
      expect(session.tokenHash).not.toBe(token);
      expect(session.tokenHash).not.toContain(token);
    });

    it('issues a different token on every login', async () => {
      const first = sessionCookieOf(await login());
      const second = sessionCookieOf(await login());

      expect(first.value).not.toBe(second.value);
    });

    it('answers identically for a wrong password and an unknown email', async () => {
      const wrongPassword = await login({ password: 'wrong-password' });
      const unknownEmail = await login({ email: 'nobody@example.com' });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(unknownEmail.json()).toEqual(wrongPassword.json());
      expect(wrongPassword.cookies).toHaveLength(0);
      expect(unknownEmail.cookies).toHaveLength(0);
    });

    it('blocks further attempts on an email, even with the right password', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await login({ password: 'wrong-password' });
      }

      const response = await login();

      expect(response.statusCode).toBe(429);
      expect(response.cookies).toHaveLength(0);
    });

    it('throttles unknown emails the same way, so the limit reveals nothing', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await login({ email: 'nobody@example.com' });
      }

      const response = await login({ email: 'nobody@example.com' });

      expect(response.statusCode).toBe(429);
    });

    it('allows attempts again after the window passes', async () => {
      for (let attempt = 0; attempt < 11; attempt += 1) {
        await login({ password: 'wrong-password' });
      }

      advanceTime(15 * 60_000 + 1);

      expect((await login()).statusCode).toBe(200);
    });

    it('resets the email counter after a successful login', async () => {
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await login({ password: 'wrong-password' });
      }
      await login();

      for (let attempt = 0; attempt < 9; attempt += 1) {
        await login({ password: 'wrong-password' });
      }

      expect((await login()).statusCode).toBe(200);
    });

    it('limits attempts per IP across different emails', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await login({ email: `user${attempt}@example.com` });
      }

      const response = await login();

      expect(response.statusCode).toBe(429);
    });

    it('ignores a forged X-Forwarded-For when no proxy is trusted', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await post(
          '/auth/login',
          { email: `user${attempt}@example.com`, password: PASSWORD },
          { headers: { 'x-forwarded-for': `198.51.100.${attempt}` } },
        );
      }

      const response = await post(
        '/auth/login',
        { email: registration.email, password: PASSWORD },
        { headers: { 'x-forwarded-for': '198.51.100.200' } },
      );

      expect(response.statusCode).toBe(429);
    });

    it('does not count successful logins against the IP', async () => {
      for (let attempt = 0; attempt < 31; attempt += 1) {
        expect((await login()).statusCode).toBe(200);
      }
    });

    it('does not let an already blocked IP lock out an account', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await login({ email: `user${attempt}@example.com` });
      }
      for (let attempt = 0; attempt < 11; attempt += 1) {
        await login({ password: 'wrong-password' });
      }

      const victim = await post(
        '/auth/login',
        { email: registration.email, password: PASSWORD },
        { remoteAddress: '203.0.113.9' },
      );

      expect(victim.statusCode).toBe(200);
    });

    it('limits an IPv6 client by its /64, so rotating addresses does not help', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await post(
          '/auth/login',
          { email: `user${attempt}@example.com`, password: PASSWORD },
          { remoteAddress: `2001:db8:1:2::${attempt + 1}` },
        );
      }

      const response = await post(
        '/auth/login',
        { email: registration.email, password: PASSWORD },
        { remoteAddress: '2001:db8:1:2::ffff' },
      );

      expect(response.statusCode).toBe(429);
    });

    it('does not let one IP exhaust the limit of another', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await login({ email: `user${attempt}@example.com` });
      }

      const response = await post(
        '/auth/login',
        { email: registration.email, password: PASSWORD },
        { remoteAddress: '203.0.113.9' },
      );

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /auth/me', () => {
    beforeEach(async () => {
      await post('/auth/register', registration);
    });

    it('returns the user that owns the session', async () => {
      const { value: token } = sessionCookieOf(await login());

      const response = await getMe(token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ user: { email: registration.email } });
    });

    it('never mixes users across sessions', async () => {
      await post('/auth/register', { ...registration, name: 'Ana', email: 'ana@example.com' });
      const rafael = sessionCookieOf(await login());
      const ana = sessionCookieOf(await login({ email: 'ana@example.com' }));

      const rafaelResponse = await getMe(rafael.value);
      const anaResponse = await getMe(ana.value);

      expect(rafaelResponse.json()).toMatchObject({ user: { name: 'Rafael' } });
      expect(anaResponse.json()).toMatchObject({ user: { name: 'Ana' } });
    });

    it('is not cacheable', async () => {
      const { value: token } = sessionCookieOf(await login());

      const response = await getMe(token);

      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('rejects a request without a session', async () => {
      const response = await app.inject({ url: '/auth/me' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('rejects and clears an unknown token', async () => {
      const response = await getMe('forged-token');

      expect(response.statusCode).toBe(401);
      expect(sessionCookieOf(response).value).toBe('');
    });

    it('rejects the stored hash used as a token', async () => {
      await login();
      const { tokenHash } = await database.session.findFirstOrThrow();

      const response = await getMe(tokenHash);

      expect(response.statusCode).toBe(401);
    });

    it('expires a temporary session after 24 hours and removes it', async () => {
      const { value: token } = sessionCookieOf(await login());

      advanceTime(DAY_IN_MS - 1);
      expect((await getMe(token)).statusCode).toBe(200);

      advanceTime(1);
      expect((await getMe(token)).statusCode).toBe(401);
      await expect(database.session.count()).resolves.toBe(0);
    });

    it('does not extend a temporary session with use', async () => {
      const { value: token } = sessionCookieOf(await login());

      advanceTime(23 * HOUR_IN_MS);
      await getMe(token);
      advanceTime(2 * HOUR_IN_MS);

      expect((await getMe(token)).statusCode).toBe(401);
    });

    it('keeps a remembered session alive for 30 days from its last use', async () => {
      const loginResponse = await login({ rememberMe: true });
      const cookie = sessionCookieOf(loginResponse);
      expect(cookie.maxAge).toBe(30 * 86_400);

      advanceTime(20 * DAY_IN_MS);
      const renewed = await getMe(cookie.value);
      expect(renewed.statusCode).toBe(200);
      expect(sessionCookieOf(renewed).maxAge).toBe(30 * 86_400);

      advanceTime(20 * DAY_IN_MS);
      expect((await getMe(cookie.value)).statusCode).toBe(200);
    });

    it('ignores a renewal for a session that was already removed', async () => {
      const missingSessionId = '01a194f0-3145-7052-a3a9-e07aa766da1d';

      await expect(
        createAuthRepository(database).renewSession(missingSessionId, START),
      ).resolves.toBeUndefined();
    });

    it('expires a remembered session after 30 days without use', async () => {
      const { value: token } = sessionCookieOf(await login({ rememberMe: true }));

      advanceTime(30 * DAY_IN_MS);

      expect((await getMe(token)).statusCode).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    beforeEach(async () => {
      await post('/auth/register', registration);
    });

    it('revokes the session on the server and clears the cookie', async () => {
      const { value: token } = sessionCookieOf(await login());

      const response = await post('/auth/logout', undefined, {
        cookies: { [COOKIE_NAME]: token },
      });

      expect(response.statusCode).toBe(204);
      expect(sessionCookieOf(response).value).toBe('');
      expect((await getMe(token)).statusCode).toBe(401);
    });

    it('keeps other sessions of the same user active', async () => {
      const { value: firstToken } = sessionCookieOf(await login());
      const { value: secondToken } = sessionCookieOf(await login());

      await post('/auth/logout', undefined, { cookies: { [COOKIE_NAME]: firstToken } });

      expect((await getMe(secondToken)).statusCode).toBe(200);
    });

    it('succeeds without a session', async () => {
      const response = await post('/auth/logout');

      expect(response.statusCode).toBe(204);
    });
  });

  describe('cross-site requests', () => {
    it('rejects a write from an origin that is not allowed', async () => {
      const response = await post('/auth/register', registration, {
        headers: { origin: 'https://evil.example' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN_ORIGIN' });
      await expect(database.user.count()).resolves.toBe(0);
    });

    it.each(['/auth/login', '/auth/logout'])('protects %s as well', async (url) => {
      const response = await post(url, undefined, { headers: { origin: 'null' } });

      expect(response.statusCode).toBe(403);
    });

    it('accepts a write without an Origin header, which browsers always send', async () => {
      const response = await post('/auth/register', registration);

      expect(response.statusCode).toBe(202);
    });

    it('accepts a write from an allowed origin', async () => {
      const response = await post('/auth/register', registration, {
        headers: { origin: 'http://localhost:5173' },
      });

      expect(response.statusCode).toBe(202);
    });
  });

  describe('behind one trusted proxy', () => {
    let proxiedApp: FastifyInstance;

    beforeAll(async () => {
      const env = buildTestEnv({ DATABASE_URL: inject('databaseUrl'), TRUSTED_PROXY_HOPS: 1 });
      proxiedApp = await buildApp({
        env,
        database: createDatabaseClient(env.DATABASE_URL),
        clock: { now: () => currentTime },
      });
    });

    afterAll(async () => {
      await proxiedApp.close();
    });

    function loginThroughProxy(forwardedFor: string, email: string) {
      return proxiedApp.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': forwardedFor },
        payload: { email, password: PASSWORD },
      });
    }

    it('limits by the address the proxy saw, not one the client forged', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await loginThroughProxy(`198.51.100.${attempt}, 203.0.113.7`, `user${attempt}@example.com`);
      }

      const sameClient = await loginThroughProxy('198.51.100.200, 203.0.113.7', 'a@example.com');
      const otherClient = await loginThroughProxy('203.0.113.8', 'b@example.com');

      expect(sameClient.statusCode).toBe(429);
      expect(otherClient.statusCode).toBe(401);
    });
  });

  describe('in production', () => {
    let productionApp: FastifyInstance;

    beforeAll(async () => {
      const env = buildTestEnv({ DATABASE_URL: inject('databaseUrl'), NODE_ENV: 'production' });
      productionApp = await buildApp({
        env,
        database: createDatabaseClient(env.DATABASE_URL),
        clock: { now: () => currentTime },
      });
    });

    afterAll(async () => {
      await productionApp.close();
    });

    it('uses a host-only secure cookie', async () => {
      await post('/auth/register', registration);

      const response = await productionApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: registration.email, password: PASSWORD },
      });

      expect(response.cookies[0]).toMatchObject({
        name: '__Host-juizo_session',
        secure: true,
        httpOnly: true,
        path: '/',
      });
      expect(response.cookies[0]).not.toHaveProperty('domain');
    });
  });
});
