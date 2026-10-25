import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export type SandboxDetails = { exit: number | null; timedOut: boolean };
type BrokerEvent =
  | { stream: 'stdout' | 'stderr'; line: string }
  | { exit: number; timedOut: boolean }
  | { error: string };

const MAX_OUTPUT = 20_000;

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
        const details: SandboxDetails = { exit: null, timedOut: false };
        const text = () => out.slice(-MAX_OUTPUT);
        const fail = (msg: string) => ({
          content: [{ type: 'text' as const, text: `${text()}\n${msg}`.trimStart() }],
          details,
          isError: true,
        });
        const skill = opts.skill?.();
        try {
          const res = await fetch(`${opts.brokerUrl}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-broker-token': opts.token },
            body: JSON.stringify({
              userId: opts.userId,
              chatId: opts.chatId,
              command: params.command,
              ...(skill ? { skill } : {}),
              ...(params.timeout
                ? { timeoutMs: Math.min(Math.round(params.timeout * 1000), 120_000) }
                : {}),
            }),
            ...(signal ? { signal } : {}),
          });
          if (!res.ok || !res.body) return fail(`sandbox broker: HTTP ${res.status}`);
          const decoder = new TextDecoder();
          let buf = '';
          for await (const chunk of res.body) {
            buf += decoder.decode(chunk, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const l of lines) {
              if (!l) continue;
              const ev = JSON.parse(l) as BrokerEvent;
              if ('error' in ev) return fail(`sandbox broker: ${ev.error}`);
              if ('line' in ev) {
                out += `${ev.line}\n`;
                onUpdate?.({ content: [{ type: 'text', text: text() }], details });
              } else {
                details.exit = ev.exit;
                details.timedOut = ev.timedOut;
              }
            }
          }
        } catch (err) {
          return fail(`sandbox broker: ${(err as Error).message}`);
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
