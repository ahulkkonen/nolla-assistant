import { createCn } from 'cn/config';

/** The type roles in tokens.css are font sizes, not colours (`text-meta`, `text-prose`, …). */
export const cn = createCn({
  extend: {
    theme: {
      text: ['display', 'title', 'heading', 'prose', 'body', 'ui', 'meta', 'micro', 'code'],
    },
  },
});
