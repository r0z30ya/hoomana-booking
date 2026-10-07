import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hmn/worker',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
