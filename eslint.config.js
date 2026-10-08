import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/src/generated/**',
      'legacy/**',
      // Build/tooling configs are not part of any tsconfig project, so they cannot
      // participate in type-aware linting. Prettier still formats them.
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Resolves each file to the nearest tsconfig.json, so linting works per workspace.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Backend and worker code logs through the injectable logger, never console.
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // ADR-0003 D4: tenant-scoped repositories accept a TenantTx handle only.
    // They must never reach the raw client factory or the generated client, and
    // must never import the platform repository family.
    files: ['packages/db/src/repositories/**/*.ts'],
    ignores: ['packages/db/src/repositories/platform/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/database.js', '**/generated/**'],
              message:
                'Tenant repositories accept a TenantTx handle only; raw client access is forbidden (ADR-0003 D4).',
            },
            {
              group: ['**/platform/**'],
              message:
                'Platform repositories are a separate module family and must not be imported from tenant-facing code (ADR-0003 D4/D5).',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
