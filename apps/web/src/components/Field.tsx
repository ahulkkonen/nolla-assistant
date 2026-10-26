import { AlertCircle } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

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
export function Check({
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

/** A grid of check boxes for a list of names (tools, servers), in the list's own order. */
export function Checks({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
      {options.map((t) => (
        <Check
          key={t}
          label={t}
          mono
          checked={value.includes(t)}
          onChange={(on) => onChange(on ? [...value, t] : value.filter((x) => x !== t))}
        />
      ))}
    </div>
  );
}
