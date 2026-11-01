import { describe, expect, it, vi } from 'vitest';
import type { AttemptLimiter } from './attempt-limiter.js';
import type { AuthRepository } from './auth.repository.js';
import { createAuthService } from './auth.service.js';
import type { PasswordHasher } from './password-hasher.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');

describe('AuthService.login with an unknown email', () => {
  it('still verifies the password, so the response takes the same time', async () => {
    const verify = vi.fn<PasswordHasher['verify']>().mockResolvedValue(false);
    const repository = {
      findCredentialsByEmail: () => Promise.resolve(null),
    } as Partial<AuthRepository> as AuthRepository;
    const attemptLimiter = {
      exceeds: () => Promise.resolve(false),
    } as Partial<AttemptLimiter> as AttemptLimiter;
    const service = createAuthService({
      repository,
      attemptLimiter,
      passwordHasher: { hash: vi.fn<PasswordHasher['hash']>(), verify },
      clock: { now: () => NOW },
      decoyPasswordHash: 'decoy-hash',
    });

    await expect(
      service.login({
        email: 'nobody@example.com',
        password: 'any password',
        rememberMe: false,
        clientIp: '203.0.113.9',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(verify).toHaveBeenCalledExactlyOnceWith('any password', 'decoy-hash');
  });
});
