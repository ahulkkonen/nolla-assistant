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

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((v, i) => v === b[i]);

/** The browser's subscription, regardless of the permission state. */
async function browserSubscription() {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

/** The subscription the toggle shows: only with notification permission granted. */
export async function pushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  return browserSubscription();
}

/**
 * Permission, VAPID key, browser subscription, then the server. Throws `denied` on refusal. A
 * subscription for another VAPID key is replaced; if the server refuses, the browser one is
 * dropped too, so both sides agree.
 */
export async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  const key = keyBytes((await pushVapid()).publicKey);
  const reg = await navigator.serviceWorker.ready;
  const old = await reg.pushManager.getSubscription();
  if (old && !sameKey(old.options.applicationServerKey, key)) await old.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  try {
    await pushSubscribe(sub.toJSON());
  } catch (err) {
    await sub.unsubscribe().catch(() => {});
    throw err;
  }
}

/** Server first; the browser subscription goes even when the DELETE fails. */
export async function disablePush() {
  const sub = await browserSubscription();
  if (!sub) return;
  try {
    await pushUnsubscribe(sub.endpoint);
  } finally {
    await sub.unsubscribe().catch(() => {});
  }
}

/**
 * On app start: the browser may have rotated the subscription (no `pushsubscriptionchange` handler
 * needed); the server upserts by endpoint, so re-posting the current one is idempotent.
 */
export async function resyncPush() {
  const sub = await pushSubscription().catch(() => null);
  if (sub) await pushSubscribe(sub.toJSON()).catch(() => {});
}
