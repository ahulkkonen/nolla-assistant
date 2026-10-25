import { useEffect, useRef } from 'react';
import { useStore } from './store.ts';
import { send } from './ws.ts';

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

/** Global keys: Cmd/Ctrl+K palette, Cmd/Ctrl+Enter send, Esc stop while running, `[` sidebar. */
export function useShortcuts(onSend: () => void) {
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        useStore.setState({ paletteOpen: !st.paletteOpen });
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && st.screen === 'chat') {
        e.preventDefault();
        sendRef.current();
      } else if (e.key === 'Escape' && !e.defaultPrevented && st.screen === 'search') {
        st.setScreen('chat');
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        const id = st.activeChatId;
        if (id && st.agentStatus[id] === 'running') send({ type: 'user.stop', chatId: id });
      } else if (e.key === '[' && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e.target)) {
        e.preventDefault();
        st.setSidebarOpen(!st.sidebarOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
