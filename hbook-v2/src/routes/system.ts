/**
 * hbook — system routes (public, no API key).
 */
import type { FastifyInstance } from 'fastify';
import { R } from '../schemas/core';
import { prisma } from '../lib/prisma';

export default async function systemRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/',
    {
      schema: {
        summary: 'Service banner',
        tags: ['System'],
        security: [],
        response: { 200: R('RootResponse') },
      },
      config: { rateLimit: false },
    },
    async () => ({
      name: 'hbook',
      version: '1.0.0',
      description: 'Fast, secure, multi-tenant booking engine API.',
      docs: '/docs',
      health: '/health',
    }),
  );

  fastify.get(
    '/health',
    {
      schema: {
        summary: 'Health check (liveness + database readiness)',
        tags: ['System'],
        security: [],
        response: { 200: R('HealthResponse'), 503: R('HealthResponse') },
      },
      config: { rateLimit: false },
    },
    async (_req, reply) => {
      let db: 'up' | 'down' = 'up';
      try {
        await Promise.race([
          prisma.$queryRaw`SELECT 1`,
          new Promise((_, rej) => setTimeout(() => rej(new Error('db timeout')), 2000)),
        ]);
      } catch {
        db = 'down';
      }
      const body = {
        status: 'ok' as const,
        version: '1.0.0',
        uptimeSeconds: Math.round(process.uptime()),
        db,
      };
      return reply.status(db === 'up' ? 200 : 503).send(body);
    },
  );
}
