import { defineConfig } from 'vitest/config';

// The core has no database, no framework and no network, so the suite needs
// none of the machinery a host's tests do: no environment, no setup file, no
// service container. That is the package's central claim, and a config that
// stayed this small is one piece of evidence for it.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
