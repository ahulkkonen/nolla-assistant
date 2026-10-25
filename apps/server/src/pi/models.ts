import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeModelsJson(
  agentDir: string,
  litellmUrl: string,
  modelsPath: string | URL = new URL('../../../../infra/models.json', import.meta.url),
) {
  const { models } = JSON.parse(readFileSync(modelsPath, 'utf8'));
  const config = {
    providers: {
      zdr: {
        baseUrl: litellmUrl,
        api: 'openai-completions',
        apiKey: '$LITELLM_MASTER_KEY',
        models,
      },
    },
  };
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(config, null, 2));
}
