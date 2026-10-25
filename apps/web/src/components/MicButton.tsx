import { Mic, MicOff } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HttpError, transcribe } from '../api.ts';
import { useStore } from '../store.ts';
import { Tip } from './IconButton.tsx';

const MAX_MS = 55_000;
/** Released sooner than this: a tap, not a hold; it shows the hold hint instead. */
const TAP_MS = 300;
/** Slid this far left while holding: release cancels (brief 7.5). */
const CANCEL_PX = 64;
const TRANSCRIBE_TIMEOUT_MS = 30_000;

export type MicState = 'idle' | 'starting' | 'recording' | 'cancel' | 'transcribing';

type Rec = {
  recorder?: MediaRecorder;
  stream?: MediaStream;
  ctx?: AudioContext;
  raf?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Released before the microphone was ready: stop as soon as it starts. */
  released: boolean;
  cancelled: boolean;
};

const mimeType = () =>
  MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4';

const error = (message: string) => useStore.getState().pushError(message);

const transcribeError = (err: unknown) =>
  err instanceof HttpError && err.status === 413
    ? 'Äänite on liian pitkä.'
    : err instanceof HttpError && err.status === 429
      ? 'Liian monta litterointia. Odota hetki.'
      : err instanceof DOMException && err.name === 'TimeoutError'
        ? 'Litterointi aikakatkaistiin.'
        : 'Litterointi epäonnistui.';

/**
 * Hold to record, release to transcribe (plan §12): `MediaRecorder` audio goes to
 * `/api/transcribe`; the text lands in the composer. Esc or a slide left cancels. The composer
 * shows the status row (`onState`) and owns the level bar (`meter`). Hidden without
 * `MediaRecorder`.
 */
export function MicButton({
  onText,
  onState,
  meter,
}: {
  onText: (text: string) => void;
  onState: (state: MicState) => void;
  meter: RefObject<HTMLDivElement | null>;
}) {
  const [state, setStateRaw] = useState<MicState>('idle');
  const [denied, setDenied] = useState(false);
  const [hint, setHint] = useState(false);
  const rec = useRef<Rec | null>(null);
  const transcribing = useRef<AbortController | null>(null);
  const press = useRef<{ x: number; at: number } | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;
  const stateRef = useRef(onState);
  stateRef.current = onState;
  const setState = (next: MicState) => {
    setStateRaw(next);
    stateRef.current(next);
  };

  const cleanup = (r: Rec) => {
    if (r.raf) cancelAnimationFrame(r.raf);
    clearTimeout(r.timer);
    for (const t of r.stream?.getTracks() ?? []) t.stop();
    void r.ctx?.close().catch(() => {});
  };

  const stop = (cancel = false) => {
    const r = rec.current;
    if (!r) return;
    r.cancelled ||= cancel;
    r.released = true;
    if (r.recorder?.state === 'recording') r.recorder.stop();
  };

  /** Ends a recording that has no running recorder to stop (failed setup, unmount). */
  const abandon = (r: Rec) => {
    cleanup(r);
    if (rec.current === r) rec.current = null;
  };

  const send = async (blob: Blob) => {
    setState('transcribing');
    const ctrl = new AbortController();
    transcribing.current = ctrl;
    try {
      const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]);
      const text = await transcribe(blob, useStore.getState().sttLanguage, signal);
      if (text.trim()) textRef.current(text.trim());
    } catch (err) {
      if (!ctrl.signal.aborted) error(transcribeError(err));
    } finally {
      if (transcribing.current === ctrl) transcribing.current = null;
      setState('idle');
    }
  };

  const start = async () => {
    if (rec.current || transcribing.current) return;
    const r: Rec = { released: false, cancelled: false };
    rec.current = r;
    setState('starting');
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      rec.current = null;
      setState('idle');
      const blocked = err instanceof DOMException && err.name === 'NotAllowedError';
      setDenied(blocked);
      error(blocked ? 'Mikrofonin käyttö estetty.' : 'Mikrofonia ei saatu käyttöön.');
      return;
    }
    setDenied(false);
    // Unmounted or cancelled while the permission prompt was open.
    if (r.cancelled) return abandon(r);
    const type = mimeType();
    try {
      const recorder = new MediaRecorder(r.stream, { mimeType: type });
      r.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onerror = () => {
        r.cancelled = true;
        abandon(r);
        setState('idle');
        error('Äänitys keskeytyi.');
      };
      recorder.onstop = () => {
        abandon(r);
        const blob = new Blob(chunks, { type: type.split(';')[0] ?? type });
        if (r.cancelled || blob.size === 0) return setState('idle');
        void send(blob);
      };
      // Level meter: RMS of the analyser's time-domain data, about 60 times a second.
      r.ctx = new AudioContext();
      const analyser = r.ctx.createAnalyser();
      analyser.fftSize = 512;
      r.ctx.createMediaStreamSource(r.stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
        if (meter.current) meter.current.style.width = `${Math.round(level * 100)}%`;
        r.raf = requestAnimationFrame(tick);
      };
      tick();
      recorder.start();
    } catch {
      abandon(r);
      setState('idle');
      error('Äänitystä ei voitu aloittaa.');
      return;
    }
    r.timer = setTimeout(() => stop(), MAX_MS);
    setState('recording');
    if (r.released) stop(r.cancelled);
  };

  // Esc cancels a recording or a running transcription.
  useEffect(() => {
    if (state === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The global Esc (stop the agent) must not also fire.
      e.preventDefault();
      stop(true);
      transcribing.current?.abort();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 1500);
    return () => clearTimeout(t);
  }, [hint]);

  // Unmount: no microphone, timer or request may outlive the button.
  useEffect(
    () => () => {
      const r = rec.current;
      transcribing.current?.abort();
      if (!r) return;
      r.cancelled = true;
      if (r.recorder?.state === 'recording') r.recorder.stop();
      else abandon(r);
    },
    [],
  );

  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) return null;
  const live = state === 'recording' || state === 'starting' || state === 'cancel';
  const release = () => {
    const p = press.current;
    press.current = null;
    if (p && Date.now() - p.at < TAP_MS) {
      stop(true);
      setHint(true);
      return;
    }
    stop(state === 'cancel');
  };
  const label = live ? 'Vapauta lopettaaksesi' : 'Pidä pohjassa ja puhu';
  // No tooltip over the status row while recording; a short tap shows the hold hint.
  const tip = hint ? 'Pidä painettuna' : denied ? 'Mikrofoni on estetty' : label;
  const open = live ? false : hint ? true : undefined;

  return (
    <Tip label={tip} {...(open === undefined ? {} : { open })}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={live}
        disabled={state === 'transcribing'}
        className={cn(
          'relative rounded-full text-muted-foreground [-webkit-touch-callout:none] hover:text-foreground aria-pressed:bg-transparent',
          live &&
            'bg-destructive text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground aria-pressed:bg-destructive',
          state === 'cancel' &&
            'bg-muted text-muted-foreground hover:bg-muted aria-pressed:bg-muted',
        )}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          press.current = { x: e.clientX, at: Date.now() };
          void start();
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (!p || (state !== 'recording' && state !== 'cancel')) return;
          const armed = p.x - e.clientX > CANCEL_PX;
          if (armed !== (state === 'cancel')) setState(armed ? 'cancel' : 'recording');
        }}
        onPointerUp={release}
        onPointerCancel={() => stop(true)}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            void start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') stop();
        }}
        // A keyboard hold ends when focus leaves the button.
        onBlur={() => stop()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {denied ? <MicOff size={16} /> : <Mic size={16} />}
        {state === 'recording' && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 animate-ring rounded-full ring-2 ring-destructive"
          />
        )}
      </Button>
    </Tip>
  );
}

/** "0:07": recording time, tabular (brief 7.5). */
export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
