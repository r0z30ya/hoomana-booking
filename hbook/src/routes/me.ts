/**
 * hbook — identity of the authenticated API key.
 */
import type { FastifyInstance } from 'fastify';
import { R } from '../schemas/core';
import { MeResponse } from '../schemas/resources';

export default async function meRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/me',
    {
      schema: {
        summary: 'Current tenant and API key info',
        tags: ['API Keys'],
        security: [{ ApiKeyAuth: [] }],
        response: { 200: R('MeResponse') },
      },
    },
    async (request) => {
      return {
        tenant: request.tenant!,
        apiKey: {
          id: request.apiKey!.id,
          name: request.apiKey!.name,
          prefix: request.apiKey!.prefix,
          expiresAt: request.apiKey!.expiresAt,
        },
      };
    },
  );
}
