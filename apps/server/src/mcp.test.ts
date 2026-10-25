import { expect, test } from 'vitest';
import { loadConfig } from './config.ts';
import { allowedToolNames, loadMcp, writeTools } from './mcp.ts';

test('infra/mcp.yaml parses; manage_event is the only write', () => {
  const config = loadConfig({
    DATA_DIR: '/tmp',
    LITELLM_URL: 'http://x',
    LITELLM_MASTER_KEY: 'k',
    AUTH_ORIGIN: 'http://localhost:3000',
    COOKIE_SECRET: 'x'.repeat(32),
  });
  const ws = loadMcp(config.mcpConfig).get('workspace');
  if (!ws) throw new Error('workspace missing');
  expect(ws.url).toBe('http://mcp-workspace:8000/mcp');
  expect(allowedToolNames(ws)).toContain('mcp__workspace__get_events');
  expect(writeTools(ws)).toEqual(['mcp__workspace__manage_event']);
  expect(loadMcp('none').size).toBe(0);
});
