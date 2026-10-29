import type {
  AdminError,
  AgentDoc,
  AgentList,
  AttachmentRef,
  DeviceSession,
  ExportFormat,
  ExportJob,
  FileError,
  FileRoot,
  FileUsage,
  ModeDoc,
  ModeSave,
  TrashEntry,
  TrashListing,
  TreeEntry,
  TreeListing,
} from '@pa/protocol';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

/**
 * The rest of a failed answer body: phase 15's `path` and `message`, `in_use`'s `automations`,
 * and a mode's `agents` (phase 23).
 */
export type ErrorDetail = {
  path?: string;
  message?: string;
  chats?: number;
  automations?: string[];
  agents?: string[];
};

export class HttpError extends Error {
  readonly status: number;
  /** The `{ error }` code of the answer body, when it has one (the file and admin routes). */
  readonly code: FileError | AdminError | undefined;
  readonly detail: ErrorDetail;
  constructor(status: number, code?: FileError | AdminError, detail: ErrorDetail = {}) {
    super(`HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** The error code of a failed answer body (`{ error: FileError }`), if any. */
const codeOf = (body: unknown) => (body as { error?: FileError | AdminError } | null)?.error;

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new HttpError(r.status, codeOf(body), (body ?? {}) as ErrorDetail);
  }
  return (r.status === 204 ? undefined : await r.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const post = <T>(path: string, body?: unknown) =>
  req<T>(path, body === undefined ? { method: 'POST' } : json('POST', body));

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

/** Phase 15: the agent and automation editors, devices and the full export. */
export const agentsList = () => req<AgentList>('/api/agents');
/** A save from the form (`profile`) or the YAML tab (`yaml`); `dry` checks without a write. */
export const agentSave = (
  id: string | undefined,
  body: { profile: Record<string, unknown> } | { yaml: string },
  prompt: string,
  dry = false,
) =>
  req<AgentDoc>(
    `/api/agents${id ? `/${encodeURIComponent(id)}` : ''}${dry ? '?dry=1' : ''}`,
    json(id ? 'PUT' : 'POST', { ...body, prompt }),
  );
export const agentDelete = (id: string) =>
  req<void>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
/** Phase-23 decision 13: a mode file from the form (`file`, `body`) or the raw text. */
export const modeSave = (id: string | undefined, body: ModeSave, dry = false) =>
  req<ModeDoc>(
    `/api/modes${id ? `/${encodeURIComponent(id)}` : ''}${dry ? '?dry=1' : ''}`,
    json(id ? 'PUT' : 'POST', body),
  );
export const modeDelete = (id: string) =>
  req<void>(`/api/modes/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const automationSave = (id: string | undefined, body: Record<string, unknown>) =>
  req<{ id: string }>(
    `/api/automations${id ? `/${encodeURIComponent(id)}` : ''}`,
    json(id ? 'PUT' : 'POST', body),
  );
export const automationDelete = (id: string) =>
  req<void>(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const cronPreview = (cron: string, timezone: string) =>
  post<{ runs: string[] }>('/api/automations/preview', { cron, timezone });
export const sessionsList = () => req<{ sessions: DeviceSession[] }>('/api/auth/sessions');
export const sessionRevoke = (id: string) =>
  req<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const sessionsRevokeAll = () => post<void>('/api/auth/sessions/revoke-all');
export const exportStart = (passphrase: string, unmask: boolean) =>
  post<{ job: ExportJob }>('/api/export', { passphrase, unmask });
export const exportGet = () => req<{ job: ExportJob | null }>('/api/export');
export const exportCancel = (id: string) =>
  req<void>(`/api/export/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const exportDownloadUrl = (id: string) => `/api/export/${encodeURIComponent(id)}/download`;
