import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hmn/shared',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
