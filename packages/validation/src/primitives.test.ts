import { describe, expect, it } from 'vitest';
import { emailSchema, paginationSchema, shortTextSchema, uuidSchema } from './primitives.js';

describe('paginationSchema', () => {
  it('defaults to a bounded first page', () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it('caps the page size so a client cannot request unbounded rows', () => {
    expect(paginationSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: 100 }).success).toBe(true);
  });

  it('rejects a negative offset and a zero limit', () => {
    expect(paginationSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('primitives', () => {
  it('validates UUID shape', () => {
    expect(uuidSchema.safeParse('6f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8').success).toBe(true);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('validates email shape', () => {
    expect(emailSchema.safeParse('clinician@example.com').success).toBe(true);
    expect(emailSchema.safeParse('clinician@').success).toBe(false);
  });

  it('trims surrounding whitespace and rejects blank text', () => {
    expect(shortTextSchema.parse('  Aramehr Clinic  ')).toBe('Aramehr Clinic');
    expect(shortTextSchema.safeParse('   ').success).toBe(false);
  });
});
