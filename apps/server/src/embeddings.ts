import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env, type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/multilingual-e5-small';
const DIMS = 384;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/** Outside production only; `Config` requires `MODELS_DIR` there. This module stays a leaf: the
 * Docker model stage copies it alone. */
export const DEFAULT_MODELS_DIR = join(tmpdir(), 'pa-models');

let modelsDir = DEFAULT_MODELS_DIR;
/** `start` passes `Config.modelsDir`; code that never starts a server keeps the default. */
export const setModelsDir = (dir: string) => {
  modelsDir = dir;
};

/** Lazy, one load per process. Downloads only when the directory does not hold the model yet. */
export function loadModel() {
  extractor ??= (async () => {
    const dir = modelsDir;
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
