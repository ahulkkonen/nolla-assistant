import { defineConfig } from 'vitest/config';

// beforeAll builds the skill-runner image (first build pulls Debian packages).
export default defineConfig({ test: { testTimeout: 60000, hookTimeout: 600000 } });
