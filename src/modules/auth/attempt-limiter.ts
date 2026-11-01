import { toClientNetwork } from '../../shared/http/client-network.js';
import type { Clock } from '../../shared/time/clock.js';
import type { AttemptRepository } from './attempt.repository.js';
import { hashSecret } from './secret-token.js';

export interface AttemptLimit {
  maxAttempts: number;
  windowInMs: number;
}

export interface AttemptLimiter {
  exceeds(key: string, limit: AttemptLimit): Promise<boolean>;
  clear(key: string): Promise<void>;
  refund(key: string): Promise<void>;
}

export function emailAttemptKey(action: string, email: string): string {
  return `${action}:email:${hashSecret(email)}`;
}

export function emailAndClientAttemptKey(action: string, email: string, clientIp: string): string {
  return `${action}:email-client:${hashSecret(email)}:${toClientNetwork(clientIp)}`;
}

export function clientAttemptKey(action: string, clientIp: string): string {
  return `${action}:ip:${toClientNetwork(clientIp)}`;
}

export function createAttemptLimiter(repository: AttemptRepository, clock: Clock): AttemptLimiter {
  return {
    async exceeds(key, { maxAttempts, windowInMs }) {
      const now = clock.now();
      const windowStart = new Date(now.getTime() - windowInMs);
      return (await repository.countAttempt(key, now, windowStart)) > maxAttempts;
    },
    clear: (key) => repository.clearAttempts(key),
    refund: (key) => repository.refundAttempt(key),
  };
}
