import { clsx } from 'clsx';
import { Check, KeyRound, LogOut, Monitor, Moon, Settings, Sun, X } from 'lucide-react';
import { Dialog, DropdownMenu } from 'radix-ui';
import { useState } from 'react';
import { logout, passkeyRegister } from '../api.ts';
import { type Theme, useStore } from '../store.ts';
import { disconnect } from '../ws.ts';
import { IconButton } from './IconButton.tsx';

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'Järjestelmä', Icon: Monitor },
  { value: 'light', label: 'Vaalea', Icon: Sun },
  { value: 'dark', label: 'Tumma', Icon: Moon },
];

const item =
  'flex h-9 cursor-default items-center gap-2 rounded-sm px-2 outline-none data-[highlighted]:bg-bg-sunken';

export function ThemeMenu() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const Current = THEMES.find((t) => t.value === theme)?.Icon ?? Monitor;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label="Teema">
          <Current size={20} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={4}
          className="z-50 min-w-40 rounded-md border border-border bg-bg-raised p-1"
        >
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
            {THEMES.map(({ value, label, Icon }) => (
              <DropdownMenu.RadioItem key={value} value={value} className={item}>
                <Icon size={16} />
                <span className="flex-1">{label}</span>
                <DropdownMenu.ItemIndicator>
                  <Check size={16} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The whole settings for now: theme, passkey registration, logout. */
export function SettingsDialog() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
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
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <IconButton label="Asetukset">
          <Settings size={20} />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-fg/30" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-32px)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-raised p-6">
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
          <div className="flex flex-col gap-2">
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
