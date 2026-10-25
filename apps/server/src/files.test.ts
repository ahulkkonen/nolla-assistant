import { expect, test } from 'vitest';
import { zipUnpackedSize } from './files.ts';

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
