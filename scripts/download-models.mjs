// Pre-downloads the embedding model: node scripts/download-models.mjs <dir>
// Imports the server module so the model id and options stay in one place.
const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/download-models.mjs <dir>');
process.env.MODELS_DIR = dir;
const { embed } = await import('../apps/server/src/embeddings.ts');
await embed(['ok']);
console.log(`model ready in ${dir}`);
