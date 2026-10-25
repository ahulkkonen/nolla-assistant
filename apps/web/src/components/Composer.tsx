import type { AttachmentRef } from '@pa/protocol';
import { ArrowUp, FileText, LoaderCircle, Paperclip, Square, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, useRef, useState } from 'react';
import { uploadFiles } from '../api.ts';
import { useShortcuts } from '../shortcuts.ts';
import { useStore } from '../store.ts';
import { send, sendUserMessage } from '../ws.ts';
import { AgentPicker } from './AgentPicker.tsx';
import { IconButton } from './IconButton.tsx';
import { MicButton } from './MicButton.tsx';

type Chip = { key: string; name: string; preview?: string; ref?: AttachmentRef };

const MAX_HEIGHT = 180; // 8 lines at 15 px × 1.5.

export function Composer() {
  const chatId = useStore((s) => s.activeChatId);
  const showModelSaw = useStore((s) => s.showModelSaw);
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const [text, setText] = useState('');
  const [chips, setChips] = useState<Chip[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const uploading = chips.some((c) => !c.ref);
  const canSend = !uploading && (text.trim() !== '' || chips.length > 0);

  const resize = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  };

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

  useShortcuts(() => void submit());

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

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void addFiles([...e.dataTransfer.files]);
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  return (
    <div className="shrink-0 px-4 pb-[max(env(safe-area-inset-bottom),12px)]">
      {showModelSaw && (
        <div className="mx-auto flex w-full max-w-3xl items-center gap-1 pb-1 pl-2 text-secondary text-fg-muted">
          Näytetään mitä malli näki
          <IconButton
            label="Näytä alkuperäiset"
            className="size-7 max-md:size-11"
            onClick={() => useStore.getState().setShowModelSaw(false)}
          >
            <X size={16} />
          </IconButton>
        </div>
      )}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="mx-auto w-full max-w-3xl rounded-lg border border-border bg-bg-raised p-2 focus-within:border-accent"
      >
        {chips.length > 0 && (
          <ul className="flex flex-wrap gap-2 p-1" aria-label="Liitteet">
            {chips.map((c) => (
              <li
                key={c.key}
                className="flex h-12 max-w-60 items-center gap-2 rounded-md border border-border bg-bg pr-1 pl-1"
              >
                {c.preview ? (
                  <img src={c.preview} alt="" className="size-10 rounded-sm object-cover" />
                ) : (
                  <FileText size={20} className="ml-1 shrink-0 text-fg-muted" />
                )}
                <span className="truncate text-secondary">{c.name}</span>
                {!c.ref && (
                  <LoaderCircle
                    size={16}
                    aria-label="Lähetetään"
                    className="shrink-0 animate-spin text-fg-muted"
                  />
                )}
                <IconButton
                  label="Poista liite"
                  className="size-7 max-md:size-11"
                  onClick={() => remove([c.key])}
                >
                  <X size={16} />
                </IconButton>
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
          onPaste={onPaste}
          className="block max-h-45 w-full resize-none bg-transparent px-2 py-2 placeholder:text-fg-muted focus-visible:outline-none"
        />
        <div className="flex items-center gap-2">
          <IconButton label="Liitä tiedosto" onClick={() => picker.current?.click()}>
            <Paperclip size={20} />
          </IconButton>
          <MicButton onText={insertTranscript} />
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
          <div className="ml-auto">
            <AgentPicker />
          </div>
          {running && chatId ? (
            <IconButton
              label="Pysäytä"
              variant="primary"
              onClick={() => send({ type: 'user.stop', chatId })}
            >
              <Square size={16} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton
              label="Lähetä"
              variant="primary"
              disabled={!canSend}
              onClick={() => void submit()}
            >
              <ArrowUp size={20} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
