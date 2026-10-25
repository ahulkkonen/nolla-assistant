import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Config } from './config.ts';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIMES = new Set(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg']);
const EXT: Record<string, string> = { 'audio/mpeg': 'mp3' };
const TIMEOUT_MS = 70_000;
const RATE = { max: 30, windowMs: 60_000 };

/**
 * `POST /api/transcribe`: multipart `audio` (+ optional `language`) to LiteLLM `zdr/stt`
 * (decision 0004 §7). The audio stays in memory and is never written to disk.
 */
export function sttRoutes(
  app: FastifyInstance,
  auth: preHandlerHookHandler,
  config: Pick<Config, 'litellmUrl' | 'litellmMasterKey'>,
) {
  // ponytail: in-memory sliding window per process; fine for one user and one replica.
  const hits = new Map<string, number[]>();
  app.post(
    '/api/transcribe',
    { preHandler: auth, bodyLimit: MAX_AUDIO_BYTES + 1024 * 1024 },
    async (req, reply) => {
      const now = Date.now();
      const recent = (hits.get(req.userId) ?? []).filter((t) => t > now - RATE.windowMs);
      if (recent.length >= RATE.max) return reply.code(429).send({ error: 'rate_limited' });
      hits.set(req.userId, [...recent, now]);

      let audio: { buf: Buffer; mime: string } | undefined;
      let language = 'fi';
      for await (const part of req.parts({ limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } })) {
        if (part.type === 'field') {
          if (part.fieldname === 'language') language = String(part.value);
          continue;
        }
        const mime = part.mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
        if (part.fieldname !== 'audio' || !MIMES.has(mime)) {
          part.file.resume();
          return reply.code(415).send({ error: 'unsupported' });
        }
        // Throws a 413 when the file passes the size limit.
        audio = { buf: await part.toBuffer(), mime };
      }
      if (!audio) return reply.code(400).send({ error: 'empty' });
      if (!/^[a-z]{2}$/.test(language)) return reply.code(400).send({ error: 'bad_language' });

      const form = new FormData();
      form.set('model', 'zdr/stt');
      form.set('language', language);
      form.set('response_format', 'json');
      const ext = EXT[audio.mime] ?? audio.mime.slice(6);
      form.set(
        'file',
        new Blob([audio.buf as Uint8Array<ArrayBuffer>], { type: audio.mime }),
        `audio.${ext}`,
      );
      try {
        const res = await fetch(`${config.litellmUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.litellmMasterKey}` },
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const { text } = (await res.json()) as { text?: unknown };
        if (typeof text !== 'string') throw new Error('no text');
        return { text };
      } catch (err) {
        req.log.warn({ error: err instanceof Error ? err.message : 'unknown' }, 'stt failed');
        return reply.code(502).send({ error: 'stt_failed' });
      }
    },
  );
}
