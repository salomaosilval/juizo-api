import { readFileSync } from 'node:fs';

const RELEASES_URL = 'https://nodejs.org/dist/index.json';
const SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';

export interface NodeRelease {
  version: string;
  security: boolean;
}

export type NodeSchedule = Record<string, { end: string }>;

interface NodeSecurityInput {
  pinnedVersion: string;
  today: string;
  releases: readonly NodeRelease[];
  schedule: NodeSchedule;
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, '').split('.').map(Number);
}

function isOlderThan(version: string, reference: string): boolean {
  const [major = 0, minor = 0, patch = 0] = parseVersion(version);
  const [referenceMajor = 0, referenceMinor = 0, referencePatch = 0] = parseVersion(reference);
  return (major - referenceMajor || minor - referenceMinor || patch - referencePatch) < 0;
}

export function findNodeSecurityProblem({
  pinnedVersion,
  today,
  releases,
  schedule,
}: NodeSecurityInput): string | null {
  const [major] = parseVersion(pinnedVersion);
  const releaseLine = schedule[`v${major ?? ''}`];
  if (!releaseLine) {
    return `Node ${pinnedVersion} belongs to an unknown release line.`;
  }
  if (releaseLine.end < today) {
    return `Node ${pinnedVersion} reached end of life on ${releaseLine.end}.`;
  }

  const lastSecurityRelease = releases.find(
    ({ version, security }) => security && version.startsWith(`v${major ?? ''}.`),
  );
  if (lastSecurityRelease && isOlderThan(pinnedVersion, lastSecurityRelease.version)) {
    return `Node ${pinnedVersion} is older than security release ${lastSecurityRelease.version}.`;
  }
  return null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

if (import.meta.main) {
  const pinnedVersion = process.argv[2] ?? readFileSync('.nvmrc', 'utf8').trim();
  const problem = findNodeSecurityProblem({
    pinnedVersion,
    today: new Date().toISOString().slice(0, 10),
    releases: await fetchJson<NodeRelease[]>(RELEASES_URL),
    schedule: await fetchJson<NodeSchedule>(SCHEDULE_URL),
  });

  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Node ${pinnedVersion} has no known security problem.\n`);
  }
}
