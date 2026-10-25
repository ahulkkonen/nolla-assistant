// Phase-5 sandbox gate (plan §13): the real broker against the local Docker daemon.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, dockerClient } from '@pa/sandbox-broker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const TOKEN = 's'.repeat(32);
const IMAGE = 'pa-skill-runner:test';

const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const SKIP_NOTE = 'SKIPPED: docker not on PATH or daemon not running';
if (!hasDocker) process.stderr.write(`[sandbox] ${SKIP_NOTE}\n`);

const socket = () => {
  const host = spawnSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    {
      encoding: 'utf8',
    },
  ).stdout.trim();
  return host.startsWith('unix://') ? host.slice(7) : '/var/run/docker.sock';
};

describe.skipIf(!hasDocker)(hasDocker ? 'sandbox broker (docker)' : `sandbox ${SKIP_NOTE}`, () => {
  let app: Awaited<ReturnType<typeof build>>;
  let docker: ReturnType<typeof dockerClient>;
  let dataDir = '';
  let n = 0;

  beforeAll(async () => {
    const b = spawnSync(
      'docker',
      ['build', '-q', '-f', 'infra/Dockerfile.skill-runner', '-t', IMAGE, '.'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    if (b.status !== 0) throw new Error(`skill-runner build failed:\n${b.stderr}`);
    // realpath: Docker Desktop resolves bind sources on the host (/var -> /private/var on macOS).
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-sandbox-')));
    const cfg = {
      token: TOKEN,
      dockerSocket: socket(),
      image: IMAGE,
      dataDir,
      hostDataDir: dataDir,
      skillsDir: join(root, 'skills'),
      hostSkillsDir: join(root, 'skills'),
    };
    app = await build(cfg);
    docker = dockerClient(cfg.dockerSocket);
  });
  afterAll(async () => {
    await app?.close();
    await docker?.close();
  });

  async function run(body: Record<string, unknown>) {
    const chatId = `c${++n}-${process.pid}`;
    const res = await app.inject({
      method: 'POST',
      url: '/run',
      headers: { 'x-broker-token': TOKEN },
      payload: { userId: 'u1', chatId, ...body },
    });
    expect(res.statusCode).toBe(200);
    const events = res.payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const end = events.at(-1) as { exit: number; timedOut: boolean };
    const output = events
      .filter((e) => 'line' in e)
      .map((e) => e.line)
      .join('\n');
    return { chatId, events, end, output };
  }

  test('no skill: no network', async () => {
    const { end, output } = await run({ command: 'curl -sS -m 5 https://example.com' });
    expect(end.exit).not.toBe(0);
    expect(output).toMatch(/resolve|network|connect/i);
  });

  test('web-digest skill: internet', async (ctx) => {
    const { end, output } = await run({
      command: 'curl -sS -m 10 -o /dev/null https://example.com',
      skill: 'web-digest',
    });
    if (end.exit !== 0) {
      const online = await fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(
        () => true,
        () => false,
      );
      if (!online) ctx.skip('host is offline; internet assertion skipped');
    }
    expect(end.exit, output).toBe(0);
  });

  test('read-only root filesystem', async () => {
    expect((await run({ command: 'cat /etc/passwd' })).end.exit).toBe(0);
    const touch = await run({ command: 'touch /etc/x' });
    expect(touch.end.exit).not.toBe(0);
    expect(touch.output).toMatch(/read-only|permission/i);
  });

  test('/work is the user work dir', async () => {
    const { end, output } = await run({ command: 'touch /work/a && ls /work' });
    expect(end.exit).toBe(0);
    expect(output).toContain('a');
    expect(existsSync(join(dataDir, 'work', 'u1', 'a'))).toBe(true);
  });

  test('timeout kills and removes the container', async () => {
    const t0 = Date.now();
    const { chatId, end } = await run({ command: 'sleep 30', timeoutMs: 2000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(end.timedOut).toBe(true);
    const filters = encodeURIComponent(JSON.stringify({ label: [`pa.chat=${chatId}`] }));
    expect(await docker.ok('GET', `/containers/json?all=1&filters=${filters}`)).toEqual([]);
  });

  test('missing token is 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/run',
      payload: { userId: 'u1', chatId: 'c', command: 'true' },
    });
    expect(res.statusCode).toBe(401);
  });
});
