import { transform } from 'sucrase';

/** JSX/TSX of a React artifact to CommonJS with classic `React.createElement` calls. */
self.onmessage = (e: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = e.data;
  try {
    const { code } = transform(source, {
      transforms: ['typescript', 'jsx', 'imports'],
      production: true,
    });
    self.postMessage({ id, code });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
