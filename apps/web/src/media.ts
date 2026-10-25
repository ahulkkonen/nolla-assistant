import { useSyncExternalStore } from 'react';

/** Touch-first devices: no hover, so no tooltips and no hover-revealed actions (brief 7.5). */
export const touch = globalThis.matchMedia?.('(hover: none)').matches ?? false;

/** Whether `query` matches now; re-renders when it changes. */
export function useMedia(query: string) {
  const mq = globalThis.matchMedia?.(query);
  return useSyncExternalStore(
    (fn) => {
      mq?.addEventListener('change', fn);
      return () => mq?.removeEventListener('change', fn);
    },
    () => mq?.matches ?? false,
  );
}

/** Under 768 px: drawer, top bar, 44 px targets (brief 7.4). */
export const useMobile = () => useMedia('(max-width: 767.98px)');
