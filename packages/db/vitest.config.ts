import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hmn/db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
