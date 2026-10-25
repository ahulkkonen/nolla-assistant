import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { PromptOptions } from '@earendil-works/pi-coding-agent';
import { chats, type Db, files } from '@pa/db';
import type { AttachmentRef } from '@pa/protocol';
import { and, eq, inArray, sum } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import mammoth from 'mammoth';
import sharp from 'sharp';
import { getDocumentProxy } from 'unpdf';

export type ImageContent = NonNullable<PromptOptions['images']>[number];

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIMES = new Set(['application/pdf', DOCX, 'text/plain', 'text/csv', 'text/markdown']);
const MAX_PIXELS = 1_500_000;
const MAX_TEXT = 60_000;
const MAX_PDF_PAGES = 100;
const MAX_DOCX_UNZIPPED = 50 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 20_000;
const USER_QUOTA = 2 * 1024 ** 3;
const SNIFF_BYTES = 8192;
const TEXT_FAILED = '(tekstin poiminta epäonnistui)';

const startsWith = (head: Buffer, sig: string, at = 0) =>
  head.subarray(at, at + sig.length).equals(Buffer.from(sig, 'latin1'));

/** True when the first bytes match the declared mime. Text must be NUL-free strict UTF-8. */
function sniff(mime: string, head: Buffer): boolean {
  switch (mime) {
    case 'application/pdf':
      return startsWith(head, '%PDF-');
    case DOCX:
      return startsWith(head, 'PK\x03\x04');
    case 'image/png':
      return startsWith(head, '\x89PNG\r\n\x1a\n');
    case 'image/jpeg':
      return startsWith(head, '\xff\xd8\xff');
    case 'image/webp':
      return startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8);
    case 'image/gif':
      return startsWith(head, 'GIF87a') || startsWith(head, 'GIF89a');
    default:
      if (head.includes(0)) return false;
      try {
        // stream: true so a multi-byte character cut at the 8 KB edge is not an error.
        new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
        return true;
      } catch {
        return false;
      }
  }
}

async function readHead(path: string): Promise<Buffer> {
  const fh = await open(path);
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Strips control characters, brackets and line breaks; at most 120 characters. */
const cleanName = (name: string) => name.replace(/[\p{Cc}\u2028\u2029[\]]/gu, '').slice(0, 120);

type FileRow = typeof files.$inferSelect;

const toRef = (r: FileRow): AttachmentRef => ({
  id: r.id,
  name: r.name,
  mime: r.mime,
  size: r.size,
  kind: IMAGE_MIMES.has(r.mime) ? 'image' : 'document',
});

/** RFC 5987 value for `filename*`. */
const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function fileRoutes(
  app: FastifyInstance,
  db: Db,
  dataDir: string,
  auth: preHandlerHookHandler,
) {
  app.post('/api/files', { preHandler: auth, bodyLimit: 260 * 1024 * 1024 }, async (req, reply) => {
    const { userId } = req;
    mkdirSync(join(dataDir, 'files', userId), { recursive: true });
    const used = Number(
      db
        .select({ total: sum(files.size) })
        .from(files)
        .where(eq(files.userId, userId))
        .get()?.total ?? 0,
    );
    const stored: FileRow[] = [];
    const cleanup = () => {
      for (const r of stored) rmSync(join(dataDir, r.path), { force: true });
    };
    const fail = (code: number, error: string) => {
      cleanup();
      return reply.code(code).send({ error });
    };
    let chatId: string | null = null;
    let added = 0;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'chatId' && typeof part.value === 'string') chatId = part.value;
          continue;
        }
        if (!IMAGE_MIMES.has(part.mimetype) && !DOC_MIMES.has(part.mimetype)) {
          part.file.resume();
          return fail(415, 'unsupported');
        }
        const id = randomUUID();
        const path = join('files', userId, id);
        const row: FileRow = {
          id,
          userId,
          chatId: null,
          name: cleanName(part.filename) || id,
          mime: part.mimetype,
          size: 0,
          path,
          createdAt: new Date().toISOString(),
        };
        stored.push(row);
        await pipeline(part.file, createWriteStream(join(dataDir, path)));
        if (part.file.truncated) return fail(413, 'too_large');
        row.size = part.file.bytesRead;
        added += row.size;
        if (used + added > USER_QUOTA) return fail(413, 'quota');
        if (!sniff(row.mime, await readHead(join(dataDir, path)))) return fail(415, 'unsupported');
      }
    } catch (err) {
      cleanup();
      throw err;
    }
    if (stored.length === 0) return fail(400, 'empty');
    const ownsChat =
      chatId !== null &&
      db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
        .get() !== undefined;
    for (const r of stored) r.chatId = ownsChat ? chatId : null;
    db.insert(files).values(stored).run();
    return { files: stored.map(toRef) };
  });

  app.get<{ Params: { id: string } }>(
    '/api/files/:id',
    { preHandler: auth },
    async (req, reply) => {
      const row = db
        .select()
        .from(files)
        .where(and(eq(files.id, req.params.id), eq(files.userId, req.userId)))
        .get();
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const disposition = IMAGE_MIMES.has(row.mime) ? 'inline' : 'attachment';
      return reply
        .type(row.mime)
        .header('Content-Disposition', `${disposition}; filename*=UTF-8''${rfc5987(row.name)}`)
        .header('Content-Security-Policy', "sandbox; default-src 'none'")
        .send(createReadStream(join(dataDir, row.path)));
    },
  );
}

async function toImage(buf: Buffer, mime: string): Promise<ImageContent> {
  const img = sharp(buf, { autoOrient: true, limitInputPixels: 50e6, failOn: 'error' });
  const { autoOrient } = await img.metadata();
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (autoOrient.width * autoOrient.height)));
  const format = mime === 'image/gif' ? 'png' : (mime.slice(6) as 'png' | 'jpeg' | 'webp');
  const out = await img
    .resize(Math.max(1, Math.floor(autoOrient.width * scale)))
    .toFormat(format)
    .toBuffer();
  return { type: 'image', data: out.toString('base64'), mimeType: `image/${format}` };
}

async function pdfText(buf: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES); i++) {
      const { items } = await (await pdf.getPage(i)).getTextContent();
      pages.push(items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''));
    }
    return pages.join('\n');
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Sum of uncompressed sizes from the zip central directory; Infinity when unreadable or zip64. */
export function zipUnpackedSize(buf: Buffer): number {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return Infinity;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return Infinity;
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) return Infinity;
    total += size;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}

async function toText(buf: Buffer, mime: string): Promise<string> {
  if (mime === 'application/pdf') return pdfText(buf);
  if (mime === DOCX) {
    if (zipUnpackedSize(buf) > MAX_DOCX_UNZIPPED) throw new Error('docx too large unpacked');
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  return buf.toString('utf8');
}

/** Extracted text, or the failure marker after an error or 20 s. */
// ponytail: the timeout stops waiting but does not cancel the parser; move extraction to a worker if a stuck parse ever matters.
async function safeText(buf: Buffer, mime: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('extract timeout')), EXTRACT_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([toText(buf, mime), timeout])).slice(0, MAX_TEXT);
  } catch {
    return TEXT_FAILED;
  } finally {
    clearTimeout(timer);
  }
}

export class AttachmentNotFound extends Error {}

/**
 * Loads the user's files for a message, binds them to `chatId`, and returns Pi images plus the
 * `[Liite: <name>]` text blocks to append to the prompt.
 */
export async function ingestAttachments(
  db: Db,
  config: { dataDir: string },
  userId: string,
  chatId: string,
  refs: AttachmentRef[],
): Promise<{ images: ImageContent[]; text: string }> {
  const ids = [...new Set(refs.map((r) => r.id))].slice(0, 20);
  const rows = ids.length
    ? db
        .select()
        .from(files)
        .where(and(eq(files.userId, userId), inArray(files.id, ids)))
        .all()
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id));
  if (ordered.some((r) => !r || (r.chatId !== null && r.chatId !== chatId)))
    throw new AttachmentNotFound();
  const images: ImageContent[] = [];
  let text = '';
  for (const r of ordered as FileRow[]) {
    const buf = await readFile(join(config.dataDir, r.path));
    if (IMAGE_MIMES.has(r.mime)) images.push(await toImage(buf, r.mime));
    else text += `\n\n[Liite: ${r.name}]\n${await safeText(buf, r.mime)}`;
  }
  if (ids.length)
    db.update(files)
      .set({ chatId })
      .where(and(eq(files.userId, userId), inArray(files.id, ids)))
      .run();
  return { images, text };
}

/** Attachment refs of a chat's files, for rebuilding `chat.state`. */
export function chatFiles(
  db: Db,
  userId: string,
  chatId: string,
): (AttachmentRef & { createdAt: string })[] {
  return db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), eq(files.chatId, chatId)))
    .orderBy(files.createdAt)
    .all()
    .map((r) => ({ ...toRef(r), createdAt: r.createdAt }));
}
