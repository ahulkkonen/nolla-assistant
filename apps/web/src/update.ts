import { toast } from 'sonner';
import { useStore } from './store.ts';

type Idle = Pick<ReturnType<typeof useStore.getState>, 'agentStatus' | 'composing' | 'draft'>;

/**
 * Phase-22 decision 5: a reload loses nothing now. No chat runs, the composer is empty (no text
 * to give back either) and nothing on the page blocks it (`busy`: an open dialog or sheet, or text
 * in a focused field).
 */
export const isIdle = (s: Idle, busy: boolean) =>
  !busy && !s.composing && !s.draft && !Object.values(s.agentStatus).includes('running');

/** An open dialog or sheet, or text in a focused input (message edit, rename, find bar). */
const pageBusy = () => {
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return true;
  const el = document.activeElement as HTMLInputElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value !== '';
};

let watching = false;

/**
 * A new build waits: `reload` at once when idle, else at the first idle moment. The store covers
 * runs and the composer; dialogs and sheets are portals, so a change of <body>'s children covers
 * them; `input` and `focusout` cover other fields. "Päivitetään…" shows for a second; when the page
 * is no longer idle after it, the toast goes and the wait starts again. One watcher per page.
 */
export function reloadWhenIdle(reload: () => void) {
  if (watching) return;
  watching = true;
  let toastId: string | number | undefined;
  const idle = () => isIdle(useStore.getState(), pageBusy());
  const check = () => {
    if (toastId !== undefined || !idle()) return;
    toastId = toast.loading('Päivitetään…');
    setTimeout(() => {
      // toastId stays set after `reload`: no second toast or reload.
      if (idle()) return reload();
      toast.dismiss(toastId);
      toastId = undefined;
    }, 1000);
  };
  useStore.subscribe(check);
  new MutationObserver(check).observe(document.body, { childList: true });
  for (const type of ['input', 'focusout']) document.addEventListener(type, check);
  check();
}
