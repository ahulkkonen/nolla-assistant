import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export type SandboxDetails = { exit: number | null; timedOut: boolean };
type BrokerEvent =
  | { stream: 'stdout' | 'stderr'; line: string }
  | { exit: number; timedOut: boolean }
  | { error: string };

const MAX_OUTPUT = 20_000;
const UPDATE_EVERY_MS = 100;

/** Pi's `bash`, replaced by a broker call (phase-5 decision 3). Add `bash` to the host `tools`. */
export function sandboxExtension(opts: {
  brokerUrl: string;
  token: string;
  userId: string;
  chatId: string;
  skill?: () => string | undefined;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'bash',
      label: 'bash',
      description:
        'Run a shell command in an isolated sandbox (no network by default). The working directory is your workspace.',
      parameters: Type.Object({
        command: Type.String(),
        timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (max 120)' })),
      }),
      async execute(_id, params, signal, onUpdate) {
        let out = '';
        let truncated = false;
        let lastUpdate = 0;
        let pendingUpdate = false;
        const details: SandboxDetails = { exit: null, timedOut: false };
        const text = () => (truncated ? `[output truncated]\n${out}` : out);
        const update = (force = false) => {
          const now = Date.now();
          if (!force && now - lastUpdate < UPDATE_EVERY_MS) return void (pendingUpdate = true);
          lastUpdate = now;
          pendingUpdate = false;
          onUpdate?.({ content: [{ type: 'text', text: text() }], details });
        };
        const fail = (msg: string) => ({
          content: [{ type: 'text' as const, text: `${text()}\n${msg}`.trimStart() }],
          details,
          isError: true,
        });
        const skill = opts.skill?.();
        const timeoutMs = Math.min(
          Math.max(Math.round((params.timeout ?? 120) * 1000), 1000),
          120_000,
        );
        // Hard stop past the broker's longest run (120 s), in case the broker hangs.
        const limit = AbortSignal.timeout(130_000);
        try {
          const res = await fetch(`${opts.brokerUrl}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-broker-token': opts.token },
            body: JSON.stringify({
              userId: opts.userId,
              chatId: opts.chatId,
              command: params.command,
              ...(skill ? { skill } : {}),
              timeoutMs,
            }),
            signal: signal ? AbortSignal.any([signal, limit]) : limit,
          });
          if (!res.ok || !res.body) return fail(`sandbox broker: HTTP ${res.status}`);
          const decoder = new TextDecoder();
          let buf = '';
          // Cast: the DOM lib (e2e typecheck) types ReadableStream without an async iterator.
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += decoder.decode(chunk, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const l of lines) {
              if (!l) continue;
              const ev = JSON.parse(l) as BrokerEvent;
              if ('error' in ev) return fail(`sandbox broker: ${ev.error}`);
              if ('line' in ev) {
                out += `${ev.line}\n`;
                if (out.length > MAX_OUTPUT) {
                  out = out.slice(-MAX_OUTPUT);
                  truncated = true;
                }
                update();
              } else {
                details.exit = ev.exit;
                details.timedOut = ev.timedOut;
              }
            }
          }
        } catch (err) {
          return fail(`sandbox broker: ${(err as Error).message}`);
        } finally {
          if (pendingUpdate) update(true);
        }
        if (details.exit === null) return fail('sandbox broker: stream ended without exit');
        const tail = details.timedOut
          ? '\n[timed out]'
          : details.exit
            ? `\n[exit ${details.exit}]`
            : '';
        return { content: [{ type: 'text', text: `${text()}${tail}` || '(no output)' }], details };
      },
    });
  };
}
