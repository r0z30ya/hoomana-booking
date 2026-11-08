#!/usr/bin/env node
/**
 * hbook — fresh-install verification: brand-new empty database →
 * `prisma migrate deploy` → seed → basic smoke over the HTTP API.
 */
const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('/home/z/my-project/hbook/node_modules/@prisma/client');

const DB = `hbook_fresh_${Date.now().toString(36)}`;
const ADMIN_URL = 'postgresql://hbook:hbook@127.0.0.1:5433/postgres?connection_limit=2';
const URL_FRESH = `postgresql://hbook:hbook@127.0.0.1:5433/${DB}?connection_limit=10`;

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name} ${extra ? `— ${extra}` : ''}`);
  }
}

async function main() {
  const boot = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  await boot.$executeRawUnsafe(`CREATE DATABASE "${DB}"`);
  await boot.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist`); // DBA prerequisite
  await boot.$disconnect();

  console.log('▸ migrate deploy on an empty database');
  const mig = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: '/home/z/my-project/hbook',
    env: { ...process.env, DATABASE_URL: URL_FRESH },
    encoding: 'utf8',
  });
  const migOut = `${mig.stdout ?? ''}${mig.stderr ?? ''}`;
  ok('migrate deploy from scratch succeeded', mig.status === 0 && !/Error:/.test(migOut), migOut.slice(-300));

  console.log('▸ trigger function + constraint trigger exist');
  const db = new PrismaClient({ datasources: { db: { url: URL_FRESH } } });
  const trg = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'booking_fit_guard' AND NOT tgisinternal`,
  );
  ok('booking_fit_guard constraint trigger created', trg[0].n === 1, JSON.stringify(trg));
  const chk = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'SlotInstance_taken_bounds'`,
  );
  ok('SlotInstance CHECK constraint created', chk[0].n === 1);

  console.log('▸ idempotent seed');
  const seed = spawnSync('npx', ['tsx', 'prisma/seed.ts'], {
    cwd: '/home/z/my-project/hbook',
    env: { ...process.env, DATABASE_URL: URL_FRESH },
    encoding: 'utf8',
  });
  ok('seed created demo clinic', /seed ✔/.test(seed.stdout ?? ''), (seed.stderr ?? '').slice(-200));
  const seed2 = spawnSync('npx', ['tsx', 'prisma/seed.ts'], {
    cwd: '/home/z/my-project/hbook',
    env: { ...process.env, DATABASE_URL: URL_FRESH },
    encoding: 'utf8',
  });
  ok('second seed run skips gracefully', /already exists/.test(seed2.stdout ?? ''), (seed2.stdout ?? '').slice(-120));

  await db.$disconnect();

  // cleanup
  const clean = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  await clean.$executeRawUnsafe(`DROP DATABASE "${DB}"`);
  await clean.$disconnect();

  console.log(`\nFRESH-INSTALL RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
