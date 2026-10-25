import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env, type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers';

export const MODEL = 'Xenova/multilingual-e5-small';
export const DIMS = 384;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/** Model files live in `MODELS_DIR` (image: /app/models), else `DATA_DIR/models` (dev). */
export const modelsDir = () =>
  process.env.MODELS_DIR || join(process.env.DATA_DIR ?? '.', 'models');

/** Lazy, one load per process. Downloads only when the directory does not hold the model yet. */
export function loadModel() {
  extractor ??= (async () => {
    const dir = modelsDir();
    env.cacheDir = dir;
    env.localModelPath = dir;
    env.allowRemoteModels = !existsSync(join(dir, MODEL, 'onnx', 'model_quantized.onnx'));
    return pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  })();
  extractor.catch(() => (extractor = undefined));
  return extractor;
}

/** Mean-pooled, normalized e5 vectors; e5 wants `query: ` / `passage: ` prefixes. */
export async function embed(
  texts: string[],
  mode: 'query' | 'passage' = 'passage',
): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const out = await (await loadModel())(
    texts.map((t) => `${mode}: ${t}`),
    { pooling: 'mean', normalize: true },
  );
  const data = out.data as Float32Array;
  return texts.map((_, i) => data.slice(i * DIMS, (i + 1) * DIMS));
}
