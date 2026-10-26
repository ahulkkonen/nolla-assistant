import { expect, test } from 'vitest';
import { cleanName, splitBlocks, zipUnpackedSize } from './files.ts';

const zip = (sizes: number[]) => {
  const entries = sizes.map((size) => {
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt32LE(size, 24);
    return cen;
  });
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sizes.length, 10);
  eocd.writeUInt32LE(46 * sizes.length, 12);
  return Buffer.concat([...entries, eocd]);
};

test('zipUnpackedSize sums central directory sizes', () => {
  expect(zipUnpackedSize(zip([10, 20]))).toBe(30);
  expect(zipUnpackedSize(zip([0xffffffff]))).toBe(Infinity);
  expect(zipUnpackedSize(Buffer.from('not a zip at all, no eocd here'))).toBe(Infinity);
});

test('splitBlocks: a marker in the user text stays; masked names fall back to the last blocks', () => {
  const own = 'Lainaus:\n\n[Liite: vanha.txt]\nteksti';
  const block = (name: string) => `\n\n[Liite: ${name}]\nsisältö`;
  // Exact name first; the user's own marker is not a document name.
  expect(splitBlocks(own + block('a.txt') + block('b.txt'), ['a.txt', 'b.txt'])).toEqual({
    own,
    names: ['a.txt', 'b.txt'],
  });
  // Masked names: the last `docs.length` blocks; a placeholder name may hold brackets.
  expect(splitBlocks(own + block('[henkilö 3].txt'), ['Matti.txt'])).toEqual({
    own,
    names: ['[henkilö 3].txt'],
  });
  // No document: nothing is cut.
  expect(splitBlocks(own, [])).toEqual({ own, names: [] });
});

test('cleanName: a name ending in (OCR) loses it, so the OCR label round-trips', () => {
  const name = cleanName('skannaus (OCR) (OCR)');
  expect(name).toBe('skannaus');
  expect(cleanName('x (OCR).pdf')).toBe('x (OCR).pdf');
  const block = (label: string) => `\n\n[Liite: ${label}]\nteksti`;
  expect(splitBlocks(`oma${block(name)}${block(`${name} (OCR)`)}`, [name, name])).toEqual({
    own: 'oma',
    names: [name, name],
  });
});
