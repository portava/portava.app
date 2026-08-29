/**
 * Jest mock for @op-engineering/op-sqlite.
 *
 * Simulates a SQLite database using an in-memory store keyed by database name.
 * Supports the core execute/executeAsync API used in localMessageDb.ts.
 * Does NOT implement full SQL parsing — returns empty results for SELECT,
 * noops for DDL, and records rows for INSERT/REPLACE.
 *
 * Tests that need realistic query results should set up the _tables map directly
 * or use the _insert helper.
 */

import type { LocalMessage } from '../../src/lib/localMessageDb';

type Row = Record<string, unknown>;
type TableStore = Map<string, Row[]>;

const _databases = new Map<string, TableStore>();

export function _reset(): void {
  _databases.clear();
}

function getOrCreateDb(name: string): TableStore {
  if (!_databases.has(name)) _databases.set(name, new Map());
  return _databases.get(name)!;
}

function makeDb(name: string) {
  const tables = getOrCreateDb(name);
  return {
    execute(sql: string, args: unknown[] = []) {
      return _executeSync(tables, sql, args);
    },
    async executeAsync(sql: string, args: unknown[] = []) {
      return _executeSync(tables, sql, args);
    },
    close() {
      _databases.delete(name);
    },
  };
}

// op-sqlite v17+: rows is a direct array (not rows._array).
function _executeSync(tables: TableStore, sql: string, args: unknown[]) {
  const trimmed = sql.trim().toUpperCase();

  // DDL: ignore (CREATE TABLE, CREATE INDEX, CREATE VIRTUAL TABLE)
  if (
    trimmed.startsWith('CREATE') ||
    trimmed.startsWith('DROP') ||
    trimmed.startsWith('ALTER')
  ) {
    return { rows: [] };
  }

  // INSERT OR REPLACE INTO <table> (cols...) VALUES (?,?,...)
  if (trimmed.startsWith('INSERT')) {
    const tableMatch = sql.match(/INTO\s+(\w+)/i);
    if (tableMatch) {
      const tableName = tableMatch[1].toLowerCase();
      if (!tables.has(tableName)) tables.set(tableName, []);
      const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
      const cols = colMatch ? colMatch[1].split(',').map(c => c.trim().toLowerCase()) : [];
      const row: Row = {};
      cols.forEach((col, i) => { row[col] = args[i]; });
      // Replace by primary key if present
      const store = tables.get(tableName)!;
      const pkIdx = store.findIndex(r => r['id'] === row['id']);
      if (pkIdx >= 0) store[pkIdx] = row;
      else store.push(row);
    }
    return { rows: [] };
  }

  // DELETE FROM <table> WHERE ...
  if (trimmed.startsWith('DELETE')) {
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    if (tableMatch) {
      const tableName = tableMatch[1].toLowerCase();
      // Simple: clear the whole table (tests verify intent, not SQL engine)
      if (tables.has(tableName)) tables.set(tableName, []);
    }
    return { rows: [] };
  }

  // SELECT: return all rows from the first table mentioned
  if (trimmed.startsWith('SELECT')) {
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    if (tableMatch) {
      const tableName = tableMatch[1].toLowerCase();
      return { rows: tables.get(tableName) ?? [] };
    }
  }

  return { rows: [] };
}

/** Helper: pre-seed a table for test assertions. */
export function _seedTable(dbName: string, tableName: string, rows: Row[]): void {
  const tables = getOrCreateDb(dbName);
  tables.set(tableName.toLowerCase(), [...rows]);
}

export const open = jest.fn((opts: { name: string; encryptionKey?: string }) => makeDb(opts.name));
