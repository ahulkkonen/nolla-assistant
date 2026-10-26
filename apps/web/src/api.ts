import type {
  AttachmentRef,
  ExportFormat,
  FileError,
  FileRoot,
  FileUsage,
  TrashEntry,
  TrashListing,
  TreeEntry,
  TreeListing,
} from '@pa/protocol';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export class HttpError extends Error {
  readonly status: number;
  /** The `{ error }` code of the answer body, when it has one (the file routes). */
  readonly code: FileError | undefined;
  constructor(status: number, code?: FileError) {
    super(`HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

/** The error code of a failed answer body (`{ error: FileError }`), if any. */
const codeOf = (body: unknown) => (body as { error?: FileError } | null)?.error;

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) throw new HttpError(r.status, codeOf(await r.json().catch(() => null)));
  return (r.status === 204 ? undefined : await r.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  req<T>(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

export const passwordLogin = (password: string) =>
  post<{ userId: string }>('/api/auth/password', { password });

export const me = () => req<{ userId: string; passkeys: number }>('/api/auth/me');

export const logout = () => post<void>('/api/auth/logout');

export async function passkeyLogin() {
  const optionsJSON = await post<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    '/api/auth/passkey/login/options',
  );
  const response = await startAuthentication({ optionsJSON });
  return post<{ userId: string }>('/api/auth/passkey/login/verify', { response });
}

export async function passkeyRegister() {
  const optionsJSON = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    '/api/auth/passkey/register/options',
  );
  const response = await startRegistration({ optionsJSON });
  return post<{ ok: true }>('/api/auth/passkey/register/verify', { response });
}

export async function uploadFiles(files: File[], chatId?: string): Promise<AttachmentRef[]> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  if (chatId) form.append('chatId', chatId);
  const r = await req<{ files: AttachmentRef[] }>('/api/files', { method: 'POST', body: form });
  return r.files;
}

export async function transcribe(
  audio: Blob,
  language: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append('audio', audio, `audio.${audio.type.includes('mp4') ? 'mp4' : 'webm'}`);
  form.append('language', language);
  return (await req<{ text: string }>('/api/transcribe', { method: 'POST', body: form, signal }))
    .text;
}

/** One chat as a file (`GET /api/chats/:id/export`); the server names it. */
export async function exportChat(
  chatId: string,
  format: ExportFormat,
  unmask: boolean,
  signal: AbortSignal,
) {
  const r = await fetch(
    `/api/chats/${encodeURIComponent(chatId)}/export?format=${format}&unmask=${unmask ? 1 : 0}`,
    { credentials: 'same-origin', signal },
  );
  if (!r.ok) throw new HttpError(r.status);
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1];
  return { blob: await r.blob(), name: name ?? `keskustelu.${format}` };
}

export const pushVapid = () => req<{ publicKey: string }>('/api/push/vapid');
export const pushSubscribe = (sub: PushSubscriptionJSON) =>
  post<{ ok: true }>('/api/push/subscribe', sub);
export const pushUnsubscribe = (endpoint: string) =>
  req<unknown>('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });

export const integrationsStatus = () =>
  req<{ google: { connected: boolean; email?: string } }>('/api/integrations/status');
export const googleConnect = () =>
  post<{ authUrl: string } | { connected: true }>('/api/integrations/google/connect');

/** Tiedostot (phase-11): `GET/POST/DELETE /api/files/tree…`. */
const q = (params: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
  ).toString();

export const treeList = (root: FileRoot, path: string, cursor?: string) =>
  req<TreeListing>(`/api/files/tree?${q({ root, path, cursor })}`);
export const treeRawUrl = (root: FileRoot, path: string, download = false) =>
  `/api/files/tree/raw?${q({ root, path, download: download ? '1' : '0' })}`;
export const treeMkdir = (path: string) =>
  post<{ entry: TreeEntry }>('/api/files/tree/mkdir', { path });
export const treeMove = (from: string, to: string) =>
  post<{ entry: TreeEntry }>('/api/files/tree/move', { from, to });
export const treeDelete = (path: string) =>
  req<{ entry: TrashEntry }>(`/api/files/tree?${q({ path })}`, { method: 'DELETE' });
export const trashList = (cursor?: string) =>
  req<TrashListing>(`/api/files/tree/trash?${q({ cursor })}`);
export const trashRestore = (id: string) =>
  post<{ entry: TreeEntry }>('/api/files/tree/restore', { id });
/** One entry for good, or (no id) the whole trash. */
export const trashDelete = (id?: string) =>
  req<void>(`/api/files/tree/trash?${q({ id })}`, { method: 'DELETE' });
export const fileUsage = () => req<FileUsage>('/api/files/tree/usage');
export const treeAttach = async (path: string) =>
  (await post<{ file: AttachmentRef }>('/api/files/tree/attach', { path })).file;
export const saveArtifact = (chatId: string, artifactId: string) =>
  post<{ entry: TreeEntry }>('/api/files/tree/artifact', { chatId, artifactId });

/**
 * One file into a work-dir folder, one request per file (record risk 8). XHR, not fetch: only XHR
 * reports upload progress.
 */
export function treeUpload(path: string, file: File, onProgress: (done: number) => void) {
  const xhr = new XMLHttpRequest();
  const done = new Promise<TreeEntry[]>((resolve, reject) => {
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 201) resolve((body as { entries: TreeEntry[] }).entries);
      else reject(new HttpError(xhr.status, codeOf(body)));
    };
    xhr.onerror = () => reject(new HttpError(0));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
  });
  const form = new FormData();
  form.append('files', file);
  xhr.open('POST', `/api/files/tree/upload?${q({ path })}`);
  xhr.withCredentials = true;
  xhr.send(form);
  return { done, abort: () => xhr.abort() };
}
