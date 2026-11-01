import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32, createDeflateRaw } from 'node:zlib';
import { EXPORT_PBKDF2_ITER } from '@pa/protocol';

// The full export's archive (docs/decisions/phase-15-admin.md, decision 13) and its encryption
// (docs/decisions/phase-35-security-fixes.md).

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
  let count = 0;
  let offset = 0;
  let input = 0;
  for await (const e of entries) {
    if (++count > MAX_ENTRIES) throw new ZipTooLarge('too many entries');
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
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([directory, end]);
}

/** Export file header (phase 35): magic, version byte, 16-byte salt, 12-byte GCM nonce. */
const MAGIC = Buffer.from('PAEXPORT');
/**
 * The format version. The header has no round count: version 2 always means
 * `EXPORT_PBKDF2_ITER` = 600,000 rounds. A change of the rounds needs version 3.
 */
export const EXPORT_VERSION = 2;
const HEAD = MAGIC.length + 1 + 16 + 12;
const TAG = 16;
/** The magic of the version-1 files (OpenSSL `enc`, AES-256-CBC, no MAC). */
const OPENSSL_MAGIC = 'Salted__';

/** A file that is not a version-2 export; the message says what it is. */
export class ExportFormatError extends Error {}
/** The decrypt target appeared while the decrypt ran; the plain bytes are not moved over it. */
export class DestinationExists extends Error {}

const exportKey = (passphrase: string, salt: Buffer) =>
  promisify(pbkdf2)(passphrase, salt, EXPORT_PBKDF2_ITER, 32, 'sha256');

/**
 * A stream that encrypts into the export format: the header, AES-256-GCM with the header as
 * additional data, then the 16-byte tag. The key is PBKDF2-HMAC-SHA256 of the passphrase and salt.
 */
export async function exportEncrypt(passphrase: string): Promise<Transform> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  let head: Buffer | undefined = Buffer.concat([MAGIC, Buffer.of(EXPORT_VERSION), salt, nonce]);
  const cipher = createCipheriv('aes-256-gcm', await exportKey(passphrase, salt), nonce);
  cipher.setAAD(head);
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
      done(null, withHead(Buffer.concat([cipher.final(), cipher.getAuthTag()])));
    },
  });
}

/**
 * Decrypts the export file `src` into `dst`. The plain bytes go to `dst.part`, which becomes `dst`
 * only after the tag checks out; a wrong passphrase or a changed byte leaves no file. Throws
 * `ExportFormatError` for a version-1 or a foreign file.
 */
export async function exportDecrypt(src: string, dst: string, passphrase: string): Promise<void> {
  const fh = await open(src);
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(HEAD);
    await fh.read(head, 0, HEAD, 0);
    if (head.subarray(0, 8).toString('latin1') === OPENSSL_MAGIC)
      throw new ExportFormatError(
        `version 1 file (AES-256-CBC): openssl enc -d -aes-256-cbc -pbkdf2 -iter ${EXPORT_PBKDF2_ITER} -md sha256`,
      );
    if (size <= HEAD + TAG || !head.subarray(0, MAGIC.length).equals(MAGIC))
      throw new ExportFormatError('not an export file');
    if (head[MAGIC.length] !== EXPORT_VERSION)
      throw new ExportFormatError(`unknown export version ${head[MAGIC.length]}`);
    const tag = Buffer.alloc(TAG);
    await fh.read(tag, 0, TAG, size - TAG);
    const salt = head.subarray(MAGIC.length + 1, MAGIC.length + 17);
    const d = createDecipheriv(
      'aes-256-gcm',
      await exportKey(passphrase, salt),
      head.subarray(-12),
    );
    d.setAAD(head).setAuthTag(tag);
    const part = `${dst}.part`;
    // `wx` after the removal: a symlink planted at the part path is never followed.
    await rm(part, { force: true });
    try {
      await pipeline(
        fh.createReadStream({ start: HEAD, end: size - TAG - 1, autoClose: false }),
        d,
        createWriteStream(part, { mode: 0o600, flags: 'wx' }),
      );
      // ponytail: check, then rename; a file that appears in between is replaced. link() would close
      // it but fails on file systems without hard links.
      if (
        await lstat(dst).then(
          () => true,
          () => false,
        )
      )
        throw new DestinationExists(`${dst} exists`);
      await rename(part, dst);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
  } finally {
    await fh.close();
  }
}
