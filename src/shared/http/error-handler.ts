import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../errors/app-error.js';
import type { ErrorResponse } from './error-response.js';

const INTERNAL_ERROR: ErrorResponse = {
  code: 'INTERNAL_ERROR',
  message: 'An unexpected error occurred.',
};

const CODE_BY_CLIENT_STATUS: Partial<Record<number, string>> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMIT_EXCEEDED',
};

export function handleError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply.status(400).send({
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid.',
      issues: error.validation.map((issue) => ({
        path: issue.instancePath,
        message: issue.message ?? 'Invalid value.',
      })),
    } satisfies ErrorResponse);
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed with a server error');
    }
    return reply
      .status(error.statusCode)
      .send({ code: error.code, message: error.message } satisfies ErrorResponse);
  }

  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 400 && statusCode < 500) {
    return reply.status(statusCode).send({
      code: CODE_BY_CLIENT_STATUS[statusCode] ?? 'BAD_REQUEST',
      message: error.message,
    } satisfies ErrorResponse);
  }

  request.log.error({ err: error }, 'Unhandled request error');
  return reply.status(500).send(INTERNAL_ERROR);
}

export function handleNotFound(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .status(404)
    .send({ code: 'NOT_FOUND', message: 'Route not found.' } satisfies ErrorResponse);
}
