import type {
  Annotation,
  ChatSummary,
  Message,
  ServerMessage,
  ToolRow,
  VaultEntity,
  VaultPending,
} from '@pa/protocol';
import { create } from 'zustand';

export type ToolView = ToolRow & { argsPreview?: string };
export type UiMessage = Omit<Message, 'tools'> & { tools: ToolView[] };
export type Streaming = {
  messageId: string;
  text: string;
  /** Message-absolute offsets. */
  annotations: Annotation[];
  tools: ToolView[];
};
export type Theme = 'system' | 'light' | 'dark';
export type Toast = { id: number; message: string };
type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type TopicState = Of<'topic.state'>;
type SearchResults = Of<'search.results'>;
type RelatedState = Of<'chat.related'>;
export type Approval = Of<'approval.request'>;
export type Agent = Of<'agents.state'>['agents'][number];
export type SubagentChild = Of<'subagent.state'>['children'][number];
export type Automation = Of<'automations.state'>['automations'][number];

type State = {
  auth: 'unknown' | 'out' | 'in';
  chats: ChatSummary[];
  /** The sidebar lists archived chats instead of active ones. */
  archivedView: boolean;
  activeChatId: string | null;
  messages: Record<string, UiMessage[]>;
  streaming: Record<string, Streaming>;
  agentStatus: Record<string, 'idle' | 'running'>;
  errors: Toast[];
  sidebarOpen: boolean;
  theme: Theme;
  /** Annotated spans show the surrogate the model saw instead of the real value. */
  showModelSaw: boolean;
  /** What `main` shows. Choosing a chat returns to `chat`. */
  screen: 'chat' | 'vault' | 'search' | 'topics' | 'agents' | 'automations';
  agents: Agent[];
  /** Agent for the next `chat.create` (the empty chat's picker). */
  pendingAgentId: string;
  /** Open approval requests of every chat, oldest first. */
  approvals: Approval[];
  /** Live subagent children per chat; cleared when the chat goes idle. */
  subagents: Record<string, SubagentChild[]>;
  /** Last `automations.state`; null until the first one arrives. */
  automations: Automation[] | null;
  setPendingAgentId(id: string): void;
  dropApproval(requestId: string): void;
  /** Last `vault.state`; null until the first one arrives. */
  vault: { entities: VaultEntity[]; pending: VaultPending[] } | null;
  topics: TopicState['topics'];
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
  pushError(message: string): void;
  dismissError(id: number): void;
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
};

/** Delta annotations are chunk-relative; `offset` is the chunk's start in the message. */
const shift = (annotations: Annotation[], offset: number) =>
  annotations.map((a) => ({ ...a, start: a.start + offset, end: a.end + offset }));

let toastId = 0;

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
    archivedView: false,
    activeChatId: null,
    screen: 'chat',
    agents: [],
    pendingAgentId: 'assistant',
    approvals: [],
    subagents: {},
    automations: null,
    vault: null,
    topics: [],
    proposals: [],
    search: null,
    related: {},
    scrollTo: null,
    messages: {},
    streaming: {},
    agentStatus: {},
    errors: [],
    sidebarOpen: globalThis.matchMedia?.('(min-width: 1200px)').matches ?? false,
    theme: loadTheme(),
    showModelSaw: false,

    apply(msg) {
      switch (msg.type) {
        case 'auth.state':
          return set({ auth: msg.authenticated ? 'in' : 'out' });
        case 'chat.list':
          return set({ chats: sortChats(msg.chats) });
        case 'chat.created':
          return set((st) => ({
            chats: sortChats([msg.chat, ...st.chats.filter((c) => c.id !== msg.chat.id)]),
            activeChatId: msg.chat.id,
            messages: { ...st.messages, [msg.chat.id]: st.messages[msg.chat.id] ?? [] },
            pendingAgentId: 'assistant',
          }));
        case 'chat.updated':
          return set((st) => {
            const rest = st.chats.filter((c) => c.id !== msg.chat.id);
            return {
              chats: sortChats(msg.chat.archived === st.archivedView ? [msg.chat, ...rest] : rest),
            };
          });
        case 'chat.titled':
          return set((st) => ({
            chats: st.chats.map((c) =>
              c.id === msg.chatId ? { ...c, title: msg.title, topicId: msg.topicId } : c,
            ),
          }));
        case 'chat.state':
          return set((st) => ({ messages: { ...st.messages, [msg.chat.id]: msg.messages } }));
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
          return patchTool(msg.chatId, msg.callId, { summary: msg.output });
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
                  approvals: st.approvals.filter((a) => a.chatId !== msg.chatId),
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
          return get().dropApproval(msg.requestId);
        case 'subagent.state':
          return set((st) => ({ subagents: { ...st.subagents, [msg.chatId]: msg.children } }));
        case 'automations.state':
          return set({ automations: msg.automations });
        case 'topic.state':
          return set({ topics: msg.topics, proposals: msg.proposals });
        case 'search.results':
          return set((st) =>
            st.search?.q === msg.q ? { search: { q: msg.q, results: msg.results } } : {},
          );
        case 'chat.related':
          return set((st) => ({ related: { ...st.related, [msg.chatId]: msg.related } }));
        case 'vault.state':
          return set({ vault: { entities: msg.entities, pending: msg.pending } });
        case 'error':
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
    dropApproval: (requestId) =>
      set((st) => ({ approvals: st.approvals.filter((a) => a.requestId !== requestId) })),
    setArchivedView: (archivedView) => set({ archivedView }),
    addLocalMessage: (chatId, m) =>
      set((st) => ({
        messages: { ...st.messages, [chatId]: [...(st.messages[chatId] ?? []), m] },
      })),
    pushError(message) {
      const id = ++toastId;
      set((st) => ({ errors: [...st.errors, { id, message }] }));
      setTimeout(() => get().dismissError(id), 6000);
    },
    dismissError: (id) => set((st) => ({ errors: st.errors.filter((e) => e.id !== id) })),
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
