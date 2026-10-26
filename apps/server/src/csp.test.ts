import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { api, boot, runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);

const post = (port: number, type: string, body: unknown) =>
  api(port, '/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': type },
    body: JSON.stringify(body),
  });

test('csp report: logged and 204; a flood gets 429', { timeout: 30_000 }, async () => {
  const web = tempDir('pa-web-');
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>t</title>');
  const { config, run, logs } = await boot([], { WEB_DIST: web });
  await run();
  const html = await api(config.port, '/', { headers: { accept: 'text/html' } });
  expect(html.headers.get('content-security-policy')).toContain(
    'report-uri /api/csp-report; report-to csp',
  );
  expect(html.headers.get('reporting-endpoints')).toBe('csp="/api/csp-report"');
  const legacy = await post(config.port, 'application/csp-report', {
    'csp-report': {
      'document-uri': 'https://assistant.example.fi/c/abc?token=salainen',
      'violated-directive': 'script-src-elem',
      'blocked-uri': 'https://evil.example/x.js?q=salainen',
      'script-sample': 'alert(salainen)',
    },
  });
  expect(legacy.status).toBe(204);
  const modern = await post(config.port, 'application/reports+json', [
    {
      type: 'csp-violation',
      url: 'https://assistant.example.fi/',
      body: {
        documentURL: 'https://assistant.example.fi/asetukset#x',
        effectiveDirective: 'img-src',
        blockedURL: 'data:image/png;base64,AAAA',
      },
    },
    { type: 'deprecation', body: {} },
  ]);
  expect(modern.status).toBe(204);
  const lines = logs.filter((l) => l.includes('csp violation')).map((l) => JSON.parse(l));
  expect(lines.map(({ directive, blocked, path }) => ({ directive, blocked, path }))).toEqual([
    { directive: 'script-src-elem', blocked: 'https://evil.example', path: '/c/abc' },
    { directive: 'img-src', blocked: 'data:', path: '/asetukset' },
  ]);
  expect(logs.join('')).not.toContain('salainen');
  // A long host is cut at 100 characters.
  const host = `${'a'.repeat(150)}.example`;
  await post(config.port, 'application/csp-report', {
    'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': `https://${host}/x` },
  });
  expect(JSON.parse(logs.findLast((l) => l.includes('csp violation')) ?? '{}').blocked).toBe(
    `https://${host}`.slice(0, 100),
  );
  expect((await post(config.port, 'application/csp-report', 'x'.repeat(17_000))).status).toBe(413);
  expect((await post(config.port, 'application/xml', {})).status).toBe(415);
  // 30 per minute in all: the three above, 27 more, then 429.
  for (let i = 0; i < 27; i++)
    expect((await post(config.port, 'application/csp-report', {})).status).toBe(204);
  expect((await post(config.port, 'application/csp-report', {})).status).toBe(429);
});
