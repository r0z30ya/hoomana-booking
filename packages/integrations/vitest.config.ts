import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@hmn/integrations',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
