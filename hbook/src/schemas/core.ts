/**
 * hbook — shared JSON Schemas (core).
 * Schemas double as: request validation (AJV), response serialization
 * (fast-json-stringify, strips undeclared fields — leak-proof by design)
 * and OpenAPI documentation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Reference an addSchema()'d shared schema from a route.
 * IMPORTANT: routes must always reference shared schemas via $ref —
 * passing the same $id-bearing object into multiple routes inside one
 * encapsulation context breaks fastify's serialization schema cache.
 */
export const R = (id: string): { $ref: string } => ({ $ref: `${id}#` });

export const ErrorSchema: any = {
  $id: 'Error',
  type: 'object',
  description: 'Standard error envelope returned by every failed request.',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', examples: ['SLOT_TAKEN', 'UNAUTHORIZED'] },
        message: { type: 'string' },
        details: { description: 'Optional structured details (e.g. AJV validation errors).' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
};

export const HealthResponse: any = {
  $id: 'HealthResponse',
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
    version: { type: 'string' },
    uptimeSeconds: { type: 'number' },
    db: { type: 'string', enum: ['up', 'down'] },
  },
  required: ['status', 'version', 'uptimeSeconds', 'db'],
};

export const RootResponse: any = {
  $id: 'RootResponse',
  type: 'object',
  properties: {
    name: { type: 'string' },
    version: { type: 'string' },
    description: { type: 'string' },
    docs: { type: 'string' },
    health: { type: 'string' },
  },
};

/** Cursor-based pagination query (used by all list endpoints). */
export const ListQuery: any = {
  $id: 'ListQuery',
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Page size (max 100).' },
    cursor: { type: 'string', maxLength: 128, description: 'Opaque cursor from a previous page (nextCursor).' },
  },
};
