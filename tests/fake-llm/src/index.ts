import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeTurn =
  | { text: string; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { toolCalls: { id?: string; name: string; args: Record<string, unknown> }[]; text?: string };
export type FakeRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

const split = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? [];

export async function startFakeLlm(turns: FakeTurn[] = []) {
  const queue = [...turns];
  const requests: FakeRequest[] = [];
  let callN = 0;

  const server = createServer((req, res) => {
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST' || !req.url?.split('?')[0]?.endsWith('/chat/completions')) {
      return json(404, { error: { message: 'fake-llm: not found' } });
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: { message: 'fake-llm: bad json' } });
      }
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const turn = queue.shift();
      if (!turn) return json(500, { error: { message: 'fake-llm: no scripted turn' } });

      const id = `chatcmpl-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model;
      const calls =
        'toolCalls' in turn
          ? turn.toolCalls.map((c) => ({ ...c, id: c.id ?? `call_${++callN}` }))
          : [];
      const text = turn.text ?? '';
      const finish = calls.length ? 'tool_calls' : 'stop';
      const usage =
        'usage' in turn && turn.usage
          ? { ...turn.usage, total_tokens: turn.usage.prompt_tokens + turn.usage.completion_tokens }
          : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      if (body.stream !== true) {
        const message: Record<string, unknown> = { role: 'assistant', content: text || null };
        if (calls.length) {
          message.tool_calls = calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          }));
        }
        return json(200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        });
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (choices: unknown[], extra: object = {}) =>
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`,
        );
      const delta = (d: object, finish_reason: string | null = null) =>
        send([{ index: 0, delta: d, finish_reason }]);

      delta({ role: 'assistant', content: '' });
      for (const part of split(text, 8)) delta({ content: part });
      calls.forEach((c, index) => {
        delta({
          tool_calls: [
            { index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } },
          ],
        });
        for (const part of split(JSON.stringify(c.args), 16)) {
          delta({ tool_calls: [{ index, function: { arguments: part } }] });
        }
      });
      delta({}, finish);
      if (body.stream_options?.include_usage) send([], { usage });
      res.end('data: [DONE]\n\n');
    });
  });

  const { origin, close } = await listenLocal(server);
  return {
    url: `${origin}/v1`,
    requests,
    push: (turn: FakeTurn) => void queue.push(turn),
    close,
  };
}

/** Listens on a free loopback port; `close` also drops open connections. */
export async function listenLocal(server: Server) {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
