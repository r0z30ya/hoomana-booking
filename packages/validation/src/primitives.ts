import { z } from 'zod';

/**
 * Reusable primitive schemas.
 *
 * These are intentionally generic. Entity-specific schemas (tenant, patient,
 * appointment, ...) belong with the phases that introduce those entities, so that
 * this package stays a vocabulary of shared building blocks rather than a place
 * where domain rules accumulate.
 */

/** Any opaque UUID. Identifiers are validated by shape, never derived from user input. */
export const uuidSchema = z.uuid();

export const emailSchema = z.email();

export const shortTextSchema = z.string().trim().min(1).max(255);

export const longTextSchema = z.string().trim().max(10_000);

export const positiveIntegerSchema = z.number().int().positive();

/** A pagination window with a hard ceiling so a client cannot request unbounded rows. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;
