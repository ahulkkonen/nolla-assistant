import type { AttachmentRef } from '@pa/protocol';
import {
  ArrowUp,
  Eye,
  FileText,
  FolderOpen,
  LoaderCircle,
  Paperclip,
  Square,
  Upload,
  X,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { uploadFiles } from '../api.ts';
import { touch } from '../media.ts';
import { useShortcuts } from '../shortcuts.ts';
import { useStore } from '../store.ts';
import { send, sendUserMessage } from '../ws.ts';
import { AgentPicker } from './AgentPicker.tsx';
import { DropOverlay, useFileDrop } from './FileDrop.tsx';
import { IconButton } from './IconButton.tsx';
import { clock, MicButton, type MicState } from './MicButton.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { WorkPicker } from './TreeDialogs.tsx';

type Chip = { key: string; name: string; preview?: string; ref?: AttachmentRef };

/** The textarea grows to min(40dvh, 320px), then scrolls (brief 7.5). */
const maxHeight = () => Math.min(window.innerHeight * 0.4, 320);

export function Composer() {
  const chatId = useStore((s) => s.activeChatId);
  const chatScreen = useStore((s) => s.screen === 'chat');
  const showModelSaw = useStore((s) => s.showModelSaw);
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const [mic, setMic] = useState<MicState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [workPicker, setWorkPicker] = useState(false);
  const queued = useStore((s) => s.attachQueue);
  // Phase 12: a message held by the vault, and the text of one that was dropped.
  const held = useStore((s) => (chatId ? s.held[chatId] !== undefined : false));
  const draft = useStore((s) => s.draft);
  useEffect(() => {
    if (!draft || draft.chatId !== chatId) return;
    setText((t) => t || draft.text);
    useStore.setState({ draft: null });
  }, [draft, chatId]);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
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

  // Toasts sit 8 px above the composer, its bottom padding included (brief 7.5: never over it);
  // off the chat screen, 16 px + safe area.
  useLayoutEffect(() => {
    const el = wrap.current;
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

  // Work-dir copies ("Liitä keskusteluun", "Valitse työkansiosta") arrive already uploaded.
  useEffect(() => {
    if (!queued.length) return;
    setChips((c) => [
      ...c,
      ...queued.map((ref) => ({
        key: crypto.randomUUID(),
        name: ref.name,
        ref,
        ...(ref.kind === 'image' ? { preview: `/api/files/${encodeURIComponent(ref.id)}` } : {}),
      })),
    ]);
    useStore.setState({ attachQueue: [] });
  }, [queued]);

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
    <div
      ref={wrap}
      className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),8px)] md:pb-4 [[data-kb]_&]:pb-2"
    >
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
      <div className="mx-auto w-full max-w-(--thread-max) rounded-2xl border border-border bg-card shadow-sm transition-colors duration-100 focus-within:border-input">
        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Liitteet">
            {chips.map((c) => (
              <li
                key={c.key}
                className="relative flex h-10 items-center gap-2 rounded-md border border-border pr-1 pl-1 max-md:h-11 max-md:gap-1 max-md:pr-0"
              >
                {c.preview ? (
                  <img src={c.preview} alt="" className="size-8 rounded-xs object-cover" />
                ) : (
                  <span className="flex size-8 items-center justify-center rounded-xs bg-muted">
                    <FileText size={16} className="text-muted-foreground" />
                  </span>
                )}
                <span className="max-w-40 truncate text-meta max-md:max-w-18">{c.name}</span>
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
          placeholder={held ? 'Odottaa Nimisuojaa' : 'Kirjoita viesti'}
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
        <div className="flex h-12 items-center gap-1 px-2 py-1.5 max-md:h-14 max-md:px-1.5">
          {/* Not modal: a modal menu hides the page from assistive technology (axe). */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <IconButton label="Liitä tiedosto" className="rounded-full">
                <Paperclip size={16} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              collisionPadding={8}
              className="w-auto min-w-48"
            >
              <DropdownMenuItem onSelect={() => picker.current?.click()}>
                <Upload size={16} className="text-muted-foreground" />
                Lataa laitteelta
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setWorkPicker(true)}>
                <FolderOpen size={16} className="text-muted-foreground" />
                Valitse työkansiosta
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <WorkPicker open={workPicker} onClose={() => setWorkPicker(false)} />
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
          <ModelPicker />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <MicButton onText={insertTranscript} onState={setMic} meter={meter} />
            {running && chatId ? (
              <IconButton
                label="Pysäytä"
                variant="primary"
                // No transparent border: the fill is the whole 36 / 44 px target.
                className="rounded-full border-0"
                onClick={() => send({ type: 'user.stop', chatId })}
              >
                <Square size={14} fill="currentColor" />
              </IconButton>
            ) : (
              <IconButton
                label="Lähetä"
                variant="primary"
                className="rounded-full border-0"
                disabled={!canSend}
                onClick={() => void submit()}
              >
                <ArrowUp size={16} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
      {dropping && <DropOverlay />}
    </div>
  );
}
