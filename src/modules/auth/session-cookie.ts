import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../../shared/time/clock.js';

const SECURE_COOKIE_NAME = '__Host-juizo_session';
const LOCAL_COOKIE_NAME = 'juizo_session';

export interface SessionCookie {
  read(request: FastifyRequest): string | undefined;
  write(reply: FastifyReply, token: string, expiresAt: Date): void;
  clear(reply: FastifyReply): void;
}

export function createSessionCookie(isSecure: boolean, clock: Clock): SessionCookie {
  const name = isSecure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
  const options: CookieSerializeOptions = {
    path: '/',
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
  };

  return {
    read: (request) => request.cookies[name],
    write(reply, token, expiresAt) {
      const maxAge = Math.floor((expiresAt.getTime() - clock.now().getTime()) / 1000);
      void reply.setCookie(name, token, { ...options, maxAge });
    },
    clear(reply) {
      void reply.clearCookie(name, options);
    },
  };
}
