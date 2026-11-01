import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import apiReference from '@scalar/fastify-api-reference';
import fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Env } from './config/env.js';
import { registerAuthModule } from './modules/auth/index.js';
import { registerHealthModule } from './modules/health/index.js';
import type { DatabaseClient } from './shared/database/prisma-client.js';
import { toClientNetwork } from './shared/http/client-network.js';
import { handleError, handleNotFound } from './shared/http/error-handler.js';
import { createOriginGuard } from './shared/http/origin-guard.js';
import { systemClock } from './shared/time/clock.js';
import type { Clock } from './shared/time/clock.js';

const REDACTED_LOG_PATHS = ['req.headers.authorization', 'req.headers.cookie'];

export interface AppDependencies {
  env: Env;
  database: DatabaseClient;
  clock?: Clock;
}

function buildLoggerOptions(env: Env): NonNullable<FastifyServerOptions['logger']> {
  const base = { level: env.LOG_LEVEL, redact: REDACTED_LOG_PATHS };
  return env.NODE_ENV === 'development' ? { ...base, transport: { target: 'pino-pretty' } } : base;
}

export async function buildApp({
  env,
  database,
  clock = systemClock,
}: AppDependencies): Promise<FastifyInstance> {
  const app = fastify({
    logger: buildLoggerOptions(env),
    genReqId: () => crypto.randomUUID(),
    trustProxy: (_address, hop) => hop < env.TRUSTED_PROXY_HOPS,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);
  app.addHook('onRequest', createOriginGuard(env.CORS_ALLOWED_ORIGINS));

  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ALLOWED_ORIGINS, credentials: true });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: ({ ip }) => toClientNetwork(ip),
  });

  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: { info: { title: 'Juízo API', version: '0.1.0' } },
      transform: jsonSchemaTransform,
    });
    await app.register(apiReference, { routePrefix: '/docs' });
  }

  await registerHealthModule(app, database);
  await registerAuthModule(app, {
    database,
    clock,
    useSecureCookies: env.NODE_ENV === 'production',
  });

  app.addHook('onClose', async () => {
    await database.$disconnect();
  });

  return app;
}
