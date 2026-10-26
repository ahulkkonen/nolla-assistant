import type { FileError } from '@pa/protocol';
import { HttpError, treeAttach } from './api.ts';
import { useStore } from './store.ts';

const num = new Intl.NumberFormat('fi', { maximumFractionDigits: 1 });
const UNITS = ['t', 'kt', 'Mt', 'Gt', 'Tt'];

/** "12,4 Mt": bytes in binary steps with Finnish units and a decimal comma (brief 7.9). */
export function formatBytes(n: number) {
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${num.format(u ? v : Math.round(v))} ${UNITS[u]}`;
}

const dateTime = new Intl.DateTimeFormat('fi', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('fi', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});
/** "25.10.2026 klo 17.20", or only the date. */
export const formatDate = (iso: string, time = true) =>
  (time ? dateTime : dateOnly).format(new Date(iso));

/** Finnish text per file route error (phase-11 UI); toasts stay within 60 characters. */
const FILE_ERROR: Partial<Record<FileError, string>> = {
  exists: 'Nimi on jo käytössä.',
  bad_name: 'Nimi ei kelpaa.',
  not_found: 'Tiedostoa ei löydy.',
  too_large: 'Tiedosto on yli 200 Mt.',
  quota: 'Tallennustila on täynnä. Tyhjennä roskakori.',
  unsupported: 'Tätä tiedostotyyppiä ei voi liittää.',
  pseudo_down: 'Nimisuoja ei vastaa. Yritä uudelleen.',
};

/** The text for a failed file route call; `own` overrides a code where the context differs. */
export const fileError = (err: unknown, own: Partial<Record<FileError, string>> = {}) => {
  const code = err instanceof HttpError ? err.code : undefined;
  return (code && (own[code] ?? FILE_ERROR[code])) || 'Toiminto epäonnistui.';
};

/** Opens Tiedostot at a work-dir file: its folder, with the file in the preview. */
export function showInFiles(path: string) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  useStore.setState({
    filesView: { root: 'work', path: dir, focus: path },
    openArtifact: null,
    screen: 'files',
  });
}

/**
 * "Liitä keskusteluun" and the composer picker: a snapshot copy of the work file as an attachment,
 * added to the composer of the open chat (a new chat when none is open).
 */
export async function attachWorkFile(path: string) {
  try {
    const ref = await treeAttach(path);
    useStore.setState((s) => ({ attachQueue: [...s.attachQueue, ref], screen: 'chat' }));
  } catch (err) {
    useStore.getState().pushError(fileError(err, { too_large: 'Liite on yli 25 Mt.' }));
  }
}
