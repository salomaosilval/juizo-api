import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createAuthTestApp,
  SESSION_COOKIE_NAME,
  TEST_PASSWORD,
  TEST_EMAIL,
  TEST_START_TIME,
} from '../../../test/auth-test-app.js';
import type { AuthTestApp } from '../../../test/auth-test-app.js';
import { emailAttemptKey } from './attempt-limiter.js';
import { createAuthRepository } from './auth.repository.js';

const HOUR_IN_MS = 3_600_000;
const DAY_IN_MS = 24 * HOUR_IN_MS;
const LOGOUT = '/auth/logout';

describe('sessions', () => {
  let test: AuthTestApp;

  async function failLogins(count: number, overrides: object = {}, options: object = {}) {
    for (let attempt = 0; attempt < count; attempt += 1) {
      await test.login({ password: 'wrong-password', ...overrides }, options);
    }
  }

  async function failLoginsOnDifferentEmails(count: number) {
    for (let attempt = 0; attempt < count; attempt += 1) {
      await test.login({ email: `user${attempt}@example.com` });
    }
  }

  beforeAll(async () => {
    test = await createAuthTestApp(inject('databaseUrl'));
  });

  beforeEach(async () => {
    await test.reset();
    await test.createVerifiedUser();
  });

  afterAll(async () => {
    await test.close();
  });

  describe('POST /auth/login', () => {
    it('returns the user without any sensitive field', async () => {
      const response = await test.login();

      expect(response.statusCode).toBe(200);
      const user = await test.database.user.findUniqueOrThrow({
        where: { email: TEST_EMAIL },
      });
      expect(response.json()).toEqual({
        user: { id: user.id, name: 'Rafael', email: 'rafael@example.com' },
      });
    });

    it('accepts the email regardless of its case', async () => {
      const response = await test.login({ email: 'RAFAEL@example.com' });

      expect(response.statusCode).toBe(200);
    });

    it('sets a cookie scripts cannot read', async () => {
      const cookie = test.sessionCookieOf(await test.login());

      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    });

    it('stores only the hash of the session token', async () => {
      const { value: token } = test.sessionCookieOf(await test.login());

      const session = await test.database.session.findFirstOrThrow();
      expect(session.tokenHash).not.toBe(token);
      expect(session.tokenHash).not.toContain(token);
    });

    it('issues a different token on every login', async () => {
      const first = test.sessionCookieOf(await test.login());
      const second = test.sessionCookieOf(await test.login());

      expect(first.value).not.toBe(second.value);
    });

    it('answers identically for a wrong password and an unknown email', async () => {
      const wrongPassword = await test.login({ password: 'wrong-password' });
      const unknownEmail = await test.login({ email: 'nobody@example.com' });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(unknownEmail.json()).toEqual(wrongPassword.json());
      expect(wrongPassword.cookies).toHaveLength(0);
      expect(unknownEmail.cookies).toHaveLength(0);
    });

    it('blocks further attempts on an email, even with the right password', async () => {
      await failLogins(10);

      const response = await test.login();

      expect(response.statusCode).toBe(429);
      expect(response.cookies).toHaveLength(0);
    });

    it('throttles unknown emails the same way, so the limit reveals nothing', async () => {
      await failLogins(10, { email: 'nobody@example.com' });

      const response = await test.login({ email: 'nobody@example.com' });

      expect(response.statusCode).toBe(429);
    });

    it('allows attempts again after the window passes', async () => {
      await failLogins(11);

      test.advanceTime(15 * 60_000 + 1);

      expect((await test.login()).statusCode).toBe(200);
    });

    it('resets the email counter after a successful login', async () => {
      await failLogins(9);
      await test.login();
      await failLogins(9);

      expect((await test.login()).statusCode).toBe(200);
    });

    it('limits attempts per IP across different emails', async () => {
      await failLoginsOnDifferentEmails(30);

      const response = await test.login();

      expect(response.statusCode).toBe(429);
    });

    it('ignores a forged X-Forwarded-For when no proxy is trusted', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await test.login(
          { email: `user${attempt}@example.com` },
          { headers: { 'x-forwarded-for': `198.51.100.${attempt}` } },
        );
      }

      const response = await test.login({}, { headers: { 'x-forwarded-for': '198.51.100.200' } });

      expect(response.statusCode).toBe(429);
    });

    it('does not count successful logins against the IP', async () => {
      for (let attempt = 0; attempt < 31; attempt += 1) {
        expect((await test.login()).statusCode).toBe(200);
      }
    });

    it('does not let one client lock out the owner on another network', async () => {
      await failLogins(11);

      expect((await test.login()).statusCode).toBe(429);
      expect((await test.login({}, { remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    });

    it('caps distributed guessing on one email, whatever the network', async () => {
      await test.database.attemptCounter.create({
        data: {
          key: emailAttemptKey('login', TEST_EMAIL),
          attemptCount: 100,
          windowStartedAt: TEST_START_TIME,
        },
      });

      const response = await test.login({}, { remoteAddress: '203.0.113.9' });

      expect(response.statusCode).toBe(429);
      expect(response.cookies).toHaveLength(0);
    });

    it('does not let an already blocked IP lock out an account', async () => {
      await failLoginsOnDifferentEmails(30);
      await failLogins(11);

      const victim = await test.login({}, { remoteAddress: '203.0.113.9' });

      expect(victim.statusCode).toBe(200);
    });

    it('limits an IPv6 client by its /64, so rotating addresses does not help', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await test.login(
          { email: `user${attempt}@example.com` },
          { remoteAddress: `2001:db8:1:2::${attempt + 1}` },
        );
      }

      const response = await test.login({}, { remoteAddress: '2001:db8:1:2::ffff' });

      expect(response.statusCode).toBe(429);
    });

    it('does not let one IP exhaust the limit of another', async () => {
      await failLoginsOnDifferentEmails(30);

      const response = await test.login({}, { remoteAddress: '203.0.113.9' });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the user that owns the session', async () => {
      const { value: token } = test.sessionCookieOf(await test.login());

      const response = await test.getMe(token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ user: { email: TEST_EMAIL } });
    });

    it('never mixes users across sessions', async () => {
      await test.createVerifiedUser({ name: 'Ana', email: 'ana@example.com' });
      const rafael = test.sessionCookieOf(await test.login());
      const ana = test.sessionCookieOf(await test.login({ email: 'ana@example.com' }));

      expect((await test.getMe(rafael.value)).json()).toMatchObject({ user: { name: 'Rafael' } });
      expect((await test.getMe(ana.value)).json()).toMatchObject({ user: { name: 'Ana' } });
    });

    it('is not cacheable', async () => {
      const { value: token } = test.sessionCookieOf(await test.login());

      const response = await test.getMe(token);

      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('rejects a request without a session', async () => {
      const response = await test.app.inject({ url: '/auth/me' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('rejects and clears an unknown token', async () => {
      const response = await test.getMe('forged-token');

      expect(response.statusCode).toBe(401);
      expect(test.sessionCookieOf(response).value).toBe('');
    });

    it('rejects the stored hash used as a token', async () => {
      await test.login();
      const { tokenHash } = await test.database.session.findFirstOrThrow();

      const response = await test.getMe(tokenHash);

      expect(response.statusCode).toBe(401);
    });

    it('expires a temporary session after 24 hours and removes it', async () => {
      const { value: token } = test.sessionCookieOf(await test.login());

      test.advanceTime(DAY_IN_MS - 1);
      expect((await test.getMe(token)).statusCode).toBe(200);

      test.advanceTime(1);
      expect((await test.getMe(token)).statusCode).toBe(401);
      await expect(test.database.session.count()).resolves.toBe(0);
    });

    it('does not extend a temporary session with use', async () => {
      const { value: token } = test.sessionCookieOf(await test.login());

      test.advanceTime(23 * HOUR_IN_MS);
      await test.getMe(token);
      test.advanceTime(2 * HOUR_IN_MS);

      expect((await test.getMe(token)).statusCode).toBe(401);
    });

    it('keeps a remembered session alive for 30 days from its last use', async () => {
      const cookie = test.sessionCookieOf(await test.login({ rememberMe: true }));
      expect(cookie.maxAge).toBe(30 * 86_400);

      test.advanceTime(20 * DAY_IN_MS);
      const renewed = await test.getMe(cookie.value);
      expect(renewed.statusCode).toBe(200);
      expect(test.sessionCookieOf(renewed).maxAge).toBe(30 * 86_400);

      test.advanceTime(20 * DAY_IN_MS);
      expect((await test.getMe(cookie.value)).statusCode).toBe(200);
    });

    it('ignores a renewal for a session that was already removed', async () => {
      const missingSessionId = '01a194f0-3145-7052-a3a9-e07aa766da1d';

      await expect(
        createAuthRepository(test.database).renewSession(missingSessionId, TEST_START_TIME),
      ).resolves.toBeUndefined();
    });

    it('expires a remembered session after 30 days without use', async () => {
      const { value: token } = test.sessionCookieOf(await test.login({ rememberMe: true }));

      test.advanceTime(30 * DAY_IN_MS);

      expect((await test.getMe(token)).statusCode).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session on the server and clears the cookie', async () => {
      const { value: token } = test.sessionCookieOf(await test.login());

      const response = await test.post(LOGOUT, undefined, {
        cookies: { [SESSION_COOKIE_NAME]: token },
      });

      expect(response.statusCode).toBe(204);
      expect(test.sessionCookieOf(response).value).toBe('');
      expect((await test.getMe(token)).statusCode).toBe(401);
    });

    it('keeps other sessions of the same user active', async () => {
      const { value: firstToken } = test.sessionCookieOf(await test.login());
      const { value: secondToken } = test.sessionCookieOf(await test.login());

      await test.post(LOGOUT, undefined, { cookies: { [SESSION_COOKIE_NAME]: firstToken } });

      expect((await test.getMe(secondToken)).statusCode).toBe(200);
    });

    it('succeeds without a session', async () => {
      const response = await test.post(LOGOUT);

      expect(response.statusCode).toBe(204);
    });
  });

  describe('cross-site requests', () => {
    it('rejects a write from an origin that is not allowed', async () => {
      const response = await test.post(
        '/auth/register',
        { email: 'new@example.com' },
        { headers: { origin: 'https://evil.example' } },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN_ORIGIN' });
      await expect(test.database.registrationToken.count()).resolves.toBe(0);
    });

    it.each([
      '/auth/login',
      '/auth/logout',
      '/auth/register/token',
      '/auth/register/complete',
      '/auth/password-reset/request',
      '/auth/password-reset/confirm',
    ])('protects %s as well', async (url) => {
      const response = await test.post(url, undefined, { headers: { origin: 'null' } });

      expect(response.statusCode).toBe(403);
    });

    it('accepts a write without an Origin header, which browsers always send', async () => {
      const response = await test.login();

      expect(response.statusCode).toBe(200);
    });

    it('accepts a write from an allowed origin', async () => {
      const response = await test.login({}, { headers: { origin: 'http://localhost:5173' } });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('behind one trusted proxy', () => {
    let proxied: AuthTestApp;

    beforeAll(async () => {
      proxied = await createAuthTestApp(inject('databaseUrl'), { TRUSTED_PROXY_HOPS: 1 });
    });

    afterAll(async () => {
      await proxied.close();
    });

    it('limits by the address the proxy saw, not one the client forged', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await proxied.login(
          { email: `user${attempt}@example.com` },
          { headers: { 'x-forwarded-for': `198.51.100.${attempt}, 203.0.113.7` } },
        );
      }

      const sameClient = await proxied.login(
        { email: 'a@example.com' },
        { headers: { 'x-forwarded-for': '198.51.100.200, 203.0.113.7' } },
      );
      const otherClient = await proxied.login(
        { email: 'b@example.com' },
        { headers: { 'x-forwarded-for': '203.0.113.8' } },
      );

      expect(sameClient.statusCode).toBe(429);
      expect(otherClient.statusCode).toBe(401);
    });
  });

  describe('in production', () => {
    let production: AuthTestApp;

    beforeAll(async () => {
      production = await createAuthTestApp(inject('databaseUrl'), {
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test',
      });
    });

    afterAll(async () => {
      await production.close();
    });

    it('uses a host-only secure cookie', async () => {
      const response = await production.login({ password: TEST_PASSWORD });

      expect(response.statusCode).toBe(200);
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
