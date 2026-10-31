import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { pushSQLiteSchema } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, test } from 'vitest';
import * as schema from './schema.ts';

test('the migrated database is the schema that schema.ts describes', async () => {
  const db = drizzle(new Database(':memory:'));
  migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const { statementsToExecute } = await pushSQLiteSchema(schema, db as never);
  expect(statementsToExecute).toEqual([]);
});
