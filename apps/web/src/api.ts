import type { AttachmentRef, ExportFormat } from '@pa/protocol';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  if (!r.ok) throw new HttpError(r.status);
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
