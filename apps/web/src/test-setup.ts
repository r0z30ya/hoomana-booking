import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Registered explicitly rather than relying on Testing Library's automatic cleanup,
// which only activates when Vitest globals are enabled.
afterEach(() => {
  cleanup();
});
