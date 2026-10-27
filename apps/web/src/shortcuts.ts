import { useEffect, useRef } from 'react';
import { useStore } from './store.ts';
import { stopTurn } from './ws.ts';

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

/**
 * Global keys (brief 7.8; ShortcutsDialog lists them): Cmd/Ctrl+K palette, Cmd/Ctrl+Enter send,
 * Cmd/Ctrl+Shift+O new chat, Shift+Esc focus the composer, Esc stop while running, `[` sidebar.
 */
export function useShortcuts(onSend: () => void, focusComposer: () => void) {
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (e.key.toLowerCase() === 'k' && mod) {
        e.preventDefault();
        useStore.setState({ paletteOpen: !st.paletteOpen });
      } else if (e.key.toLowerCase() === 'o' && mod && e.shiftKey) {
        e.preventDefault();
        st.setActive(null);
        requestAnimationFrame(() => focusRef.current());
      } else if (e.key === 'Enter' && mod && st.screen === 'chat') {
        e.preventDefault();
        sendRef.current();
      } else if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        if (st.screen !== 'chat') st.setScreen('chat');
        requestAnimationFrame(() => focusRef.current());
      } else if (e.key === 'Escape' && !e.defaultPrevented && st.screen === 'search') {
        st.setScreen('chat');
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        const id = st.activeChatId;
        if (id && st.agentStatus[id] === 'running') stopTurn(id);
      } else if (e.key === '[' && !mod && !e.altKey && !editable(e.target)) {
        e.preventDefault();
        st.setSidebarOpen(!st.sidebarOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
