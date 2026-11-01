import closeWithGrace from 'close-with-grace';
import { buildApp } from './app.js';
import { parseEnv } from './config/env.js';
import { createDatabaseClient } from './shared/database/prisma-client.js';

const SHUTDOWN_TIMEOUT_IN_MS = 10_000;

const env = parseEnv(process.env);
const app = await buildApp({ env, database: createDatabaseClient(env.DATABASE_URL) });

closeWithGrace({ delay: SHUTDOWN_TIMEOUT_IN_MS }, async ({ err }) => {
  if (err) {
    app.log.error({ err }, 'Shutting down after a fatal error');
  }
  await app.close();
});

await app.listen({ host: env.HOST, port: env.PORT });
