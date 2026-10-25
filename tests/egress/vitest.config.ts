import { defineConfig } from 'vitest/config';

// Compose startup happens in beforeAll; images must already be pulled.
export default defineConfig({ test: { testTimeout: 30000, hookTimeout: 150000 } });
