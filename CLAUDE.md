# juizo-api

Read `docs/glossary.md` before naming anything and `docs/adr/` before changing the architecture.

## Language

- All code, commits and technical docs are in English. Only what the end user sees is in PT-BR.
- The API returns stable error codes in English and the frontend owns their translation. Emails and messages from Ju are written in PT-BR in the backend.

## Decisions

- Bring every complex code or business decision to the project owner, explained with alternatives, and record the outcome as an ADR.

## Code

- No comments, except for a highly complex business rule or a constraint that code cannot express.
- Clean code and SOLID, as simple as an MVP allows and easy to extend. No abstraction without a current need.
- A module exposes only its `index.ts`. Layers run routes -> service -> repository, and ESLint enforces these boundaries.
- Interfaces are for external services (LLM, email, payment, clock) and repositories. Business calculations are pure functions.

## Domain

- Money is an integer in cents, never a float. Names carry the unit, as in `amountInCents`.
- Due dates are date-only values, and "today" is computed in the user's time zone.
- Every query on user data is scoped by `userId`, and a test proves one user cannot reach another's data.
- Ju never calculates values. Code calculates, Ju explains and proposes, and the user confirms.

## Tests

- Every financial rule has unit tests.
- Every route has integration tests against real Postgres, with no database mocks.

## Database

- Never edit a migration that has been pushed. Create a new one.

## Git

- Commit and push directly to `develop`, using Conventional Commits.
- `main` only receives pull requests from `develop`, merged with a merge commit and assigned to `salomaosilval`.
- Never commit secrets. New environment variables go in `.env.example` and `src/config/env.ts`.

## Runtime

- Node and npm versions are pinned. To upgrade, change `.nvmrc`, `engines` and `devEngines` together, and record the reason in an ADR when the major version changes.
