// Sandbox broker (plan §2 invariant 8, phase-5 decision 3). The only service with the Docker
// socket: it runs each command in a throwaway skill-runner container and streams the output.
import { createHash, timingSafeEqual } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import Fastify from 'fastify';
import { Agent, request } from 'undici';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createProxy } from './proxy.ts';

export type BrokerConfig = {
  token: string;
  dockerSocket: string;
  image: string;
  /** DATA_DIR as the broker sees it (work dirs are created here). */
  dataDir: string;
  /** The same directory as the Docker host sees it (bind source). Defaults to dataDir. */
  hostDataDir: string;
  skillsDir: string;
  hostSkillsDir: string;
  /** Egress proxy for `network: [hosts]`: listen port, and the host name runners reach it by. */
  proxyPort: number;
  proxyHost: string;
};

export const EGRESS_NETWORK = 'pa-skill-egress';
/** Internal Docker network (no gateway): runners with a host list reach only the broker's proxy. */
export const PROXY_NETWORK = 'pa-skill-proxy-only';
const RUNNER_UID = 10001;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL = /^[a-z0-9-]{1,64}$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_RUNS = 4;
const QUEUE_WAIT_MS = 10_000;
const MANAGED = 'pa.managed';
/**
 * Docker's default seccomp profile (moby/profiles seccomp/v0.1.0, the one Docker 29.1 ships) with
 * `symlink` and `symlinkat` removed: a runner cannot plant a symlink in the work dir that the
 * server's path guard would race against (phase 30). The Engine API takes the JSON text itself.
 */
const SECCOMP = JSON.stringify(
  JSON.parse(readFileSync(new URL('./seccomp.json', import.meta.url), 'utf8')),
);

export function loadConfig(env = process.env): BrokerConfig {
  const token = env.BROKER_TOKEN ?? '';
  if (token.length < 32) throw new Error('BROKER_TOKEN must be at least 32 characters');
  const dataDir = env.DATA_DIR ?? '/data';
  const skillsDir = env.SKILLS_DIR ?? '/app/skills';
  // In the image the fallback is wrong: `/data` would be a path on the Docker host, not the volume.
  if (env.NODE_ENV === 'production' && !env.HOST_DATA_DIR)
    throw new Error('HOST_DATA_DIR is required in production (docs/deploy.md, Sandbox)');
  return {
    token,
    dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    image: env.SKILL_RUNNER_IMAGE ?? 'pa-skill-runner:latest',
    dataDir,
    hostDataDir: env.HOST_DATA_DIR || dataDir,
    skillsDir,
    hostSkillsDir: env.HOST_SKILLS_DIR || skillsDir,
    proxyPort: Number(env.EGRESS_PROXY_PORT ?? 3128),
    proxyHost: env.EGRESS_PROXY_HOST ?? 'sandbox-broker',
  };
}

const RunBody = z.object({
  userId: z.string().regex(ID),
  chatId: z.string().regex(ID),
  command: z.string().min(1).max(100_000),
  skill: z.string().regex(SKILL).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  cwd: z
    .string()
    .max(1024)
    .refine(
      (c) => !posix.isAbsolute(c) && !posix.normalize(c).startsWith('..'),
      'cwd escapes /work',
    )
    .optional(),
});
type RunBody = z.infer<typeof RunBody>;

export type Network = 'none' | 'internet' | string[];

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Reads the `sandbox:` block of skills/<skill>/SKILL.md. `network: internet`, a list of hosts, or `none` (also for anything invalid). */
export function skillPolicy(skillsDir: string, skill: string | undefined) {
  const none = { network: 'none' as Network, bin: false };
  if (!skill) return none;
  const dir = join(skillsDir, skill);
  let text: string;
  try {
    text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return none;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const meta = fm ? (parseYaml(fm) as { sandbox?: { network?: unknown } } | null) : null;
  const n = meta?.sandbox?.network;
  const network: Network =
    n === 'internet'
      ? 'internet'
      : Array.isArray(n) && n.length > 0 && n.every((h) => typeof h === 'string' && HOST.test(h))
        ? (n as string[])
        : 'none'; // fail closed
  return { network, bin: existsSync(join(dir, 'bin')) };
}

/** Docker Engine API `POST /containers/create` body for one run. */
export function containerConfig(cfg: BrokerConfig, body: RunBody, proxyToken?: string) {
  const policy = skillPolicy(cfg.skillsDir, body.skill);
  const binds = [`${join(cfg.hostDataDir, 'work', body.userId)}:/work:rw`];
  if (body.skill && policy.bin)
    binds.push(`${join(cfg.hostSkillsDir, body.skill, 'bin')}:/skill/bin:ro`);
  const hosts = Array.isArray(policy.network) && proxyToken !== undefined;
  const proxy = `http://${proxyToken}@${cfg.proxyHost}:${cfg.proxyPort}`;
  return {
    Image: cfg.image,
    Env: hosts
      ? [
          `HTTP_PROXY=${proxy}`,
          `HTTPS_PROXY=${proxy}`,
          `http_proxy=${proxy}`,
          `https_proxy=${proxy}`,
          'NO_PROXY=',
          'no_proxy=',
        ]
      : [],
    Cmd: ['bash', '-lc', body.command],
    User: `${RUNNER_UID}:${RUNNER_UID}`,
    WorkingDir: posix.join('/work', body.cwd ?? '.'),
    Labels: {
      [MANAGED]: '1',
      'pa.user': body.userId,
      'pa.chat': body.chatId,
      ...(body.skill ? { 'pa.skill': body.skill } : {}),
    },
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      Binds: binds,
      NetworkMode: policy.network === 'internet' ? EGRESS_NETWORK : hosts ? PROXY_NETWORK : 'none', // a host list without a proxy token fails closed
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024, // equal to Memory: no swap
      NanoCpus: 2e9,
      PidsLimit: 256,
      ReadonlyRootfs: true,
      // An empty read-only tmpfs hides the trash from `bash` (phase-11 decision 4).
      Tmpfs: { '/tmp': 'rw,size=64m', '/work/.trash': 'ro,size=4k' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges', `seccomp=${SECCOMP}`],
      AutoRemove: false,
    },
  };
}

export function dockerClient(socketPath: string) {
  const dispatcher = new Agent({ connect: { socketPath } });
  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, json?: unknown) => {
    return request(`http://docker${path}`, {
      method,
      dispatcher,
      headers: { 'content-type': 'application/json' },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
  };
  const ok = async (method: 'GET' | 'POST' | 'DELETE', path: string, json?: unknown) => {
    const res = await call(method, path, json);
    const text = await res.body.text();
    if (res.statusCode >= 300)
      throw new Error(`docker ${method} ${path}: ${res.statusCode} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  return { call, ok, close: () => dispatcher.close() };
}
type Docker = ReturnType<typeof dockerClient>;

async function ensureNetwork(docker: Docker, name: string, internal: boolean) {
  const res = await docker.call('POST', '/networks/create', {
    Name: name,
    Driver: 'bridge',
    Internal: internal,
  });
  await res.body.dump();
  // 409: already exists (a concurrent run created it).
  if (res.statusCode >= 300 && res.statusCode !== 409)
    throw new Error(`docker network create: ${res.statusCode}`);
}

/**
 * Splits Docker's multiplexed log stream (8-byte frame headers, Tty false) into lines. One decoder
 * per stream keeps multi-byte characters intact across frames; a line longer than MAX_LINE is
 * flushed in pieces. Yields `bytes` (frame payload size) for the output cap.
 */
async function* demux(stream: AsyncIterable<Buffer>) {
  let buf = Buffer.alloc(0);
  const rest = { stdout: '', stderr: '' };
  const decoder = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const name = buf[0] === 2 ? 'stderr' : 'stdout';
      const lines = (rest[name] + decoder[name].write(buf.subarray(8, 8 + size))).split('\n');
      rest[name] = lines.pop() ?? '';
      buf = buf.subarray(8 + size);
      for (const line of lines) yield { stream: name, line, bytes: 0 };
      while (rest[name].length > MAX_LINE) {
        yield { stream: name, line: rest[name].slice(0, MAX_LINE), bytes: 0 };
        rest[name] = rest[name].slice(MAX_LINE);
      }
      yield { stream: name, line: undefined, bytes: size };
    }
  }
  for (const name of ['stdout', 'stderr'] as const)
    if (rest[name]) yield { stream: name, line: rest[name], bytes: 0 };
}

async function* run(
  cfg: BrokerConfig,
  docker: Docker,
  body: RunBody,
  gone: AbortSignal,
  startProxy: () => Promise<ReturnType<typeof createProxy>>,
) {
  const work = join(cfg.dataDir, 'work', body.userId);
  // `.trash` exists before Docker mounts the tmpfs on it, so Docker does not create it as root.
  mkdirSync(join(work, '.trash'), { recursive: true });
  // uid 10001 is shared: pa-server (infra/Dockerfile.server) and the runner both run as it, so the
  // work dir stays writable for Pi's own tools and for the sandbox.
  try {
    chownSync(work, RUNNER_UID, RUNNER_UID);
    chownSync(join(work, '.trash'), RUNNER_UID, RUNNER_UID);
  } catch {
    // Not root (tests on a workstation): Docker Desktop maps ownership itself.
  }
  const policy = skillPolicy(cfg.skillsDir, body.skill);
  const reg = Array.isArray(policy.network)
    ? (await startProxy()).register(policy.network)
    : undefined;
  try {
    yield* runContainer(cfg, docker, body, gone, reg?.token);
  } finally {
    reg?.forget();
  }
}

async function* runContainer(
  cfg: BrokerConfig,
  docker: Docker,
  body: RunBody,
  gone: AbortSignal,
  proxyToken: string | undefined,
) {
  const config = containerConfig(cfg, body, proxyToken);
  if (config.HostConfig.NetworkMode === EGRESS_NETWORK)
    await ensureNetwork(docker, EGRESS_NETWORK, false);
  if (config.HostConfig.NetworkMode === PROXY_NETWORK)
    await ensureNetwork(docker, PROXY_NETWORK, true);
  const { Id: id } = (await docker.ok('POST', '/containers/create', config)) as { Id: string };
  // Force removal kills a running container; the log stream then ends.
  const remove = () =>
    docker.call('DELETE', `/containers/${id}?force=1`).then(
      (r) => r.body.dump(),
      () => {},
    );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void docker.call('POST', `/containers/${id}/kill`).then(
      (r) => r.body.dump(),
      () => {},
    );
  }, body.timeoutMs ?? 120_000);
  const onGone = () => void remove();
  gone.addEventListener('abort', onGone);
  try {
    if (gone.aborted) return;
    await docker.ok('POST', `/containers/${id}/start`);
    const logs = await docker.call('GET', `/containers/${id}/logs?follow=1&stdout=1&stderr=1`);
    if (logs.statusCode >= 300) throw new Error(`docker logs: ${await logs.body.text()}`);
    let total = 0;
    for await (const { stream, line, bytes } of demux(logs.body)) {
      total += bytes;
      if (total > MAX_OUTPUT_BYTES) {
        await remove();
        yield { error: 'output limit' };
        return;
      }
      if (line !== undefined) yield { stream, line };
    }
    const { StatusCode } = (await docker.ok('POST', `/containers/${id}/wait`)) as {
      StatusCode: number;
    };
    yield { exit: StatusCode, timedOut };
  } finally {
    clearTimeout(timer);
    gone.removeEventListener('abort', onGone);
    await remove();
  }
}

/** At most `max` holders; a waiter gives up after `waitMs`. */
function semaphore(max: number, waitMs: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return {
    acquire: () =>
      new Promise<boolean>((resolve) => {
        if (active < max) {
          active++;
          return resolve(true);
        }
        const grant = () => {
          clearTimeout(t);
          resolve(true);
        };
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(grant), 1);
          resolve(false);
        }, waitMs);
        waiters.push(grant);
      }),
    // Hands the slot straight to the next waiter, so `active` stays the same.
    release: () => {
      const next = waiters.shift();
      if (next) next();
      else active--;
    },
  };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export async function build(cfg: BrokerConfig) {
  const docker = dockerClient(cfg.dockerSocket);
  // Startup sweep: containers left by a crashed or killed broker.
  const filters = encodeURIComponent(JSON.stringify({ label: [`${MANAGED}=1`] }));
  const stale = (await docker.ok('GET', `/containers/json?all=1&filters=${filters}`)) as {
    Id: string;
  }[];
  for (const c of stale) await docker.ok('DELETE', `/containers/${c.Id}?force=1`);
  const runs = semaphore(MAX_RUNS, QUEUE_WAIT_MS);
  const app = Fastify({ logger: false });
  // The proxy starts on the first run that needs it.
  let proxy: Promise<ReturnType<typeof createProxy>> | undefined;
  const startProxy = () => {
    proxy ??= (async () => {
      const p = createProxy();
      await p.listen(cfg.proxyPort);
      return p;
    })();
    proxy.catch(() => {
      proxy = undefined;
    });
    return proxy;
  };
  app.addHook('onClose', async () => {
    await (await proxy?.catch(() => undefined))?.close();
    await docker.close();
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.post('/run', async (req, reply) => {
    const given = req.headers['x-broker-token'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(cfg.token)))
      return reply.code(401).send({ error: 'unauthorized' });
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!(await runs.acquire())) return reply.code(429).send({ error: 'too many runs' });
    // The response's `close` fires once: on a client disconnect, or after a normal end (then
    // writableFinished is true). A request `close` can fire as soon as the body is read. The slot
    // is released here, not in the generator, because a stream destroyed before its first read
    // never runs the generator's `finally`.
    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
      runs.release();
    });
    const ndjson = async function* () {
      try {
        for await (const ev of run(cfg, docker, parsed.data, gone.signal, startProxy))
          yield `${JSON.stringify(ev)}\n`;
      } catch (err) {
        req.log.error({ err }, 'run failed');
        yield `${JSON.stringify({ error: String((err as Error).message ?? err) })}\n`;
      }
    };
    return reply.type('application/x-ndjson').send(Readable.from(ndjson()));
  });
  return app;
}
