const HOUR_IN_MS = 3_600_000;
const DAY_IN_MS = 24 * HOUR_IN_MS;

const TEMPORARY_SESSION_LIFETIME_IN_MS = 24 * HOUR_IN_MS;
const PERSISTENT_SESSION_LIFETIME_IN_MS = 30 * DAY_IN_MS;
const RENEWAL_INTERVAL_IN_MS = DAY_IN_MS;

export function computeSessionExpiry(now: Date, isPersistent: boolean): Date {
  const lifetime = isPersistent
    ? PERSISTENT_SESSION_LIFETIME_IN_MS
    : TEMPORARY_SESSION_LIFETIME_IN_MS;
  return new Date(now.getTime() + lifetime);
}

export function shouldRenewSession(
  session: { isPersistent: boolean; expiresAt: Date },
  now: Date,
): boolean {
  const remainingLifetime = session.expiresAt.getTime() - now.getTime();
  return (
    session.isPersistent &&
    remainingLifetime <= PERSISTENT_SESSION_LIFETIME_IN_MS - RENEWAL_INTERVAL_IN_MS
  );
}

export function isSessionExpired(session: { expiresAt: Date }, now: Date): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}
