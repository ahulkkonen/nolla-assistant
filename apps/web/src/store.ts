import type {
  Annotation,
  Artifact,
  AttachmentRef,
  AutoApprove,
  ChatSummary,
  ExportJob,
  FileRoot,
  ForkLink,
  FxRate,
  Message,
  ModeInfo,
  ModelChoice,
  ModelPolicy,
  ServerMessage,
  ToolRow,
  TreeEntry,
  VaultEntity,
  VaultPending,
} from '@pa/protocol';
import { toast } from 'sonner';
import { create } from 'zustand';
import type { Wait } from './thread.ts';

/** `output`: live `tool.update` text while the tool runs. */
export type ToolView = ToolRow & { argsPreview?: string; output?: string };
/**
 * `serverId`: the entry id of a message this client sent (`message.accepted`); its `id` stays the
 * local one, so the row does not remount. A message from the server has its entry id as `id`.
 */
export type UiMessage = Omit<Message, 'tools'> & { tools: ToolView[]; serverId?: string };
/** The entry id of a message, or undefined while the server has not stored it yet. */
export const serverIdOf = (m: UiMessage) => (m.id.startsWith('local-') ? m.serverId : m.id);
/** Key of `thinkingText`: one assistant entry of one chat. */
export const thinkingKey = (chatId: string, messageId: string) => `${chatId}:${messageId}`;
export type Streaming = {
  messageId: string;
  text: string;
  /** Message-absolute offsets. */
  annotations: Annotation[];
  tools: ToolView[];
};
export type Theme = 'system' | 'light' | 'dark';
type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type TopicState = Of<'topic.state'>;
type SearchResults = Of<'search.results'>;
type RelatedState = Of<'chat.related'>;
/**
 * `expired` / `denied`: decided; the card is gone and its tool row says "vanhentunut" or
 * "hylätty" until the next message in that chat (brief 7.5).
 */
export type Approval = Of<'approval.request'> & { expired?: true; denied?: true };
export type Agent = Of<'agents.state'>['agents'][number];
export type SubagentChild = Of<'subagent.state'>['children'][number];
export type Automation = Of<'automations.state'>['automations'][number];
export type MemoryState = Omit<Of<'memory.state'>, 'type'>;
/** The last `claims.state` (phase 17): proposed, active, superseded and stale claims. */
export type ClaimsState = Omit<Of<'claims.state'>, 'type'>;
export type ClaimChip = Of<'claims.activated'>['claims'][number];
/** The last `models.state` (phase-10): Auto's model, favourites and the catalog. */
export type ModelsState = Omit<Of<'models.state'>, 'type'>;
/** A new chat's model until `chat.create` (phase-10). */
export const DEFAULT_MODEL: ModelChoice = { modelId: 'auto', reasoning: 'auto' };
/** `lines`: "+ added" / "- removed" lines of the agent's write. */
export type MemoryChip = { kind: 'applied' | 'pending'; lines: string[] };

/** "+"/"-" lines of one pending write (the old text from `replace`). */
export function pendingLines(p: MemoryState['pending'][number]): string[] {
  const split = (sign: string, t: string) => t.split('\n').map((l) => `${sign}${l}`);
  if (p.action === 'remove') return split('-', p.replace ?? p.text);
  return [...(p.replace ? split('-', p.replace) : []), ...split('+', p.text)];
}

/** Lines added and removed between two memory states (both files, then new pending writes). */
export function memoryChanges(prev: MemoryState | null, next: MemoryState): string[] {
  if (!prev) return [];
  const out: string[] = [];
  for (const f of ['user', 'memory'] as const) {
    const before = prev[f].split('\n').filter(Boolean);
    const after = next[f].split('\n').filter(Boolean);
    for (const l of after) if (!before.includes(l)) out.push(`+${l}`);
    for (const l of before) if (!after.includes(l)) out.push(`-${l}`);
  }
  const known = new Set(prev.pending.map((p) => p.id));
  for (const p of next.pending) if (!known.has(p.id)) out.push(...pendingLines(p));
  return out;
}

type State = {
  auth: 'unknown' | 'out' | 'in';
  chats: ChatSummary[];
  /** The first `chat.list` has arrived (the sidebar shows skeletons until then). */
  chatsLoaded: boolean;
  /** The sidebar lists archived chats instead of active ones. */
  archivedView: boolean;
  activeChatId: string | null;
  messages: Record<string, UiMessage[]>;
  streaming: Record<string, Streaming>;
  agentStatus: Record<string, 'idle' | 'running'>;
  /** Counts error toasts: screens that wait for a server echo also stop waiting on an error. */
  errorCount: number;
  /** A failed reply per chat, shown inline in the thread until the next message. */
  failed: Record<string, Failure>;
  /** The provider's message of a failed model call in the "Näytä tiedot" dialog (phase 22). */
  errorDetail: Failure | null;
  /** A user message to open in edit mode (↑ in an empty composer). */
  editMessageId: string | null;
  sidebarOpen: boolean;
  theme: Theme;
  /** Annotated spans show the surrogate the model saw instead of the real value. */
  showModelSaw: boolean;
  /** What `main` shows. Choosing a chat returns to `chat`. */
  screen:
    | 'chat'
    | 'vault'
    | 'search'
    | 'topics'
    | 'agents'
    | 'automations'
    | 'memory'
    | 'files'
    | 'usage'
    | 'devices';
  /** The full export (`export.state`, phase 15): null when there is none. */
  exportJob: ExportJob | null;
  /** "Vie kaikki tiedot" dialog. */
  exportAllOpen: boolean;
  /** The newest ECB rate (`fx.state`); null: prices show in dollars (phase-13 decision 16). */
  fx: FxRate | null;
  /** The source of each forked chat from its `chat.state` (phase 13); null: not a fork. */
  forkedFrom: Record<string, ForkLink | null>;
  /**
   * The summary of each chat opened here (`chat.state`, then `chat.updated`): the desktop header
   * reads it, also for a chat outside the loaded list (archived, opened from search).
   */
  summaries: Record<string, ChatSummary>;
  /**
   * A `chat.fork` sent from this client, until its `chat.state` (or an error) arrives. `localId`
   * is the edited text's message in the new chat; `forkId` the new chat once `chat.created` came.
   */
  pendingFork: {
    chatId: string;
    messageId: string;
    text: string;
    localId: string;
    forkId?: string;
  } | null;
  /** Phase 26: the waiting line of each running chat (`thread.ts` `waitSteps`). */
  waits: Record<string, Wait>;
  /** The streamed message that thinks now, per chat (`message.thinking`); `endedAt` once it stopped. */
  thinkingLive: Record<string, { messageId: string; startedAt: number; endedAt?: number }>;
  /** Thinking text per `thinkingKey`, loaded on the first open of its row (`thinking.get`). */
  thinkingText: Record<
    string,
    | { chatId: string; state: 'loading' | 'error' }
    | { chatId: string; state: 'ok'; text: string; annotations: Annotation[] }
  >;
  /** "Näytä ajattelu" (localStorage, on by default): off hides every thinking row. */
  showThinking: boolean;
  setShowThinking(on: boolean): void;
  /** "Näytä luvut" (phase-23 decision 9, localStorage, off by default): every N in the text. */
  showConfN: boolean;
  setShowConfN(on: boolean): void;
  /** The last `usage.state` (Käyttö); null until the first answer. */
  usage: Omit<Of<'usage.state'>, 'type'> | null;
  /** A query for the find bar to open with (a global search hit opens its chat with it). */
  findQuery: string | null;
  /**
   * Where Tiedostot stands (phase-11): a root or the trash, the folder, and an entry to show
   * (opened in the preview) once the folder is listed.
   */
  filesView: { root: FileRoot | 'trash'; path: string; focus: string | null };
  /** The file whose preview is open in Tiedostot; the shell treats it as a side panel. */
  filePreview: { root: FileRoot; entry: TreeEntry } | null;
  /** Work-dir copies to add to the composer as attachments ("Liitä keskusteluun"). */
  attachQueue: AttachmentRef[];
  agents: Agent[];
  /** Agent for the next `chat.create` (the empty chat's picker). */
  pendingAgentId: string;
  /** Model and thinking level for the next `chat.create` (the empty chat's model chip). */
  pendingModel: ModelChoice;
  /** Phase-23 decision 7: the loaded output modes (`agents.state`), without their prompts. */
  modes: ModeInfo[];
  /** Modes for the next `chat.create`; null: the agent's `modes.default` (phase-23 decision 8). */
  pendingModes: string[] | null;
  /** Null until the first `models.state`. */
  models: ModelsState | null;
  /**
   * The model policy of every chat seen (`chat.list`, `chat.created`, `chat.updated`,
   * `chat.state`), also of chats outside the sidebar list (search hits, the other archive view).
   */
  policies: Record<string, ModelPolicy>;
  /**
   * A ZDR refusal per chat (`zdr_unavailable`) and the model it was for. The thread shows it while
   * the chat keeps that model, until consent, a policy change or a new message.
   */
  zdrRefused: Record<string, { modelId: ModelPolicy['modelId'] }>;
  /** The composer's model menu (the refusal alert's "Vaihda malli" opens it). */
  modelMenuOpen: boolean;
  /** Open approval requests of every chat, oldest first. */
  approvals: Approval[];
  /** "Hyväksy automaattisesti" per chat (`chat.state`, `chat.autoApprove`; phase-21 decision 7). */
  autoApprove: Record<string, AutoApprove>;
  /** Live subagent children per chat; cleared when the chat goes idle. */
  subagents: Record<string, SubagentChild[]>;
  /** Last `automations.state`; null until the first one arrives. */
  automations: Automation[] | null;
  /** Last `memory.state`; null until the first one arrives. */
  memory: MemoryState | null;
  /** Chip under a chat's last message after an agent memory write, until the next message. */
  memoryChip: Record<string, MemoryChip>;
  /** Last `claims.state`; null until the first one arrives. */
  claims: ClaimsState | null;
  /** Claims a chat activated at once (`claims.activated`, `chat.state.claims`): its chip. */
  claimChips: Record<string, ClaimChip[]>;
  /**
   * The claim whose action is on its way (its buttons wait); cleared by the next `claims.state`
   * or an error. `undo`: the chip a "Kumoa" took away, restored when the reject fails.
   */
  claimAction: { id: number; undo?: { chatId: string; chip: ClaimChip } } | null;
  /** The last failed claim action: the card shows it inline (no toast). */
  claimError: { id: number; code: string; message: string } | null;
  /** The Muisti screen's tab; "Avaa muisti" in a claim chip opens Havainnot. */
  memoryTab: 'profile' | 'claims';

  /** Artifacts per chat (from `chat.state` and `artifact.upsert`, plus code blocks opened locally). */
  artifacts: Record<string, Artifact[]>;
  /** The artifact of the panel (`shownArtifact`); closed when null or on another chat. */
  openArtifact: { chatId: string; id: string } | null;
  paletteOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  /** The composer holds text, files or a recording (phase-22 decision 5: no reload then). */
  composing: boolean;
  /** The chat the export dialog is open for ("Vie…"); closed when null. */
  exportChatId: string | null;
  integrations: Of<'integrations.state'>['google'] | null;
  showArtifact(chatId: string, a: Artifact): void;
  /** Voice: send the transcript at once, and the language hint (both kept in localStorage). */
  sttAutoSend: boolean;
  sttLanguage: 'fi' | 'en' | 'sv';
  setStt(patch: Partial<Pick<State, 'sttAutoSend' | 'sttLanguage'>>): void;
  setPendingAgentId(id: string): void;
  /** Approved: the card goes and the tool row runs; denied: remembered for the tool row. */
  decideApproval(requestId: string, approved: boolean): void;
  expireApproval(requestId: string): void;
  /** Last `vault.state`; null until the first one arrives. */
  vault: { entities: VaultEntity[]; pending: VaultPending[] } | null;
  /** Per chat, the user message that waits for the vault (`chat.held`): its text, given back on a drop. */
  held: Record<string, string>;
  /**
   * Text for the composer to take back: a held message that was dropped, or a queued one given
   * back. Never sent again by itself.
   */
  draft: { chatId: string; text: string; attachments?: AttachmentRef[] } | null;
  /**
   * Phase-20 decision 17: one message per chat written while a reply runs; `ws.ts` sends it when
   * the chat goes idle. Stop, a failed reply or a held message give it back to the composer.
   */
  queued: Record<string, { text: string; attachments: AttachmentRef[] }>;
  /** Adds to the chat's queued message (a blank line between). */
  enqueue(chatId: string, text: string, attachments: AttachmentRef[]): void;
  /** "Peru" and "Pysäytä": the queued message back into the composer. */
  unqueue(chatId: string): void;
  /** The chat's queued message, out of the queue to be sent. */
  takeQueued(chatId: string): State['queued'][string] | undefined;
  topics: TopicState['topics'];
  /** The first `topic.state` has arrived (the topics screen shows skeletons until then). */
  topicsLoaded: boolean;
  proposals: TopicState['proposals'];
  /** The running search; `results` is null until `search.results` for `q` arrives. */
  search: { q: string; results: SearchResults['results'] | null } | null;
  related: Record<string, RelatedState['related']>;
  /** Message to scroll to once the open chat's messages are loaded. */
  scrollTo: string | null;
  setScrollTo(messageId: string | null): void;
  setScreen(screen: State['screen']): void;
  apply(msg: ServerMessage): void;
  setAuth(auth: State['auth']): void;
  setActive(chatId: string | null): void;
  setArchivedView(on: boolean): void;
  addLocalMessage(chatId: string, msg: UiMessage): void;
  /** Keeps the chat's first `keep` messages and ends the turn (a retry in place). */
  rewind(chatId: string, keep: number): void;
  /** A message sent again: its new local id, and no entry id until `message.accepted`. */
  relocal(chatId: string, id: string, localId: string): void;
  pushError(message: string, action?: { label: string; onClick: () => void }): void;
  notify(message: string, action?: { label: string; onClick: () => void }): void;
  setSidebarOpen(open: boolean): void;
  setTheme(theme: Theme): void;
  setShowModelSaw(on: boolean): void;
};

const THEME_KEY = 'pa.theme';
function loadTheme(): Theme {
  try {
    const t = globalThis.localStorage?.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const THINKING_KEY = 'pa.thinking';
function loadShowThinking() {
  try {
    return globalThis.localStorage?.getItem(THINKING_KEY) !== 'off';
  } catch {
    return true;
  }
}

const CONF_N_KEY = 'pa.confN';
function loadShowConfN() {
  try {
    return globalThis.localStorage?.getItem(CONF_N_KEY) === 'on';
  } catch {
    return false;
  }
}

const STT_KEY = 'pa.stt';
function loadStt(): Pick<State, 'sttAutoSend' | 'sttLanguage'> {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(STT_KEY) ?? '{}');
    return {
      sttAutoSend: v.sttAutoSend === true,
      sttLanguage: ['fi', 'en', 'sv'].includes(v.sttLanguage) ? v.sttLanguage : 'fi',
    };
  } catch {
    return { sttAutoSend: false, sttLanguage: 'fi' };
  }
}

const NO_MODES: string[] = [];
/**
 * Phase-23 decision 7: the active mode ids of `chatId`, or of the new chat when null: the chat's
 * own list, else its agent's `modes.default`. A stable reference, so it can be a selector.
 */
export function effectiveModes(st: State, chatId: string | null): string[] {
  const chat = chatId ? (st.summaries[chatId] ?? st.chats.find((c) => c.id === chatId)) : undefined;
  const own = chatId ? chat?.modes : st.pendingModes;
  if (own) return own;
  const agentId = chatId ? (chat?.agentId ?? 'assistant') : st.pendingAgentId;
  return st.agents.find((a) => a.id === agentId)?.modes ?? NO_MODES;
}

/** First line of the first user message: the label for an untitled chat. */
export const firstUserLine = (msgs?: UiMessage[]) =>
  msgs
    ?.find((m) => m.role === 'user' && m.text.trim())
    ?.text.trim()
    .split('\n')[0];

export const sortChats = (chats: ChatSummary[]) =>
  [...chats].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  );

/**
 * Phase-20 decision 13: the chat's new artifact list, and where the panel goes. New ids are the
 * ones the old list did not hold; none on a chat's `first` list. A new page or component moves an
 * open panel of this chat to it, and opens a closed one in the active chat on the chat screen; a
 * new figure shows inline and moves nothing. An open artifact that is gone gives way to its twin
 * or closes the panel.
 */
function adopt(st: State, chatId: string, list: Artifact[], first = false): Partial<State> {
  const before = st.artifacts[chatId] ?? [];
  const added = first ? [] : list.filter((a) => !before.some((b) => b.id === a.id));
  const artifacts = { ...st.artifacts, [chatId]: list };
  const open = st.openArtifact?.chatId === chatId ? st.openArtifact : null;
  const page = added.findLast((a) => a.kind === 'html' || a.kind === 'react');
  if (open && page) return { artifacts, openArtifact: { chatId, id: page.id } };
  if (open && !list.some((a) => a.id === open.id)) {
    // A local copy's server twin (same content) takes its place; else the panel closes.
    const was = before.find((a) => a.id === open.id);
    const twin = was && list.find((a) => a.content.trimEnd() === was.content.trimEnd());
    return { artifacts, openArtifact: twin ? { chatId, id: twin.id } : null };
  }
  if (!open && page && chatId === st.activeChatId && st.screen === 'chat')
    return { artifacts, openArtifact: { chatId, id: page.id } };
  return { artifacts };
}

/**
 * `chat.state` artifacts plus the ones opened locally from code blocks (`local-` ids, not known
 * to the server) that have no server twin yet.
 */
function mergeArtifacts(st: State, chatId: string, server: Artifact[]): Partial<State> {
  const local = (st.artifacts[chatId] ?? []).filter(
    (a) =>
      a.id.startsWith('local-') && !server.some((x) => x.content.trimEnd() === a.content.trimEnd()),
  );
  return adopt(st, chatId, [...server, ...local], !st.artifacts[chatId]);
}

/** The artifact the panel shows: only on the chat screen, only of the chat on it (decision 12). */
export const shownArtifact = (s: State) =>
  s.screen === 'chat' && s.openArtifact?.chatId === s.activeChatId ? s.openArtifact : null;

const omit = <T>(rec: Record<string, T>, key: string) => {
  const { [key]: _, ...rest } = rec;
  return rest;
};

/** The chat's queued message as the composer's draft (after a draft it already has). */
const giveBack = (st: State, chatId: string): Partial<State> => {
  const q = st.queued[chatId];
  if (!q) return {};
  const before = st.draft?.chatId === chatId ? st.draft : undefined;
  return {
    queued: omit(st.queued, chatId),
    draft: {
      chatId,
      text: [before?.text, q.text].filter(Boolean).join('\n\n'),
      attachments: [...(before?.attachments ?? []), ...q.attachments],
    },
  };
};

/** Finnish text for a server error code, else the server's own text. */
export const errorText = (code: string, message: string) => ERROR_TEXT[code] ?? message;

/** Finnish text per server error code; unknown codes show the server text. */
const ERROR_TEXT: Record<string, string> = {
  llm_failed: 'Mallikutsu epäonnistui.',
  prompt_failed: 'Viestin lähetys epäonnistui.',
  not_found: 'Keskustelua ei löydy.',
  bad_message: 'Virheellinen viesti.',
  not_implemented: 'Ei vielä tuettu.',
  failed: 'Toiminto epäonnistui.',
  pseudo_down: 'Pseudonymisointipalvelu ei vastaa.',
  // A toast: at most 60 characters (brief 7.9); its action "Avaa Nimisuoja" says where.
  pseudo_collision: 'Nimi on jo pseudonyymi. Vastaa Nimisuojassa.',
  held: 'Edellinen viesti odottaa Nimisuojaa.',
  memory_full: 'Muisti on täynnä.',
  memory_conflict: 'Teksti on muuttunut, lataa uudelleen.',
  zdr_unavailable: 'Mallilla ei ole ZDR-reittiä. Avaa keskustelu ja valitse toinen malli.',
};

/** Inline failed-reply text; the alert's "Yritä uudelleen" button says what to do. */
export const FAILED_TEXT = {
  llm_failed: 'Mallikutsu epäonnistui.',
  prompt_failed: 'Viestin lähetys epäonnistui.',
};
type FailedCode = keyof typeof FAILED_TEXT;
/** A failed reply; a failed model call can carry the provider's status and detail (phase 22). */
export type Failure = { code: FailedCode; status?: number; detail?: string };
/** "Mallikutsu epäonnistui (404)" when the provider gave a status, else the code's own text. */
export const failedText = (f: Failure) =>
  f.status === undefined
    ? FAILED_TEXT[f.code]
    : `${FAILED_TEXT.llm_failed.slice(0, -1)} (${f.status})`;

/** What a new turn ends in a chat: decided approvals, the memory chip and both inline alerts. */
const endTurn = (st: State, chatId: string) => ({
  approvals: st.approvals.filter((a) => a.chatId !== chatId || (!a.expired && !a.denied)),
  memoryChip: omit(st.memoryChip, chatId),
  failed: omit(st.failed, chatId),
  zdrRefused: omit(st.zdrRefused, chatId),
});

/** The wait moves to `step` at `now`; leaving the queue adds its time (phase 26). */
const enter = (w: Wait, step: Wait['step'], now: number): Partial<Wait> => ({
  step,
  since: now,
  ...(w.step === 1 ? { queued: (w.queued ?? 0) + now - w.since } : {}),
});
/** The running chat's wait changed by `fn` (at the client's `now`); nothing without one. */
const patchWait = (
  st: State,
  chatId: string,
  fn: (w: Wait, now: number) => Partial<Wait>,
): Partial<State> => {
  const w = st.waits[chatId];
  return w ? { waits: { ...st.waits, [chatId]: { ...w, ...fn(w, Date.now()) } } } : {};
};

/** A chat's run state (`agent.status`, or `chat.state` after a reconnect). */
const status = (st: State, chatId: string, state: 'idle' | 'running'): Partial<State> => ({
  agentStatus: { ...st.agentStatus, [chatId]: state },
  // Phase 26: a run starts its waiting line at "Lähetetään"; a known one keeps going.
  waits:
    state === 'idle'
      ? omit(st.waits, chatId)
      : st.waits[chatId]
        ? st.waits
        : {
            ...st.waits,
            [chatId]: { step: 0, since: Date.now(), accepted: false, ended: false },
          },
  // A turn that ended without a final (error, abort) must not leave a stale stream.
  streaming: state === 'idle' ? omit(st.streaming, chatId) : st.streaming,
  thinkingLive: state === 'idle' ? omit(st.thinkingLive, chatId) : st.thinkingLive,
  // An idle chat waits for nothing: a stop drops its approval without a message.
  ...(state === 'idle'
    ? {
        approvals: st.approvals.filter((a) => a.chatId !== chatId || a.expired || a.denied),
        subagents: omit(st.subagents, chatId),
      }
    : {}),
});

/** Delta annotations are chunk-relative; `offset` is the chunk's start in the message. */
const shift = (annotations: Annotation[], offset: number) =>
  annotations.map((a) => ({ ...a, start: a.start + offset, end: a.end + offset }));

export const useStore = create<State>()((set, get) => {
  const patchStream = (chatId: string, fn: (s: Streaming) => Streaming) =>
    set((st) => ({
      streaming: {
        ...st.streaming,
        [chatId]: fn(
          st.streaming[chatId] ?? { messageId: '', text: '', annotations: [], tools: [] },
        ),
      },
    }));
  const patchTool = (chatId: string, callId: string, patch: Partial<ToolView>) =>
    patchStream(chatId, (s) => ({
      ...s,
      tools: s.tools.map((t) => (t.callId === callId ? { ...t, ...patch } : t)),
    }));

  return {
    auth: 'unknown',
    chats: [],
    chatsLoaded: false,
    archivedView: false,
    activeChatId: null,
    screen: 'chat',
    filesView: { root: 'work', path: '', focus: null },
    filePreview: null,
    attachQueue: [],
    agents: [],
    pendingAgentId: 'assistant',
    pendingModel: DEFAULT_MODEL,
    modes: [],
    pendingModes: null,
    models: null,
    policies: {},
    zdrRefused: {},
    modelMenuOpen: false,
    approvals: [],
    autoApprove: {},
    subagents: {},
    automations: null,
    memory: null,
    memoryChip: {},
    claims: null,
    claimChips: {},
    claimAction: null,
    claimError: null,
    memoryTab: 'profile',
    artifacts: {},
    openArtifact: null,
    paletteOpen: false,
    settingsOpen: false,
    shortcutsOpen: false,
    composing: false,
    exportChatId: null,
    integrations: null,
    ...loadStt(),
    vault: null,
    held: {},
    draft: null,
    queued: {},
    topics: [],
    topicsLoaded: false,
    proposals: [],
    search: null,
    related: {},
    scrollTo: null,
    messages: {},
    streaming: {},
    agentStatus: {},
    errorCount: 0,
    failed: {},
    errorDetail: null,
    editMessageId: null,
    // Docked from 1024 px (brief 7.4); below, the rail or the drawer starts closed.
    sidebarOpen: globalThis.matchMedia?.('(min-width: 1024px)').matches ?? false,
    theme: loadTheme(),
    fx: null,
    exportJob: null,
    exportAllOpen: false,
    forkedFrom: {},
    summaries: {},
    pendingFork: null,
    waits: {},
    thinkingLive: {},
    thinkingText: {},
    showThinking: loadShowThinking(),
    showConfN: loadShowConfN(),
    usage: null,
    findQuery: null,
    showModelSaw: false,

    apply(msg) {
      switch (msg.type) {
        case 'auth.state':
          return set({ auth: msg.authenticated ? 'in' : 'out' });
        case 'chat.list':
          return set((st) => ({
            chats: sortChats(msg.chats),
            chatsLoaded: true,
            policies: {
              ...st.policies,
              ...Object.fromEntries(msg.chats.map((c) => [c.id, c.modelPolicy])),
            },
          }));
        case 'chat.created':
          return set((st) => ({
            // The fork this client asked for: its chat opens now, its state comes next.
            ...(st.pendingFork && !st.pendingFork.forkId
              ? { pendingFork: { ...st.pendingFork, forkId: msg.chat.id } }
              : {}),
            chats: sortChats([msg.chat, ...st.chats.filter((c) => c.id !== msg.chat.id)]),
            activeChatId: msg.chat.id,
            messages: { ...st.messages, [msg.chat.id]: st.messages[msg.chat.id] ?? [] },
            pendingAgentId: 'assistant',
            pendingModel: DEFAULT_MODEL,
            pendingModes: null,
            policies: { ...st.policies, [msg.chat.id]: msg.chat.modelPolicy },
          }));
        case 'chat.updated':
          return set((st) => {
            const rest = st.chats.filter((c) => c.id !== msg.chat.id);
            const was = st.policies[msg.chat.id];
            const now = msg.chat.modelPolicy;
            // A new model or level (the server drops the refusal record) or the consent ends the
            // refusal alert; an unknown previous policy counts as a change.
            const policyChanged =
              !was ||
              was.modelId !== now.modelId ||
              was.reasoning !== now.reasoning ||
              was.dataPolicy !== now.dataPolicy;
            return {
              chats: sortChats(msg.chat.archived === st.archivedView ? [msg.chat, ...rest] : rest),
              ...(st.summaries[msg.chat.id]
                ? { summaries: { ...st.summaries, [msg.chat.id]: msg.chat } }
                : {}),
              policies: { ...st.policies, [msg.chat.id]: now },
              ...(policyChanged ? { zdrRefused: omit(st.zdrRefused, msg.chat.id) } : {}),
            };
          });
        case 'chat.autoApprove': {
          const { type: _, chatId, ...auto } = msg;
          return set((st) => ({ autoApprove: { ...st.autoApprove, [chatId]: auto } }));
        }
        case 'chat.titled':
          return set((st) => ({
            chats: st.chats.map((c) =>
              c.id === msg.chatId ? { ...c, title: msg.title, topicId: msg.topicId } : c,
            ),
          }));
        case 'chat.state':
          return set((st) => {
            // Phase 13: the fork this client asked for: the copied history, then the edited text
            // as the optimistic user message (the server does not echo it).
            // `chat.state` holds the copied history only: the server stores the edited text when
            // the turn starts, and `message.accepted` gives this message its entry id then.
            const fork = st.pendingFork;
            const mine =
              fork &&
              msg.forkedFrom?.chatId === fork.chatId &&
              msg.forkedFrom.messageId === fork.messageId;
            const local: UiMessage[] = mine
              ? [
                  {
                    id: fork.localId,
                    role: 'user',
                    text: fork.text,
                    annotations: [],
                    attachments: [],
                    tools: [],
                    createdAt: new Date().toISOString(),
                  },
                ]
              : [];
            // A message this client sent keeps its local id (no remount, an open edit box stays)
            // and takes the entry id as `serverId`, when the same place holds the same text and
            // the same number of attachments.
            const prev = st.messages[msg.chat.id] ?? [];
            const kept = msg.messages.map((m, k): UiMessage => {
              const old = prev[k];
              return old?.id.startsWith('local-') &&
                old.role === m.role &&
                old.text === m.text &&
                (old.attachments?.length ?? 0) === (m.attachments?.length ?? 0)
                ? { ...m, id: old.id, serverId: m.id }
                : m;
            });
            return {
              messages: { ...st.messages, [msg.chat.id]: [...kept, ...local] },
              summaries: { ...st.summaries, [msg.chat.id]: msg.chat },
              claimChips: { ...st.claimChips, [msg.chat.id]: msg.claims ?? [] },
              policies: { ...st.policies, [msg.chat.id]: msg.chat.modelPolicy },
              forkedFrom: { ...st.forkedFrom, [msg.chat.id]: msg.forkedFrom ?? null },
              ...(msg.autoApprove
                ? { autoApprove: { ...st.autoApprove, [msg.chat.id]: msg.autoApprove } }
                : {}),
              ...(mine ? { pendingFork: null, activeChatId: msg.chat.id, screen: 'chat' } : {}),
              ...(msg.artifacts ? mergeArtifacts(st, msg.chat.id, msg.artifacts) : {}),
              // Phase 20: an `agent.status` missed while offline (the run ended meanwhile).
              ...(msg.running === undefined
                ? {}
                : status(st, msg.chat.id, msg.running ? 'running' : 'idle')),
            };
          });
        case 'fx.state':
          return set({ fx: msg.rate });
        case 'export.state':
          return set({ exportJob: msg.job });
        case 'message.phase':
          // Phase 26: the request is out (its queue clock starts), or its headers came.
          return set((st) =>
            patchWait(st, msg.chatId, (w, now) =>
              msg.phase === 'sent'
                ? { queued: w.queued ?? 0, ...enter(w, 1, now), ended: false, writing: undefined }
                : w.step < 2
                  ? enter(w, 2, now)
                  : {},
            ),
          );
        case 'message.thinking':
          return set((st) => {
            const now = st.thinkingLive[msg.chatId];
            const wait = patchWait(st, msg.chatId, (w, at) =>
              msg.active
                ? { thinking: at, thought: w.thought ?? 0, ...(w.step < 2 ? enter(w, 2, at) : {}) }
                : w.thinking === undefined
                  ? {}
                  : { thought: (w.thought ?? 0) + at - w.thinking, thinking: undefined },
            );
            if (msg.active)
              return {
                ...wait,
                thinkingLive: {
                  ...st.thinkingLive,
                  [msg.chatId]: { messageId: msg.messageId, startedAt: Date.now() },
                },
              };
            return now?.messageId === msg.messageId
              ? {
                  ...wait,
                  thinkingLive: {
                    ...st.thinkingLive,
                    [msg.chatId]: { ...now, endedAt: Date.now() },
                  },
                }
              : wait;
          });
        case 'message.accepted':
          return set((st) => ({
            ...patchWait(st, msg.chatId, () => ({ accepted: true })),
            messages: {
              ...st.messages,
              [msg.chatId]: (st.messages[msg.chatId] ?? []).map((m) =>
                m.id === msg.localId ? { ...m, serverId: msg.messageId } : m,
              ),
            },
          }));
        case 'thinking.text':
          return set((st) => ({
            thinkingText: {
              ...st.thinkingText,
              [thinkingKey(msg.chatId, msg.messageId)]: {
                chatId: msg.chatId,
                state: 'ok',
                text: msg.text,
                annotations: msg.annotations,
              },
            },
          }));
        case 'usage.state': {
          const { type: _, ...usage } = msg;
          return set({ usage });
        }
        case 'artifact.upsert':
          return set((st) => {
            const list = st.artifacts[msg.chatId] ?? [];
            const i = list.findIndex((a) => a.id === msg.artifact.id);
            return adopt(
              st,
              msg.chatId,
              i < 0 ? [...list, msg.artifact] : list.with(i, msg.artifact),
            );
          });
        case 'chat.deleted':
          return set((st) => ({
            chats: st.chats.filter((c) => c.id !== msg.chatId),
            messages: omit(st.messages, msg.chatId),
            artifacts: omit(st.artifacts, msg.chatId),
            streaming: omit(st.streaming, msg.chatId),
            agentStatus: omit(st.agentStatus, msg.chatId),
            waits: omit(st.waits, msg.chatId),
            memoryChip: omit(st.memoryChip, msg.chatId),
            failed: omit(st.failed, msg.chatId),
            zdrRefused: omit(st.zdrRefused, msg.chatId),
            policies: omit(st.policies, msg.chatId),
            queued: omit(st.queued, msg.chatId),
            approvals: st.approvals.filter((a) => a.chatId !== msg.chatId),
            ...(st.activeChatId === msg.chatId
              ? { activeChatId: null, screen: 'chat', scrollTo: null }
              : {}),
            ...(st.openArtifact?.chatId === msg.chatId ? { openArtifact: null } : {}),
          }));
        case 'integrations.state':
          return set({ integrations: msg.google });
        case 'message.delta':
          // Phase 26: the round's first text token: the line moves to "kirjoittaa".
          set((st) =>
            patchWait(st, msg.chatId, (w, now) =>
              w.writing === undefined ? { writing: now, ...enter(w, 3, now) } : {},
            ),
          );
          return patchStream(msg.chatId, (s) =>
            s.messageId === msg.messageId
              ? {
                  ...s,
                  text: s.text + msg.text,
                  annotations: [...s.annotations, ...shift(msg.annotations, s.text.length)],
                }
              : { ...s, messageId: msg.messageId, text: msg.text, annotations: msg.annotations },
          );
        case 'message.final':
          return set((st) => {
            const streamed = st.streaming[msg.chatId]?.tools ?? [];
            const tools = msg.message.tools.map((t) => {
              const s = streamed.find((x) => x.callId === t.callId);
              return s ? { ...s, ...t, summary: t.summary || s.summary } : t;
            });
            const prev = (st.messages[msg.chatId] ?? []).filter((m) => m.id !== msg.message.id);
            return {
              messages: { ...st.messages, [msg.chatId]: [...prev, { ...msg.message, tools }] },
              streaming: omit(st.streaming, msg.chatId),
              thinkingLive: omit(st.thinkingLive, msg.chatId),
              // A reply without tool calls ends the turn's rounds; the live line goes now.
              ...patchWait(st, msg.chatId, () => ({ ended: !msg.message.tools.length })),
            };
          });
        case 'tool.start':
          set((st) =>
            patchWait(st, msg.chatId, (w, now) => ({
              tool: now,
              ...(w.step === 2 ? {} : enter(w, 2, now)),
            })),
          );
          return patchStream(msg.chatId, (s) => ({
            ...s,
            tools: [
              ...s.tools,
              {
                callId: msg.callId,
                name: msg.name,
                status: 'running',
                summary: '',
                argsPreview: msg.argsPreview,
              },
            ],
          }));
        case 'tool.update':
          return patchTool(msg.chatId, msg.callId, { output: msg.output.slice(-2000) });
        case 'tool.end': {
          set((st) => patchWait(st, msg.chatId, () => ({ tool: undefined })));
          const patch = {
            status: msg.status,
            summary: msg.summary,
            // Phase 14: a `web_search` that ran carries its query and links.
            ...(msg.search ? { search: msg.search } : {}),
          };
          // Live: the streamed row. After its `message.final` the row is in `messages`; never a
          // new stream for it (that would show a reply that is not coming).
          if (get().streaming[msg.chatId]?.tools.some((t) => t.callId === msg.callId))
            return patchTool(msg.chatId, msg.callId, patch);
          return set((st) => ({
            messages: {
              ...st.messages,
              [msg.chatId]: (st.messages[msg.chatId] ?? []).map((m) =>
                m.tools.some((t) => t.callId === msg.callId)
                  ? {
                      ...m,
                      tools: m.tools.map((t) => (t.callId === msg.callId ? { ...t, ...patch } : t)),
                    }
                  : m,
              ),
            },
          }));
        }
        case 'agent.status':
          return set((st) => status(st, msg.chatId, msg.state));
        case 'agents.state':
          return set({ agents: msg.agents, modes: msg.modes });
        case 'approval.request':
          return set((st) => ({
            approvals: [...st.approvals.filter((a) => a.requestId !== msg.requestId), msg],
          }));
        case 'approval.resolved':
          return msg.outcome === 'expired'
            ? get().expireApproval(msg.requestId)
            : get().decideApproval(msg.requestId, msg.outcome === 'approved');
        case 'subagent.state':
          return set((st) => ({ subagents: { ...st.subagents, [msg.chatId]: msg.children } }));
        case 'memory.state':
          return set((st) => {
            const { type: _, ...memory } = msg;
            // Mid-turn means the agent wrote; the user's own edits arrive while no chat runs.
            const chatId = st.activeChatId;
            const agentWrite =
              st.screen === 'chat' && chatId && st.agentStatus[chatId] === 'running';
            const grew = memory.pending.length > (st.memory?.pending.length ?? 0);
            const lines = memoryChanges(st.memory, memory);
            // An applied write that changed nothing visible gets no chip.
            const chip = agentWrite && (grew || lines.length > 0);
            return {
              memory,
              ...(chip
                ? {
                    memoryChip: {
                      ...st.memoryChip,
                      [chatId]: {
                        kind: grew ? 'pending' : 'applied',
                        lines,
                      },
                    },
                  }
                : {}),
            };
          });
        case 'claims.state': {
          const { type: _, ...claims } = msg;
          // Chips follow the state: a claim no longer active leaves its chip, a new text shows.
          const active = new Map(claims.active.map((c) => [c.id, c]));
          return set((st) => ({
            claims,
            claimAction: null,
            claimChips: Object.fromEntries(
              Object.entries(st.claimChips).map(([chatId, chips]) => [
                chatId,
                chips.flatMap((c) => {
                  const now = active.get(c.id);
                  return now ? [{ ...c, text: now.text }] : [];
                }),
              ]),
            ),
          }));
        }
        case 'claims.activated':
          return set((st) => ({
            claimChips: {
              ...st.claimChips,
              [msg.chatId]: [
                ...(st.claimChips[msg.chatId] ?? []).filter(
                  (c) => !msg.claims.some((n) => n.id === c.id),
                ),
                ...msg.claims,
              ],
            },
          }));
        case 'automations.state':
          return set({ automations: msg.automations });
        case 'topic.state':
          return set({ topics: msg.topics, proposals: msg.proposals, topicsLoaded: true });
        case 'search.results':
          return set((st) =>
            st.search?.q === msg.q ? { search: { q: msg.q, results: msg.results } } : {},
          );
        case 'chat.related':
          return set((st) => ({ related: { ...st.related, [msg.chatId]: msg.related } }));
        case 'vault.state':
          return set({ vault: { entities: msg.entities, pending: msg.pending } });
        // Phase 12: a message that names an issued surrogate waits for an answer in the vault.
        case 'chat.held': {
          const last = get().messages[msg.chatId]?.findLast((m) => m.role === 'user');
          set((st) => ({
            held: { ...st.held, [msg.chatId]: last?.text ?? '' },
            ...giveBack(st, msg.chatId),
          }));
          // A question, not a success: a warning toast that stays long enough to use its action.
          toast.warning(ERROR_TEXT.pseudo_collision ?? msg.type, {
            duration: 8000,
            action: { label: 'Avaa Nimisuoja', onClick: () => get().setScreen('vault') },
          });
          return;
        }
        case 'chat.released': {
          const st = get();
          const text = st.held[msg.chatId];
          if (text === undefined) return;
          if (msg.outcome === 'resumed') return set({ held: omit(st.held, msg.chatId) });
          // Dropped: the message never reached the chat, so it leaves the thread and its text goes
          // back to the composer.
          const thread = st.messages[msg.chatId] ?? [];
          const last = thread.at(-1);
          set({
            held: omit(st.held, msg.chatId),
            draft: { chatId: msg.chatId, text },
            ...(last?.role === 'user' && last.text === text
              ? { messages: { ...st.messages, [msg.chatId]: thread.slice(0, -1) } }
              : {}),
          });
          return get().notify('Viestiä ei lähetetty. Teksti on taas kirjoituskentässä.');
        }
        case 'models.state': {
          const { type: _, ...models } = msg;
          return set({ models });
        }
        case 'error': {
          // Phase-22 decision 1: devtools shows the whole message of a failed model call.
          if (msg.code === 'llm_failed') console.error('model call failed', msg);
          // A failed reply: its queued message goes back to the composer, not into a new turn.
          if (msg.chatId && ['llm_failed', 'prompt_failed', 'zdr_unavailable'].includes(msg.code))
            set((st) => giveBack(st, msg.chatId as string));
          const st0 = get();
          // Phase 17: a failed claim action shows on its card (or restores the chip it hid).
          const action = st0.claimAction;
          if (action)
            return set((st) => ({
              claimAction: null,
              claimError: {
                id: action.id,
                code: msg.code,
                message: errorText(msg.code, msg.message),
              },
              errorCount: st.errorCount + 1,
              ...(action.undo
                ? {
                    claimChips: {
                      ...st.claimChips,
                      [action.undo.chatId]: [
                        ...(st.claimChips[action.undo.chatId] ?? []),
                        action.undo.chip,
                      ],
                    },
                  }
                : {}),
            }));
          // Phase 13: the answer to a pending `chat.fork`; the edit box stays open for a retry.
          if (
            st0.pendingFork &&
            msg.chatId === st0.pendingFork.chatId &&
            ['bad_message', 'failed', 'not_found', 'pseudo_down'].includes(msg.code)
          ) {
            set({ pendingFork: null });
            return get().pushError(
              msg.code === 'pseudo_down'
                ? (ERROR_TEXT.pseudo_down ?? msg.message)
                : 'Haarautus epäonnistui. Yritä uudelleen.',
            );
          }
          // A thinking text that could not load: its row says so, no toast. The answer names the
          // chat, not the message, so every pending row of that chat takes it.
          const loading = Object.entries(st0.thinkingText).filter(
            ([, t]) => t.state === 'loading' && msg.chatId && t.chatId === msg.chatId,
          );
          if (loading.length && (msg.code === 'not_found' || msg.code === 'pseudo_down'))
            return set((st) => ({
              thinkingText: {
                ...st.thinkingText,
                ...Object.fromEntries(
                  loading.map(([id, t]) => [id, { chatId: t.chatId, state: 'error' as const }]),
                ),
              },
            }));
          // `chat.open` of a chat deleted elsewhere (e.g. while offline) answers not_found; a find
          // query for it must not open in another chat.
          if (msg.code === 'not_found') {
            const st = get();
            if (st.activeChatId && !st.chats.some((c) => c.id === st.activeChatId))
              set({ activeChatId: null, scrollTo: null, findQuery: null });
          }
          // A ZDR refusal asks for consent inline (phase-10 UI), also when the chat opens later;
          // in a chat in the background a toast says so too.
          if (msg.code === 'zdr_unavailable' && msg.chatId) {
            const { chatId } = msg;
            set((st) => ({
              zdrRefused: {
                ...st.zdrRefused,
                // The model the refused run used (phase 20); it may have changed during the run.
                [chatId]: {
                  modelId:
                    msg.modelId === undefined
                      ? (st.policies[chatId]?.modelId ?? null)
                      : msg.modelId,
                },
              },
            }));
            if (chatId !== get().activeChatId)
              return get().pushError(ERROR_TEXT.zdr_unavailable ?? msg.message);
            return set((st) => ({ errorCount: st.errorCount + 1 }));
          }
          if (msg.code === 'llm_failed' || msg.code === 'prompt_failed') {
            const failure: Failure = {
              code: msg.code,
              ...(msg.status === undefined ? {} : { status: msg.status }),
              ...(msg.detail ? { detail: msg.detail } : {}),
            };
            // A failed reply in the open chat is an inline alert with a retry (brief 7.5).
            if (msg.chatId && msg.chatId === get().activeChatId)
              return set((st) => ({
                failed: { ...st.failed, [msg.chatId as string]: failure },
                errorCount: st.errorCount + 1,
              }));
            const detail = { label: 'Näytä tiedot', onClick: () => set({ errorDetail: failure }) };
            return get().pushError(failedText(failure), failure.detail ? detail : undefined);
          }
          return get().pushError(ERROR_TEXT[msg.code] ?? msg.message);
        }
        default:
          return;
      }
    },

    setAuth: (auth) => set({ auth }),
    setActive: (activeChatId) => set({ activeChatId, screen: 'chat' }),
    setScreen: (screen) => set({ screen }),

    setScrollTo: (scrollTo) => set({ scrollTo }),
    setPendingAgentId: (pendingAgentId) => set({ pendingAgentId }),
    setStt(patch) {
      set(patch);
      const { sttAutoSend, sttLanguage } = get();
      try {
        localStorage.setItem(STT_KEY, JSON.stringify({ sttAutoSend, sttLanguage }));
      } catch {}
    },
    showArtifact: (chatId, a) =>
      set((st) => {
        const list = st.artifacts[chatId] ?? [];
        const known = list.find(
          (x) => x.id === a.id || x.content.trimEnd() === a.content.trimEnd(),
        );
        return {
          artifacts: known ? st.artifacts : { ...st.artifacts, [chatId]: [...list, a] },
          openArtifact: { chatId, id: known?.id ?? a.id },
        };
      }),
    enqueue: (chatId, text, attachments) =>
      set((st) => {
        const was = st.queued[chatId];
        return {
          queued: {
            ...st.queued,
            [chatId]: {
              text: [was?.text, text].filter(Boolean).join('\n\n'),
              attachments: [...(was?.attachments ?? []), ...attachments],
            },
          },
        };
      }),
    unqueue: (chatId) => set((st) => giveBack(st, chatId)),
    takeQueued(chatId) {
      const q = get().queued[chatId];
      if (q) set((st) => ({ queued: omit(st.queued, chatId) }));
      return q;
    },
    decideApproval: (requestId, approved) =>
      set((st) => ({
        approvals: approved
          ? st.approvals.filter((a) => a.requestId !== requestId)
          : st.approvals.map((a) =>
              a.requestId === requestId ? { ...a, denied: true as const } : a,
            ),
      })),
    expireApproval: (requestId) =>
      set((st) => ({
        approvals: st.approvals.map((a) =>
          a.requestId === requestId ? { ...a, expired: true as const } : a,
        ),
      })),
    setArchivedView: (archivedView) => set({ archivedView }),
    addLocalMessage: (chatId, m) =>
      set((st) => ({
        ...endTurn(st, chatId),
        messages: { ...st.messages, [chatId]: [...(st.messages[chatId] ?? []), m] },
      })),
    relocal: (chatId, id, localId) =>
      set((st) => ({
        messages: {
          ...st.messages,
          [chatId]: (st.messages[chatId] ?? []).map((m) => {
            if (m.id !== id) return m;
            const { serverId: _, ...rest } = m;
            return { ...rest, id: localId };
          }),
        },
      })),
    rewind: (chatId, keep) =>
      set((st) => ({
        ...endTurn(st, chatId),
        messages: { ...st.messages, [chatId]: (st.messages[chatId] ?? []).slice(0, keep) },
        // A rerun's reply is a new entry: no thinking text of this chat carries over.
        thinkingText: Object.fromEntries(
          Object.entries(st.thinkingText).filter(([, t]) => t.chatId !== chatId),
        ),
      })),
    // Toasts (brief 7.5): 4 s, errors 6 s with a close button.
    pushError(message, action) {
      toast.error(message, { duration: 6000, closeButton: true, ...(action ? { action } : {}) });
      set((st) => ({ errorCount: st.errorCount + 1 }));
    },
    notify: (message, action) => void toast.success(message, action ? { action } : {}),
    setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    setTheme(theme) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {}
      set({ theme });
    },
    setShowModelSaw: (showModelSaw) => set({ showModelSaw }),
    setShowThinking(showThinking) {
      try {
        localStorage.setItem(THINKING_KEY, showThinking ? 'on' : 'off');
      } catch {}
      set({ showThinking });
    },
    setShowConfN(showConfN) {
      try {
        localStorage.setItem(CONF_N_KEY, showConfN ? 'on' : 'off');
      } catch {}
      set({ showConfN });
    },
  };
});

// Phase-20 decision 12: the panel belongs to its chat; another chat (or a new one) closes it.
useStore.subscribe((s, prev) => {
  if (
    s.activeChatId !== prev.activeChatId &&
    s.openArtifact &&
    s.openArtifact.chatId !== s.activeChatId
  )
    useStore.setState({ openArtifact: null });
});
