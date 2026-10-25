import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as sqliteVec from 'sqlite-vec';
import * as schema from './schema.ts';

export * from './schema.ts';

export function openDb(
  path: string,
  migrationsFolder: string = fileURLToPath(new URL('../drizzle', import.meta.url)),
) {
  const sqlite = new Database(path);
  sqliteVec.load(sqlite);
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  // Not managed by drizzle-kit: changes need DROP + rebuild. Row ids match `chunks.id`
  // (`chat_fts.chunk_id`, `chunk_vec.chunk_id`); kind: title | summary | transcript.
  // Phase-4 `chat_fts` had no `chunk_id` and no writer: an old empty table is rebuilt.
  const ftsCols = sqlite.pragma('table_info(chat_fts)') as { name: string }[];
  if (ftsCols.length && !ftsCols.some((c) => c.name === 'chunk_id'))
    sqlite.exec('DROP TABLE chat_fts');
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(chat_id UNINDEXED, message_id UNINDEXED, user_id UNINDEXED, kind UNINDEXED, text, chunk_id UNINDEXED, tokenize='trigram');
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(chunk_id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, embedding float[384] distance_metric=cosine);
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chat_fts WHERE chunk_id = old.id;
      DELETE FROM chunk_vec WHERE chunk_id = old.id;
    END;
  `);
  return { db, sqlite };
}

export type Db = ReturnType<typeof openDb>['db'];
