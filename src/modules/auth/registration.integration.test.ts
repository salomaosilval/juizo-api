import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createAuthTestApp,
  SESSION_COOKIE_NAME,
  TEST_EMAIL,
  TEST_PASSWORD,
  TEST_PROFILE,
  TEST_START_TIME,
} from '../../../test/auth-test-app.js';
import type { AuthTestApp } from '../../../test/auth-test-app.js';

const HOUR_IN_MS = 3_600_000;
const REGISTER = '/auth/register';
const TOKEN = '/auth/register/token';
const COMPLETE = '/auth/register/complete';

describe('registration', () => {
  let test: AuthTestApp;

  async function requestLink(email = TEST_EMAIL): Promise<string> {
    await test.post(REGISTER, { email });
    return test.tokenFromLastEmail();
  }

  function complete(token: string, overrides: object = {}, options: object = {}) {
    return test.post(COMPLETE, { ...TEST_PROFILE, token, ...overrides }, options);
  }

  beforeAll(async () => {
    test = await createAuthTestApp(inject('databaseUrl'));
  });

  beforeEach(async () => {
    await test.reset();
  });

  afterAll(async () => {
    await test.close();
  });

  describe('POST /auth/register', () => {
    it('creates no account and no session, only sends a link', async () => {
      const response = await test.post(REGISTER, { email: '  Rafael@Example.COM ' });

      expect(response.statusCode).toBe(202);
      expect(response.cookies).toHaveLength(0);
      await expect(test.database.user.count()).resolves.toBe(0);
      const [email] = test.sentEmails;
      expect(email?.to).toBe('rafael@example.com');
      expect(email?.subject).toBe('Confirme seu e-mail para criar sua conta no Juízo');
    });

    it('keeps the token out of reach of servers and referrers', async () => {
      const token = await requestLink();

      const [email] = test.sentEmails;
      expect(email?.text).toContain(`https://app.juizo.test/finalizar-cadastro#token=${token}`);
      expect(email?.html).toContain(`#token=${token}`);
    });

    it('stores only the hash of the token', async () => {
      const token = await requestLink();

      const stored = await test.database.registrationToken.findFirstOrThrow();
      expect(stored.tokenHash).not.toBe(token);
    });

    it('accepts nothing but the email, so a stranger can leave no password or consent', async () => {
      await test.post(REGISTER, { email: TEST_EMAIL, ...TEST_PROFILE, password: 'attacker-pass' });

      const response = await complete(test.tokenFromLastEmail());

      expect(response.statusCode).toBe(201);
      expect((await test.login()).statusCode).toBe(200);
      expect((await test.login({ password: 'attacker-pass' })).statusCode).toBe(401);
    });

    it('rejects an invalid email', async () => {
      const response = await test.post(REGISTER, { email: 'not-an-email' });

      expect(response.statusCode).toBe(400);
      expect(test.sentEmails).toHaveLength(0);
    });

    it('answers identically for an email in use, and only warns the owner', async () => {
      await test.createVerifiedUser();
      test.sentEmails.length = 0;
      const unused = await test.post(REGISTER, { email: 'new@example.com' });
      test.sentEmails.length = 0;

      const taken = await test.post(REGISTER, { email: TEST_EMAIL });

      expect(taken.statusCode).toBe(unused.statusCode);
      expect(taken.body).toBe(unused.body);
      expect(test.sentEmails.map(({ subject }) => subject)).toEqual([
        'Você já tem uma conta no Juízo',
      ]);
      expect(test.sentEmails[0]?.text).not.toContain('#token=');
      await expect(
        test.database.registrationToken.count({ where: { email: TEST_EMAIL } }),
      ).resolves.toBe(0);
    });

    it('still accepts the request when the email provider fails, and logs the failure', async () => {
      test.failEmails(true);

      const response = await test.post(REGISTER, { email: TEST_EMAIL });

      expect(response.statusCode).toBe(202);
      expect(test.backgroundFailures).toHaveLength(1);
    });

    it('limits requests per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await test.post(REGISTER, { email: `user${attempt}@example.com` });
      }

      const response = await test.post(REGISTER, { email: 'one-more@example.com' });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    });

    it('stops emailing one address after 3 per hour from a client, without revealing it', async () => {
      const responses = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        responses.push(await test.post(REGISTER, { email: TEST_EMAIL }));
      }

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([202, 202, 202, 202, 202]);
      expect(test.sentEmails).toHaveLength(3);

      test.advanceTime(HOUR_IN_MS + 1);
      await test.post(REGISTER, { email: TEST_EMAIL });
      expect(test.sentEmails).toHaveLength(4);
    });

    it('still emails the owner when another client used up its own limit', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await test.post(REGISTER, { email: TEST_EMAIL });
      }
      test.sentEmails.length = 0;

      await test.post(REGISTER, { email: TEST_EMAIL }, { remoteAddress: '203.0.113.9' });

      expect(test.sentEmails).toHaveLength(1);
    });

    it('caps the emails to one address at 10 per hour across clients', async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await test.post(
          REGISTER,
          { email: TEST_EMAIL },
          { remoteAddress: `203.0.113.${attempt + 1}` },
        );
      }

      expect(test.sentEmails).toHaveLength(10);
    });

    it('removes expired tokens', async () => {
      await requestLink();
      test.advanceTime(24 * HOUR_IN_MS);

      await requestLink('ana@example.com');

      const remaining = await test.database.registrationToken.findMany();
      expect(remaining.map(({ email }) => email)).toEqual(['ana@example.com']);
    });
  });

  describe('POST /auth/register/token', () => {
    it('returns the email of a valid link, without consuming it', async () => {
      const token = await requestLink();

      const response = await test.post(TOKEN, { token });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ email: TEST_EMAIL });
      expect((await complete(token)).statusCode).toBe(201);
    });

    it('rejects a forged token, an expired one and the stored hash', async () => {
      const token = await requestLink();
      const { tokenHash } = await test.database.registrationToken.findFirstOrThrow();

      expect((await test.post(TOKEN, { token: 'forged' })).statusCode).toBe(400);
      expect((await test.post(TOKEN, { token: tokenHash })).statusCode).toBe(400);

      test.advanceTime(24 * HOUR_IN_MS);
      const expired = await test.post(TOKEN, { token });
      expect(expired.statusCode).toBe(400);
      expect(expired.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    });
  });

  describe('POST /auth/register/complete', () => {
    it('creates the account with a hashed password and starts a session', async () => {
      const response = await complete(await requestLink());

      expect(response.statusCode).toBe(201);
      const user = await test.database.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
      expect(response.json()).toEqual({
        user: { id: user.id, name: 'Rafael', email: TEST_EMAIL },
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(TEST_PASSWORD);
      const { value } = test.sessionCookieOf(response);
      expect((await test.getMe(value)).statusCode).toBe(200);
    });

    it('takes the email from the link, not from the request', async () => {
      const response = await complete(await requestLink(), { email: 'other@example.com' });

      expect(response.json()).toMatchObject({ user: { email: TEST_EMAIL } });
      await expect(
        test.database.user.count({ where: { email: 'other@example.com' } }),
      ).resolves.toBe(0);
    });

    it('records terms, privacy and AI consents with version and date', async () => {
      const token = await requestLink();
      test.advanceTime(HOUR_IN_MS);
      await complete(token);

      const consents = await test.database.consent.findMany({ orderBy: { type: 'asc' } });
      expect(consents.map(({ type }) => type)).toEqual([
        'TERMS_OF_USE',
        'PRIVACY_POLICY',
        'AI_DATA_PROCESSING',
      ]);
      expect(consents[0]).toMatchObject({
        version: '1',
        grantedAt: new Date(TEST_START_TIME.getTime() + HOUR_IN_MS),
      });
    });

    it('does not record AI consent when the user declines it', async () => {
      await complete(await requestLink(), { hasConsentedToAiDataProcessing: false });

      const consents = await test.database.consent.findMany();
      expect(consents.map(({ type }) => type)).not.toContain('AI_DATA_PROCESSING');
    });

    it('rejects a completion that did not accept the terms', async () => {
      const token = await requestLink();

      const response = await complete(token, { hasAcceptedTerms: false });

      expect(response.statusCode).toBe(400);
      await expect(test.database.user.count()).resolves.toBe(0);
    });

    it.each([
      ['a short password', { password: 'too-short' }],
      ['an oversized password', { password: 'x'.repeat(129) }],
      ['a blank name', { name: '   ' }],
      ['control characters in the name', { name: 'Ra\u0000fael' }],
    ])('rejects %s and keeps the link usable', async (_description, override) => {
      const token = await requestLink();

      const invalid = await complete(token, override);
      const valid = await complete(token);

      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(valid.statusCode).toBe(201);
    });

    it('never echoes the password in a validation error', async () => {
      const response = await complete(await requestLink(), { password: 'tiny-pw' });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('tiny-pw');
    });

    it('works only once', async () => {
      const token = await requestLink();
      await complete(token);

      const response = await complete(token, { password: 'attacker-password' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
      expect((await test.login({ password: 'attacker-password' })).statusCode).toBe(401);
    });

    it('creates one account when the same link is used concurrently', async () => {
      const token = await requestLink();

      const responses = await Promise.all([complete(token), complete(token), complete(token)]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 400, 400]);
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('creates one account when different links of an email are used concurrently', async () => {
      const first = await requestLink();
      const second = await requestLink();

      const responses = await Promise.all([complete(first), complete(second)]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 400]);
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('invalidates the other links of the email', async () => {
      const first = await requestLink();
      const second = await requestLink();
      await complete(second);

      expect((await complete(first, { password: 'attacker-password' })).statusCode).toBe(400);
      await expect(test.database.registrationToken.count()).resolves.toBe(0);
    });

    it('rejects a link after 24 hours', async () => {
      const token = await requestLink();
      test.advanceTime(24 * HOUR_IN_MS);

      const response = await complete(token);

      expect(response.statusCode).toBe(400);
      await expect(test.database.user.count()).resolves.toBe(0);
    });

    it('rejects a forged token and the stored hash', async () => {
      await requestLink();
      const { tokenHash } = await test.database.registrationToken.findFirstOrThrow();

      expect((await complete('forged')).statusCode).toBe(400);
      expect((await complete(tokenHash)).statusCode).toBe(400);
    });

    it('limits guesses per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await complete(`forged-${attempt}`);
      }

      const response = await complete(await requestLink());

      expect(response.statusCode).toBe(429);
      await expect(test.database.user.count()).resolves.toBe(0);
    });

    it('uses a session that does not persist', async () => {
      const response = await complete(await requestLink());

      expect(test.sessionCookieOf(response).maxAge).toBe(86_400);
      expect(response.cookies.map(({ name }) => name)).toEqual([SESSION_COOKIE_NAME]);
    });
  });

  describe('someone starts a registration for an email that is not theirs', () => {
    it('gains nothing, and the owner chooses the password', async () => {
      await test.post(REGISTER, { email: TEST_EMAIL }, { remoteAddress: '198.51.100.7' });
      await test.post(REGISTER, { email: TEST_EMAIL });

      await complete(test.tokenFromLastEmail());

      expect((await test.login()).statusCode).toBe(200);
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('cannot sign in, and the response matches an unknown email', async () => {
      await test.post(REGISTER, { email: TEST_EMAIL });

      const pending = await test.login();
      const unknown = await test.login({ email: 'nobody@example.com' });

      expect(pending.statusCode).toBe(401);
      expect(pending.json()).toEqual(unknown.json());
    });
  });
});
