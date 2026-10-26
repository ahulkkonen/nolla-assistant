import type { CatalogModel, ModelChoice, ModelPolicy, ReasoningEffort } from '@pa/protocol';
import { useStore } from './store.ts';
import { send } from './ws.ts';

/** Thinking levels in Finnish (docs/decisions/phase-10-models.md, UI). */
export const EFFORT_LABEL: Record<'auto' | ReasoningEffort, string> = {
  auto: 'Automaattinen',
  max: 'Maksimi',
  xhigh: 'Erittäin korkea',
  high: 'Korkea',
  medium: 'Keskitaso',
  low: 'Matala',
  minimal: 'Minimaalinen',
  none: 'Pois',
};

/** The alias of an agent profile as infra/models.json names it: `zdr/strong` → "Strong (ZDR)". */
export const aliasName = (alias: string) => {
  const base = alias.replace(/^zdr\//, '').replace(/-/g, ' ');
  return `${base.charAt(0).toUpperCase()}${base.slice(1)} (ZDR)`;
};

/**
 * A model id as LiteLLM got it ('zdr/google/gemini-4-argon', 'zdr/strong'): the catalog name,
 * else the alias name, else the id (phase-13 cost tooltip and Käyttö).
 */
export function modelLabel(catalog: CatalogModel[] | undefined, id: string) {
  const bare = id.replace(/^(zdr|open)\//, '');
  const hit = catalog?.find((m) => m.id === bare);
  if (hit) return hit.name;
  return bare.includes('/') ? id : aliasName(id);
}

/**
 * The phone chip's name: "Claude Opus 5.5" → "Opus 5.5". A name of two words, or one whose second
 * word is not a word ("Gemini 4 Argon"), stays whole.
 */
export const shortName = (name: string) => {
  const [, ...rest] = name.split(' ');
  return rest.length >= 2 && /^\p{L}/u.test(rest[0] ?? '') ? rest.join(' ') : name;
};

/**
 * The model of the open chat (or the new chat's pending choice): its policy, the catalog entry
 * it resolves to, and its display name.
 */
export function useModel() {
  const chatId = useStore((s) => s.activeChatId);
  const stored = useStore((s) => (s.activeChatId ? s.policies[s.activeChatId] : undefined));
  const pending = useStore((s) => s.pendingModel);
  const models = useStore((s) => s.models);
  const agentModel = useStore((s) => {
    const agentId = s.chats.find((c) => c.id === s.activeChatId)?.agentId ?? s.pendingAgentId;
    return s.agents.find((a) => a.id === agentId)?.model;
  });
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const policy: ModelPolicy = stored ?? { ...pending, dataPolicy: 'zdr' };
  const id = policy.modelId === 'auto' ? models?.auto : policy.modelId;
  const entry = id ? models?.catalog.find((m) => m.id === id) : undefined;
  const name =
    policy.modelId === 'auto'
      ? 'Auto'
      : policy.modelId === null
        ? aliasName(agentModel ?? 'zdr/strong')
        : (entry?.name ?? policy.modelId);
  /** Sets the model or the level: the pending choice in a new chat, `chat.setModel` after. */
  const choose = (choice: ModelChoice) => {
    if (chatId) send({ type: 'chat.setModel', chatId, ...choice });
    else useStore.setState({ pendingModel: choice });
  };
  return { chatId, policy, entry, name, models, agentModel, running, choose };
}
