// Embedded alternative to test-intelligence-monitor.sh. Supply the installed
// PGlite module path; no runtime dependency or database credentials are added.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Usage: node scripts/test-intelligence-monitor.mjs /absolute/path/to/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
const read = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
try {
  await db.exec(await read('tests/intelligence_system_monitor.fixture.sql'));
  const migration = await read('migrations/20261113111829_intelligence_system_monitor.sql');
  await db.exec(migration.split('create extension if not exists pg_cron')[0]);
  await db.exec(await read('tests/intelligence_system_monitor.sql'));
  await db.exec(await read('tests/intelligence_system_monitor.fixture-checks.sql'));
  await db.exec(await read('tests/whole_system_monitor.fixture.sql'));
  await db.exec(await read('migrations/20261113120000_whole_system_monitor.sql'));
  await db.exec(await read('tests/whole_system_monitor.fixture-checks.sql'));
  console.log('PASS: monitor privacy, state semantics, deduplication, timing, outage isolation, and thirteen-system collection and same-hour upgrade.');
} finally { await db.close(); }
