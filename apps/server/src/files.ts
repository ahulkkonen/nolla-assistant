import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { PromptOptions } from '@earendil-works/pi-coding-agent';
import { chats, type Db, files } from '@pa/db';
import type { AttachmentRef } from '@pa/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import mammoth from 'mammoth';
import sharp from 'sharp';
import { extractText } from 'unpdf';

export type ImageContent = NonNullable<PromptOptions['images']>[number];

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIMES = new Set(['application/pdf', DOCX, 'text/plain', 'text/csv', 'text/markdown']);
const MAX_PIXELS = 1_500_000;
const MAX_TEXT = 60_000;

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
  app.post('/api/files', { preHandler: auth }, async (req, reply) => {
    const { userId } = req;
    const dir = join(dataDir, 'files', userId);
    mkdirSync(dir, { recursive: true });
    const stored: FileRow[] = [];
    let chatId: string | null = null;
    let rejected = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'chatId' && typeof part.value === 'string') chatId = part.value;
          continue;
        }
        if (!IMAGE_MIMES.has(part.mimetype) && !DOC_MIMES.has(part.mimetype)) {
          rejected = true;
          part.file.resume();
          continue;
        }
        const id = randomUUID();
        const path = join('files', userId, id);
        const row: FileRow = {
          id,
          userId,
          chatId: null,
          name: part.filename.slice(0, 255) || id,
          mime: part.mimetype,
          size: 0,
          path,
          createdAt: new Date().toISOString(),
        };
        stored.push(row);
        await pipeline(part.file, createWriteStream(join(dataDir, path)));
        row.size = part.file.bytesRead;
      }
    } catch (err) {
      for (const r of stored) rmSync(join(dataDir, r.path), { force: true });
      throw err;
    }
    const ownsChat =
      chatId !== null &&
      db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
        .get() !== undefined;
    if (rejected || stored.length === 0) {
      for (const r of stored) rmSync(join(dataDir, r.path), { force: true });
      return reply.code(rejected ? 415 : 400).send({ error: rejected ? 'unsupported' : 'empty' });
    }
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
      return reply
        .type(row.mime)
        .header('Content-Disposition', `inline; filename*=UTF-8''${rfc5987(row.name)}`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(createReadStream(join(dataDir, row.path)));
    },
  );
}

async function toImage(buf: Buffer, mime: string): Promise<ImageContent> {
  const img = sharp(buf, { autoOrient: true });
  const { autoOrient } = await img.metadata();
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (autoOrient.width * autoOrient.height)));
  const format = mime === 'image/gif' ? 'png' : (mime.slice(6) as 'png' | 'jpeg' | 'webp');
  const out = await img
    .resize(Math.max(1, Math.floor(autoOrient.width * scale)))
    .toFormat(format)
    .toBuffer();
  return { type: 'image', data: out.toString('base64'), mimeType: `image/${format}` };
}

async function toText(buf: Buffer, mime: string): Promise<string> {
  if (mime === 'application/pdf')
    return (await extractText(new Uint8Array(buf), { mergePages: true })).text;
  if (mime === DOCX) return (await mammoth.extractRawText({ buffer: buf })).value;
  return buf.toString('utf8');
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
  const ids = refs.map((r) => r.id);
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
    else text += `\n\n[Liite: ${r.name}]\n${(await toText(buf, r.mime)).slice(0, MAX_TEXT)}`;
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
