/*
 * Escape: one press does one thing (phase-22 decision 6). The first in this order that applies
 * takes the press; every later one sees `defaultPrevented` or no event.
 *
 * 1. A recording or a transcription: Esc cancels it (MicButton, a capture listener on window).
 * 2. The topmost Radix layer: an open select, menu or popover, then the dialog or sheet under it
 *    (palette, settings, shortcuts, exports, confirmations, the model sheet, the phone drawer, the
 *    phone side panel). A tooltip never opens on focus that a layer moves (Tip in IconButton.tsx),
 *    so the Esc meant for a dialog is not spent on the tooltip of its first button.
 * 3. A field with its own Esc: the find bar closes, the sidebar search with text clears (and
 *    leaves the results), a chat or topic rename and a message edit are cancelled. In the drawer
 *    these keep the drawer open.
 * 4. The global keys below: Shift+Esc focuses the composer; Esc on the results page goes back to
 *    the chat; Esc on the chat screen stops a running reply.
 */
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
      } else if (e.key === 'Escape' && e.defaultPrevented) {
        // Taken by an earlier step of the order above.
      } else if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        if (st.screen !== 'chat') st.setScreen('chat');
        requestAnimationFrame(() => focusRef.current());
      } else if (e.key === 'Escape' && st.screen === 'search') {
        st.setScreen('chat');
      } else if (e.key === 'Escape' && st.screen === 'chat') {
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
