import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '../store.ts';
import { keys } from './Sidebar.tsx';

/** Exactly the shipped keys (shortcuts.ts, Composer, MicButton); brief 7.8. */
const KEYS: [string, string][] = [
  ['Enter', 'Lähetä viesti'],
  [keys('Enter'), 'Lähetä viesti'],
  ['Shift+Enter', 'Uusi rivi'],
  ['Esc', 'Pysäytä vastaus, peru äänitys tai sulje ikkuna'],
  ['Välilyönti pohjassa', 'Sanele, kun mikrofoni on valittuna'],
  ['↑', 'Muokkaa viimeisintä viestiä, kun viestikenttä on tyhjä'],
  [keys('K'), 'Komennot'],
  [keys('O', true), 'Uusi keskustelu'],
  [keys('F'), 'Etsi keskustelusta'],
  ['Shift+Esc', 'Siirry viestikenttään'],
  ['[', 'Avaa tai sulje sivupalkki'],
];

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={(shortcutsOpen) => useStore.setState({ shortcutsOpen })}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Pikanäppäimet</DialogTitle>
          <DialogDescription className="sr-only">Näppäimet ja niiden toiminnot</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-body">
          {KEYS.map(([key, what]) => (
            <div key={key} className="contents">
              <dt>
                <kbd className="rounded-xs border border-border bg-muted px-1.5 py-0.5 font-sans text-micro">
                  {key}
                </kbd>
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
