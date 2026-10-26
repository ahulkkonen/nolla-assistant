import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AttachmentRef, ChatExport } from '@pa/protocol';
import sharp from 'sharp';
import { afterEach, expect, test } from 'vitest';
import { api, bootPseudo, login, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const REPLY = 'Hei Pekka Laaksonen.\n\n```html\n<h1>Sivu</h1>\n```';
const REAL_REPLY = 'Hei Matti Virtanen.\n\n```html\n<h1>Sivu</h1>\n```';

test('export: md and json, masked and real names; real names fail while the sidecar is down', {
  timeout: 30_000,
}, async () => {
  const { c, chat, config, srv, sc } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [
    { toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] },
    { text: REPLY },
  ]);
  writeFileSync(join(srv.registry.cwd, 'note.txt'), 'hello');
  const { port } = config;
  const { cookie } = await login(port);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('files', new Blob(['sisältö 42'], { type: 'text/plain' }), 'Matti Virtanen.txt');
  form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'passi.png');
  const up = await api(port, '/api/files', { method: 'POST', body: form, headers: { cookie } });
  const { files } = (await up.json()) as { files: AttachmentRef[] };
  c.send({
    type: 'user.message',
    chatId: chat.id,
    text: 'Moi, olen Matti Virtanen',
    attachments: files,
  });
  await c.idle();
  c.inbox.length = 0;
  c.send({ type: 'chat.rename', chatId: chat.id, title: 'Matti Virtanen muistio' });
  await c.next('chat.updated');

  const get = (query: string, id = chat.id) =>
    api(port, `/api/chats/${id}/export?${query}`, { headers: { cookie } });
  const day = '\\d{4}-\\d{2}-\\d{2}';

  const md = await get('format=md&unmask=0');
  expect(md.status).toBe(200);
  expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  expect(md.headers.get('cache-control')).toBe('no-store');
  expect(md.headers.get('content-disposition')).toMatch(
    new RegExp(`^attachment; filename="pekka-laaksonen-muistio-${day}-masked\\.md"$`),
  );
  const masked = await md.text();
  expect(masked).toMatch(/^# Pekka Laaksonen muistio\n\n- Päivämäärä: \d+\.\d+\.\d{4}\n/);
  expect(masked).toContain('- Agentti: Avustaja');
  expect(masked).toContain('- Nimet: niin kuin malli näki ne');
  expect(masked).toMatch(/## Sinä · \d+\.\d+\.\d{4} klo \d+\.\d{2}\n\nMoi, olen Pekka Laaksonen\n/);
  expect(masked).toContain('- `Pekka Laaksonen.txt` (text/plain)\n- kuva (image/png)');
  expect(masked).toContain('- `read` · valmis');
  expect(masked).toContain(REPLY);
  expect(masked).not.toMatch(/Matti|Virtanen|passi|sisältö 42/);

  const open = await get('format=md&unmask=1');
  expect(open.headers.get('content-disposition')).toMatch(
    new RegExp(`filename="matti-virtanen-muistio-${day}-avoin\\.md"$`),
  );
  const real = await open.text();
  expect(real).toContain('- Nimet: oikeat nimet, sisältää henkilötietoja');
  expect(real).toContain('Moi, olen Matti Virtanen\n');
  expect(real).toContain('- `Matti Virtanen.txt` (text/plain)\n- `passi.png` (image/png)');
  expect(real).toContain(REAL_REPLY);
  expect(real).not.toContain('Pekka');

  const jsonOf = async (unmask: 0 | 1) => {
    const res = await get(`format=json&unmask=${unmask}`);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/\.json"$/);
    return ChatExport.parse(await res.json());
  };
  for (const [unmask, name, text, reply, files] of [
    [0, 'Pekka Laaksonen', 'Moi, olen Pekka Laaksonen', REPLY, ['Pekka Laaksonen.txt', null]],
    [
      1,
      'Matti Virtanen',
      'Moi, olen Matti Virtanen',
      REAL_REPLY,
      ['Matti Virtanen.txt', 'passi.png'],
    ],
  ] as const) {
    const e = await jsonOf(unmask);
    expect(e.masked).toBe(!unmask);
    expect(e.chat).toEqual({
      id: chat.id,
      title: `${name} muistio`,
      createdAt: expect.any(String),
      agent: { id: 'assistant', name: 'Avustaja' },
      topic: null,
    });
    expect(e.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', text],
      ['assistant', ''],
      ['assistant', reply],
    ]);
    const [user, tool, last] = e.messages;
    expect(user?.attachments.map((a) => [a.kind, a.name])).toEqual([
      ['document', files[0]],
      ['image', files[1]],
    ]);
    expect(tool?.tools).toEqual([{ name: 'read', status: 'ok' }]);
    expect(last?.artifacts).toEqual([
      { kind: 'html', title: 'Sivu', language: 'html', content: '<h1>Sivu</h1>' },
    ]);
  }

  expect((await get('format=pdf')).status).toBe(400);
  expect((await get('format=md', 'nope')).status).toBe(404);
  expect((await api(port, `/api/chats/${chat.id}/export?format=md`)).status).toBe(401);

  await sc.close();
  const down = await get('format=md&unmask=1');
  expect(down.status).toBe(503);
  expect(await down.json()).toEqual({ error: 'pseudo_down' });
  expect((await get('format=json&unmask=0')).status).toBe(200);
});
