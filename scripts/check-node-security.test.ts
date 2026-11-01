import { describe, expect, it } from 'vitest';
import { findNodeSecurityProblem } from './check-node-security.js';
import type { NodeRelease, NodeSchedule } from './check-node-security.js';

const releases: NodeRelease[] = [
  { version: 'v26.13.0', security: false },
  { version: 'v26.12.1', security: true },
  { version: 'v24.22.2', security: false },
  { version: 'v24.22.1', security: true },
  { version: 'v20.20.2', security: true },
];

const schedule: NodeSchedule = {
  v20: { end: '2026-04-30' },
  v24: { end: '2028-04-30' },
  v26: { end: '2029-04-30' },
};

function check(pinnedVersion: string): string | null {
  return findNodeSecurityProblem({ pinnedVersion, today: '2026-10-31', releases, schedule });
}

describe('findNodeSecurityProblem', () => {
  it('accepts a version newer than the last security release', () => {
    expect(check('26.13.0')).toBeNull();
  });

  it('accepts the security release itself', () => {
    expect(check('24.22.1')).toBeNull();
  });

  it('rejects a version older than the last security release of its line', () => {
    expect(check('24.21.0')).toMatch(/older than security release v24\.22\.1/);
  });

  it('compares versions numerically, not alphabetically', () => {
    expect(check('24.9.0')).toMatch(/older than security release/);
  });

  it('rejects a release line past its end of life, even when fully patched', () => {
    expect(check('20.20.2')).toMatch(/end of life on 2026-04-30/);
  });

  it('rejects a release line it does not know', () => {
    expect(check('99.0.0')).toMatch(/unknown release line/);
  });
});
