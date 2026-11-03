import type { FastifyRequest } from 'fastify';

export function serializeRequestForLog({ id, method, url }: FastifyRequest): {
  id: string;
  method: string;
  url: string;
} {
  const [urlWithoutQuery = url] = url.split('?');
  return { id, method, url: urlWithoutQuery };
}
