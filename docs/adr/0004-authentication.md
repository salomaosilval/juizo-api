# 4. Self-implemented authentication with server-side sessions

Status: accepted, 2026-11-01

## Context

Juízo holds personal financial data. The product needs email and password, Google sign-in, optional two-factor authentication and a list of active sessions that can be revoked.

## Decision

- Sessions are random opaque tokens sent in a `HttpOnly`, `Secure`, `SameSite=Lax` cookie. The database stores only their SHA-256 hash, so a database leak does not expose usable sessions.
- Temporary sessions last 24 hours. Remembered sessions last 30 days from their last use.
- Passwords use Argon2id from `node:crypto`, stored with their parameters so they can be strengthened later, and are normalized with NFKC so the same password works across devices.
- Responses do not reveal whether an email has an account.
- Failed logins are limited per email and per IP, with counters in Postgres. IPv6 clients are counted by their /64. The email limit also blocks a correct password, which keeps distributed guessing out at the cost of allowing a temporary targeted lockout.
- API and web must share a registrable domain, because the CSRF defense is `SameSite` plus an `Origin` check on writes.
- The rest of the system depends only on `requireAuth`, so the implementation can be replaced.
- Email must be verified before signing in, and two-factor authentication is optional for users.

## Alternatives

- Better Auth: faster to build, with many external reviewers. It had 18 security advisories in 2026, 3 of them critical, including an account takeover through social login linking and a two-factor bypass in some configurations. Staying safe requires upgrading quickly, which conflicts with the 7-day release age rule, and its routes sit outside the API's error and OpenAPI conventions.
- Hosted services such as Clerk or Auth0: they remove the most work, but place login data with a third party and add cost and lock-in.
- JWT sessions: they cannot be revoked immediately, which the active sessions screen requires.

## Consequences

Requests without a body must not send `Content-Type: application/json`, because Fastify rejects an empty JSON body with 400. The frontend must treat a failed logout as a failure, since the session stays active.

No external reviewer sees this code, so **an external penetration test is required before launch**. Every known attack gets an automated test. If the test cannot happen, move to Better Auth with only password, Google and TOTP enabled.
