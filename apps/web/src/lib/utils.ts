import { createCn } from 'cn/config';

/** Saves a blob as a download named `name`. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The type roles in tokens.css are font sizes, not colours (`text-meta`, `text-prose`, …). */
export const cn = createCn({
  extend: {
    theme: {
      text: ['display', 'title', 'heading', 'prose', 'body', 'ui', 'meta', 'micro', 'code'],
    },
  },
});
