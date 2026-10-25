import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export * from './schema.ts';

export function openDb(
  path: string,
  migrationsFolder: string = fileURLToPath(new URL('../drizzle', import.meta.url)),
) {
  const sqlite = new Database(path);
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  // kind: title | summary | transcript. Not managed by drizzle-kit: changes need DROP + rebuild.
  sqlite.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(chat_id UNINDEXED, message_id UNINDEXED, user_id UNINDEXED, kind UNINDEXED, text, tokenize='trigram')",
  );
  return { db, sqlite };
}

export type Db = ReturnType<typeof openDb>['db'];
