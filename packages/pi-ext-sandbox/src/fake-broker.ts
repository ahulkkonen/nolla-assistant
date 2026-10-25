// Test double for services/sandbox-broker: same HTTP API, but runs the command on the host with
// no isolation. Test use only.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export async function startFakeBroker(opts: { token: string; root: string }) {
  const state = { root: opts.root };
  const requests: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ headers: req.headers, body });
    if (req.headers['x-broker-token'] !== opts.token) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const send = (ev: object) => res.write(`${JSON.stringify(ev)}\n`);
    const child = spawn('bash', ['-lc', body.command], { cwd: join(state.root, body.cwd ?? '') });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, body.timeoutMs ?? 120_000);
    for (const stream of ['stdout', 'stderr'] as const)
      createInterface({ input: child[stream] }).on('line', (line) => send({ stream, line }));
    child.on('close', (code) => {
      clearTimeout(timer);
      send({ exit: code ?? 137, timedOut });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return { url, state, requests, close };
}
