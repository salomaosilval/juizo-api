import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createAuthTestApp,
  TEST_PASSWORD,
  TEST_REGISTRATION,
} from '../../../test/auth-test-app.js';
import type { AuthTestApp } from '../../../test/auth-test-app.js';
import { createAuthRepository } from './auth.repository.js';

const MINUTE_IN_MS = 60_000;
const REQUEST = '/auth/password-reset/request';
const CONFIRM = '/auth/password-reset/confirm';
const NEW_PASSWORD = 'a brand new passphrase';
const EMAIL = TEST_REGISTRATION.email;

describe('password recovery', () => {
  let test: AuthTestApp;

  async function requestToken(): Promise<string> {
    await test.post(REQUEST, { email: EMAIL });
    return test.tokenFromLastEmail();
  }

  beforeAll(async () => {
    test = await createAuthTestApp(inject('databaseUrl'));
  });

  beforeEach(async () => {
    await test.reset();
    await test.createVerifiedUser();
    test.sentEmails.length = 0;
  });

  afterAll(async () => {
    await test.close();
  });

  describe('POST /auth/password-reset/request', () => {
    it('sends a link valid for the owner of the account', async () => {
      const response = await test.post(REQUEST, { email: EMAIL });

      expect(response.statusCode).toBe(202);
      const [email] = test.sentEmails;
      expect(email?.to).toBe(EMAIL);
      expect(email?.text).toContain(
        `https://app.juizo.test/redefinir-senha#token=${test.tokenFromLastEmail()}`,
      );
      expect(email?.text).toContain('30 minutos');
    });

    it('answers identically for an unknown email and sends nothing', async () => {
      const known = await test.post(REQUEST, { email: EMAIL });
      test.sentEmails.length = 0;

      const unknown = await test.post(REQUEST, { email: 'nobody@example.com' });

      expect(unknown.statusCode).toBe(known.statusCode);
      expect(unknown.body).toBe(known.body);
      expect(test.sentEmails).toHaveLength(0);
    });

    it('stores only the hash of the token', async () => {
      const token = await requestToken();

      const stored = await test.database.passwordResetToken.findFirstOrThrow();
      expect(stored.tokenHash).not.toBe(token);
    });

    it('does not change the password until the link is used', async () => {
      await requestToken();

      expect((await test.login()).statusCode).toBe(200);
    });

    it('invalidates earlier links', async () => {
      const oldToken = await requestToken();
      const newToken = await requestToken();

      const oldResponse = await test.post(CONFIRM, { token: oldToken, password: NEW_PASSWORD });
      const newResponse = await test.post(CONFIRM, { token: newToken, password: NEW_PASSWORD });

      expect(oldResponse.statusCode).toBe(400);
      expect(newResponse.statusCode).toBe(200);
    });

    it('stops emailing one address after 3 per hour, without revealing it', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await test.post(REQUEST, { email: EMAIL });
        expect(response.statusCode).toBe(202);
      }

      expect(test.sentEmails).toHaveLength(3);
    });

    it('still emails the owner when another client used up its own limit', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await test.post(REQUEST, { email: EMAIL });
      }
      test.sentEmails.length = 0;

      await test.post(REQUEST, { email: EMAIL }, { remoteAddress: '203.0.113.9' });

      expect(test.sentEmails).toHaveLength(1);
    });

    it('caps the emails to one address at 10 per hour across clients', async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await test.post(REQUEST, { email: EMAIL }, { remoteAddress: `203.0.113.${attempt + 1}` });
      }

      expect(test.sentEmails).toHaveLength(10);
    });

    it('keeps a single valid link when requests arrive concurrently', async () => {
      await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          test.post(REQUEST, { email: EMAIL }, { remoteAddress: `203.0.113.${index + 1}` }),
        ),
      );

      await expect(test.database.passwordResetToken.count()).resolves.toBe(1);
    });

    it('limits requests per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await test.post(REQUEST, { email: `user${attempt}@example.com` });
      }

      const response = await test.post(REQUEST, { email: EMAIL });

      expect(response.statusCode).toBe(429);
    });
  });

  describe('POST /auth/password-reset/confirm', () => {
    it('replaces the password, without signing in', async () => {
      const response = await test.post(CONFIRM, {
        token: await requestToken(),
        password: NEW_PASSWORD,
      });

      expect(response.statusCode).toBe(200);
      expect(response.cookies).toHaveLength(0);
      expect((await test.login({ password: NEW_PASSWORD })).statusCode).toBe(200);
      expect((await test.login()).statusCode).toBe(401);
    });

    it('ends every session of the account, including an intruder', async () => {
      const { value: first } = test.sessionCookieOf(await test.login());
      const { value: second } = test.sessionCookieOf(await test.login({ rememberMe: true }));

      await test.post(CONFIRM, { token: await requestToken(), password: NEW_PASSWORD });

      expect((await test.getMe(first)).statusCode).toBe(401);
      expect((await test.getMe(second)).statusCode).toBe(401);
    });

    it('leaves no session behind from logins racing with the reset', async () => {
      for (let round = 0; round < 5; round += 1) {
        const password = round === 0 ? TEST_PASSWORD : `rotated password ${round - 1}`;
        const token = await requestToken();
        await test.database.attemptCounter.deleteMany();

        const logins = [0, 30, 60, 90, 120].map(async (delayInMs) => {
          await new Promise((resolve) => setTimeout(resolve, delayInMs));
          return test.login({ password, rememberMe: true });
        });
        const [reset, ...loginResponses] = await Promise.all([
          test.post(CONFIRM, { token, password: `rotated password ${round}` }),
          ...logins,
        ]);

        expect(reset.statusCode).toBe(200);
        for (const response of loginResponses) {
          if (response.statusCode === 200) {
            const { value } = test.sessionCookieOf(response);
            expect((await test.getMe(value)).statusCode).toBe(401);
          }
        }
      }
    });

    it('refuses to create a session for a password that was just replaced', async () => {
      const { id: userId, passwordHash } = await test.database.user.findUniqueOrThrow({
        where: { email: EMAIL },
      });
      await test.post(CONFIRM, { token: await requestToken(), password: NEW_PASSWORD });

      const isCreated = await createAuthRepository(test.database).createSessionIfPasswordUnchanged(
        { userId, tokenHash: 'stale-login', isPersistent: true, expiresAt: new Date() },
        passwordHash,
      );

      expect(isCreated).toBe(false);
      await expect(test.database.session.count()).resolves.toBe(0);
    });

    it('keeps the sessions and password of other users', async () => {
      await test.createVerifiedUser({ name: 'Ana', email: 'ana@example.com' });
      const { value: anaToken } = test.sessionCookieOf(
        await test.login({ email: 'ana@example.com' }),
      );

      await test.post(CONFIRM, { token: await requestToken(), password: NEW_PASSWORD });

      expect((await test.getMe(anaToken)).statusCode).toBe(200);
      expect((await test.login({ email: 'ana@example.com' })).statusCode).toBe(200);
    });

    it('warns the owner that the password changed', async () => {
      await test.post(CONFIRM, { token: await requestToken(), password: NEW_PASSWORD });

      const email = test.sentEmails.at(-1);
      expect(email?.subject).toBe('Sua senha do Juízo foi alterada');
      expect(email?.to).toBe(EMAIL);
      expect(email?.text).not.toContain(NEW_PASSWORD);
    });

    it('releases an account locked by failed logins', async () => {
      for (let attempt = 0; attempt < 11; attempt += 1) {
        await test.login({ password: 'wrong-password' }, { remoteAddress: `203.0.113.${attempt}` });
      }
      expect((await test.login()).statusCode).toBe(429);

      await test.post(CONFIRM, { token: await requestToken(), password: NEW_PASSWORD });

      expect((await test.login({ password: NEW_PASSWORD })).statusCode).toBe(200);
    });

    it('works only once', async () => {
      const token = await requestToken();
      await test.post(CONFIRM, { token, password: NEW_PASSWORD });

      const response = await test.post(CONFIRM, { token, password: 'attacker-password' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
      expect((await test.login({ password: 'attacker-password' })).statusCode).toBe(401);
    });

    it('applies only one password when the same link is used concurrently', async () => {
      const token = await requestToken();

      const responses = await Promise.all([
        test.post(CONFIRM, { token, password: 'first new password' }),
        test.post(CONFIRM, { token, password: 'second new password' }),
      ]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 400]);
    });

    it('accepts the link until just before 30 minutes', async () => {
      const token = await requestToken();
      test.advanceTime(30 * MINUTE_IN_MS - 1);

      const response = await test.post(CONFIRM, { token, password: NEW_PASSWORD });

      expect(response.statusCode).toBe(200);
    });

    it('rejects the link after 30 minutes', async () => {
      const token = await requestToken();
      test.advanceTime(30 * MINUTE_IN_MS);

      const response = await test.post(CONFIRM, { token, password: NEW_PASSWORD });

      expect(response.statusCode).toBe(400);
      expect((await test.login()).statusCode).toBe(200);
    });

    it('rejects a forged token and the stored hash', async () => {
      await requestToken();
      const { tokenHash } = await test.database.passwordResetToken.findFirstOrThrow();

      const forged = await test.post(CONFIRM, { token: 'forged', password: NEW_PASSWORD });
      const hash = await test.post(CONFIRM, { token: tokenHash, password: NEW_PASSWORD });

      expect(forged.statusCode).toBe(400);
      expect(hash.statusCode).toBe(400);
      expect((await test.login({ password: TEST_PASSWORD })).statusCode).toBe(200);
    });

    it('rejects a weak password and keeps the link usable', async () => {
      const token = await requestToken();

      const weak = await test.post(CONFIRM, { token, password: 'short' });
      const strong = await test.post(CONFIRM, { token, password: NEW_PASSWORD });

      expect(weak.statusCode).toBe(400);
      expect(strong.statusCode).toBe(200);
    });

    it('limits guesses per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await test.post(CONFIRM, { token: `forged-${attempt}`, password: NEW_PASSWORD });
      }

      const response = await test.post(CONFIRM, {
        token: await requestToken(),
        password: NEW_PASSWORD,
      });

      expect(response.statusCode).toBe(429);
    });
  });
});
