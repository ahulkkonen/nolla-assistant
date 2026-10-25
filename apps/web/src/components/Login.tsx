import { AlertCircle, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

/** Brief 7.5: no card on phones (top at 20dvh); from 768 px a 400 px card. */
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
    <main className="flex h-dvh justify-center px-6 pt-[20dvh] md:items-center md:pt-0">
      <div className="w-full max-w-sm md:max-w-[400px] md:rounded-xl md:border md:border-border md:bg-card md:p-8 md:shadow-sm">
        <h1 className="mb-6 text-title">Assistant</h1>
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <label htmlFor="password" className="text-ui">
            Salasana
          </label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11"
          />
          {error && (
            <p
              id="login-error"
              role="alert"
              className="flex items-center gap-1.5 text-meta text-destructive"
            >
              <AlertCircle size={16} className="shrink-0" />
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={busy || !password} className="mt-2 w-full">
            Kirjaudu
          </Button>
        </form>
        <Button
          variant="outline"
          size="lg"
          disabled={busy}
          onClick={() => void run(passkeyLogin)}
          className="mt-3 w-full"
        >
          <KeyRound size={16} />
          Käytä avainta
        </Button>
      </div>
    </main>
  );
}
