# 3. Real Postgres in integration tests

Status: accepted, 2026-10-31

## Decision

Integration tests run against a disposable Postgres container, started by Testcontainers with the same image as development, with all migrations applied.

## Alternatives

- Mocking Prisma: fast, but it would hide errors in the financial aggregations and constraints.
- A shared local database: no container startup cost, but results depend on its state.

## Consequences

Integration tests need Docker. Unit tests do not, and they run on every push through the Git hook.
