import { pushSubscribe, pushUnsubscribe, pushVapid } from './api.ts';

export const pushSupported = () =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

const keyBytes = (b64url: string) => {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

export async function pushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

/** Permission, VAPID key, browser subscription, then the server. Throws `denied` on refusal. */
export async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  const { publicKey } = await pushVapid();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  await pushSubscribe(sub.toJSON());
}

export async function disablePush() {
  const sub = await pushSubscription();
  if (!sub) return;
  await pushUnsubscribe(sub.endpoint);
  await sub.unsubscribe();
}
