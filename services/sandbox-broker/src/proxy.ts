// Egress allowlist proxy for skills with `sandbox: { network: [hosts] }` (phase-7 decision 5).
// HTTP CONNECT (port 443) and plain HTTP forwarding (port 80). Each run registers a random token
// with its host list; the runner sends the token as proxy userinfo. No other authentication.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { publicLookup } from './net.ts';

/** `host` is on the list: exact match, or `*.example.com` for any subdomain (not the apex). */
export function allowed(hosts: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hosts.some((p) => {
    const pat = p.toLowerCase();
    return pat.startsWith('*.') ? h.endsWith(pat.slice(1)) && h.length > pat.length - 1 : h === pat;
  });
}

type Run = { hosts: string[]; sockets: Set<Duplex> };

export function createProxy() {
  const runs = new Map<string, Run>();
  const server = http.createServer();
  const authed = (header: string | undefined) => {
    const m = /^Basic (.+)$/i.exec(header ?? '');
    const token = m
      ? Buffer.from(m[1] as string, 'base64')
          .toString()
          .split(':')[0]
      : undefined;
    return token ? runs.get(token) : undefined;
  };
  const track = (run: Run, s: Duplex) => {
    run.sockets.add(s);
    s.on('close', () => run.sockets.delete(s));
    s.on('error', () => s.destroy());
    if (s instanceof net.Socket) s.setTimeout(300_000, () => s.destroy());
  };
  const deny = (s: Duplex) => s.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');

  server.on('connect', (req, client, head) => {
    const run = authed(req.headers['proxy-authorization']);
    const [host = '', port = ''] = (req.url ?? '').split(':');
    if (!run || port !== '443' || !allowed(run.hosts, host)) return deny(client);
    track(run, client);
    const up = net.connect({ host, port: 443, lookup: publicLookup }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    track(run, up);
    up.on('error', () => (client.writable ? client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') : 0));
  });

  server.on('request', (req, res) => {
    const run = authed(req.headers['proxy-authorization']);
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? '');
    } catch {}
    if (
      !run ||
      !url ||
      url.protocol !== 'http:' ||
      (url.port && url.port !== '80') ||
      !allowed(run.hosts, url.hostname)
    ) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = http.request(
      {
        host: url.hostname,
        port: 80,
        path: url.pathname + url.search,
        method: req.method,
        headers,
        lookup: publicLookup,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    track(run, req.socket);
    up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(up);
  });

  return {
    listen: (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
      }),
    /** Registers a run; returns its token and a function that forgets it and drops its connections. */
    register(hosts: string[]) {
      const token = randomBytes(24).toString('hex');
      const run: Run = { hosts, sockets: new Set() };
      runs.set(token, run);
      return {
        token,
        forget: () => {
          runs.delete(token);
          for (const s of run.sockets) s.destroy();
        },
      };
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => (server.listening ? server.close(() => r()) : r()));
    },
  };
}
