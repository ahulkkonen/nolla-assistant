/** Screen-reader announcement in the app's live regions (App.tsx; brief 7.8). */
export function announce(text: string, assertive = false) {
  const el = document.getElementById(assertive ? 'live-assertive' : 'live-polite');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = text;
  }, 50);
}
