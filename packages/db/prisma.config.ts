import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed the `url` property from the schema datasource block, so the
 * connection string for CLI commands (migrate, introspect, studio) is declared here.
 *
 * Because Node no longer loads `.env` implicitly, and because the repository root is
 * the single source of truth for local credentials, we load it explicitly before
 * resolving DATABASE_URL.
 *
 * IMPORTANT: run Prisma through the workspace scripts (`npm run prisma:generate`,
 * `npm run prisma:validate`), which execute with the working directory set to
 * `packages/db`. Running the CLI from an arbitrary directory will not locate the
 * root `.env` and will fail with a missing DATABASE_URL.
 */
const repositoryRootEnvFile = resolve(process.cwd(), '../../.env');

if (existsSync(repositoryRootEnvFile)) {
  process.loadEnvFile(repositoryRootEnvFile);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
