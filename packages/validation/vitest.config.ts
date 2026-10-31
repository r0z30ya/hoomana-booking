import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hmn/validation',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
