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
- Failed logins are limited per client network, per email and client network, and per email overall, with counters in Postgres. IPv6 clients are counted by their /48, which one customer can rotate through. The 10 attempts per email count per network, so an attacker on one network cannot lock out the owner. The overall ceiling of 100 per email in 15 minutes caps distributed guessing and also blocks a correct password, so an attack from many networks can still cause a lockout.
- API and web must share a registrable domain, because the CSRF defense is `SameSite` plus an `Origin` check on writes.
- The rest of the system depends only on `requireAuth`, so the implementation can be replaced.
- Registration happens in two steps. The first step asks only for the email and sends a link. The link opens the form for name, password, terms and consents, so nothing an unverified person types is ever kept, and registering someone else's email cannot affect that person's account. An account exists only after this second step, which also signs the person in. There are no unverified users to hijack through a later Google sign-in.
- Resetting a password does not sign in, so whoever clicks the link must still use the new password.
- Links carry their token in the URL fragment, which servers and referrers never receive, and the frontend submits it with `POST`, so email scanners that open links do not consume them.
- Work that would reveal through timing whether an email exists runs after the response, in background tasks that are drained on shutdown. Raw tokens are never stored, so a lost email is recovered by requesting a new link rather than by a queue.
- Email goes through Resend with `fetch`, without its SDK, and through Mailpit locally.
- Google sign-in uses the code flow on the server with PKCE, state and nonce kept in a short-lived `HttpOnly` cookie, through `openid-client`. It stays disabled until its three settings exist.
- Google is trusted about an email only where it is authoritative, for `@gmail.com` and for Workspace addresses matching `hd`, as its documentation advises. Elsewhere the address may have changed owner since Google verified it. Such an address never links to an existing account, which must sign in with its password, and creating a new account requires a link sent to that mailbox.
- Recovering the password also removes linked Google identities, so the owner can always expel an intruder. A later Google sign-in links again if Google is authoritative. Sessions start only if the identity is still linked, so a sign-in racing with a recovery leaves no session.
- A new person only becomes an account after accepting the terms, on a link kept in the URL fragment for 30 minutes. The form must show the email clearly, because this link is not bound to the browser.
- Query strings are removed from request logs, since they can carry authorization codes.
- Two-factor authentication is optional for users.

## Alternatives

- Better Auth: faster to build, with many external reviewers. It had 18 security advisories in 2026, 3 of them critical, including an account takeover through social login linking and a two-factor bypass in some configurations. Staying safe requires upgrading quickly, which conflicts with the 7-day release age rule, and its routes sit outside the API's error and OpenAPI conventions.
- Hosted services such as Clerk or Auth0: they remove the most work, but place login data with a third party and add cost and lock-in.
- JWT sessions: they cannot be revoked immediately, which the active sessions screen requires.

## Consequences

Requests without a body must not send `Content-Type: application/json`, because Fastify rejects an empty JSON body with 400. The frontend must treat a failed logout as a failure, since the session stays active.

No external reviewer sees this code, so **an external penetration test is required before launch**. Every known attack gets an automated test. If the test cannot happen, move to Better Auth with only password, Google and TOTP enabled.
