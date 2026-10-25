import { clsx } from 'clsx';
import { LoaderCircle, Mic } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { transcribe } from '../api.ts';
import { useStore } from '../store.ts';
import { IconButton } from './IconButton.tsx';

const MAX_MS = 55_000;

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

/**
 * Hold to record, release to transcribe (plan §12): `MediaRecorder` audio goes to
 * `/api/transcribe`; the text lands in the composer. Esc cancels. Hidden without `MediaRecorder`.
 */
export function MicButton({ onText }: { onText: (text: string) => void }) {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [level, setLevel] = useState(0);
  const rec = useRef<Rec | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;

  const cleanup = (r: Rec) => {
    if (r.raf) cancelAnimationFrame(r.raf);
    clearTimeout(r.timer);
    for (const t of r.stream?.getTracks() ?? []) t.stop();
    void r.ctx?.close();
    setLevel(0);
  };

  const stop = (cancel = false) => {
    const r = rec.current;
    if (!r) return;
    r.cancelled ||= cancel;
    r.released = true;
    if (r.recorder?.state === 'recording') r.recorder.stop();
  };

  const start = async () => {
    if (rec.current) return;
    const r: Rec = { released: false, cancelled: false };
    rec.current = r;
    setState('starting');
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      rec.current = null;
      setState('idle');
      useStore
        .getState()
        .pushError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Mikrofonin käyttö estetty.'
            : 'Mikrofonia ei saatu käyttöön.',
        );
      return;
    }
    const type = mimeType();
    const recorder = new MediaRecorder(r.stream, { mimeType: type });
    r.recorder = recorder;
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      cleanup(r);
      rec.current = null;
      const blob = new Blob(chunks, { type: type.split(';')[0] ?? type });
      if (r.cancelled || blob.size === 0) return setState('idle');
      setState('transcribing');
      try {
        const text = await transcribe(blob, useStore.getState().sttLanguage);
        if (text.trim()) textRef.current(text.trim());
      } catch {
        useStore.getState().pushError('Litterointi epäonnistui.');
      } finally {
        setState('idle');
      }
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
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      r.raf = requestAnimationFrame(tick);
    };
    tick();
    recorder.start();
    r.timer = setTimeout(() => stop(), MAX_MS);
    setState('recording');
    if (r.released) stop();
  };

  useEffect(() => {
    if (state !== 'recording' && state !== 'starting') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The global Esc (stop the agent) must not also fire.
      e.preventDefault();
      stop(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state]);

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
        onContextMenu={(e) => e.preventDefault()}
      >
        <Mic size={20} />
      </IconButton>
      {state === 'recording' && (
        <div role="status" className="flex min-w-0 items-center gap-2 text-secondary text-fg-muted">
          <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-bg-sunken">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
          <span className="truncate">
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
