/**
 * JSON-only calls to the small task model through LiteLLM (`taskSmall`): the title job and the
 * claims extraction use it. One retry with a repair message; each call is a `task` usage row.
 *
 * Every model call goes to LiteLLM (invariant 2). Callers send masked text only (invariant 1);
 * this module must not log a reply, because a reply can quote the text it was given.
 */
import type { z } from 'zod';
import { type RecordUsage, rawUsage } from './usage.ts';

const TIMEOUT_MS = 20_000;

const REPAIR =
  'Vastauksesi ei ollut kelvollista JSONia annetussa muodossa. Vastaa uudelleen pelkällä JSON-objektilla.';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const TASK_MODEL = 'zdr/task-small';

/**
 * JSON-only calls to the LiteLLM alias `zdr/task-small` (or `model`): validates the reply with `schema` and
 * retries once with a repair message. Resolves `undefined` when the reply stays invalid. Each call
 * goes to `onUsage` as a `task` row of `chatId` (phase-13 decision 14).
 */
export function taskSmall(
  litellmUrl: string,
  litellmMasterKey: string,
  onUsage?: RecordUsage,
  model = TASK_MODEL,
) {
  let jsonMode = true;
  const complete = async (messages: ChatMessage[], chatId: string | null): Promise<string> => {
    for (;;) {
      const res = await fetch(`${litellmUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${litellmMasterKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // The alias may reject `response_format`; the prompt asks for JSON only anyway.
      if (res.status === 400 && jsonMode) {
        jsonMode = false;
        continue;
      }
      if (!res.ok) throw new Error(`task-small call status ${res.status}`);
      const body = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: unknown;
      };
      onUsage?.({ kind: 'task', chatId }, rawUsage(model, body.usage, onUsage.warn));
      return body.choices?.[0]?.message?.content ?? '';
    }
  };
  const parse = <T>(schema: z.ZodType<T>, text: string) => {
    try {
      return schema.safeParse(JSON.parse(text.replace(/^\s*```(?:json)?|```\s*$/g, ''))).data;
    } catch {
      // The parser error quotes the reply text: never log it.
      return undefined;
    }
  };
  return async <T>(
    schema: z.ZodType<T>,
    messages: ChatMessage[],
    chatId: string | null = null,
  ): Promise<T | undefined> => {
    const content = await complete(messages, chatId);
    return (
      parse(schema, content) ??
      parse(
        schema,
        await complete(
          [...messages, { role: 'assistant', content }, { role: 'user', content: REPAIR }],
          chatId,
        ),
      )
    );
  };
}
