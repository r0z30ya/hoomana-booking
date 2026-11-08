/**
 * hbook — tenant provisioning.
 *
 * POST /v1/tenants is the ONLY unauthenticated write endpoint and is guarded
 * by the HBOOK_SETUP_TOKEN master token (constant-time compared) plus a
 * strict per-IP rate limit. It creates the tenant, its owner user and the
 * first API key — the key is returned exactly once.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { conflict, unauthorized } from '../lib/errors';
import { generateApiKey, safeEqual } from '../lib/keys';
import { prisma } from '../lib/prisma';
import { assertTimeZone } from '../lib/time';
import { R } from '../schemas/core';

export default async function tenantRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/tenants',
    {
      schema: {
        summary: 'Create a tenant (requires X-Setup-Token master token)',
        description:
          'Provisions a tenant, its OWNER user and the first API key. The API key is returned once — store it immediately.',
        tags: ['Tenants'],
        security: [],
        headers: {
          type: 'object',
          required: ['x-setup-token'],
          properties: {
            'x-setup-token': { type: 'string', minLength: 8, maxLength: 256 },
          },
        },
        body: R('TenantCreateBody'),
        response: { 201: R('TenantCreated'), 401: R('Error'), 409: R('Error') },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const token = request.headers['x-setup-token'] as string;
      if (!safeEqual(token, config.setupToken)) {
        throw unauthorized('SETUP_TOKEN_INVALID', 'Invalid setup token.');
      }

      const body = request.body as {
        name: string;
        slug: string;
        timezone?: string;
        owner: { name?: string; email?: string; timezone?: string };
      };

      const tenantTimezone = body.timezone ?? config.defaultTimezone;
      assertTimeZone(tenantTimezone);
      const ownerTimezone = body.owner.timezone ?? tenantTimezone;
      assertTimeZone(ownerTimezone);

      const { key, prefix, hashedKey } = generateApiKey();

      try {
        const result = await prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: { name: body.name, slug: body.slug, timezone: tenantTimezone },
          });
          const owner = await tx.user.create({
            data: {
              tenantId: tenant.id,
              name: body.owner.name ?? 'Owner',
              email: body.owner.email ? body.owner.email.toLowerCase() : null,
              timezone: ownerTimezone,
              role: 'OWNER',
              isHost: true,
            },
          });
          const apiKey = await tx.apiKey.create({
            data: { tenantId: tenant.id, name: 'default', hashedKey, prefix },
          });
          return { tenant, owner, apiKey };
        });

        request.log.info({ tenantId: result.tenant.id }, 'tenant created');

        return reply.status(201).send({
          tenant: result.tenant,
          owner: result.owner,
          apiKey: {
            id: result.apiKey.id,
            name: result.apiKey.name,
            prefix: result.apiKey.prefix,
            key,
          },
        });
      } catch (e: unknown) {
        if (
          e &&
          typeof e === 'object' &&
          'code' in e &&
          (e as { code: string }).code === 'P2002'
        ) {
          throw conflict('SLUG_TAKEN', `Tenant slug "${body.slug}" is already in use.`);
        }
        throw e;
      }
    },
  );
}
