import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SEED_MANIFEST, seedDir } from './seed.ts';
import { runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);

function setup() {
  const root = tempDir('pa-seed-');
  const image = join(root, 'image');
  const dir = join(root, 'data', 'agents');
  mkdirSync(join(image, 'prompts'), { recursive: true });
  writeFileSync(join(image, 'a.yaml'), 'v1 a\n');
  writeFileSync(join(image, 'prompts', 'a.md'), 'v1 prompt\n');
  const warns: string[] = [];
  const seed = () =>
    seedDir(dir, image, 'agent', (msg, data) => warns.push(`${msg} ${JSON.stringify(data)}`));
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return { image, dir, warns, seed, read };
}

test('seed: a missing folder is copied with a manifest of every file', () => {
  const { dir, seed, read } = setup();
  seed();
  expect(read('a.yaml')).toBe('v1 a\n');
  expect(read('prompts/a.md')).toBe('v1 prompt\n');
  expect(Object.keys(JSON.parse(read(SEED_MANIFEST))).sort()).toEqual(['a.yaml', 'prompts/a.md']);
  expect(existsSync(`${dir}.seeding`)).toBe(false);
});

test('seed: an unedited file takes the new image; an edited one stays and is logged', () => {
  const { image, dir, warns, seed, read } = setup();
  seed();
  writeFileSync(join(dir, 'prompts', 'a.md'), 'my own prompt\n');
  writeFileSync(join(image, 'a.yaml'), 'v2 a\n');
  writeFileSync(join(image, 'prompts', 'a.md'), 'v2 prompt\n');
  writeFileSync(join(image, 'b.yaml'), 'v2 b\n');
  seed();
  expect(read('a.yaml')).toBe('v2 a\n');
  expect(read('prompts/a.md')).toBe('my own prompt\n');
  expect(read('b.yaml')).toBe('v2 b\n');
  expect(warns).toEqual(['agent file edited by user, not updated {"file":"prompts/a.md"}']);
  // A file the user deleted stays deleted.
  rmSync(join(dir, 'b.yaml'));
  seed();
  expect(existsSync(join(dir, 'b.yaml'))).toBe(false);
});

test('seed: without a manifest existing files count as edited; missing ones are added', () => {
  const { image, dir, warns, seed, read } = setup();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.yaml'), 'old a\n');
  writeFileSync(join(image, 'b.yaml'), 'v1 b\n');
  seed();
  expect(read('a.yaml')).toBe('old a\n');
  expect(read('b.yaml')).toBe('v1 b\n');
  expect(read('prompts/a.md')).toBe('v1 prompt\n');
  expect(warns).toEqual(['agent file edited by user, not updated {"file":"a.yaml"}']);
  const manifest = JSON.parse(read(SEED_MANIFEST));
  expect(Object.keys(manifest).sort()).toEqual(['b.yaml', 'prompts/a.md']);
  // The edited file stays out of the manifest, so a later image never overwrites it.
  writeFileSync(join(image, 'a.yaml'), 'v2 a\n');
  seed();
  expect(read('a.yaml')).toBe('old a\n');
});
