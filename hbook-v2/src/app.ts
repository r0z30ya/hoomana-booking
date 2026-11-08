/**
 * hbook — application assembly.
 *
 * Security posture:
 *  - Helmet security headers on every response
 *  - CORS is opt-in via CORS_ORIGINS (default: none — server-to-server)
 *  - Global rate limit per API key / IP (+ stricter limit on tenant creation)
 *  - AJV request validation with removeAdditional (unknown fields dropped)
 *  - Response serialization via JSON Schema (undeclared fields can never leak)
 *  - request body limit 64 KB, request logging with secret redaction
 */
import Fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Prisma } from '@prisma/client';
import { config } from './config';
import { AppError } from './lib/errors';
import { prisma } from './lib/prisma';
import authPlugin from './plugins/auth';
import * as coreSchemas from './schemas/core';
import * as resourceSchemas from './schemas/resources';
import systemRoutes from './routes/system';
import tenantRoutes from './routes/tenants';
import meRoutes from './routes/me';
import userRoutes from './routes/users';
import eventTypeRoutes from './routes/eventTypes';
import availabilityRoutes from './routes/availability';
import slotRoutes from './routes/slots';
import bookingRoutes from './routes/bookings';
import webhookRoutes from './routes/webhooks';
import apiKeyRoutes from './routes/apiKeys';

const ALL_SCHEMAS: Array<{ $id: string }> = [
  coreSchemas.ErrorSchema,
  coreSchemas.HealthResponse,
  coreSchemas.RootResponse,
  coreSchemas.ListQuery,
  resourceSchemas.TenantRef,
  resourceSchemas.TenantCreateBody,
  resourceSchemas.TenantCreated,
  resourceSchemas.SetupTokenHeader,
  resourceSchemas.MeResponse,
  resourceSchemas.UserRef,
  resourceSchemas.UserInput,
  resourceSchemas.UserPatch,
  resourceSchemas.UsersList,
  resourceSchemas.IdParam,
  resourceSchemas.EventTypeRef,
  resourceSchemas.EventTypeInput,
  resourceSchemas.EventTypePatch,
  resourceSchemas.EventTypesList,
  resourceSchemas.AvailabilityWindow,
  resourceSchemas.AvailabilityWeeklyItem,
  resourceSchemas.AvailabilityPutBody,
  resourceSchemas.DateOverrideInput,
  resourceSchemas.AvailabilityResponse,
  resourceSchemas.OverrideDateParam,
  resourceSchemas.SlotsQuery,
  resourceSchemas.SlotsResponse,
  resourceSchemas.BookingRef,
  resourceSchemas.HostRef,
  resourceSchemas.BookingCreateBody,
  resourceSchemas.BookingsQuery,
  resourceSchemas.BookingsList,
  resourceSchemas.BookingCancelBody,
  resourceSchemas.BookingRescheduleBody,
  resourceSchemas.BookingUidParam,
  resourceSchemas.WebhookEventsEnum,
  resourceSchemas.WebhookCreateBody,
  resourceSchemas.WebhookRef,
  resourceSchemas.WebhookCreated,
  resourceSchemas.WebhooksList,
  resourceSchemas.WebhookDeliveryRef,
  resourceSchemas.DeliveriesList,
  resourceSchemas.ApiKeyRef,
  resourceSchemas.ApiKeyCreated,
  resourceSchemas.ApiKeyCreateBody,
  resourceSchemas.ApiKeysList,
];

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers["x-api-key"]',
          'req.headers["x-setup-token"]',
          'req.headers.authorization',
        ],
        censor: '[REDACTED]',
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        removeAdditional: true,
        useDefaults: true,
        coerceTypes: true,
      },
    },
  });

  // ── shared schemas FIRST (validation + serialization + docs) ─────
  // Added before any plugin/route registration so every encapsulation
  // context sees them.
  for (const schema of ALL_SCHEMAS) {
    app.addSchema(schema);
  }

  // ── security plugins ──────────────────────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false }); // CSP off: Swagger UI needs inline scripts

  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Setup-Token'],
      maxAge: 600,
    });
  }

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    // Authenticated requests get their own bucket per API key; everything
    // else (and every INVALID key) falls back to the client IP, so rotating
    // random keys cannot create fresh rate-limit buckets. The auth plugin
    // additionally limits failed authentications per IP (authFailLimit).
    // Behind a reverse proxy set TRUST_PROXY=true so req.ip is the real client.
    keyGenerator: (req) => (req.apiKey ? `k:${req.apiKey.id}` : req.ip),
    errorResponseBuilder: () => ({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Slow down and retry shortly.',
      },
    }),
  });

  // ── OpenAPI + Swagger UI ──────────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'hbook API',
        description:
          'Fast, secure, multi-tenant booking engine API — inspired by cal.com / cal.diy. Authenticate with the X-API-Key header.',
        version: '1.0.0',
      },
      servers: [{ url: '/' }],
      tags: [
        { name: 'System', description: 'Health and service banner' },
        { name: 'Tenants', description: 'Tenant provisioning (setup token)' },
        { name: 'Users', description: 'Hosts and members' },
        { name: 'Event Types', description: 'Bookable services' },
        { name: 'Availability', description: 'Weekly schedule + date overrides' },
        { name: 'Slots', description: 'Free slot discovery' },
        { name: 'Bookings', description: 'Booking lifecycle' },
        { name: 'Webhooks', description: 'Signed event notifications' },
        { name: 'API Keys', description: 'Key management' },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'none', deepLinking: true, tryItOutEnabled: true },
  });

  // ── error handling ────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const body: Record<string, unknown> = {
        error: { code: err.code, message: err.message },
      };
      if (err.details !== undefined) (body.error as Record<string, unknown>).details = err.details;
      return reply.status(err.statusCode).send(body);
    }
    const anyErr = err as { validation?: unknown; statusCode?: number; code?: string };
    // @fastify/rate-limit rejections (either its built error or the custom body)
    const rateBody = (err as { error?: { code?: string } })?.error?.code === 'RATE_LIMITED';
    if (rateBody || anyErr.statusCode === 429 || anyErr.code === 'FST_ERR_RATE_LIMITED') {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and retry shortly.' },
      });
    }
    if (anyErr.validation) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', details: anyErr.validation },
      });
    }
    if (anyErr.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send({ error: { code: 'EMPTY_BODY', message: 'Request body must be valid JSON.' } });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
      }
      if (err.code === 'P2002') {
        return reply.status(409).send({ error: { code: 'DUPLICATE', message: 'Resource already exists.' } });
      }
      if (err.code === 'P2003') {
        return reply.status(422).send({ error: { code: 'REFERENCE_INVALID', message: 'Referenced resource does not exist.' } });
      }
    }
    // database capacity/overlap guard (constraint trigger / CHECK constraint)
    const guardMsg = String((err as Error).message ?? '');
    if (guardMsg.includes('HBOOK_CAPACITY_EXCEEDED') || guardMsg.includes('HBOOK_OVERLAP')) {
      return reply.status(409).send({
        error: { code: 'SLOT_TAKEN', message: 'This slot has just been booked (database conflict guard).' },
      });
    }
    if (guardMsg.includes('SlotInstance_taken_bounds')) {
      return reply.status(422).send({
        error: { code: 'CAPACITY_CONFLICT', message: 'Operation would exceed the configured capacity.' },
      });
    }
    if (anyErr.statusCode && anyErr.statusCode >= 400 && anyErr.statusCode < 500) {
      return reply.status(anyErr.statusCode).send({
        error: { code: 'BAD_REQUEST', message: (err as Error).message },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  // ── routes ────────────────────────────────────────────────────────
  await app.register(authPlugin);
  await app.register(systemRoutes); // / and /health

  // POST /v1/tenants lives under /v1 but outside the API-key guard:
  // it authenticates with the X-Setup-Token master token instead.
  await app.register(
    async (v1) => {
      await v1.register(tenantRoutes);
    },
    { prefix: '/v1' },
  );

  await app.register(
    async (api) => {
      api.addHook('onRequest', app.requireApiKey);
      await api.register(meRoutes);
      await api.register(userRoutes);
      await api.register(eventTypeRoutes);
      await api.register(availabilityRoutes);
      await api.register(slotRoutes);
      await api.register(bookingRoutes);
      await api.register(webhookRoutes);
      await api.register(apiKeyRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}
