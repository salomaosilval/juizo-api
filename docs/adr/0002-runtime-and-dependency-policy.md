# 2. Runtime and dependency policy

Status: accepted, 2026-10-31

## Decision

- Use Node 26, the active LTS supported until April 2029, with the npm version it bundles.
- `engines`, `devEngines`, `engine-strict` and `.nvmrc` make npm reject any other version, locally and in CI.
- Pin exact dependency versions and refuse packages published less than 7 days ago, which limits exposure to compromised releases.
- Fail CI on high or critical vulnerabilities in production dependencies.

## Held-back versions

- TypeScript stays on 6.0 because `typescript-eslint` does not yet support 7.
- `prisma` stays on 7.10 because its `latest` npm tag points to a release candidate of version 8.

## Alternatives

Node 24 is also supported, until April 2028, but it is in maintenance and only receives critical fixes.
