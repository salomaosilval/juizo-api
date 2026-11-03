import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  enableNonRepudiationChecks,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { Configuration } from 'openid-client';

const GOOGLE_ISSUER_URL = 'https://accounts.google.com';
const SCOPES = 'openid email profile';
const GMAIL_DOMAIN = 'gmail.com';

export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GoogleProfile {
  subject: string;
  email: string;
  isEmailVerified: boolean;
  isGoogleAuthoritativeForEmail: boolean;
  name: string;
}

export interface GoogleIdentityProvider {
  createAuthorizationRequest(): Promise<{ url: string; checks: OidcChecks }>;
  exchangeCode(callbackUrl: URL, checks: OidcChecks): Promise<GoogleProfile>;
}

interface GoogleIdentityProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  issuerUrl?: string;
  discoveryOptions?: Parameters<typeof discovery>[4];
}

export function createGoogleIdentityProvider({
  clientId,
  clientSecret,
  redirectUrl,
  issuerUrl = GOOGLE_ISSUER_URL,
  discoveryOptions,
}: GoogleIdentityProviderOptions): GoogleIdentityProvider {
  let configuration: Promise<Configuration> | undefined;

  function loadConfiguration(): Promise<Configuration> {
    configuration ??= discovery(
      new URL(issuerUrl),
      clientId,
      clientSecret,
      undefined,
      discoveryOptions,
    )
      .then((discovered) => {
        enableNonRepudiationChecks(discovered);
        return discovered;
      })
      .catch((error: unknown) => {
        configuration = undefined;
        throw error;
      });
    return configuration;
  }

  return {
    async createAuthorizationRequest() {
      const checks = {
        state: randomState(),
        nonce: randomNonce(),
        codeVerifier: randomPKCECodeVerifier(),
      };
      const url = buildAuthorizationUrl(await loadConfiguration(), {
        redirect_uri: redirectUrl,
        scope: SCOPES,
        state: checks.state,
        nonce: checks.nonce,
        code_challenge: await calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
      });
      return { url: url.toString(), checks };
    },

    async exchangeCode(callbackUrl, { state, nonce, codeVerifier }) {
      const tokens = await authorizationCodeGrant(await loadConfiguration(), callbackUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims['email'] !== 'string') {
        throw new Error('Google did not return the email of the account.');
      }

      const email = claims['email'];
      const isEmailVerified = claims['email_verified'] === true;
      const emailDomain = email.split('@').at(-1)?.toLowerCase();
      const hostedDomain = claims['hd'];
      return {
        subject: claims.sub,
        email,
        isEmailVerified,
        isGoogleAuthoritativeForEmail:
          isEmailVerified &&
          (emailDomain === GMAIL_DOMAIN ||
            (typeof hostedDomain === 'string' && hostedDomain.toLowerCase() === emailDomain)),
        name: typeof claims['name'] === 'string' ? claims['name'] : '',
      };
    },
  };
}
