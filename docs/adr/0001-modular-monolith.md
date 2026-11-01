# 1. Modular monolith with three layers

Status: accepted, 2026-10-31

## Context

Juízo is an MVP built by one person. Its financial rules must be easy to test, and the code must be able to grow.

## Decision

Build one deployable made of feature modules under `src/modules`. Each module has routes, a service and a repository, and exposes only its `index.ts`. Business calculations are pure functions. Only repositories and external services sit behind interfaces, and dependencies are wired by hand in each module's `index.ts`, with no container.

## Alternatives

- Routes and services calling Prisma directly: faster at first, but it mixes financial rules with persistence and makes them harder to test.
- Full hexagonal architecture or DDD: more extensible, but too much ceremony for one person at this stage.

## Consequences

ESLint enforces module and layer boundaries, so violations fail in CI. A module can later be extracted because others reach it only through its public index.
