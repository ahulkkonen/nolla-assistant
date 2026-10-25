import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One upstream request as LiteLLM sent it. `body` is parsed JSON, or the raw text for multipart. */
export type UpstreamRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

/**
 * Mock OpenRouter: records every request and answers chat (plain and SSE), embeddings and
 * transcriptions. Docker Desktop reaches 127.0.0.1 through host.docker.internal; on Linux the
 * host-gateway address is the bridge, so the mock must listen on all interfaces there.
 */
export async function startMockOpenRouter() {
  const requests: UpstreamRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('latin1');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url ?? '';
      const multipart = String(req.headers['content-type']).startsWith('multipart/');
      const body = multipart ? raw : JSON.parse(raw || '{}');
      requests.push({ path, headers: req.headers, body });
      const json = (obj: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.00001 };
      if (path.endsWith('/embeddings')) {
        return json({
          object: 'list',
          model: body.model,
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }
      if (path.endsWith('/audio/transcriptions')) return json({ text: 'hei maailma' });
      const base = { id: 'gen-1', created: Math.floor(Date.now() / 1000), model: body.model };
      if (body.stream !== true) {
        return json({
          ...base,
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage,
        });
      }
      // OpenRouter's stream shape: the usage chunk repeats finish_reason with an empty delta.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (choice: object, extra: object = {}) =>
        res.write(
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }], ...extra })}\n\n`,
        );
      chunk({ delta: { role: 'assistant', content: 'hi' }, finish_reason: null });
      chunk({ delta: { content: '' }, finish_reason: 'stop' });
      chunk({ delta: { content: '' }, finish_reason: 'stop' }, { usage });
      res.end('data: [DONE]\n\n');
    });
  });
  const host = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1';
  await new Promise<void>((r) => server.listen(0, host, r));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
