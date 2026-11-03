import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { allowInsecureRequests } from 'openid-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleIdentityProvider } from './google-identity-provider.js';
import type { GoogleIdentityProvider } from './google-identity-provider.js';

const CLIENT_ID = 'test-client';
const REDIRECT_URL = 'https://api.juizo.test/auth/google/callback';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

describe('GoogleIdentityProvider against an OpenID Connect server', () => {
  let server: Server;
  let issuer: string;
  let provider: GoogleIdentityProvider;
  let trustedKeys: KeyPair;
  let signingKey: CryptoKey;
  let idTokenClaims: Record<string, unknown>;
  let receivedTokenRequest: URLSearchParams;

  function callbackFor(url: string, overrides: Record<string, string> = {}): URL {
    const { searchParams } = new URL(url);
    const callback = new URL(REDIRECT_URL);
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', searchParams.get('state') ?? '');
    for (const [key, value] of Object.entries(overrides)) {
      callback.searchParams.set(key, value);
    }
    return callback;
  }

  beforeAll(async () => {
    trustedKeys = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = { ...(await exportJWK(trustedKeys.publicKey)), kid: 'key', alg: 'RS256' };

    server = createServer((request, response) => {
      const respond = (body: unknown) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(body));
      };

      if (request.url === '/.well-known/openid-configuration') {
        respond({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
        });
        return;
      }
      if (request.url === '/jwks') {
        respond({ keys: [publicJwk] });
        return;
      }

      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        receivedTokenRequest = new URLSearchParams(body);
        void new SignJWT(idTokenClaims)
          .setProtectedHeader({ alg: 'RS256', kid: 'key' })
          .setIssuer(issuer)
          .setAudience(CLIENT_ID)
          .setSubject('google-subject')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(signingKey)
          .then((idToken) => {
            respond({ access_token: 'access', token_type: 'bearer', id_token: idToken });
          });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    provider = createGoogleIdentityProvider({
      clientId: CLIENT_ID,
      clientSecret: 'test-secret',
      redirectUrl: REDIRECT_URL,
      issuerUrl: issuer,
      discoveryOptions: { execute: [allowInsecureRequests] },
    });
  });

  beforeEach(() => {
    signingKey = trustedKeys.privateKey;
    idTokenClaims = { email: 'rafael@example.com', email_verified: true, name: 'Rafael' };
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('asks for the code flow with PKCE, state and nonce', async () => {
    const { url, checks } = await provider.createAuthorizationRequest();

    const { searchParams } = new URL(url);
    expect(searchParams.get('response_type')).toBe('code');
    expect(searchParams.get('code_challenge_method')).toBe('S256');
    expect(searchParams.get('code_challenge')).not.toBe(checks.codeVerifier);
    expect(searchParams.get('state')).toBe(checks.state);
    expect(searchParams.get('nonce')).toBe(checks.nonce);
    expect(searchParams.get('redirect_uri')).toBe(REDIRECT_URL);
  });

  it('returns the profile from a valid response and sends the PKCE verifier', async () => {
    const { url, checks } = await provider.createAuthorizationRequest();
    idTokenClaims['nonce'] = checks.nonce;

    const profile = await provider.exchangeCode(callbackFor(url), checks);

    expect(profile).toEqual({
      subject: 'google-subject',
      email: 'rafael@example.com',
      isEmailVerified: true,
      isGoogleAuthoritativeForEmail: false,
      name: 'Rafael',
    });
    expect(receivedTokenRequest.get('code_verifier')).toBe(checks.codeVerifier);
  });

  it.each([
    ['a Gmail address', { email: 'rafael@gmail.com' }, true],
    ['a Workspace address of the hosted domain', { email: 'a@corp.com', hd: 'corp.com' }, true],
    ['another domain than the hosted one', { email: 'a@corp.com', hd: 'other.com' }, false],
    ['a third-party address, even if verified', { email: 'a@corp.com' }, false],
    ['an unverified Gmail address', { email: 'a@gmail.com', email_verified: false }, false],
  ])('decides whether Google is authoritative for %s', async (_case, claims, expected) => {
    const { url, checks } = await provider.createAuthorizationRequest();
    idTokenClaims = { ...idTokenClaims, nonce: checks.nonce, ...claims };

    const profile = await provider.exchangeCode(callbackFor(url), checks);

    expect(profile.isGoogleAuthoritativeForEmail).toBe(expected);
  });

  it('reports an email Google has not verified', async () => {
    const { url, checks } = await provider.createAuthorizationRequest();
    idTokenClaims = { ...idTokenClaims, nonce: checks.nonce, email_verified: false };

    const profile = await provider.exchangeCode(callbackFor(url), checks);

    expect(profile.isEmailVerified).toBe(false);
  });

  it('rejects a callback with another state', async () => {
    const { url, checks } = await provider.createAuthorizationRequest();
    idTokenClaims['nonce'] = checks.nonce;

    await expect(
      provider.exchangeCode(callbackFor(url, { state: 'forged' }), checks),
    ).rejects.toThrow();
  });

  it('rejects an id token with another nonce', async () => {
    const { url, checks } = await provider.createAuthorizationRequest();
    idTokenClaims['nonce'] = 'forged';

    await expect(provider.exchangeCode(callbackFor(url), checks)).rejects.toThrow();
  });

  it('rejects a response without an email', async () => {
    const { url, checks } = await provider.createAuthorizationRequest();
    idTokenClaims = { nonce: checks.nonce };

    await expect(provider.exchangeCode(callbackFor(url), checks)).rejects.toThrow(/email/);
  });

  it('rejects an id token signed by another key', async () => {
    const { url, checks } = await provider.createAuthorizationRequest();
    idTokenClaims['nonce'] = checks.nonce;
    signingKey = (await generateKeyPair('RS256')).privateKey;

    await expect(provider.exchangeCode(callbackFor(url), checks)).rejects.toThrow();
  });
});
