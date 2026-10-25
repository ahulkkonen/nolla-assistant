import { clsx } from 'clsx';
import { LoaderCircle, Mic } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HttpError, transcribe } from '../api.ts';
import { useStore } from '../store.ts';
import { IconButton } from './IconButton.tsx';

const MAX_MS = 55_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;

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
 * `/api/transcribe`; the text lands in the composer. Esc cancels. Hidden without `MediaRecorder`.
 */
export function MicButton({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const rec = useRef<Rec | null>(null);
  const transcribing = useRef<AbortController | null>(null);
  // The level bar is written per frame through the DOM, not React state.
  const meter = useRef<HTMLDivElement>(null);
  const textRef = useRef(onText);
  textRef.current = onText;

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
      error(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Mikrofonin käyttö estetty.'
          : 'Mikrofonia ei saatu käyttöön.',
      );
      return;
    }
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
    if (r.released) stop();
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
  const recording = state === 'recording' || state === 'starting';

  return (
    <div className="flex min-w-0 items-center gap-2">
      <IconButton
        label={recording ? 'Vapauta lopettaaksesi' : 'Pidä pohjassa ja puhu'}
        aria-pressed={recording}
        disabled={state === 'transcribing'}
        className={clsx(recording && 'bg-bg-sunken')}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          void start();
        }}
        onPointerUp={() => stop()}
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
        <Mic size={20} />
      </IconButton>
      {state === 'recording' && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 text-secondary text-fg-muted"
        >
          <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-bg-sunken">
            <div ref={meter} className="h-full w-0 rounded-full bg-accent" />
          </div>
          <span>
            Kuuntelee<span className="max-md:hidden"> · Esc peruu</span>
          </span>
        </div>
      )}
      {state === 'transcribing' && (
        <div role="status" className="flex items-center gap-2 text-secondary text-fg-muted">
          <LoaderCircle size={16} className="animate-spin" />
          Litteroidaan…
        </div>
      )}
    </div>
  );
}
