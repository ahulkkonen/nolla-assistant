import { AlertCircle } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { HttpError } from '../api.ts';
import { useStore } from '../store.ts';
import { useLeaveGuard } from './ConfirmDialog.tsx';

/** The text under a field that the server refused (phase-15 UI). */
export const CHECK_FIELD = 'Tarkista kenttä.';

/** A refused save: the field's id (none: a general error) and the text to show. */
export type FieldError = { field: string | undefined; message: string };

/** The refused field: its text by field id, and focus on the field when the error changes. */
export function useFieldError(initial: FieldError | null = null) {
  const [error, setError] = useState(initial);
  useEffect(() => {
    if (error?.field) document.getElementById(error.field)?.focus();
  }, [error]);
  const at = (id: string) => (error?.field === id ? error.message : null);
  return { error, setError, at };
}

/**
 * A file editor's state (phase-15 UI; the agents and the modes of phase 23): the form, the tab,
 * the refused field, `busy`, and the leave guard of Agentit. `call` saves, or with `dry` checks,
 * what the tab on screen holds and throws a `FieldError`. A tab switch dry-runs first; `take` puts
 * the checked file into the next tab. `page` is the `EditorPage` part.
 */
export function useEditor<F extends object, T extends string, D>(opts: {
  form: F;
  tab: T;
  error: FieldError | null;
  /** The leave guard's text. */
  leave: string;
  call: (form: F, tab: T, dry: boolean) => Promise<D>;
  take: (doc: D, next: T, replace: (form: F) => void) => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState(opts.form);
  const [tab, setTab] = useState(opts.tab);
  const { error, setError, at } = useFieldError(opts.error);
  const [busy, setBusy] = useState(false);
  // Any edit by the user; a dry run's own rewrite of the text does not count.
  const [dirty, setDirty] = useState(false);
  const guard = useLeaveGuard('agents', dirty, opts.leave);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(err as FieldError);
    } finally {
      setBusy(false);
    }
  };
  const onTab = (next: string) =>
    next !== tab &&
    void run(async () => {
      opts.take(await opts.call(form, tab, true), next as T, setForm);
      setTab(next as T);
    });
  const onSave = () =>
    void run(async () => {
      await opts.call(form, tab, false);
      useStore.getState().notify('Tallennettu');
      opts.onDone();
    });
  return {
    form,
    tab,
    at,
    guard,
    /** An edit outside the form's fields (a file text, a prompt). */
    touch: () => setDirty(true),
    set: (patch: Partial<F>) => {
      setDirty(true);
      setForm((f) => ({ ...f, ...patch }));
    },
    page: {
      general: error && !error.field ? error.message : null,
      busy,
      tab,
      onTab,
      onSave,
      onDone: opts.onDone,
    },
  };
}

/**
 * Where an editor's refused save goes: the file tab (its field id and tab name), the name field
 * (a taken id), and the form field of each server `path` prefix.
 */
export type SaveFields = { file: string; tab: string; name: string; fields: [string, string][] };

/**
 * A refused save as the field and its text (phase-15 UI): "Tarkista kenttä." on the form, the
 * server's text on the file tab. A key the form does not show points to the file tab.
 */
export function saveFailure(err: unknown, onFile: boolean, at: SaveFields): FieldError {
  const failed = { field: undefined, message: 'Tallennus epäonnistui. Yritä uudelleen.' };
  if (!(err instanceof HttpError)) return failed;
  if (err.code === 'exists')
    return { field: onFile ? at.file : at.name, message: 'Tunniste on jo käytössä.' };
  if (err.code !== 'bad_message') return failed;
  const { path, message = '' } = err.detail;
  if (onFile) return { field: at.file, message: path ? `${path}: ${message}` : message };
  const field = at.fields.find(([p]) => path === p || path?.startsWith(`${p}.`))?.[1];
  if (field) return { field, message: CHECK_FIELD };
  return {
    field: undefined,
    message: path
      ? `Tarkista kohta ${path} välilehdellä ${at.tab}.`
      : `Tarkista tiedosto välilehdellä ${at.tab}.`,
  };
}

/** `aria-invalid` and `aria-describedby` of the control in a `Field` with this `id`. */
export const invalid = (id: string, error: string | null | undefined) =>
  error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {};

/**
 * A form field (brief 7.5): the label over the control, then the error with `AlertCircle`. `group`:
 * a labelled group of controls (check boxes) that takes focus as a whole when it has an error.
 */
export function Field({
  id,
  label,
  error,
  helper,
  group = false,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string | null | undefined;
  helper?: ReactNode;
  group?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      {...(group
        ? {
            id,
            role: 'group',
            tabIndex: -1,
            'aria-labelledby': `${id}-label`,
            ...(error ? { 'aria-describedby': `${id}-error` } : {}),
          }
        : {})}
      className={cn('flex min-w-0 flex-col gap-1.5 py-3 outline-none', className)}
    >
      {group ? (
        <span id={`${id}-label`} className="text-ui font-medium">
          {label}
        </span>
      ) : (
        <label htmlFor={id} className="text-ui font-medium">
          {label}
        </label>
      )}
      {children}
      {helper && <p className="text-meta text-muted-foreground">{helper}</p>}
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-meta text-destructive">
          <AlertCircle size={16} className="mt-px shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
        </p>
      )}
    </div>
  );
}

/** A check box with its label, padded to a 44 px hit area on phones (brief 7.5). */
function Check({
  label,
  checked,
  onChange,
  mono = false,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  mono?: boolean;
}) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-ui max-md:min-h-11">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded-xs accent-primary"
      />
      <span className={cn(mono && 'font-mono text-[13px]')}>{label}</span>
    </label>
  );
}

/**
 * A grid of check boxes for a list of ids, in the list's own order: identifiers in mono (tools,
 * servers), or the names that `labelOf` gives (modes).
 */
export function Checks({
  options,
  value,
  onChange,
  labelOf,
}: {
  options: readonly string[];
  value: string[];
  onChange: (value: string[]) => void;
  labelOf?: (id: string) => string;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
      {options.map((t) => (
        <Check
          key={t}
          label={labelOf?.(t) ?? t}
          mono={!labelOf}
          checked={value.includes(t)}
          onChange={(on) => onChange(on ? [...value, t] : value.filter((x) => x !== t))}
        />
      ))}
    </div>
  );
}
