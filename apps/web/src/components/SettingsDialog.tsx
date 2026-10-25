import { clsx } from 'clsx';
import { KeyRound, LogOut, Monitor, Moon, Settings, ShieldCheck, Sun, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useRef, useState } from 'react';
import { logout, passkeyRegister } from '../api.ts';
import { type Theme, useStore } from '../store.ts';
import { disconnect } from '../ws.ts';
import { IconButton } from './IconButton.tsx';

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'Järjestelmä', Icon: Monitor },
  { value: 'light', label: 'Vaalea', Icon: Sun },
  { value: 'dark', label: 'Tumma', Icon: Moon },
];

/** Settings: theme, the vault screen, passkey registration, logout. */
export function SettingsDialog({ onNavigate }: { onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  // Leaving for another screen: focus must not return to the gear (its tooltip would open).
  const leaving = useRef(false);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const showModelSaw = useStore((s) => s.showModelSaw);
  const setShowModelSaw = useStore((s) => s.setShowModelSaw);
  const [note, setNote] = useState('');

  const addPasskey = async () => {
    setNote('');
    try {
      await passkeyRegister();
      setNote('Avain lisätty.');
    } catch {
      setNote('Avaimen lisäys epäonnistui.');
    }
  };

  const signOut = async () => {
    try {
      await logout();
    } finally {
      disconnect();
      useStore.getState().setAuth('out');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <IconButton label="Asetukset">
          <Settings size={20} />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-fg/30 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          onCloseAutoFocus={(e) => {
            if (leaving.current) e.preventDefault();
            leaving.current = false;
          }}
          className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-sm -translate-y-1/2 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in rounded-lg border border-border bg-bg-raised p-6"
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="font-semibold">Asetukset</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Sulje">
                <X size={20} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Teema, avaimet ja uloskirjautuminen
          </Dialog.Description>
          <fieldset className="mb-6">
            <legend className="mb-2 text-secondary text-fg-muted">Teema</legend>
            <div className="flex gap-1 rounded-md bg-bg-sunken p-1">
              {THEMES.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                  className={clsx(
                    'flex h-8 flex-1 items-center justify-center gap-1 rounded-sm text-secondary',
                    theme === value ? 'bg-bg text-accent' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="mb-6 flex items-center gap-2">
            <input
              type="checkbox"
              checked={showModelSaw}
              onChange={(e) => setShowModelSaw(e.target.checked)}
              className="size-4 accent-accent"
            />
            Näytä mitä malli näki
          </label>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                leaving.current = true;
                setOpen(false);
                onNavigate?.();
                useStore.getState().setScreen('vault');
              }}
              className="flex h-10 items-center gap-2 rounded-md border border-border px-3 hover:bg-bg-sunken"
            >
              <ShieldCheck size={16} />
              Nimisuoja
            </button>
            <button
              type="button"
              onClick={() => void addPasskey()}
              className="flex h-10 items-center gap-2 rounded-md border border-border px-3 hover:bg-bg-sunken"
            >
              <KeyRound size={16} />
              Lisää avain
            </button>
            <p role="status" className="min-h-5 text-secondary text-fg-muted">
              {note}
            </p>
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex h-10 items-center gap-2 rounded-md border border-border px-3 hover:bg-bg-sunken"
            >
              <LogOut size={16} />
              Kirjaudu ulos
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
