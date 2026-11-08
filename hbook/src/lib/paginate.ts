/**
 * hbook — cursor pagination helper.
 *
 * The cursor is the row's unique id. Stability comes from the compound
 * orderBy ([sortField desc, id desc]): id acts as the tiebreaker, so
 * pages are deterministic even with concurrent inserts.
 * (Prisma `cursor` accepts only unique fields — a bare id works everywhere.)
 */
import { unprocessable } from './errors';

export interface Page {
  limit: number;
  cursor?: string;
}

export function parsePage(query: { limit?: number; cursor?: string }): Page {
  const limit = query.limit ?? 20;
  if (!query.cursor) return { limit };
  const id = query.cursor.trim();
  if (!id || id.length > 64) {
    throw unprocessable('INVALID_CURSOR', 'Malformed pagination cursor.');
  }
  return { limit, cursor: id };
}

export function pageResult<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? last.id : null };
}

/** Prisma findMany cursor fragment (spread into query options). */
export function cursorArg(cursor?: string): {
  cursor?: { id: string } | undefined;
  skip?: number | undefined;
} {
  return cursor ? { cursor: { id: cursor }, skip: 1 } : {};
}
