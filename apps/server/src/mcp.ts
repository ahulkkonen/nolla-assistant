import { readFileSync } from 'node:fs';
import { createMcpExtension, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { parse } from 'yaml';
import { z } from 'zod';

// Names stay inside Pi's `[A-Za-z0-9_]`, so `mcp__<server>__<tool>` needs no sanitizing.
const Server = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
    description: z.string().min(1).max(300).optional(),
    timeout: z.number().int().min(1).max(600).optional(),
    tools: z
      .array(
        z.object({ name: z.string().regex(/^[A-Za-z0-9_]{1,40}$/), write: z.boolean() }).strict(),
      )
      .min(1),
  })
  .strict();
const File = z
  .object({ servers: z.record(z.string().regex(/^[a-z0-9_]{1,16}$/), Server) })
  .strict();

export type McpServer = z.infer<typeof Server> & { name: string };
export type McpServers = Map<string, McpServer>;

/** `infra/mcp.yaml` (decision 0005). `none` means no MCP servers (tests, dev). Throws on a bad file. */
export function loadMcp(path: string): McpServers {
  if (path === 'none') return new Map();
  const { servers } = File.parse(parse(readFileSync(path, 'utf8')));
  return new Map(Object.entries(servers).map(([name, s]) => [name, { ...s, name }]));
}

const toolName = (s: McpServer, tool: string) => `mcp__${s.name}__${tool}`;
export const allowedToolNames = (s: McpServer) => s.tools.map((t) => toolName(s, t.name));
export const writeTools = (s: McpServer) =>
  s.tools.filter((t) => t.write).map((t) => toolName(s, t.name));

/**
 * Pi's MCP extension with the config passed as an option, not as `mcp.json` (decision 0005).
 * Only allowlisted tools are reachable (`hidden` server, `direct` per tool); codemode stays off.
 */
export function mcpExtension(servers: McpServer[], logPath: string): ExtensionFactory {
  return createMcpExtension({
    loadConfig: () => ({
      servers: servers.map((s) => ({
        name: s.name,
        source: 'infra/mcp.yaml',
        scope: 'extension' as const,
        config: {
          type: 'http' as const,
          url: s.url,
          // Also keeps the server instructions (they name the account) out of the system prompt.
          ...(s.description ? { description: s.description } : {}),
          ...(s.timeout ? { timeout: s.timeout } : {}),
          exposure: 'hidden' as const,
          toolExposure: Object.fromEntries(s.tools.map((t) => [t.name, 'direct' as const])),
        },
      })),
      autoEnableCodemode: false,
      errors: [],
    }),
    logPath,
    openUrl: () => {},
    updateConfig: () => {},
    startupWaitMs: 5000,
  });
}
