/**
 * hbook — fastify type augmentation.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Tenant } from '@prisma/client';
import type { ApiKeyContext } from '../plugins/auth';

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
    apiKey?: ApiKeyContext;
  }

  interface FastifyInstance {
    requireApiKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifySchema {
    security?: Array<Record<string, string[]>>;
  }
}
