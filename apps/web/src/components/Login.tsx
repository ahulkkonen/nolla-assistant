import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { HttpError, me, passkeyLogin, passwordLogin } from '../api.ts';
import { useStore } from '../store.ts';
import { connect } from '../ws.ts';

const message = (err: unknown) =>
  err instanceof HttpError
    ? err.status === 401
      ? 'Väärä salasana.'
      : err.status === 429
        ? 'Liian monta yritystä. Odota hetki.'
        : 'Kirjautuminen epäonnistui.'
    : 'Kirjautuminen epäonnistui.';

export function Login() {
  const setAuth = useStore((s) => s.setAuth);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (login: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await login();
      await me();
      setAuth('in');
      connect();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (password) void run(() => passwordLogin(password));
  };

  return (
    <main className="flex h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-raised p-6">
        <h1 className="mb-6 font-semibold">Assistant</h1>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label htmlFor="password" className="text-secondary text-fg-muted">
            Salasana
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 rounded-md border border-border bg-bg px-3 max-md:h-11"
          />
          <button
            type="submit"
            disabled={busy || !password}
            className="h-10 rounded-md bg-accent font-medium max-md:h-11 text-accent-fg disabled:bg-bg-sunken disabled:text-fg-muted"
          >
            Kirjaudu
          </button>
        </form>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(passkeyLogin)}
          className="mt-3 flex h-10 w-full max-md:h-11 items-center justify-center gap-2 rounded-md border border-border hover:bg-bg-sunken disabled:text-fg-muted"
        >
          <KeyRound size={16} />
          Käytä avainta
        </button>
        {error && (
          <p role="alert" className="mt-3 text-secondary text-fg">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
