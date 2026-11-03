import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createAuthTestApp,
  DEFAULT_GOOGLE_PROFILE,
  SESSION_COOKIE_NAME,
  TEST_EMAIL,
  TEST_PASSWORD,
} from '../../../test/auth-test-app.js';
import type { AuthTestApp } from '../../../test/auth-test-app.js';
import { createAuthRepository } from './auth.repository.js';

const FLOW_COOKIE_NAME = 'juizo_google_flow';
const FAILURE_URL = 'https://app.juizo.test/entrar?erro=google';
const MINUTE_IN_MS = 60_000;
const TOKEN = '/auth/google/signup/token';
const COMPLETE = '/auth/google/signup/complete';
const CONSENTS = { hasAcceptedTerms: true, hasConsentedToAiDataProcessing: true };

describe('Google sign-in', () => {
  let test: AuthTestApp;

  async function startFlow(query = ''): Promise<LightMyRequestResponse> {
    return test.app.inject({ url: `/auth/google/start${query}` });
  }

  async function finishFlow(
    { state = 'expected-state', rememberMe = false } = {},
    extraQuery = '',
  ): Promise<LightMyRequestResponse> {
    const start = await startFlow(rememberMe ? '?rememberMe=true' : '');
    const flow = start.cookies.find(({ name }) => name === FLOW_COOKIE_NAME);
    const response = await test.app.inject({
      url: `/auth/google/callback?code=abc&state=${state}${extraQuery}`,
      cookies: { [FLOW_COOKIE_NAME]: flow?.value ?? '' },
    });
    await test.drainBackgroundTasks();
    return response;
  }

  function signupTokenOf(response: LightMyRequestResponse): string {
    const token = /finalizar-cadastro-google#token=([\w-]+)$/.exec(
      String(response.headers.location),
    )?.[1];
    if (!token) {
      throw new Error('The response did not redirect to the signup page.');
    }
    return token;
  }

  function complete(token: string, overrides: object = {}, options: object = {}) {
    return test.post(COMPLETE, { name: 'Rafael', token, ...CONSENTS, ...overrides }, options);
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

  describe('GET /auth/google/start', () => {
    it('redirects to Google and keeps the checks in a cookie scripts cannot read', async () => {
      const response = await startFlow();

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('https://accounts.google.test/authorize');
      expect(response.cookies.find(({ name }) => name === FLOW_COOKIE_NAME)).toMatchObject({
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 600,
      });
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('GET /auth/google/callback', () => {
    it('fails without the cookie, so a forged link cannot sign someone in', async () => {
      await test.createVerifiedUser();

      const response = await test.app.inject({
        url: '/auth/google/callback?code=attacker-code&state=expected-state',
      });

      expect(response.headers.location).toBe(FAILURE_URL);
      expect(response.cookies.map(({ name }) => name)).not.toContain(SESSION_COOKIE_NAME);
    });

    it('fails with a malformed cookie', async () => {
      const response = await test.app.inject({
        url: '/auth/google/callback?code=abc&state=expected-state',
        cookies: { [FLOW_COOKIE_NAME]: 'not-a-valid-flow' },
      });

      expect(response.headers.location).toBe(FAILURE_URL);
    });

    it('fails when the provider rejects the response, and consumes the cookie', async () => {
      await test.createVerifiedUser();

      const response = await finishFlow({ state: 'forged' });

      expect(response.headers.location).toBe(FAILURE_URL);
      expect(response.cookies.map(({ name }) => name)).not.toContain(SESSION_COOKIE_NAME);
      expect(response.cookies.find(({ name }) => name === FLOW_COOKIE_NAME)?.value).toBe('');
    });

    it('never links an email Google has not verified', async () => {
      await test.createVerifiedUser();
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, isEmailVerified: false };

      const response = await finishFlow();

      expect(response.headers.location).toBe(FAILURE_URL);
      expect(response.cookies.map(({ name }) => name)).not.toContain(SESSION_COOKIE_NAME);
      await expect(test.database.userIdentity.count()).resolves.toBe(0);
    });

    it('creates no signup for an email Google has not verified', async () => {
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, isEmailVerified: false };

      const response = await finishFlow();

      expect(response.headers.location).toBe(FAILURE_URL);
      await expect(test.database.googleSignupToken.count()).resolves.toBe(0);
    });

    it('sends a new person to accept the terms before any account exists', async () => {
      const response = await finishFlow();

      expect(signupTokenOf(response)).toBeTruthy();
      expect(response.cookies.map(({ name }) => name)).not.toContain(SESSION_COOKIE_NAME);
      await expect(test.database.user.count()).resolves.toBe(0);
    });

    it('links an existing account by verified email, warns the owner and signs in', async () => {
      await test.createVerifiedUser();
      test.sentEmails.length = 0;

      const callback = await finishFlow();
      await test.post('/auth/logout');

      expect(callback.headers.location).toBe('https://app.juizo.test/');
      const { value } = test.sessionCookieOf(callback);
      expect((await test.getMe(value)).json()).toMatchObject({ user: { email: TEST_EMAIL } });
      await expect(test.database.userIdentity.count()).resolves.toBe(1);
      expect(test.sentEmails.map(({ subject }) => subject)).toEqual([
        'Sua conta do Google foi conectada ao Juízo',
      ]);
      expect((await test.login()).statusCode).toBe(200);
    });

    it('recognizes a linked person even after the Google email changes', async () => {
      await test.createVerifiedUser();
      await finishFlow();
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, email: 'renamed@example.com' };

      const response = await finishFlow();

      const { value } = test.sessionCookieOf(response);
      expect((await test.getMe(value)).json()).toMatchObject({ user: { email: TEST_EMAIL } });
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('does not let a second Google account take over a linked account', async () => {
      await test.createVerifiedUser();
      await finishFlow();
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, subject: 'another-google-subject' };

      const response = await finishFlow();

      expect(response.headers.location).toBe(FAILURE_URL);
      expect(response.cookies.map(({ name }) => name)).not.toContain(SESSION_COOKIE_NAME);
      await expect(test.database.userIdentity.count()).resolves.toBe(1);
    });

    it('does not link an address Google is not authoritative for, as ownership may have changed', async () => {
      await test.createVerifiedUser();
      test.sentEmails.length = 0;
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, isGoogleAuthoritativeForEmail: false };

      const response = await finishFlow();

      expect(response.headers.location).toBe('https://app.juizo.test/entrar?erro=google-use-senha');
      expect(response.cookies.map(({ name }) => name)).not.toContain(SESSION_COOKIE_NAME);
      await expect(test.database.userIdentity.count()).resolves.toBe(0);
      expect(test.sentEmails).toHaveLength(0);
    });

    it('sends the signup link to the mailbox when Google is not authoritative', async () => {
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, isGoogleAuthoritativeForEmail: false };

      const response = await finishFlow();

      expect(response.headers.location).toBe('https://app.juizo.test/cadastro/confira-seu-email');
      expect(response.headers.location).not.toContain('token');
      await expect(test.database.user.count()).resolves.toBe(0);
      expect(test.sentEmails[0]?.to).toBe(TEST_EMAIL);

      const completion = await complete(test.tokenFromLastEmail());

      expect(completion.statusCode).toBe(201);
      await expect(test.database.userIdentity.count()).resolves.toBe(1);
    });

    it('limits signup links to one mailbox', async () => {
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, isGoogleAuthoritativeForEmail: false };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await finishFlow();
        await test.post('/auth/logout');
      }

      expect(test.sentEmails).toHaveLength(3);
    });

    it('rejects an email the API could not serve back', async () => {
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, email: 'a&b@corp.example' };

      const response = await finishFlow();

      expect(response.headers.location).toBe(FAILURE_URL);
      await expect(test.database.googleSignupToken.count()).resolves.toBe(0);
    });

    it('revokes the Google link when the owner recovers the password', async () => {
      await test.createVerifiedUser();
      await finishFlow();
      await test.post('/auth/password-reset/request', { email: TEST_EMAIL });

      await test.post('/auth/password-reset/confirm', {
        token: test.tokenFromLastEmail(),
        password: 'a brand new passphrase',
      });

      await expect(test.database.userIdentity.count()).resolves.toBe(0);
      test.googleProfile = {
        ...DEFAULT_GOOGLE_PROFILE,
        email: 'attacker@example.com',
      };
      const attacker = await finishFlow();
      expect(attacker.cookies.map(({ name }) => name)).not.toContain(SESSION_COOKIE_NAME);
    });

    it('creates no session when the link was revoked during the sign-in', async () => {
      await test.createVerifiedUser();
      await finishFlow();
      const { id: userId } = await test.database.user.findUniqueOrThrow({
        where: { email: TEST_EMAIL },
      });
      await test.database.userIdentity.deleteMany();
      await test.database.session.deleteMany();

      const isCreated = await createAuthRepository(
        test.database,
      ).createSessionIfGoogleIdentityLinked(
        { userId, tokenHash: 'stale', isPersistent: false, expiresAt: new Date() },
        DEFAULT_GOOGLE_PROFILE.subject,
      );

      expect(isCreated).toBe(false);
      await expect(test.database.session.count()).resolves.toBe(0);
    });

    it('does not move a linked person to an account owned by the new email', async () => {
      await test.createVerifiedUser();
      await finishFlow();
      await test.createVerifiedUser({ email: 'ana@example.com', name: 'Ana' });
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, email: 'ana@example.com' };

      const response = await finishFlow();

      const { value } = test.sessionCookieOf(response);
      expect((await test.getMe(value)).json()).toMatchObject({ user: { email: TEST_EMAIL } });
    });

    it('normalizes the email Google sends', async () => {
      await test.createVerifiedUser();
      test.googleProfile = { ...DEFAULT_GOOGLE_PROFILE, email: 'RAFAEL@Example.com' };

      const response = await finishFlow();

      expect(response.headers.location).toBe('https://app.juizo.test/');
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('honors remember me', async () => {
      await test.createVerifiedUser();

      const temporary = await finishFlow();
      const persistent = await finishFlow({ rememberMe: true });

      expect(test.sessionCookieOf(temporary).maxAge).toBe(86_400);
      expect(test.sessionCookieOf(persistent).maxAge).toBe(30 * 86_400);
    });
  });

  describe('signup after accepting the terms', () => {
    it('shows what Google shared', async () => {
      const token = signupTokenOf(await finishFlow());

      const response = await test.post(TOKEN, { token });

      expect(response.json()).toEqual({ email: TEST_EMAIL, name: 'Rafael do Google' });
    });

    it('creates the account without a password, with identity and consents, and signs in', async () => {
      const response = await complete(signupTokenOf(await finishFlow()));

      expect(response.statusCode).toBe(201);
      const user = await test.database.user.findUniqueOrThrow({ where: { email: TEST_EMAIL } });
      expect(user.passwordHash).toBeNull();
      await expect(test.database.userIdentity.count()).resolves.toBe(1);
      await expect(test.database.consent.count()).resolves.toBe(3);
      const { value } = test.sessionCookieOf(response);
      expect((await test.getMe(value)).statusCode).toBe(200);
    });

    it('rejects a signup that did not accept the terms', async () => {
      const token = signupTokenOf(await finishFlow());

      const response = await complete(token, { hasAcceptedTerms: false });

      expect(response.statusCode).toBe(400);
      await expect(test.database.user.count()).resolves.toBe(0);
    });

    it('works only once, and concurrently creates one account', async () => {
      const token = signupTokenOf(await finishFlow());

      const responses = await Promise.all([complete(token), complete(token)]);

      expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 400]);
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('rejects a link after 30 minutes', async () => {
      const token = signupTokenOf(await finishFlow());
      test.advanceTime(30 * MINUTE_IN_MS);

      expect((await test.post(TOKEN, { token })).statusCode).toBe(400);
      expect((await complete(token)).statusCode).toBe(400);
    });

    it('rejects a forged token and the stored hash', async () => {
      await finishFlow();
      const { tokenHash } = await test.database.googleSignupToken.findFirstOrThrow();

      expect((await complete('forged')).statusCode).toBe(400);
      expect((await complete(tokenHash)).statusCode).toBe(400);
    });

    it('removes pending links of the same email', async () => {
      await test.post('/auth/register', { email: TEST_EMAIL });
      const registrationToken = test.tokenFromLastEmail();

      await complete(signupTokenOf(await finishFlow()));

      const response = await test.post('/auth/register/complete', {
        token: registrationToken,
        name: 'Attacker',
        password: 'attacker-password',
        ...CONSENTS,
      });
      expect(response.statusCode).toBe(400);
      await expect(test.database.registrationToken.count()).resolves.toBe(0);
    });

    it('refuses to create a second account when one appeared meanwhile', async () => {
      const token = signupTokenOf(await finishFlow());
      await test.createVerifiedUser();

      const response = await complete(token);

      expect(response.statusCode).toBe(400);
      await expect(test.database.user.count()).resolves.toBe(1);
    });

    it('limits guesses per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await complete(`forged-${attempt}`);
      }

      const response = await complete(signupTokenOf(await finishFlow()));

      expect(response.statusCode).toBe(429);
    });

    it('rejects a write from an origin that is not allowed', async () => {
      const token = signupTokenOf(await finishFlow());

      const response = await complete(token, {}, { headers: { origin: 'https://evil.example' } });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('an account created through Google', () => {
    beforeEach(async () => {
      await complete(signupTokenOf(await finishFlow()));
      await test.database.attemptCounter.deleteMany();
    });

    it('cannot sign in with a password', async () => {
      const response = await test.login({ password: TEST_PASSWORD });

      expect(response.statusCode).toBe(401);
    });

    it('can add a password through recovery', async () => {
      await test.post('/auth/password-reset/request', { email: TEST_EMAIL });

      await test.post('/auth/password-reset/confirm', {
        token: test.tokenFromLastEmail(),
        password: TEST_PASSWORD,
      });

      expect((await test.login()).statusCode).toBe(200);
    });

    it('is warned when someone tries to register its email', async () => {
      test.sentEmails.length = 0;

      await test.post('/auth/register', { email: TEST_EMAIL });

      expect(test.sentEmails[0]?.subject).toBe('Você já tem uma conta no Juízo');
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

    it('keeps the checks in a host-only secure cookie', async () => {
      const response = await production.app.inject({ url: '/auth/google/start' });

      const [cookie] = response.cookies;
      expect(cookie).toMatchObject({
        name: '__Host-juizo_google_flow',
        secure: true,
        httpOnly: true,
        path: '/',
      });
      expect(cookie).not.toHaveProperty('domain');
    });
  });

  describe('when Google is not configured', () => {
    let disabled: AuthTestApp;

    beforeAll(async () => {
      disabled = await createAuthTestApp(inject('databaseUrl'), {
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REDIRECT_URL: undefined,
      });
    });

    afterAll(async () => {
      await disabled.close();
    });

    it('has no Google routes', async () => {
      const response = await disabled.app.inject({ url: '/auth/google/start' });

      expect(response.statusCode).toBe(404);
    });
  });
});
