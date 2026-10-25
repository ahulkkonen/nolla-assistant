import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export * from './schema.ts';

export function openDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  // drizzle-kit does not manage virtual tables.
  sqlite.exec(
    'CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(chat_id UNINDEXED, message_id UNINDEXED, user_id UNINDEXED, text)',
  );
  return { db, sqlite };
}

export type Db = ReturnType<typeof openDb>['db'];
