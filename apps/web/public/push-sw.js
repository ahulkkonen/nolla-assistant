// Imported by the generated service worker (vite.config.ts `workbox.importScripts`).
// Payload `{ title, chatId, kind }` holds the chat title only, never message content.
const BODY = {
  approval: 'Hyväksyntä odottaa',
  automation: 'Automaatio valmistui',
  settled: 'Vastaus valmis',
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Assistant', {
      body: BODY[data.kind] || '',
      icon: '/icon-192.png',
      tag: data.chatId,
      data: { chatId: data.chatId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  const url = chatId ? `/c/${encodeURIComponent(chatId)}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Only windows of this app; a visible one first. The app opens the chat itself.
      const ours = list.filter((c) => new URL(c.url).origin === self.location.origin);
      const client = ours.find((c) => c.visibilityState === 'visible') ?? ours[0];
      if (!client) return self.clients.openWindow(url);
      if (chatId) client.postMessage({ type: 'open-chat', chatId });
      return client.focus().catch(() => self.clients.openWindow(url));
    }),
  );
});
