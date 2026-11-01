# juizo-api

Backend for Juízo, a personal finance assistant for Brazilian users.

## Requirements

- Node and npm in the versions pinned by `.nvmrc` and `package.json`. Other versions are rejected by npm.
- Docker, for the local database and the integration tests.

## Getting started

```sh
nvm use
npm install
cp .env.example .env
npm run db:up
npm run dev
```

The API runs on `http://localhost:3333` and its reference on `http://localhost:3333/docs/`.

## Scripts

| Script                     | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `npm run dev`              | Starts the API in watch mode                            |
| `npm run check`            | Runs format check, lint, typecheck, all tests and build |
| `npm run test:unit`        | Runs tests that need no external service                |
| `npm run test:integration` | Runs tests against a real Postgres container            |
| `npm run test:coverage`    | Runs all tests and enforces the coverage thresholds     |
| `npm run db:migrate`       | Creates and applies a migration in development          |

## Documentation

- [Engineering rules](CLAUDE.md)
- [Glossary](docs/glossary.md)
- [Architecture decisions](docs/adr)
