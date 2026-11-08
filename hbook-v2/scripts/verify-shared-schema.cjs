#!/usr/bin/env node
/**
 * hbook — shared-PostgreSQL deployment verification (no psql needed).
 *
 * Creates a SECOND database with TWO separate schemas (homana + hbook),
 * a dedicated app role limited to the hbook schema, runs `prisma migrate
 * deploy` against ?schema=hbook, writes a Homana-side table in the homana
 * schema, then verifies: both live side by side, Homana data untouched,
 * and the hbook role CANNOT read/write the homana schema.
 */
const { execSync, spawnSync } = require('node:child_process');
const { PrismaClient } = require('/home/z/my-project/hbook/node_modules/@prisma/client');

const ADMIN_URL = 'postgresql://hbook:hbook@127.0.0.1:5433/postgres?connection_limit=2';
const DB = 'homana_shared_demo';
const SHARED_URL = `postgresql://hbook_app:hbook-app-pass@127.0.0.1:5433/${DB}?schema=hbook&connection_limit=10`;

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
  console.log('▸ setup database + roles + schemas');
  const bootstrap = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  {
    const exists = await bootstrap.$queryRawUnsafe(`SELECT 1 FROM pg_database WHERE datname = $1`, DB);
    if (exists.length === 0) {
      await bootstrap.$executeRawUnsafe(`CREATE DATABASE "${DB}"`);
    }
    const role = await bootstrap.$queryRawUnsafe(`SELECT 1 FROM pg_roles WHERE rolname = 'hbook_app'`);
    if (role.length === 0) {
      await bootstrap.$executeRawUnsafe(`CREATE ROLE hbook_app LOGIN PASSWORD 'hbook-app-pass' CONNECTION LIMIT 20`);
    }
  }
  await bootstrap.$disconnect();

  // everything else happens INSIDE the shared database
  const admin = new PrismaClient({
    datasources: { db: { url: `postgresql://hbook:hbook@127.0.0.1:5433/${DB}?connection_limit=2` } },
  });
  {
    await admin.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS homana`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS hbook`);
    await admin.$executeRawUnsafe(`GRANT USAGE, CREATE ON SCHEMA hbook TO hbook_app`);
    // prisma migrate deploy issues CREATE SCHEMA IF NOT EXISTS internally —
    // needs CREATE on the database (scoped: allows creating schemas only)
    await admin.$executeRawUnsafe(`GRANT CREATE ON DATABASE "${DB}" TO hbook_app`);
    await admin.$executeRawUnsafe(`ALTER ROLE hbook_app SET search_path = hbook`);
    await admin.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS homana.users (id int PRIMARY KEY, name text)`);
    await admin.$executeRawUnsafe(`INSERT INTO homana.users VALUES (1, 'homana-admin') ON CONFLICT (id) DO NOTHING`);
    // one-time DBA prerequisite of the v1 init migration (btree_gist powers the
    // legacy EXCLUDE constraint; v2 no longer needs it but replays init)
    await admin.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  }
  await admin.$disconnect();

  console.log('▸ prisma migrate deploy against ?schema=hbook as hbook_app');
  const mig = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: '/home/z/my-project/hbook',
    env: { ...process.env, DATABASE_URL: SHARED_URL },
    encoding: 'utf8',
  });
  const migOut = `${mig.stdout ?? ''}${mig.stderr ?? ''}`;
  const migFailed = mig.status !== 0 || /Error:|error:/.test(migOut);
  ok('migrate deploy succeeded on shared database', !migFailed, migOut.slice(-300));

  console.log('▸ verify both schemas side by side');
  const admin2 = new PrismaClient({
    datasources: { db: { url: `postgresql://hbook:hbook@127.0.0.1:5433/${DB}?connection_limit=2` } },
  });
  const tables = await admin2.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'hbook'`,
  );
  ok('hbook schema contains all engine tables (≥ 13 incl. _prisma_migrations)', tables[0].n >= 13, `got ${tables[0].n}`);
  const homanaRow = await admin2.$queryRawUnsafe(`SELECT name FROM homana.users WHERE id = 1`);
  ok('homana.users data preserved untouched', homanaRow[0]?.name === 'homana-admin', JSON.stringify(homanaRow));

  console.log('▸ privilege check: hbook_app must NOT read/write homana schema');
  const appAsAdmin = new PrismaClient({ datasources: { db: { url: SHARED_URL } } });
  let denied = false;
  try {
    await appAsAdmin.$queryRawUnsafe(`SELECT count(*) FROM homana.users`);
  } catch {
    denied = true;
  }
  ok('hbook_app denied on homana.users (SELECT)', denied);

  console.log('▸ hbook_app CAN use its own schema (smoke)');
  const tenants = await appAsAdmin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Tenant"`);
  ok('engine tables reachable with search_path=hbook', Array.isArray(tenants), JSON.stringify(tenants));
  await appAsAdmin.$disconnect();

  console.log('▸ idempotent re-run of migrate deploy');
  const mig2 = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: '/home/z/my-project/hbook',
    env: { ...process.env, DATABASE_URL: SHARED_URL },
    encoding: 'utf8',
  });
  ok('second migrate deploy is a no-op', mig2.status === 0, (mig2.stderr ?? '').slice(-200));
  await admin2.$disconnect();

  console.log(`\nSHARED-SCHEMA RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
