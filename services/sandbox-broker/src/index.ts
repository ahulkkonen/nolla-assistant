// Sandbox broker (plan §2 invariant 8, phase-5 decision 3). The only service with the Docker
// socket: it runs each command in a throwaway skill-runner container and streams the output.
import { createHash, timingSafeEqual } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { Agent, request } from 'undici';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

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
};

export const EGRESS_NETWORK = 'pa-skill-egress';
const RUNNER_UID = 10001;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL = /^[a-z0-9-]{1,64}$/;

export function loadConfig(env = process.env): BrokerConfig {
  const token = env.BROKER_TOKEN ?? '';
  if (token.length < 32) throw new Error('BROKER_TOKEN must be at least 32 characters');
  const dataDir = env.DATA_DIR ?? '/data';
  const skillsDir = env.SKILLS_DIR ?? '/app/skills';
  return {
    token,
    dockerSocket: env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    image: env.SKILL_RUNNER_IMAGE ?? 'pa-skill-runner:latest',
    dataDir,
    hostDataDir: env.HOST_DATA_DIR || dataDir,
    skillsDir,
    hostSkillsDir: env.HOST_SKILLS_DIR || skillsDir,
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

export type Network = 'none' | 'internet';

/** Reads the `sandbox:` block of skills/<skill>/SKILL.md. Anything but `network: internet` is `none`. */
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
  // ponytail: host allowlists (`network: [hosts]`) need an egress proxy; phase 7. Fail closed.
  const network: Network = meta?.sandbox?.network === 'internet' ? 'internet' : 'none';
  return { network, bin: existsSync(join(dir, 'bin')) };
}

/** Docker Engine API `POST /containers/create` body for one run. */
export function containerConfig(cfg: BrokerConfig, body: RunBody) {
  const policy = skillPolicy(cfg.skillsDir, body.skill);
  const binds = [`${join(cfg.hostDataDir, 'work', body.userId)}:/work:rw`];
  if (body.skill && policy.bin)
    binds.push(`${join(cfg.hostSkillsDir, body.skill, 'bin')}:/skill/bin:ro`);
  return {
    Image: cfg.image,
    Cmd: ['bash', '-lc', body.command],
    User: `${RUNNER_UID}:${RUNNER_UID}`,
    WorkingDir: posix.join('/work', body.cwd ?? '.'),
    Labels: {
      'pa.user': body.userId,
      'pa.chat': body.chatId,
      ...(body.skill ? { 'pa.skill': body.skill } : {}),
    },
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      Binds: binds,
      NetworkMode: policy.network === 'internet' ? EGRESS_NETWORK : 'none',
      Memory: 512 * 1024 * 1024,
      NanoCpus: 2e9,
      PidsLimit: 256,
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=64m' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
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

async function ensureEgressNetwork(docker: Docker) {
  const res = await docker.call('POST', '/networks/create', {
    Name: EGRESS_NETWORK,
    Driver: 'bridge',
  });
  await res.body.dump();
  // 409: already exists (a concurrent run created it).
  if (res.statusCode >= 300 && res.statusCode !== 409)
    throw new Error(`docker network create: ${res.statusCode}`);
}

/** Splits Docker's multiplexed log stream (8-byte frame headers, Tty false) into lines. */
async function* demux(stream: AsyncIterable<Buffer>) {
  let buf = Buffer.alloc(0);
  const rest = { stdout: '', stderr: '' };
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const name = buf[0] === 2 ? 'stderr' : 'stdout';
      const lines = (rest[name] + buf.subarray(8, 8 + size).toString('utf8')).split('\n');
      rest[name] = lines.pop() ?? '';
      buf = buf.subarray(8 + size);
      for (const line of lines) yield { stream: name, line };
    }
  }
  for (const name of ['stdout', 'stderr'] as const)
    if (rest[name]) yield { stream: name, line: rest[name] };
}

async function* run(cfg: BrokerConfig, docker: Docker, body: RunBody) {
  const work = join(cfg.dataDir, 'work', body.userId);
  mkdirSync(work, { recursive: true });
  try {
    chownSync(work, RUNNER_UID, RUNNER_UID);
  } catch {
    // Not root (tests on a workstation): Docker Desktop maps ownership itself.
  }
  const config = containerConfig(cfg, body);
  if (config.HostConfig.NetworkMode === EGRESS_NETWORK) await ensureEgressNetwork(docker);
  const { Id: id } = (await docker.ok('POST', '/containers/create', config)) as { Id: string };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void docker.call('POST', `/containers/${id}/kill`).then(
      (r) => r.body.dump(),
      () => {},
    );
  }, body.timeoutMs ?? 120_000);
  try {
    await docker.ok('POST', `/containers/${id}/start`);
    const logs = await docker.call('GET', `/containers/${id}/logs?follow=1&stdout=1&stderr=1`);
    if (logs.statusCode >= 300) throw new Error(`docker logs: ${await logs.body.text()}`);
    for await (const line of demux(logs.body)) yield line;
    const { StatusCode } = (await docker.ok('POST', `/containers/${id}/wait`)) as {
      StatusCode: number;
    };
    yield { exit: StatusCode, timedOut };
  } finally {
    clearTimeout(timer);
    // Also runs when the client disconnects mid-stream: force removal kills a running container.
    await docker.call('DELETE', `/containers/${id}?force=1`).then(
      (r) => r.body.dump(),
      () => {},
    );
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export async function build(cfg: BrokerConfig) {
  const docker = dockerClient(cfg.dockerSocket);
  const app = Fastify({ logger: false });
  app.addHook('onClose', () => docker.close());
  app.get('/healthz', async () => ({ ok: true }));
  app.post('/run', async (req, reply) => {
    const given = req.headers['x-broker-token'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(cfg.token)))
      return reply.code(401).send({ error: 'unauthorized' });
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const ndjson = async function* () {
      try {
        for await (const ev of run(cfg, docker, parsed.data)) yield `${JSON.stringify(ev)}\n`;
      } catch (err) {
        req.log.error({ err }, 'run failed');
        yield `${JSON.stringify({ error: String((err as Error).message ?? err) })}\n`;
      }
    };
    return reply.type('application/x-ndjson').send(Readable.from(ndjson()));
  });
  return app;
}
