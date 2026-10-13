import { defineConfig } from 'vitest/config';

/**
 * Root test orchestrator.
 *
 * Each workspace owns its own vitest config so that environment (node vs jsdom),
 * setup files and build plugins stay local to the code they test. This file only
 * composes them into a single `vitest run`.
 *
 * Node workspaces resolve `@hmn/*` imports through their built `dist/` output, which
 * is why the root `test` script builds before running. Tests therefore exercise the
 * same artifacts that run in production rather than raw source.
 *
 * `packages/domain` has no config: it contains no implementation yet (Phase 3+).
 */
export default defineConfig({
  test: {
    projects: [
      'packages/validation',
      'packages/shared',
      'packages/db',
      'packages/integrations',
      'apps/api',
      'apps/worker',
      'apps/web',
    ],
  },
});
