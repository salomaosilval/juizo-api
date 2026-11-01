import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createAuthTestApp,
  TEST_PASSWORD,
  TEST_REGISTRATION,
  TEST_START_TIME,
} from '../../../test/auth-test-app.js';
import type { AuthTestApp } from '../../../test/auth-test-app.js';

const HOUR_IN_MS = 3_600_000;
const REGISTER = '/auth/register';
const CONFIRM = '/auth/email-verification/confirm';
const RESEND = '/auth/email-verification/resend';

describe('registration and email verification', () => {
  let test: AuthTestApp;

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
    it('creates no account and no session until the email is confirmed', async () => {
      const response = await test.post(REGISTER, TEST_REGISTRATION);

      expect(response.statusCode).toBe(202);
      expect(response.cookies).toHaveLength(0);
      await expect(test.database.user.count()).resolves.toBe(0);
    });

    it('sends the confirmation link with the token out of reach of servers and referrers', async () => {
      await test.post(REGISTER, { ...TEST_REGISTRATION, email: '  Rafael@Example.COM ' });

      const [email] = test.sentEmails;
      expect(email?.to).toBe('rafael@example.com');
      expect(email?.subject).toBe('Confirme seu e-mail para entrar no Juízo');
      expect(email?.text).toContain(
        `https://app.juizo.test/confirmar-email#token=${test.tokenFromLastEmail()}`,
      );
      expect(email?.html).toContain(`#token=${test.tokenFromLastEmail()}`);
    });

    it('stores a hashed password and only the hash of the token', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);

      const pending = await test.database.pendingRegistration.findFirstOrThrow();
      expect(pending.passwordHash).toMatch(/^\$argon2id\$/);
      expect(pending.tokenHash).not.toBe(test.tokenFromLastEmail());
    });

    it('never puts text chosen by the registrant in the email', async () => {
      await test.post(REGISTER, { ...TEST_REGISTRATION, name: 'Acesse evil.example' });

      const [email] = test.sentEmails;
      expect(email?.html).not.toContain('evil.example');
      expect(email?.text).not.toContain('evil.example');
    });

    it('rejects a registration that did not accept the terms', async () => {
      const response = await test.post(REGISTER, { ...TEST_REGISTRATION, hasAcceptedTerms: false });

      expect(response.statusCode).toBe(400);
      expect(test.sentEmails).toHaveLength(0);
    });

    it.each([
      ['a short password', { password: 'too-short' }],
      ['an oversized password', { password: 'x'.repeat(129) }],
      ['an invalid email', { email: 'not-an-email' }],
      ['a blank name', { name: '   ' }],
      ['control characters in the name', { name: 'Ra\u0000fael' }],
    ])('rejects %s', async (_description, override) => {
      const response = await test.post(REGISTER, { ...TEST_REGISTRATION, ...override });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('never echoes the password in a validation error', async () => {
      const response = await test.post(REGISTER, { ...TEST_REGISTRATION, password: 'tiny-pw' });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('tiny-pw');
    });

    it('answers identically for an email in use, and only warns the owner', async () => {
      const first = await test.post(REGISTER, TEST_REGISTRATION);
      await test.post(CONFIRM, { token: test.tokenFromLastEmail() });
      test.sentEmails.length = 0;

      const second = await test.post(REGISTER, {
        ...TEST_REGISTRATION,
        name: 'Attacker',
        password: 'attacker-password',
      });

      expect(second.statusCode).toBe(first.statusCode);
      expect(second.body).toBe(first.body);
      expect(test.sentEmails.map(({ subject }) => subject)).toEqual([
        'Você já tem uma conta no Juízo',
      ]);
      expect(test.sentEmails[0]?.text).not.toContain('#token=');
      await expect(test.database.pendingRegistration.count()).resolves.toBe(0);
      expect((await test.login()).statusCode).toBe(200);
      expect((await test.login({ password: 'attacker-password' })).statusCode).toBe(401);
    });

    it('still accepts the request when the email provider fails, and logs the failure', async () => {
      test.failEmails(true);

      const response = await test.post(REGISTER, TEST_REGISTRATION);

      expect(response.statusCode).toBe(202);
      expect(test.backgroundFailures).toHaveLength(1);
    });

    it('limits registrations per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await test.post(REGISTER, { ...TEST_REGISTRATION, email: `user${attempt}@example.com` });
      }

      const response = await test.post(REGISTER, {
        ...TEST_REGISTRATION,
        email: 'one-more@example.com',
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    });

    it('stops emailing one address after 3 per hour from a client, without revealing it', async () => {
      const responses = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        responses.push(await test.post(REGISTER, TEST_REGISTRATION));
      }

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([202, 202, 202, 202, 202]);
      expect(test.sentEmails).toHaveLength(3);

      test.advanceTime(HOUR_IN_MS + 1);
      await test.post(REGISTER, TEST_REGISTRATION);
      expect(test.sentEmails).toHaveLength(4);
    });

    it('still emails the owner when another client used up its own limit', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await test.post(REGISTER, TEST_REGISTRATION);
      }
      test.sentEmails.length = 0;

      await test.post(REGISTER, TEST_REGISTRATION, { remoteAddress: '203.0.113.9' });

      expect(test.sentEmails).toHaveLength(1);
    });

    it('caps the emails to one address at 10 per hour across clients', async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await test.post(REGISTER, TEST_REGISTRATION, {
          remoteAddress: `203.0.113.${attempt + 1}`,
        });
      }

      expect(test.sentEmails).toHaveLength(10);
    });

    it('removes expired registrations, which hold personal data', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      test.advanceTime(24 * HOUR_IN_MS);

      await test.post(REGISTER, { ...TEST_REGISTRATION, email: 'ana@example.com' });

      const remaining = await test.database.pendingRegistration.findMany();
      expect(remaining.map(({ email }) => email)).toEqual(['ana@example.com']);
    });
  });

  describe('POST /auth/email-verification/confirm', () => {
    it('creates the account, without signing in', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);

      const response = await test.post(CONFIRM, { token: test.tokenFromLastEmail() });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'verified' });
      expect(response.cookies).toHaveLength(0);
      expect((await test.login()).statusCode).toBe(200);
    });

    it('records terms, privacy and AI consents with the date they were given', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      test.advanceTime(HOUR_IN_MS);
      await test.post(CONFIRM, { token: test.tokenFromLastEmail() });

      const consents = await test.database.consent.findMany({ orderBy: { type: 'asc' } });
      expect(consents.map(({ type }) => type)).toEqual([
        'TERMS_OF_USE',
        'PRIVACY_POLICY',
        'AI_DATA_PROCESSING',
      ]);
      expect(consents[0]).toMatchObject({ version: '1', grantedAt: TEST_START_TIME });
    });

    it('does not record AI consent when the user declined it', async () => {
      await test.post(REGISTER, { ...TEST_REGISTRATION, hasConsentedToAiDataProcessing: false });
      await test.post(CONFIRM, { token: test.tokenFromLastEmail() });

      const consents = await test.database.consent.findMany();
      expect(consents.map(({ type }) => type)).not.toContain('AI_DATA_PROCESSING');
    });

    it('works only once', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      const token = test.tokenFromLastEmail();
      await test.post(CONFIRM, { token });

      const response = await test.post(CONFIRM, { token });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('creates one account when the same link is confirmed concurrently', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      const token = test.tokenFromLastEmail();

      const responses = await Promise.all([
        test.post(CONFIRM, { token }),
        test.post(CONFIRM, { token }),
        test.post(CONFIRM, { token }),
      ]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400, 400]);
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('creates one account when different links of an email are confirmed concurrently', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      const first = test.tokenFromLastEmail();
      await test.post(REGISTER, TEST_REGISTRATION);
      const second = test.tokenFromLastEmail();

      const responses = await Promise.all([
        test.post(CONFIRM, { token: first }),
        test.post(CONFIRM, { token: second }),
      ]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400]);
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('rejects a link after 24 hours', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      test.advanceTime(24 * HOUR_IN_MS);

      const response = await test.post(CONFIRM, { token: test.tokenFromLastEmail() });

      expect(response.statusCode).toBe(400);
      await expect(test.database.user.count()).resolves.toBe(0);
    });

    it('rejects a forged token and the stored hash', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      const { tokenHash } = await test.database.pendingRegistration.findFirstOrThrow();

      expect((await test.post(CONFIRM, { token: 'forged' })).statusCode).toBe(400);
      expect((await test.post(CONFIRM, { token: tokenHash })).statusCode).toBe(400);
    });
  });

  describe('someone registers an email that is not theirs', () => {
    it('keeps the account of the real owner, who confirms their own link', async () => {
      await test.post(REGISTER, { ...TEST_REGISTRATION, password: 'attacker-password' });
      const attackerToken = test.tokenFromLastEmail();
      await test.post(REGISTER, TEST_REGISTRATION);

      await test.post(CONFIRM, { token: test.tokenFromLastEmail() });

      expect((await test.login()).statusCode).toBe(200);
      expect((await test.login({ password: 'attacker-password' })).statusCode).toBe(401);
      expect((await test.post(CONFIRM, { token: attackerToken })).statusCode).toBe(400);
      await expect(test.database.pendingRegistration.count()).resolves.toBe(0);
    });

    it('keeps the owner link valid when someone else registers afterwards', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      const ownerToken = test.tokenFromLastEmail();
      await test.post(REGISTER, { ...TEST_REGISTRATION, password: 'attacker-password' });

      const response = await test.post(CONFIRM, { token: ownerToken });

      expect(response.statusCode).toBe(200);
      expect((await test.login()).statusCode).toBe(200);
      expect((await test.login({ password: 'attacker-password' })).statusCode).toBe(401);
    });

    it('cannot sign in while the email is not confirmed', async () => {
      await test.post(REGISTER, { ...TEST_REGISTRATION, password: 'attacker-password' });

      const pending = await test.login({ password: 'attacker-password' });
      const unknown = await test.login({ email: 'nobody@example.com', password: TEST_PASSWORD });

      expect(pending.statusCode).toBe(401);
      expect(pending.json()).toEqual(unknown.json());
    });
  });

  describe('POST /auth/email-verification/resend', () => {
    it('sends a new link and invalidates the previous one', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      const oldToken = test.tokenFromLastEmail();

      const response = await test.post(RESEND, { email: TEST_REGISTRATION.email });
      const newToken = test.tokenFromLastEmail();

      expect(response.statusCode).toBe(202);
      expect(newToken).not.toBe(oldToken);
      expect((await test.post(CONFIRM, { token: oldToken })).statusCode).toBe(400);
      expect((await test.post(CONFIRM, { token: newToken })).statusCode).toBe(200);
    });

    it('extends the validity of the link', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);
      test.advanceTime(23 * HOUR_IN_MS);
      await test.post(RESEND, { email: TEST_REGISTRATION.email });
      test.advanceTime(2 * HOUR_IN_MS);

      const response = await test.post(CONFIRM, { token: test.tokenFromLastEmail() });

      expect(response.statusCode).toBe(200);
    });

    it('answers identically for an unknown, an expired and a confirmed email, sending nothing', async () => {
      await test.createVerifiedUser({ email: 'confirmed@example.com' });
      await test.post(REGISTER, { ...TEST_REGISTRATION, email: 'expired@example.com' });
      test.advanceTime(24 * HOUR_IN_MS);
      test.sentEmails.length = 0;

      const responses = await Promise.all(
        ['nobody@example.com', 'expired@example.com', 'confirmed@example.com'].map((email) =>
          test.post(RESEND, { email }),
        ),
      );

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([202, 202, 202]);
      expect(new Set(responses.map(({ body }) => body)).size).toBe(1);
      expect(test.sentEmails).toHaveLength(0);
    });

    it('shares the limit of 3 emails per hour with registration', async () => {
      await test.post(REGISTER, TEST_REGISTRATION);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await test.post(RESEND, { email: TEST_REGISTRATION.email });
      }

      expect(test.sentEmails).toHaveLength(3);
    });

    it('limits requests per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await test.post(RESEND, { email: `user${attempt}@example.com` });
      }

      const response = await test.post(RESEND, { email: 'one-more@example.com' });

      expect(response.statusCode).toBe(429);
    });
  });
});
