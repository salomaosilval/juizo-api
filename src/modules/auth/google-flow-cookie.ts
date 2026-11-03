import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OidcChecks } from './google-identity-provider.js';

const SECURE_COOKIE_NAME = '__Host-juizo_google_flow';
const LOCAL_COOKIE_NAME = 'juizo_google_flow';
const FLOW_LIFETIME_IN_SECONDS = 600;

const flowSchema = z.object({
  state: z.string(),
  nonce: z.string(),
  codeVerifier: z.string(),
  rememberMe: z.boolean(),
});

export interface GoogleFlow extends OidcChecks {
  rememberMe: boolean;
}

export interface GoogleFlowCookie {
  read(request: FastifyRequest): GoogleFlow | null;
  write(reply: FastifyReply, flow: GoogleFlow): void;
  clear(reply: FastifyReply): void;
}

export function createGoogleFlowCookie(isSecure: boolean): GoogleFlowCookie {
  const name = isSecure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
  const options: CookieSerializeOptions = {
    path: '/',
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
  };

  return {
    read(request) {
      const value = request.cookies[name];
      if (value === undefined) {
        return null;
      }
      try {
        const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
        return flowSchema.parse(decoded);
      } catch {
        return null;
      }
    },
    write(reply, flow) {
      const value = Buffer.from(JSON.stringify(flow)).toString('base64url');
      void reply.setCookie(name, value, { ...options, maxAge: FLOW_LIFETIME_IN_SECONDS });
    },
    clear(reply) {
      void reply.clearCookie(name, options);
    },
  };
}
