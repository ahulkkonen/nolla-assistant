import { createCipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32, createDeflateRaw } from 'node:zlib';
import { EXPORT_PBKDF2_ITER } from '@pa/protocol';

// The full export's archive and its encryption (docs/decisions/phase-15-admin.md, decision 13).

export type ZipEntry = { name: string; data: Buffer | AsyncIterable<Buffer>; mtime?: Date };

/** Over the input cap, or past a limit that would need ZIP64. */
export class ZipTooLarge extends Error {}

/** Bit 3: CRC and sizes in a data descriptor after the data. Bit 11: UTF-8 names. */
const FLAGS = 0x0808;
const DEFLATE = 8;
const VERSION = 20;
const U32 = 0xffffffff;
/** Below the 0xFFFF entry count that needs ZIP64. */
export const MAX_ENTRIES = 65_000;

/** MS-DOS time and date of `d` (local time, 2-second steps, from 1980). */
function dos(d: Date): [number, number] {
  const year = Math.max(d.getFullYear(), 1980);
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

/**
 * A zip of `entries` as a byte stream: deflate, data descriptors, UTF-8 names, no ZIP64. Throws
 * `ZipTooLarge` when the input passes `maxBytes`, the entries pass `MAX_ENTRIES`, or an offset
 * passes 4 GiB.
 */
export async function* zip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  maxBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  let input = 0;
  for await (const e of entries) {
    if (central.length >= MAX_ENTRIES) throw new ZipTooLarge('too many entries');
    const name = Buffer.from(e.name, 'utf8');
    const [time, date] = dos(e.mtime ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    const start = offset;
    yield Buffer.concat([local, name]);
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    let csize = 0;
    const deflate = createDeflateRaw();
    const fed = pipeline(async function* () {
      for await (const chunk of Buffer.isBuffer(e.data) ? [e.data] : e.data) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        input += chunk.length;
        if (input > maxBytes) throw new ZipTooLarge('input over the cap');
        yield chunk;
      }
    }, deflate);
    // A source error ends the loop below; this keeps its rejection handled.
    fed.catch(() => {});
    for await (const chunk of deflate) {
      csize += chunk.length;
      yield chunk;
    }
    await fed;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(csize, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += csize + descriptor.length;
    if (offset > U32) throw new ZipTooLarge('archive over 4 GiB');

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(VERSION, 4);
    cd.writeUInt16LE(VERSION, 6);
    cd.writeUInt16LE(FLAGS, 8);
    cd.writeUInt16LE(DEFLATE, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(csize, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(start, 42);
    central.push(cd, name);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([directory, end]);
}

/**
 * A stream that encrypts into the OpenSSL `enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256`
 * format: `Salted__`, an 8-byte salt, then AES-256-CBC with PKCS#7 padding. Key and IV are the 48
 * bytes PBKDF2 derives from the passphrase and the salt.
 */
export async function opensslEncrypt(passphrase: string): Promise<Transform> {
  const salt = randomBytes(8);
  const km = await promisify(pbkdf2)(passphrase, salt, EXPORT_PBKDF2_ITER, 48, 'sha256');
  const cipher = createCipheriv('aes-256-cbc', km.subarray(0, 32), km.subarray(32));
  let head: Buffer | undefined = Buffer.concat([Buffer.from('Salted__'), salt]);
  const withHead = (b: Buffer) => {
    const out = head ? Buffer.concat([head, b]) : b;
    head = undefined;
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      done(null, withHead(cipher.update(chunk)));
    },
    flush(done) {
      done(null, withHead(cipher.final()));
    },
  });
}
