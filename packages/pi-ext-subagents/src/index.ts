import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export type ChildStatus = 'queued' | 'running' | 'done' | 'error';
export type Child = { id: string; label: string; status: ChildStatus; durationMs?: number };
export type AskInput = {
  chatId: string;
  tool: string;
  args: unknown;
  reason: string;
  expiresAt: string;
};
/** Same contract as the server's `approvals.ask`: resolves with the user's answer. */
export type Ask = (req: AskInput, signal: AbortSignal) => Promise<boolean>;

export type SubagentsOptions = {
  chatId: string;
  userId: string;
  dataDir: string;
  /** `PI_CODING_AGENT_DIR` of the children; its `models.json` resolves the `zdr` and `open` providers. */
  agentDir: string;
  /** Working folder of the children; file tools stay inside it. */
  cwd: string;
  litellm: { url: string; key: string };
  /** Loads `pi-ext-pseudo` into every child when set. */
  pseudoUrl?: string | undefined;
  /** The parent's Pi provider (phase-10 decision 11): children run in it and nowhere else. */
  provider: 'zdr' | 'open';
  /** Default child model id in `provider`, e.g. `zdr/strong`; the parent's model. */
  model: string;
  tools: string[];
  /** Loads `pi-ext-sandbox` into every child; without it `bash` is removed from `tools`. */
  broker?: { url: string; token: string } | undefined;
  /** Child tools that need the user's approval (the profile's `approval.always`). */
  approvalAlways?: string[];
  onState: (children: Pick<Child, 'id' | 'label' | 'status'>[]) => void;
  /** Each assistant message of a child (its RPC `message_end` record), for usage (phase 13). */
  onUsage?: (message: unknown) => void;
  ask: Ask;
  log: (level: 'warn' | 'debug', msg: string, data?: object) => void;
  /** Per child; tests shorten it. */
  timeoutMs?: number;
};

const MAX_PARALLEL = 4;
const MAX_TASKS = MAX_PARALLEL + 8;
const MINUTES_10 = 10 * 60_000;
const KILL_GRACE_MS = 5000;
const INSTRUCTION =
  'Do the task below. Your final assistant message is your result: make it complete and self-contained.';

const require = createRequire(import.meta.url);
/** `bin.pi` of the installed Pi; its `exports` hide `package.json`, so walk the lookup paths. */
function piCli(): string {
  const name = '@earendil-works/pi-coding-agent';
  for (const dir of require.resolve.paths(name) ?? []) {
    const pkg = join(dir, name, 'package.json');
    if (existsSync(pkg)) return join(dir, name, JSON.parse(readFileSync(pkg, 'utf8')).bin.pi);
  }
  throw new Error(`${name} not found`);
}

type Msg = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
const textOf = (m: Msg) =>
  Array.isArray(m.content)
    ? m.content
        .map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text : ''))
        .join('')
    : typeof m.content === 'string'
      ? m.content
      : '';

/**
 * Tool `subagent` (plan §9, phase-5 decision 5): runs tasks in child `pi --mode rpc` processes
 * that load the same masking extension and write their JSONL under the chat's `sub/` folder.
 * Add `subagent` to the host `tools`.
 */
export function subagentsExtension(opts: SubagentsOptions): ExtensionFactory {
  const { chatId, userId, provider, model, ask, log, timeoutMs = MINUTES_10 } = opts;
  // Pi's built-in `bash` is never allowed (plan §2 invariant 8): without the sandbox extension,
  // `--tools bash` would enable the built-in one.
  const { broker } = opts;
  const tools = opts.tools.filter((t) => t !== 'bash' || broker);
  const cli = piCli();
  const extensions = [
    ...(opts.pseudoUrl ? [require.resolve('@pa/pi-ext-pseudo/cli')] : []),
    fileURLToPath(new URL('./child.ts', import.meta.url)),
    ...(broker ? [require.resolve('@pa/pi-ext-sandbox/cli')] : []),
  ];
  const sessionDir = join(opts.dataDir, 'sessions', userId, chatId, 'sub');

  /** Runs one child to `agent_settled`; resolves with its last assistant text. */
  const run = (
    child: Child,
    childModel: string,
    task: string,
    signal: AbortSignal | undefined,
    progress: (line: string) => void,
  ) =>
    new Promise<string>((resolveRun, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      mkdirSync(sessionDir, { recursive: true });
      const proc = spawn(
        process.execPath,
        [
          cli,
          '--mode',
          'rpc',
          '--session-dir',
          sessionDir,
          '--provider',
          provider,
          '--model',
          childModel,
          '--tools',
          tools.join(','),
          '--no-extensions',
          '--no-skills',
          '--no-context-files',
          '--no-approve',
          ...extensions.flatMap((e) => ['-e', e]),
        ],
        {
          cwd: opts.cwd,
          // Minimal env: no provider keys besides the LiteLLM master key (invariant 2).
          env: {
            PATH: process.env.PATH ?? '',
            HOME: opts.agentDir,
            PI_CODING_AGENT_DIR: opts.agentDir,
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1',
            PI_TELEMETRY: '0',
            LITELLM_URL: opts.litellm.url,
            LITELLM_MASTER_KEY: opts.litellm.key,
            USER_ID: userId,
            PA_SESSION_ID: `${chatId}/sub/${child.id}`,
            PA_PARENT_CHAT_ID: chatId,
            PA_APPROVAL_ALWAYS: (opts.approvalAlways ?? []).join(','),
            ...(opts.pseudoUrl ? { PSEUDO_URL: opts.pseudoUrl } : {}),
            ...(broker ? { BROKER_URL: broker.url, BROKER_TOKEN: broker.token } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let error: string | undefined;
      let settled = false;
      let last: Msg | undefined;
      let stdout = '';
      let stderr = '';
      const approvals = new AbortController();
      const send = (o: object) => {
        if (proc.stdin.writable) proc.stdin.write(`${JSON.stringify(o)}\n`);
      };
      const fail = (msg: string) => {
        error ??= msg;
        proc.kill('SIGTERM');
        setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), KILL_GRACE_MS).unref();
      };
      const timer = setTimeout(() => fail('timed out'), timeoutMs);
      const onAbort = () => fail('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });

      const confirm = async (req: { id: string; title: string; message: string }) => {
        let args: unknown;
        try {
          args = JSON.parse(req.message);
        } catch {
          args = req.message;
        }
        const s = AbortSignal.any([AbortSignal.timeout(MINUTES_10), approvals.signal]);
        const aborted = new Promise<false>((r) => s.addEventListener('abort', () => r(false)));
        const answer = ask(
          {
            chatId,
            tool: req.title,
            args,
            reason: `Aliagentti ${child.label}: työkalu ${req.title} vaatii hyväksynnän.`,
            expiresAt: new Date(Date.now() + MINUTES_10).toISOString(),
          },
          s,
        );
        send({
          type: 'extension_ui_response',
          id: req.id,
          confirmed: await Promise.race([answer, aborted]),
        });
      };

      const onRecord = (e: any) => {
        switch (e.type) {
          case 'response':
            if (!e.success) fail(`${e.command}: ${e.error}`);
            break;
          case 'message_end':
            if (e.message?.role === 'assistant') {
              last = e.message;
              opts.onUsage?.(e.message);
            }
            break;
          case 'tool_execution_start':
          case 'tool_execution_end':
            // Tool name only: child arguments are real values.
            progress(
              `${e.toolName} ${e.type === 'tool_execution_start' ? '…' : e.isError ? '✗' : '✓'}`,
            );
            break;
          case 'extension_ui_request':
            if (e.method === 'confirm') void confirm(e);
            else if (['select', 'input', 'editor'].includes(e.method))
              send({ type: 'extension_ui_response', id: e.id, cancelled: true });
            break;
          case 'extension_error':
            log('warn', 'subagent extension error', { childId: child.id, event: e.event });
            break;
          case 'agent_settled':
            settled = true;
            proc.stdin.end();
            break;
        }
      };
      // LF-only framing (contract note §9): no readline.
      proc.stdout.setEncoding('utf8').on('data', (d: string) => {
        stdout += d;
        for (let i = stdout.indexOf('\n'); i >= 0; i = stdout.indexOf('\n')) {
          const line = stdout.slice(0, i).replace(/\r$/, '');
          stdout = stdout.slice(i + 1);
          try {
            if (line) onRecord(JSON.parse(line));
          } catch {}
        }
      });
      proc.stderr.setEncoding('utf8').on('data', (d: string) => {
        stderr = (stderr + d).slice(-2000);
      });
      proc.stdin.on('error', () => {});
      proc.on('error', (err) => fail(err.message));
      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        approvals.abort();
        if (!error && last?.stopReason === 'error') error = last.errorMessage ?? 'model error';
        if (!error && !settled) error = `exited with ${code}: ${stderr.trim()}`;
        if (error) reject(new Error(error));
        else resolveRun(last ? textOf(last) : '');
      });
      send({ type: 'prompt', id: 'task', message: `${INSTRUCTION}\n\n${task}` });
    });

  return (pi) => {
    pi.registerTool({
      name: 'subagent',
      label: 'subagent',
      description:
        'Delegate tasks to subagents. Each subagent is a fresh agent that sees only its task text. ' +
        `mode single: one task. mode parallel: up to ${MAX_TASKS} tasks, ${MAX_PARALLEL} at a time. ` +
        'mode chain: tasks run in order and each task gets the previous result appended.',
      parameters: Type.Object({
        mode: Type.Union([Type.Literal('single'), Type.Literal('parallel'), Type.Literal('chain')]),
        tasks: Type.Array(
          Type.Object({
            label: Type.String({ description: 'Short name shown to the user' }),
            task: Type.String(),
            model: Type.Optional(Type.String()),
          }),
          { minItems: 1 },
        ),
      }),
      async execute(_id, { mode, tasks }, signal, onUpdate) {
        if (mode === 'single' && tasks.length !== 1)
          throw new Error('mode single takes exactly one task');
        if (tasks.length > MAX_TASKS)
          throw new Error(
            `Too many tasks: at most ${MAX_TASKS} (${MAX_PARALLEL} run at a time, ${MAX_TASKS - MAX_PARALLEL} wait). Split the work.`,
          );
        // A child keeps the chat's data policy: a prompt-injected model id must not leave it.
        const foreign = tasks.find(
          (t) => t.model !== undefined && !t.model.startsWith(`${provider}/`),
        );
        if (foreign)
          throw new Error(
            `Model ${foreign.model} is not allowed: subagent models must start with ${provider}/. Leave model unset to use the chat's model.`,
          );
        const children: Child[] = tasks.map((t) => ({
          id: randomUUID(),
          label: t.label,
          status: 'queued',
        }));
        const results: string[] = [];
        const details = () => ({ children: children.map((c) => ({ ...c })) });
        const update = (text = '') => {
          opts.onState(children.map(({ id, label, status }) => ({ id, label, status })));
          onUpdate?.({ content: [{ type: 'text', text }], details: details() });
        };
        const runOne = async (i: number, task: string) => {
          const child = children[i] as Child;
          child.status = 'running';
          update();
          const t0 = Date.now();
          try {
            results[i] = await run(child, tasks[i]?.model ?? model, task, signal, (line) =>
              update(`${child.label}: ${line}`),
            );
            child.status = 'done';
          } catch (err) {
            results[i] = `(failed: ${err instanceof Error ? err.message : String(err)})`;
            child.status = 'error';
          }
          child.durationMs = Date.now() - t0;
          update();
        };
        update();
        if (mode === 'chain') {
          for (const [i, t] of tasks.entries()) {
            const prev = children[i - 1];
            if (prev && prev.status !== 'done') {
              results[i] = '(skipped: the previous task failed)';
              (children[i] as Child).status = 'error';
              continue;
            }
            await runOne(i, prev ? `${t.task}\n\nPrevious result:\n${results[i - 1]}` : t.task);
          }
          update();
        } else {
          let next = 0;
          const worker = async () => {
            for (let i = next++; i < tasks.length; i = next++)
              await runOne(i, tasks[i]?.task ?? '');
          };
          await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, tasks.length) }, worker));
        }
        return {
          content: [
            {
              type: 'text',
              text: children.map((c, i) => `### ${c.label}\n\n${results[i]}`).join('\n\n'),
            },
          ],
          details: details(),
        };
      },
    });
  };
}
