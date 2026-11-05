/** Real SQLite SQL/transaction semantics with a test-only cipher capability.
 * This fixture does not claim encryption or exercise the device JSI binding. */
import { jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
const databases = new Map<string, DatabaseSync>();
export const fixture = { cipher: true, failSql: '', opened: [] as Array<{ name: string; encryptionKey: string }> };
export function resetFixture() { for (const db of databases.values()) db.close(); databases.clear(); fixture.cipher = true; fixture.failSql = ''; fixture.opened = []; }
export const open = jest.fn((options: { name: string; encryptionKey: string }) => {
  fixture.opened.push(options);
  let db = databases.get(options.name);
  if (!db) { db = new DatabaseSync(':memory:'); databases.set(options.name, db); }
  const connection = db;
  return {
    close: jest.fn(),
    executeSync(sql: string, args: Array<string | number | null> = []) {
      if (sql === 'PRAGMA cipher_version') return { rows: fixture.cipher ? [{ cipher_version: 'synthetic-fixture' }] : [] };
      if (fixture.failSql && sql.includes(fixture.failSql)) throw new Error('Synthetic SQLite write failure');
      const statement = connection.prepare(sql);
      return /^(SELECT|PRAGMA)/i.test(sql) ? { rows: statement.all(...args) } : (statement.run(...args), { rows: [] });
    },
  };
});
