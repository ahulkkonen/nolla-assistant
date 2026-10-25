import { createCn } from 'cn/config';

/** The `body` and `secondary` text sizes in tokens.css are font sizes, not colours. */
export const cn = createCn({ extend: { theme: { text: ['body', 'secondary'] } } });
