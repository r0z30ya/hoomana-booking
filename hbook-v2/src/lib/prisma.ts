/**
 * hbook — Prisma client singleton.
 * One connection pool per process; DATABASE_URL controls pool size,
 * e.g. postgresql://user:pass@host:5432/hbook?connection_limit=10&pool_timeout=10
 */
import { PrismaClient } from '@prisma/client';
import { config } from '../config';

export const prisma = new PrismaClient({
  log: config.isProd ? ['error'] : ['warn', 'error'],
});
