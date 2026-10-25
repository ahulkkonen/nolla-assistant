import { fileURLToPath } from 'node:url';

process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PI_TELEMETRY = '0';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Returns a frozen config; throws when a required value is missing or invalid. */
export function loadConfig(env: Env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  const userId = env.USER_ID ?? 'aleksi';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId))
    throw new Error('USER_ID must match [A-Za-z0-9_-]{1,64}');
  const origin = new URL(required(env, 'AUTH_ORIGIN'));
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:')
    throw new Error('AUTH_ORIGIN must be http or https');
  if (origin.protocol === 'http:' && !LOOPBACK.has(origin.hostname))
    throw new Error('AUTH_ORIGIN must be https unless the host is loopback');
  const trust = env.TRUST_PROXY;
  const cookieSecret = required(env, 'COOKIE_SECRET');
  if (cookieSecret.length < 32) throw new Error('COOKIE_SECRET must be at least 32 characters');
  return Object.freeze({
    port,
    host: env.HOST ?? '127.0.0.1',
    dataDir: required(env, 'DATA_DIR'),
    litellmUrl: required(env, 'LITELLM_URL'),
    litellmMasterKey: required(env, 'LITELLM_MASTER_KEY'),
    userId,
    agentsDir: env.AGENTS_DIR || fileURLToPath(new URL('../../../agents', import.meta.url)),
    automationsDir:
      env.AUTOMATIONS_DIR || fileURLToPath(new URL('../../../automations', import.meta.url)),
    skillsDir: env.SKILLS_DIR || fileURLToPath(new URL('../../../skills', import.meta.url)),
    // Tests shorten it; the plan fixes 10 minutes.
    approvalTimeoutMs: Number(env.APPROVAL_TIMEOUT_MS) || 10 * 60_000,
    authOrigin: origin.origin,
    passkeyRpId: env.AUTH_PASSKEY_RP_ID || origin.hostname,
    passwordHash: env.AUTH_PASSWORD_HASH || undefined,
    cookieSecret,
    cookieSecure: origin.protocol === 'https:',
    // Fastify `trustProxy`: unset is false, digits are a hop count, anything else an address/CIDR.
    trustProxy: !trust ? false : /^\d+$/.test(trust) ? Number(trust) : trust,
    webDist: env.WEB_DIST || undefined,
    logLevel: env.LOG_LEVEL ?? 'info',
    // Dev only when unset: no masking extension and no display restoration, so real values reach
    // the model. Production always sets it (invariant 1).
    pseudoUrl: env.PSEUDO_URL || undefined,
    // `none` disables MCP. Decision 0005.
    mcpConfig: env.MCP_CONFIG || fileURLToPath(new URL('../../../infra/mcp.yaml', import.meta.url)),
    // Base URL for the OAuth callback forward; unset means the origin of the `workspace` URL.
    mcpWorkspaceUrl: env.MCP_WORKSPACE_URL || undefined,
    // The user's own Google address: allowlisted in the vault at startup (decision 0005).
    selfEmail: env.SELF_EMAIL || undefined,
    // Both or nothing: without them no `bash` tool exists (Pi's built-in one is never enabled).
    broker:
      env.BROKER_URL && env.BROKER_TOKEN
        ? { url: env.BROKER_URL, token: env.BROKER_TOKEN }
        : undefined,
  });
}

export type Config = ReturnType<typeof loadConfig>;
