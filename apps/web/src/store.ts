import type {
  Annotation,
  Artifact,
  AttachmentRef,
  ChatSummary,
  FileRoot,
  Message,
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

/** `output`: live `tool.update` text while the tool runs. */
export type ToolView = ToolRow & { argsPreview?: string; output?: string };
export type UiMessage = Omit<Message, 'tools'> & { tools: ToolView[] };
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
  failed: Record<string, FailedCode>;
  /** A user message to open in edit mode (↑ in an empty composer). */
  editMessageId: string | null;
  sidebarOpen: boolean;
  theme: Theme;
  /** Annotated spans show the surrogate the model saw instead of the real value. */
  showModelSaw: boolean;
  /** What `main` shows. Choosing a chat returns to `chat`. */
  screen: 'chat' | 'vault' | 'search' | 'topics' | 'agents' | 'automations' | 'memory' | 'files';
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
  /** Live subagent children per chat; cleared when the chat goes idle. */
  subagents: Record<string, SubagentChild[]>;
  /** Last `automations.state`; null until the first one arrives. */
  automations: Automation[] | null;
  /** Last `memory.state`; null until the first one arrives. */
  memory: MemoryState | null;
  /** Chip under a chat's last message after an agent memory write, until the next message. */
  memoryChip: Record<string, MemoryChip>;
  /** Artifacts per chat (from `chat.state` and `artifact.upsert`, plus code blocks opened locally). */
  artifacts: Record<string, Artifact[]>;
  /** The artifact shown in the panel; the panel is closed when null. */
  openArtifact: { chatId: string; id: string } | null;
  paletteOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
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
  pushError(message: string): void;
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
 * `chat.state` artifacts plus the ones opened locally from code blocks (`local-` ids, not known
 * to the server); the panel closes when its artifact is gone.
 */
function mergeArtifacts(st: State, chatId: string, server: Artifact[]): Partial<State> {
  const local = (st.artifacts[chatId] ?? []).filter(
    (a) =>
      a.id.startsWith('local-') && !server.some((x) => x.content.trimEnd() === a.content.trimEnd()),
  );
  const next = [...server, ...local];
  const open = st.openArtifact;
  if (open?.chatId !== chatId || next.some((a) => a.id === open.id))
    return { artifacts: { ...st.artifacts, [chatId]: next } };
  // The open local copy now has a server twin: follow it, else close the panel.
  const was = st.artifacts[chatId]?.find((a) => a.id === open.id);
  const twin = was && server.find((x) => x.content.trimEnd() === was.content.trimEnd());
  return {
    artifacts: { ...st.artifacts, [chatId]: next },
    openArtifact: twin ? { chatId, id: twin.id } : null,
  };
}

const omit = <T>(rec: Record<string, T>, key: string) => {
  const { [key]: _, ...rest } = rec;
  return rest;
};

/** Finnish text per server error code; unknown codes show the server text. */
const ERROR_TEXT: Record<string, string> = {
  llm_failed: 'Mallin kutsu epäonnistui.',
  prompt_failed: 'Viestin lähetys epäonnistui.',
  not_found: 'Keskustelua ei löydy.',
  bad_message: 'Virheellinen viesti.',
  not_implemented: 'Ei vielä tuettu.',
  failed: 'Toiminto epäonnistui.',
  pseudo_down: 'Pseudonymisointipalvelu ei vastaa.',
  pseudo_collision:
    'Viestissä on nimi, joka on jo pseudonyymi. Vastaa Nimisuojassa, niin viesti lähtee.',
  memory_full: 'Muisti on täynnä.',
  memory_conflict: 'Teksti on muuttunut, lataa uudelleen.',
  zdr_unavailable: 'Mallilla ei ole ZDR-reittiä. Avaa keskustelu ja valitse toinen malli.',
};

/** Inline failed-reply text; the alert's "Yritä uudelleen" button says what to do. */
export const FAILED_TEXT = {
  llm_failed: 'Mallin kutsu epäonnistui.',
  prompt_failed: 'Viestin lähetys epäonnistui.',
};
type FailedCode = keyof typeof FAILED_TEXT;

/** What a new turn ends in a chat: decided approvals, the memory chip and both inline alerts. */
const endTurn = (st: State, chatId: string) => ({
  approvals: st.approvals.filter((a) => a.chatId !== chatId || (!a.expired && !a.denied)),
  memoryChip: omit(st.memoryChip, chatId),
  failed: omit(st.failed, chatId),
  zdrRefused: omit(st.zdrRefused, chatId),
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
    models: null,
    policies: {},
    zdrRefused: {},
    modelMenuOpen: false,
    approvals: [],
    subagents: {},
    automations: null,
    memory: null,
    memoryChip: {},
    artifacts: {},
    openArtifact: null,
    paletteOpen: false,
    settingsOpen: false,
    shortcutsOpen: false,
    exportChatId: null,
    integrations: null,
    ...loadStt(),
    vault: null,
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
    editMessageId: null,
    // Docked from 1024 px (brief 7.4); below, the rail or the drawer starts closed.
    sidebarOpen: globalThis.matchMedia?.('(min-width: 1024px)').matches ?? false,
    theme: loadTheme(),
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
            chats: sortChats([msg.chat, ...st.chats.filter((c) => c.id !== msg.chat.id)]),
            activeChatId: msg.chat.id,
            messages: { ...st.messages, [msg.chat.id]: st.messages[msg.chat.id] ?? [] },
            pendingAgentId: 'assistant',
            pendingModel: DEFAULT_MODEL,
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
              policies: { ...st.policies, [msg.chat.id]: now },
              ...(policyChanged ? { zdrRefused: omit(st.zdrRefused, msg.chat.id) } : {}),
            };
          });
        case 'chat.titled':
          return set((st) => ({
            chats: st.chats.map((c) =>
              c.id === msg.chatId ? { ...c, title: msg.title, topicId: msg.topicId } : c,
            ),
          }));
        case 'chat.state':
          return set((st) => ({
            messages: { ...st.messages, [msg.chat.id]: msg.messages },
            policies: { ...st.policies, [msg.chat.id]: msg.chat.modelPolicy },
            ...(msg.artifacts ? mergeArtifacts(st, msg.chat.id, msg.artifacts) : {}),
          }));
        case 'artifact.upsert':
          return set((st) => {
            const list = st.artifacts[msg.chatId] ?? [];
            const i = list.findIndex((a) => a.id === msg.artifact.id);
            const next = i < 0 ? [...list, msg.artifact] : list.with(i, msg.artifact);
            return {
              artifacts: { ...st.artifacts, [msg.chatId]: next },
              // A new artifact in the open chat opens the panel on it.
              ...(i < 0 && msg.chatId === st.activeChatId && st.screen === 'chat'
                ? { openArtifact: { chatId: msg.chatId, id: msg.artifact.id } }
                : {}),
            };
          });
        case 'chat.deleted':
          return set((st) => ({
            chats: st.chats.filter((c) => c.id !== msg.chatId),
            messages: omit(st.messages, msg.chatId),
            artifacts: omit(st.artifacts, msg.chatId),
            streaming: omit(st.streaming, msg.chatId),
            agentStatus: omit(st.agentStatus, msg.chatId),
            memoryChip: omit(st.memoryChip, msg.chatId),
            failed: omit(st.failed, msg.chatId),
            zdrRefused: omit(st.zdrRefused, msg.chatId),
            policies: omit(st.policies, msg.chatId),
            approvals: st.approvals.filter((a) => a.chatId !== msg.chatId),
            ...(st.activeChatId === msg.chatId
              ? { activeChatId: null, screen: 'chat', scrollTo: null }
              : {}),
            ...(st.openArtifact?.chatId === msg.chatId ? { openArtifact: null } : {}),
          }));
        case 'integrations.state':
          return set({ integrations: msg.google });
        case 'message.delta':
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
            };
          });
        case 'tool.start':
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
        case 'tool.end':
          return patchTool(msg.chatId, msg.callId, { status: msg.status, summary: msg.summary });
        case 'agent.status':
          return set((st) => ({
            agentStatus: { ...st.agentStatus, [msg.chatId]: msg.state },
            // A turn that ended without a final (error, abort) must not leave a stale stream.
            streaming: msg.state === 'idle' ? omit(st.streaming, msg.chatId) : st.streaming,
            // An idle chat waits for nothing: a stop drops its approval without a message.
            ...(msg.state === 'idle'
              ? {
                  approvals: st.approvals.filter(
                    (a) => a.chatId !== msg.chatId || a.expired || a.denied,
                  ),
                  subagents: omit(st.subagents, msg.chatId),
                }
              : {}),
          }));
        case 'agents.state':
          return set({ agents: msg.agents });
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
        case 'models.state': {
          const { type: _, ...models } = msg;
          return set({ models });
        }
        case 'error':
          // `chat.open` of a chat deleted elsewhere (e.g. while offline) answers not_found.
          if (msg.code === 'not_found') {
            const st = get();
            if (st.activeChatId && !st.chats.some((c) => c.id === st.activeChatId))
              set({ activeChatId: null, scrollTo: null });
          }
          // A ZDR refusal asks for consent inline (phase-10 UI), also when the chat opens later;
          // in a chat in the background a toast says so too.
          if (msg.code === 'zdr_unavailable' && msg.chatId) {
            const { chatId } = msg;
            set((st) => ({
              zdrRefused: {
                ...st.zdrRefused,
                [chatId]: { modelId: st.policies[chatId]?.modelId ?? null },
              },
            }));
            if (chatId !== get().activeChatId)
              return get().pushError(ERROR_TEXT.zdr_unavailable ?? msg.message);
            return set((st) => ({ errorCount: st.errorCount + 1 }));
          }
          // A failed reply in the open chat is an inline alert with a retry (brief 7.5).
          if (
            (msg.code === 'llm_failed' || msg.code === 'prompt_failed') &&
            msg.chatId &&
            msg.chatId === get().activeChatId
          )
            return set((st) => ({
              failed: { ...st.failed, [msg.chatId as string]: msg.code as FailedCode },
              errorCount: st.errorCount + 1,
            }));
          return get().pushError(ERROR_TEXT[msg.code] ?? msg.message);
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
    rewind: (chatId, keep) =>
      set((st) => ({
        ...endTurn(st, chatId),
        messages: { ...st.messages, [chatId]: (st.messages[chatId] ?? []).slice(0, keep) },
      })),
    // Toasts (brief 7.5): 4 s, errors 6 s with a close button.
    pushError(message) {
      toast.error(message, { duration: 6000, closeButton: true });
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
  };
});
