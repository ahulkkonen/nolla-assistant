import { useSyncExternalStore } from 'react';

/** Touch-first devices: no hover, so no tooltips and no hover-revealed actions (brief 7.5). */
export const touch = globalThis.matchMedia?.('(hover: none)').matches ?? false;

const phone = globalThis.matchMedia?.('(max-width: 767.98px)');

/** Under 768 px: drawer, top bar, 44 px targets (brief 7.4). */
export const useMobile = () =>
  useSyncExternalStore(
    (fn) => {
      phone?.addEventListener('change', fn);
      return () => phone?.removeEventListener('change', fn);
    },
    () => phone?.matches ?? false,
  );
