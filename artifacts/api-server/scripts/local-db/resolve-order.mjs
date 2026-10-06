#!/usr/bin/env node
// resolve-order.mjs — the canonical chain in APPLY order, one filename per line, for up.sh.
//
// THE AUTHORITY IS scripts/src/apply-migrations.ts (orderMigrations / applyOrderOverrides). This is
// the same algorithm in plain Node so up.sh needs no tsx, and
// scripts/src/migration-order-overrides.test.ts holds the two identical on the real tree.
// Change both or neither.
//
//   node resolve-order.mjs [migrations-dir]        (default: ../../src/migrations)
//
// stdout  every *.sql filename: byte order, then <dir>/ORDER_OVERRIDES.json's entries in list order,
//         each moving exactly the file it names to immediately before/after its anchor.
// stderr  one line per override applied, with the neighbours it landed between.
// exit 2  the overrides file is missing or malformed, or an entry names a file that is not on disk.
//         A stale override is refused, never skipped: silently falling back to byte order would
//         replay the precondition refusals the entries exist to prevent.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveOrder(filenames, overrides) {
  const out = [...filenames].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  for (const o of overrides) {
    const isBefore = o.before !== undefined;
    if (isBefore === (o.after !== undefined)) {
      throw new Error(`override for ${o.move}: exactly one of "before" / "after" is required`);
    }
    const anchor = isBefore ? o.before : o.after;
    const missing = [o.move, anchor].filter((f) => !out.includes(f));
    if (missing.length > 0) {
      throw new Error(
        `override "${o.move} ${isBefore ? 'before' : 'after'} ${anchor}" names ${missing.join(' and ')}, ` +
          'which is not in the migration list. A stale override is refused, never skipped.',
      );
    }
    if (anchor === o.move) throw new Error(`override for ${o.move}: cannot be placed next to itself`);
    out.splice(out.indexOf(o.move), 1);
    const at = out.indexOf(anchor);
    out.splice(isBefore ? at : at + 1, 0, o.move);
  }
  return out;
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) {
  const dir = resolve(process.argv[2] ?? join(dirname(SELF), '..', '..', 'src', 'migrations'));
  try {
    const doc = JSON.parse(readFileSync(join(dir, 'ORDER_OVERRIDES.json'), 'utf8'));
    if (!Array.isArray(doc?.overrides)) throw new Error('ORDER_OVERRIDES.json: "overrides" must be an array');
    const order = resolveOrder(readdirSync(dir).filter((f) => f.endsWith('.sql')), doc.overrides);
    for (const o of doc.overrides) {
      const i = order.indexOf(o.move);
      process.stderr.write(
        `local-db: order override: ${o.move} ${o.before !== undefined ? `BEFORE ${o.before}` : `AFTER ${o.after}`}` +
          ` — now ${order[i - 1] ?? '(start of chain)'} < ${o.move} < ${order[i + 1] ?? '(end of chain)'}\n`,
      );
    }
    process.stdout.write(`${order.join('\n')}\n`);
  } catch (err) {
    process.stderr.write(`::error::local-db/resolve-order.mjs: ${err.message}\n`);
    process.exit(2);
  }
}
