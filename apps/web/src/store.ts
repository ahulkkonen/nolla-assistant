import type { Annotation, ChatSummary, Message, ServerMessage, ToolRow } from '@pa/protocol';
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
            chats: st.chats.map((c) => (c.id === msg.chatId ? { ...c, title: msg.title } : c)),
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
          }));
        case 'error':
          return get().pushError(ERROR_TEXT[msg.code] ?? msg.message);
        default:
          return;
      }
    },

    setAuth: (auth) => set({ auth }),
    setActive: (activeChatId) => set({ activeChatId }),
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
