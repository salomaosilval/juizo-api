# 4. Self-implemented authentication with server-side sessions

Status: accepted, 2026-11-01

## Context

Juízo holds personal financial data. The product needs email and password, Google sign-in, optional two-factor authentication and a list of active sessions that can be revoked.

## Decision

- Sessions are random opaque tokens sent in a `HttpOnly`, `Secure`, `SameSite=Lax` cookie. The database stores only their SHA-256 hash, so a database leak does not expose usable sessions.
- Temporary sessions last 24 hours. Remembered sessions last 30 days from their last use.
- Passwords use Argon2id from `node:crypto`, stored with their parameters so they can be strengthened later, and are normalized with NFKC so the same password works across devices.
- Responses do not reveal whether an email has an account.
- Emails per address are limited per client network with a higher overall ceiling, so a single attacker cannot use up the owner's quota.
- A login creates its session only if the password is still the one it verified, so a login racing with a password reset leaves no session behind.
- Failed logins are limited per email and per IP, with counters in Postgres. IPv6 clients are counted by their /64. The email limit also blocks a correct password, which keeps distributed guessing out at the cost of allowing a temporary targeted lockout.
- API and web must share a registrable domain, because the CSRF defense is `SameSite` plus an `Origin` check on writes.
- The rest of the system depends only on `requireAuth`, so the implementation can be replaced.
- An account exists only after its email is confirmed. Until then, each registration attempt is a separate row with its own password, so registering someone else's email cannot touch their account, and only the link clicked by the owner decides which password wins. There are no unverified users to hijack through a later Google sign-in.
- Confirming an email or resetting a password does not sign in, so someone who clicks a link they did not request gains nothing and the person who set the password must still prove it.
- Links carry their token in the URL fragment, which servers and referrers never receive, and the frontend submits it with `POST`, so email scanners that open links do not consume them.
- Work that would reveal through timing whether an email exists runs after the response, in background tasks that are drained on shutdown. Raw tokens are never stored, so a lost email is recovered by requesting a new link rather than by a queue.
- Email goes through Resend with `fetch`, without its SDK, and through Mailpit locally.
- Two-factor authentication is optional for users.

## Alternatives

- Better Auth: faster to build, with many external reviewers. It had 18 security advisories in 2026, 3 of them critical, including an account takeover through social login linking and a two-factor bypass in some configurations. Staying safe requires upgrading quickly, which conflicts with the 7-day release age rule, and its routes sit outside the API's error and OpenAPI conventions.
- Hosted services such as Clerk or Auth0: they remove the most work, but place login data with a third party and add cost and lock-in.
- JWT sessions: they cannot be revoked immediately, which the active sessions screen requires.

## Open issue

Someone who registers another person's email can have their password become the account's password if that person clicks their link, because each link carries the password of the attempt that created it. A later password reset removes the intruder, but this must be closed before launch. The decision is pending with the project owner.

## Consequences

Requests without a body must not send `Content-Type: application/json`, because Fastify rejects an empty JSON body with 400. The frontend must treat a failed logout as a failure, since the session stays active.

No external reviewer sees this code, so **an external penetration test is required before launch**. Every known attack gets an automated test. If the test cannot happen, move to Better Auth with only password, Google and TOTP enabled.
