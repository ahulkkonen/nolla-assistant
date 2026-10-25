process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PI_TELEMETRY = '0';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

/** Returns a frozen config; throws when a required value is missing or invalid. */
export function loadConfig(env: Env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  const userId = env.USER_ID ?? 'aleksi';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId))
    throw new Error('USER_ID must match [A-Za-z0-9_-]{1,64}');
  return Object.freeze({
    port,
    host: env.HOST ?? '127.0.0.1',
    dataDir: required(env, 'DATA_DIR'),
    litellmUrl: required(env, 'LITELLM_URL'),
    litellmMasterKey: required(env, 'LITELLM_MASTER_KEY'),
    userId,
    model: env.MODEL ?? 'zdr/strong',
    allowedOrigin: env.ALLOWED_ORIGIN ?? `http://localhost:${port}`,
    logLevel: env.LOG_LEVEL ?? 'info',
  });
}

export type Config = ReturnType<typeof loadConfig>;
