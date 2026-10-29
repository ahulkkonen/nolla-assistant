import { toast } from 'sonner';
import { useStore } from './store.ts';

type Idle = Pick<ReturnType<typeof useStore.getState>, 'agentStatus' | 'composing' | 'draft'>;

/**
 * Phase-22 decision 5: a reload loses nothing now. No chat runs, the composer is empty (no text
 * to give back either) and no dialog or sheet is open.
 */
export const isIdle = (s: Idle, overlay: boolean) =>
  !overlay && !s.composing && !s.draft && !Object.values(s.agentStatus).includes('running');

const overlayOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"]');

/**
 * A new build waits: `reload` at once when idle, else at the first idle moment. The store covers
 * runs and the composer; dialogs and sheets are portals, so a change of <body>'s children covers
 * them. "Päivitetään…" shows for a second before the reload.
 */
export function reloadWhenIdle(reload: () => void) {
  const check = () => {
    if (!isIdle(useStore.getState(), overlayOpen())) return;
    unsubscribe();
    observer.disconnect();
    toast.loading('Päivitetään…');
    setTimeout(reload, 1000);
  };
  const unsubscribe = useStore.subscribe(check);
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true });
  check();
}
