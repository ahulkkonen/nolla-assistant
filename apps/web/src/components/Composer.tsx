import type { AttachmentRef } from '@pa/protocol';
import {
  ArrowUp,
  Clock,
  Eye,
  FileText,
  FolderOpen,
  LoaderCircle,
  Paperclip,
  ShieldAlert,
  Square,
  Upload,
  X,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
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
import { sendUserMessage, stopTurn } from '../ws.ts';
import { AgentPicker } from './AgentPicker.tsx';
import { DropOverlay, useFileDrop } from './FileDrop.tsx';
import { IconButton, Tip } from './IconButton.tsx';
import { clock, MicButton, type MicState } from './MicButton.tsx';
import { ModelPicker, ModesChip, useAutoApprove } from './ModelPicker.tsx';
import { WorkPicker } from './TreeDialogs.tsx';

type Chip = { key: string; name: string; preview?: string; ref?: AttachmentRef };

/** Files already uploaded (work-dir copies, a queued message given back) as chips. */
const refChips = (refs: AttachmentRef[]): Chip[] =>
  refs.map((ref) => ({
    key: crypto.randomUUID(),
    name: ref.name,
    ref,
    ...(ref.kind === 'image' ? { preview: `/api/files/${encodeURIComponent(ref.id)}` } : {}),
  }));

/**
 * "Hyväksy automaattisesti" (phase-21 decision 7): an outline chip, filled in the warning colour
 * while on. Not on phones: next to the queue's two run buttons it squeezed the model chip to its
 * chevron; the model sheet holds the switch there.
 */
function AutoApproveChip({ chatId }: { chatId: string }) {
  const auto = useAutoApprove(chatId);
  if (!auto) return null;
  const { on, which, tip, toggle } = auto;
  return (
    <Tip label={tip}>
      <Button
        variant="outline"
        aria-pressed={on}
        onClick={() => {
          toggle();
          // No tooltips on touch: the toast names the tools.
          if (!on && touch) useStore.getState().notify(`Ajetaan ${which}`);
        }}
        className={cn(
          'h-8 rounded-full px-3 font-normal text-muted-foreground hover:text-foreground max-md:hidden',
          on &&
            'border-warning-line bg-warning-subtle text-warning hover:bg-warning-subtle hover:text-warning aria-pressed:bg-warning-subtle',
        )}
      >
        {on && <ShieldAlert size={16} aria-hidden="true" />}
        Hyväksy automaattisesti
      </Button>
    </Tip>
  );
}

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
  const attachQueue = useStore((s) => s.attachQueue);
  // Phase 20: the message that waits for the reply to end.
  const queued = useStore((s) => (chatId ? s.queued[chatId] : undefined));
  // Phase 12: a message held by the vault, and the text of one that was dropped or given back.
  const held = useStore((s) => (chatId ? s.held[chatId] !== undefined : false));
  const draft = useStore((s) => s.draft);
  useEffect(() => {
    if (!draft || draft.chatId !== chatId) return;
    // Ahead of what is typed since: nothing is lost.
    setText((t) => [draft.text, t].filter(Boolean).join('\n\n'));
    if (draft.attachments?.length) setChips((c) => [...refChips(draft.attachments ?? []), ...c]);
    useStore.setState({ draft: null });
    requestAnimationFrame(resize);
  }, [draft, chatId]);
  // Phase-22 decision 5: an update waits while text, files or a recording would be lost.
  const composing = text !== '' || chips.length > 0 || mic !== 'idle';
  useEffect(() => useStore.setState({ composing }), [composing]);
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
    if (!attachQueue.length) return;
    setChips((c) => [...c, ...refChips(attachQueue)]);
    useStore.setState({ attachQueue: [] });
  }, [attachQueue]);

  const remove = (keys: string[]) =>
    setChips((c) =>
      c.filter((chip) => {
        if (!keys.includes(chip.key)) return true;
        if (chip.preview) URL.revokeObjectURL(chip.preview);
        return false;
      }),
    );

  /** Sends, or while a reply runs adds to the chat's queue (phase-20 decision 17). */
  const submit = async () => {
    if (!canSend) return;
    const body = text.trim();
    const refs = chips.flatMap((c) => (c.ref ? [c.ref] : []));
    setText('');
    remove(chips.map((c) => c.key));
    requestAnimationFrame(resize);
    if (running && chatId) useStore.getState().enqueue(chatId, body, refs);
    else await sendUserMessage(body, refs);
  };

  /** Phase 26: a tap on send keeps the textarea's focus, so a touch keyboard stays open. */
  const keepFocus = (e: PointerEvent) => {
    if (document.activeElement === area.current) e.preventDefault();
  };

  useShortcuts(
    () => void submit(),
    () => area.current?.focus(),
  );

  /** Enter sends (or queues) on keyboards; touch keyboards get a newline (brief 7.8). ↑ edits the last. */
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
        {queued && chatId && (
          // The icon on the textarea's text column (16 px).
          <div className="flex items-center gap-2 pt-3 pr-3 pl-4 text-meta">
            <Clock size={16} className="shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-muted-foreground">Jonossa</span>
            <span className="min-w-0 flex-1 truncate">{queued.text}</span>
            {queued.attachments.length > 0 && (
              <span className="shrink-0 text-muted-foreground">
                +{queued.attachments.length}{' '}
                {queued.attachments.length === 1 ? 'liite' : 'liitettä'}
              </span>
            )}
            <Button
              variant="ghost"
              aria-label="Peru jonotus"
              onClick={() => useStore.getState().unqueue(chatId)}
              className="h-6 shrink-0 px-2 text-meta text-muted-foreground hover:text-foreground"
            >
              Peru
            </Button>
          </div>
        )}
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
          <ModesChip chatId={chatId} running={running} />
          {chatId && <AutoApproveChip chatId={chatId} />}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <MicButton onText={insertTranscript} onState={setMic} meter={meter} />
            {running && chatId && canSend ? (
              // Text during a reply: it can wait in the queue (phase-20 decision 17).
              <>
                <IconButton
                  label="Pysäytä"
                  // The ring in --input: 3:1 or more on the composer (UI review).
                  className="rounded-full border-input text-foreground"
                  onClick={() => stopTurn(chatId)}
                >
                  <Square size={14} fill="currentColor" />
                </IconButton>
                <IconButton
                  label="Lisää jonoon"
                  variant="primary"
                  className="rounded-full border-0"
                  onPointerDown={keepFocus}
                  onClick={() => void submit()}
                >
                  <ArrowUp size={16} />
                </IconButton>
              </>
            ) : running && chatId ? (
              <IconButton
                label="Pysäytä"
                variant="primary"
                // No transparent border: the fill is the whole 36 / 44 px target.
                className="rounded-full border-0"
                onClick={() => stopTurn(chatId)}
              >
                <Square size={14} fill="currentColor" />
              </IconButton>
            ) : (
              <IconButton
                label="Lähetä"
                variant="primary"
                className="rounded-full border-0"
                disabled={!canSend}
                onPointerDown={keepFocus}
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
