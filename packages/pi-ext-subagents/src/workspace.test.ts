import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import {
  checkFileTool,
  dirBytes,
  GUARD_REASON,
  limitReason,
  MAX_WORK_FILE,
  piPath,
  realInside,
  USER_QUOTA,
} from './workspace.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'pa-ws-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const root = join(base, 'work');
mkdirSync(join(root, 'docs'), { recursive: true });
mkdirSync(join(root, '.trash'));
writeFileSync(join(base, 'secret.txt'), 'salainen');
writeFileSync(join(root, 'docs', 'a.txt'), 'abc');
writeFileSync(join(root, '.trash', '1793000000000-old.txt'), 'vanha');
symlinkSync(base, join(root, 'out'));
symlinkSync(join(base, 'secret.txt'), join(root, 'secret-link.txt'));
symlinkSync(join(root, 'docs', 'a.txt'), join(root, 'a-link.txt'));
symlinkSync(join(root, '.trash'), join(root, 'bin'));
symlinkSync(join(base, 'missing'), join(root, 'dangling'));

test('piPath resolves like Pi: @ prefix, ~, file:// URLs, Unicode spaces', () => {
  expect(piPath(root, '@docs/a.txt')).toBe(join(root, 'docs', 'a.txt'));
  expect(piPath(root, '@../secret.txt')).toBe(join(base, 'secret.txt'));
  expect(piPath(root, '~/x')).toBe(join(homedir(), 'x'));
  expect(piPath(root, `file://${join(root, '%2e%2e', 'secret.txt')}`)).toBe(
    join(base, 'secret.txt'),
  );
  expect(piPath(root, 'docs/a\u00A0b.txt')).toBe(join(root, 'docs', 'a b.txt'));
  expect(() => piPath(root, 'file://host/etc/passwd')).toThrow();
});

test('realInside: inside, missing parts, escapes, trash, symlinks out, dangling links', async () => {
  expect(await realInside(root, join(root, 'docs', 'a.txt'))).toBe(join(root, 'docs', 'a.txt'));
  expect(await realInside(root, root)).toBe(root);
  expect(await realInside(root, join(root, 'new', 'deep', 'b.txt'))).toBe(
    join(root, 'new', 'deep', 'b.txt'),
  );
  expect(await realInside(root, join(root, 'a-link.txt'))).toBe(join(root, 'docs', 'a.txt'));
  // Out and back in is inside.
  expect(await realInside(root, join(root, 'out', 'work', 'docs', 'new.txt'))).toBe(
    join(root, 'docs', 'new.txt'),
  );
  for (const p of [
    join(base, 'secret.txt'),
    join(root, '..', 'secret.txt'),
    join(root, '.trash', '1793000000000-old.txt'),
    join(root, '.TRASH', 'x'),
    join(root, 'out', 'secret.txt'),
    join(root, 'secret-link.txt'),
    join(root, 'bin', '1793000000000-old.txt'),
    join(root, 'dangling'),
    join(root, 'dangling', 'x'),
    join(root, 'docs', 'a.txt', 'x'),
  ])
    expect(await realInside(root, p), p).toBeUndefined();
  // The trash routes may reach it.
  expect(await realInside(root, join(root, '.trash', 'x'), true)).toBe(join(root, '.trash', 'x'));
});

const none = async () => 0;

test('checkFileTool: the guard blocks every escape and the trash', async () => {
  for (const [tool, path] of [
    ['read', '../secret.txt'],
    ['read', '@../secret.txt'],
    ['read', '~/.ssh/id_ed25519'],
    ['read', `file://${join(base, 'secret.txt')}`],
    ['read', 'file://host/etc/passwd'],
    ['read', '.trash/1793000000000-old.txt'],
    ['read', 'out/secret.txt'],
    ['read', 'secret-link.txt'],
    ['write', 'bin/new.txt'],
    ['write', 'dangling'],
    ['edit', '.trash/1793000000000-old.txt'],
    ['ls', '.trash'],
    ['grep', '../'],
  ] as const)
    expect(await checkFileTool(root, tool, { path, content: 'x' }, none), `${tool} ${path}`).toBe(
      GUARD_REASON,
    );
  expect(await checkFileTool(root, 'read', {}, none)).toBe(GUARD_REASON);
  expect(await checkFileTool(root, 'read', { path: 'docs/a.txt' }, none)).toBeUndefined();
  expect(await checkFileTool(root, 'ls', {}, none)).toBeUndefined();
  expect(await checkFileTool(root, 'memory', { path: '../x' }, none)).toBeUndefined();
});

test('checkFileTool: size limits for write and edit, in Finnish', async () => {
  const full = async () => USER_QUOTA - 5;
  const write = (content: string, used = none) =>
    checkFileTool(root, 'write', { path: 'docs/new.txt', content }, used);
  expect(await write('0123456789')).toBeUndefined();
  expect(await write('0123456789', full)).toMatch(/^Kirjoitus estetty: tallennustila on täynnä/);
  // Overwriting a.txt (3 bytes) with 8 bytes grows the total by 5: it still fits.
  expect(
    await checkFileTool(root, 'write', { path: 'docs/a.txt', content: '12345678' }, full),
  ).toBeUndefined();
  const edit = (oldText: string, newText: string) =>
    checkFileTool(root, 'edit', { path: 'docs/a.txt', edits: [{ oldText, newText }] }, full);
  expect(await edit('a', 'aaaaaaaaaaa')).toMatch(/tallennustila on täynnä/);
  expect(await edit('abc', 'x')).toBeUndefined();
  expect(limitReason(MAX_WORK_FILE + 1, 0)).toMatch(/yhden tiedoston raja on 200 Mt/);
  expect(limitReason(MAX_WORK_FILE, 0)).toBeUndefined();
});

test('dirBytes counts regular files, not symlink targets; a missing dir is 0', async () => {
  // docs/a.txt 3 + trash entry 5; the links to secret.txt and docs/a.txt do not count.
  expect(await dirBytes(root)).toBe(8);
  expect(await dirBytes(join(base, 'nope'))).toBe(0);
});
