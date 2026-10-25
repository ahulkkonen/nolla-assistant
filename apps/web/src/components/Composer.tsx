import type { AttachmentRef } from '@pa/protocol';
import { ArrowUp, Eye, FileText, LoaderCircle, Paperclip, Square, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/utils';
import { uploadFiles } from '../api.ts';
import { touch } from '../media.ts';
import { useShortcuts } from '../shortcuts.ts';
import { useStore } from '../store.ts';
import { send, sendUserMessage } from '../ws.ts';
import { AgentPicker } from './AgentPicker.tsx';
import { IconButton } from './IconButton.tsx';
import { clock, MicButton, type MicState } from './MicButton.tsx';

type Chip = { key: string; name: string; preview?: string; ref?: AttachmentRef };

/** The textarea grows to min(40dvh, 320px), then scrolls (brief 7.5). */
const maxHeight = () => Math.min(window.innerHeight * 0.4, 320);

/** Drag with files anywhere in the window shows the drop overlay. */
function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      filesRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return over;
}

export function Composer() {
  const chatId = useStore((s) => s.activeChatId);
  const chatScreen = useStore((s) => s.screen === 'chat');
  const showModelSaw = useStore((s) => s.showModelSaw);
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [mic, setMic] = useState<MicState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const meter = useRef<HTMLDivElement>(null);

  const uploading = chips.some((c) => !c.ref);
  const canSend = !uploading && (text.trim() !== '' || chips.length > 0);
  const recording = mic === 'recording' || mic === 'starting' || mic === 'cancel';

  const resize = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight())}px`;
  };

  // Phone toasts sit 8 px above the composer (brief 7.5); without it, 16 px + safe area.
  useLayoutEffect(() => {
    const el = box.current;
    const root = document.documentElement;
    if (!el || !chatScreen) return;
    const ro = new ResizeObserver(() =>
      root.style.setProperty('--toast-bottom', `${el.offsetHeight + 8}px`),
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--toast-bottom');
    };
  }, [chatScreen]);

  // "Kuuntelee 0:07": seconds since the recorder started.
  useEffect(() => {
    if (mic !== 'recording' && mic !== 'cancel') return setElapsed(0);
    const from = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - from), 250);
    return () => clearInterval(t);
  }, [mic === 'recording' || mic === 'cancel']);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const added: Chip[] = files.map((f) => ({
      key: crypto.randomUUID(),
      name: f.name,
      ...(f.type.startsWith('image/') ? { preview: URL.createObjectURL(f) } : {}),
    }));
    setChips((c) => [...c, ...added]);
    try {
      const refs = await uploadFiles(files, chatId ?? undefined);
      setChips((c) =>
        c.map((chip) => {
          const i = added.findIndex((a) => a.key === chip.key);
          const ref = refs[i];
          return i >= 0 && ref ? { ...chip, ref } : chip;
        }),
      );
    } catch {
      remove(added.map((a) => a.key));
      useStore.getState().pushError('Liitteen lähetys epäonnistui.');
    }
  };
  const dropping = useFileDrop(chatScreen, (files) => void addFiles(files));

  const remove = (keys: string[]) =>
    setChips((c) =>
      c.filter((chip) => {
        if (!keys.includes(chip.key)) return true;
        if (chip.preview) URL.revokeObjectURL(chip.preview);
        return false;
      }),
    );

  const submit = async () => {
    if (!canSend || running) return;
    const body = text.trim();
    const refs = chips.flatMap((c) => (c.ref ? [c.ref] : []));
    setText('');
    remove(chips.map((c) => c.key));
    requestAnimationFrame(resize);
    await sendUserMessage(body, refs);
  };

  useShortcuts(
    () => void submit(),
    () => area.current?.focus(),
  );

  /** Enter sends on keyboards; touch keyboards get a newline (brief 7.8). ↑ edits the last. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !touch) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'ArrowUp' && !text) {
      const st = useStore.getState();
      const last = chatId ? st.messages[chatId]?.findLast((m) => m.role === 'user') : undefined;
      if (last) {
        e.preventDefault();
        useStore.setState({ editMessageId: last.id });
      }
    }
  };

  /** At the caret; with "lähetä heti" the result is sent at once. */
  const insertTranscript = (spoken: string) => {
    const el = area.current;
    const at = el && document.activeElement === el ? el.selectionStart : text.length;
    const end = el && document.activeElement === el ? el.selectionEnd : text.length;
    const before = text.slice(0, at);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${sep}${spoken}${text.slice(end)}`;
    if (useStore.getState().sttAutoSend && !running && !uploading) {
      const refs = chips.flatMap((c) => (c.ref ? [c.ref] : []));
      setText('');
      remove(chips.map((c) => c.key));
      void sendUserMessage(next.trim(), refs);
      return;
    }
    setText(next);
    requestAnimationFrame(() => {
      resize();
      const caret = before.length + sep.length + spoken.length;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const hint =
    mic === 'cancel'
      ? 'Vapauta peruaksesi'
      : touch
        ? 'Vapauta lähettääksesi · liu’uta vasemmalle peruaksesi'
        : 'Vapauta lähettääksesi · Esc peruu';

  return (
    <div className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),8px)] md:pb-4 [[data-kb]_&]:pb-2">
      {showModelSaw && (
        <div className="mx-auto mb-2 flex w-full max-w-(--thread-max) items-center gap-2 rounded-lg bg-info-subtle py-1 pr-1 pl-3 text-meta text-foreground">
          <Eye size={16} className="shrink-0 text-info" />
          <span className="flex-1">Näytetään mitä malli näki</span>
          <IconButton
            label="Sulje"
            className="size-7"
            onClick={() => useStore.getState().setShowModelSaw(false)}
          >
            <X size={16} />
          </IconButton>
        </div>
      )}
      <div
        ref={box}
        className="mx-auto w-full max-w-(--thread-max) rounded-2xl border border-border bg-card shadow-sm transition-colors duration-100 focus-within:border-input"
      >
        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Liitteet">
            {chips.map((c) => (
              <li
                key={c.key}
                className="relative flex h-10 items-center gap-2 rounded-md border border-border pr-1 pl-1 max-md:h-11"
              >
                {c.preview ? (
                  <img src={c.preview} alt="" className="size-8 rounded-xs object-cover" />
                ) : (
                  <span className="flex size-8 items-center justify-center rounded-xs bg-muted">
                    <FileText size={16} className="text-muted-foreground" />
                  </span>
                )}
                <span className="max-w-40 truncate text-meta max-md:max-w-28">{c.name}</span>
                <IconButton label="Poista liite" className="size-6" onClick={() => remove([c.key])}>
                  <X size={16} />
                </IconButton>
                {!c.ref && (
                  <span
                    role="progressbar"
                    aria-label="Lähetetään"
                    className="absolute inset-x-2 bottom-0 h-0.5 animate-pulse rounded-full bg-primary"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder="Kirjoita viesti"
          aria-label="Viesti"
          onChange={(e) => {
            setText(e.target.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={cn(
            'block min-h-12 w-full resize-none bg-transparent px-4 py-3 text-body placeholder:text-muted-foreground focus-visible:outline-none max-md:text-[16px]',
            (recording || mic === 'transcribing') && 'hidden',
          )}
        />
        {recording && (
          <div
            role="status"
            className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
          >
            <span className="flex items-center gap-2 text-ui text-foreground tabular-nums">
              <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
              Kuuntelee {clock(elapsed)}
            </span>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
              <span ref={meter} className="block h-full w-0 rounded-full bg-destructive" />
            </span>
            <span className="text-meta text-muted-foreground">{hint}</span>
          </div>
        )}
        {mic === 'transcribing' && (
          <div
            role="status"
            className="flex min-h-12 items-center gap-2 px-4 py-3 text-ui text-muted-foreground"
          >
            <LoaderCircle size={16} className="animate-spin" />
            Litteroidaan…
          </div>
        )}
        <div className="flex h-12 items-center gap-1 px-2 py-1.5 max-md:h-14">
          <IconButton
            label="Liitä tiedosto"
            className="rounded-full"
            onClick={() => picker.current?.click()}
          >
            <Paperclip size={16} />
          </IconButton>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <AgentPicker />
          <div className="ml-auto flex items-center gap-2">
            <MicButton onText={insertTranscript} onState={setMic} meter={meter} />
            {running && chatId ? (
              <IconButton
                label="Pysäytä"
                variant="primary"
                className="rounded-full"
                onClick={() => send({ type: 'user.stop', chatId })}
              >
                <Square size={14} fill="currentColor" />
              </IconButton>
            ) : (
              <IconButton
                label="Lähetä"
                variant="primary"
                className="rounded-full"
                disabled={!canSend}
                onClick={() => void submit()}
              >
                <ArrowUp size={16} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
      {dropping && (
        <div className="pointer-events-none fixed inset-0 z-(--z-toast) bg-background/90">
          <div className="absolute inset-4 flex items-center justify-center rounded-xl border-2 border-dashed border-border text-heading">
            Pudota tiedostot tähän
          </div>
        </div>
      )}
    </div>
  );
}
