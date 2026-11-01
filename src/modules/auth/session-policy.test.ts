import { describe, expect, it } from 'vitest';
import { computeSessionExpiry, isSessionExpired, shouldRenewSession } from './session-policy.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

describe('computeSessionExpiry', () => {
  it('gives a temporary session 24 hours', () => {
    expect(computeSessionExpiry(NOW, false)).toEqual(addDays(NOW, 1));
  });

  it('gives a persistent session 30 days', () => {
    expect(computeSessionExpiry(NOW, true)).toEqual(addDays(NOW, 30));
  });
});

describe('shouldRenewSession', () => {
  it('never renews a temporary session', () => {
    expect(shouldRenewSession({ isPersistent: false, expiresAt: addDays(NOW, 0.5) }, NOW)).toBe(
      false,
    );
  });

  it('does not renew a persistent session used within the last day', () => {
    expect(shouldRenewSession({ isPersistent: true, expiresAt: addDays(NOW, 29.5) }, NOW)).toBe(
      false,
    );
  });

  it('renews a persistent session once a day has passed', () => {
    expect(shouldRenewSession({ isPersistent: true, expiresAt: addDays(NOW, 29) }, NOW)).toBe(true);
  });
});

describe('isSessionExpired', () => {
  it('treats the exact expiry instant as expired', () => {
    expect(isSessionExpired({ expiresAt: NOW }, NOW)).toBe(true);
  });

  it('keeps a session valid before its expiry', () => {
    expect(isSessionExpired({ expiresAt: addDays(NOW, 1) }, NOW)).toBe(false);
  });
});
