// Phase-5 sandbox gate (plan §13): the real broker against the local Docker daemon.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, dockerClient, PROXY_NETWORK, skillPolicy } from '@pa/sandbox-broker';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { allowed } from '../../../services/sandbox-broker/src/proxy.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const TOKEN = 's'.repeat(32);
const IMAGE = 'pa-skill-runner:test';

const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const SKIP_NOTE = 'SKIPPED: docker not on PATH or daemon not running';
if (!hasDocker) process.stderr.write(`[sandbox] ${SKIP_NOTE}\n`);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

// The broker runs in this process, but the runner sits on an internal network that cannot reach the
// host. A relay container on that network (alias `broker-relay`) and on the default bridge forwards
// to the in-process proxy: it stands in for the broker container, which is on both networks too.
const relayScript = (port: number) => `
import asyncio
async def pipe(a, b):
    try:
        while d := await a.read(65536):
            b.write(d)
            await b.drain()
    finally:
        b.close()
async def handle(r, w):
    try:
        R, W = await asyncio.open_connection('host.docker.internal', ${port})
    except Exception:
        w.close()
        return
    await asyncio.gather(pipe(r, W), pipe(R, w), return_exceptions=True)
async def main():
    s = await asyncio.start_server(handle, '0.0.0.0', ${port})
    await s.serve_forever()
asyncio.run(main())
`;

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
  let cfg: Parameters<typeof build>[0];
  let n = 0;
  let relayId = '';
  const online = () =>
    fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(
      () => true,
      () => false,
    );
  const containers = (label: string) => {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return docker.ok('GET', `/containers/json?all=1&filters=${filters}`);
  };

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
    const proxyPort = await freePort();
    cfg = {
      proxyPort,
      proxyHost: 'broker-relay',
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
    const net = await docker.call('POST', '/networks/create', {
      Name: PROXY_NETWORK,
      Driver: 'bridge',
      Internal: true,
    });
    await net.body.dump();
    const relay = await docker.ok('POST', '/containers/create', {
      Image: IMAGE,
      Cmd: ['python3', '-c', relayScript(proxyPort)],
      HostConfig: { NetworkMode: PROXY_NETWORK, ExtraHosts: ['host.docker.internal:host-gateway'] },
      NetworkingConfig: { EndpointsConfig: { [PROXY_NETWORK]: { Aliases: ['broker-relay'] } } },
    });
    relayId = relay.Id;
    const bridge = await docker.call('POST', '/networks/bridge/connect', { Container: relayId });
    await bridge.body.dump();
    await docker.ok('POST', `/containers/${relayId}/start`);
  });
  afterAll(async () => {
    if (relayId)
      await docker?.call('DELETE', `/containers/${relayId}?force=1`).then((r) => r.body.dump());
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

  // web-digest declares network: [example.com, "*.wikipedia.org"]
  describe('host allowlist (web-digest)', () => {
    const skill = 'web-digest';
    const curl = (args: string) => run({ command: `curl -sS -m 10 -o /dev/null ${args}`, skill });

    test('listed host over https works', async (ctx) => {
      const { end, output } = await curl('https://example.com');
      if (end.exit !== 0 && !(await online())) ctx.skip('host is offline');
      expect(end.exit, output).toBe(0);
    });

    test('listed host over plain http works', async (ctx) => {
      const { end, output } = await curl('http://example.com');
      if (end.exit !== 0 && !(await online())) ctx.skip('host is offline');
      expect(end.exit, output).toBe(0);
    });

    test('unlisted host is refused by the proxy with 403', async () => {
      const { end, output } = await curl('https://openrouter.ai');
      expect(end.exit).not.toBe(0);
      // curl 7.x prints "Received HTTP code 403 from proxy after CONNECT", curl 8.x "CONNECT tunnel failed, response 403"
      expect(output).toMatch(/403 from proxy after CONNECT|CONNECT tunnel failed, response 403/);
      const http = await run({
        command: 'curl -sS -m 10 -o /dev/null -w "%{http_code}" http://openrouter.ai',
        skill,
      });
      expect(http.output).toBe('403');
    });

    test('non-443 port on a listed host is refused', async () => {
      const { end, output } = await curl('https://example.com:8443');
      expect(end.exit).not.toBe(0);
      expect(output).toMatch(/403/);
    });

    test('bypassing the proxy fails: the network has no route out', async () => {
      const { end, output } = await curl("--noproxy '*' https://example.com");
      expect(end.exit).not.toBe(0);
      expect(output).toMatch(/resolve|connect|network|unreachable/i);
      // Unsetting the variables in the command changes nothing either.
      const raw = await run({
        command:
          'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; curl -sS -m 5 http://example.com',
        skill,
      });
      expect(raw.end.exit).not.toBe(0);
    });

    test('a wrong token is refused', async () => {
      const { output } = await run({ command: 'echo $HTTPS_PROXY', skill });
      expect(output).toMatch(/^http:\/\/[0-9a-f]{48}@broker-relay:\d+$/);
      const stale = await run({
        command: `curl -sS -m 10 -o /dev/null -x ${output.trim().replace(/@/, 'x@')} https://example.com`,
        skill,
      });
      expect(stale.output).toMatch(/403/);
    });
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
    expect(await containers(`pa.chat=${chatId}`)).toEqual([]);
  });

  test('client disconnect removes the container', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const chatId = `gone-${process.pid}`;
    const ctl = new AbortController();
    // Headers arrive with the first output line, so the fetch is not awaited.
    const pending = fetch(`http://127.0.0.1:${port}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-broker-token': TOKEN },
      body: JSON.stringify({ userId: 'u1', chatId, command: 'sleep 30' }),
      signal: ctl.signal,
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    expect(await containers(`pa.chat=${chatId}`)).toHaveLength(1);
    ctl.abort();
    await pending;
    const t0 = Date.now();
    while ((await containers(`pa.chat=${chatId}`)).length && Date.now() - t0 < 3000)
      await new Promise((r) => setTimeout(r, 100));
    expect(await containers(`pa.chat=${chatId}`)).toEqual([]);
  });

  test('output over 1 MB ends with an output limit error', async () => {
    const { events, chatId } = await run({ command: 'head -c 2000000 /dev/zero | tr "\\0" a' });
    expect(events.at(-1)).toEqual({ error: 'output limit' });
    // One 64 KB piece per line event: no single huge line.
    expect(Math.max(...events.filter((e) => 'line' in e).map((e) => e.line.length))).toBe(65536);
    expect(await containers(`pa.chat=${chatId}`)).toEqual([]);
  });

  test('startup sweep removes managed containers', async () => {
    const { Id } = await docker.ok('POST', '/containers/create', {
      Image: IMAGE,
      Cmd: ['sleep', '60'],
      Labels: { 'pa.managed': '1', 'pa.chat': `stale-${process.pid}` },
    });
    const second = await build(cfg);
    await second.close();
    expect(await containers(`pa.chat=stale-${process.pid}`)).toEqual([]);
    expect(Id).toEqual(expect.any(String));
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

describe('skill policy and host matching', () => {
  test('allowed: exact and *.suffix, not the apex', () => {
    expect(allowed(['example.com'], 'example.com')).toBe(true);
    expect(allowed(['example.com'], 'www.example.com')).toBe(false);
    expect(allowed(['*.wikipedia.org'], 'fi.wikipedia.org')).toBe(true);
    expect(allowed(['*.wikipedia.org'], 'wikipedia.org')).toBe(false);
    expect(allowed(['*.wikipedia.org'], 'evilwikipedia.org')).toBe(false);
    expect(allowed(['Example.com'], 'EXAMPLE.com.')).toBe(true);
  });

  test('skillPolicy: list, internet, invalid and unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-skills-'));
    const make = (name: string, network: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(
        join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\nsandbox:\n  network: ${network}\n---\n`,
      );
      return skillPolicy(dir, name).network;
    };
    expect(make('a', '[example.com, "*.wikipedia.org"]')).toEqual([
      'example.com',
      '*.wikipedia.org',
    ]);
    expect(make('b', 'internet')).toBe('internet');
    expect(make('c', '[]')).toBe('none');
    expect(make('d', '["not a host"]')).toBe('none');
    expect(make('e', '["*"]')).toBe('none');
    expect(skillPolicy(dir, 'missing').network).toBe('none');
  });
});
