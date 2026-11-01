import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

const POSTGRES_IMAGE = 'postgres:18.6-alpine';

const runCommand = promisify(execFile);

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const databaseUrl = container.getConnectionUri();

  await runCommand('npx', ['--no', '--', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await container.stop();
  };
}
