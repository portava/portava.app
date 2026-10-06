/**
 * migration-order-overrides.test.ts
 *
 * The declared apply-order overrides (artifacts/api-server/src/migrations/
 * ORDER_OVERRIDES.json): the algorithm in scripts/src/apply-migrations.ts, the
 * two entries' landing places on the REAL file list, the refusals, and parity
 * with the plain-Node copy up.sh runs (artifacts/api-server/scripts/local-db/
 * resolve-order.mjs).
 *
 * NO DATABASE, NO CREDENTIALS. Every test is over pure functions, plus reads of
 * the canonical migrations directory and one `node resolve-order.mjs` spawn.
 *
 * Run:
 *   pnpm --filter @workspace/scripts run test:migration-order-overrides
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MIGRATIONS_DIR,
  ORDER_OVERRIDES_FILE,
  applyOrderOverrides,
  checksumOf,
  compareMigrationFilenames,
  describeOrderOverrides,
  listMigrationFiles,
  orderMigrations,
  parseOrderOverrides,
  planApply,
  readOrderOverrides,
  type LedgerRow,
  type OrderOverride,
} from './apply-migrations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVER = resolve(HERE, '..', '..', 'artifacts', 'api-server', 'scripts', 'local-db', 'resolve-order.mjs');
const resolver = (await import(pathToFileURL(RESOLVER).href)) as {
  resolveOrder: (filenames: readonly string[], overrides: readonly OrderOverride[]) => string[];
};

const CONV_2136 = '2136_profiles_auth_users_convergence.sql';
const STMT_2137 = '2137_intel_stmt_trigger_removal.sql';
const PREP_2138 = '2138_profiles_fk_convergence_prep.sql';
const TOMB_2139 = '2139_shared_content_tombstones.sql';
const RCPT_2140 = '2140_deletion_receipt.sql';

const ov = (move: string, where: { before: string } | { after: string }): OrderOverride => ({
  move,
  ...where,
  why: 'measured',
  evidence: 'ledger',
});

/** `order` with `moved` taken out — what must be unchanged by any override. */
const without = (order: readonly string[], moved: readonly string[]) => order.filter((f) => !moved.includes(f));

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE ALGORITHM
// ─────────────────────────────────────────────────────────────────────────────

describe('applyOrderOverrides — before / after semantics', () => {
  const base = ['a.sql', 'b.sql', 'c.sql', 'd.sql', 'e.sql'];

  it('"before" places the file immediately before its anchor (moving backwards)', () => {
    assert.deepEqual(applyOrderOverrides(base, [ov('d.sql', { before: 'b.sql' })]), [
      'a.sql', 'd.sql', 'b.sql', 'c.sql', 'e.sql',
    ]);
  });

  it('"after" places the file immediately after its anchor (moving forwards)', () => {
    assert.deepEqual(applyOrderOverrides(base, [ov('b.sql', { after: 'd.sql' })]), [
      'a.sql', 'c.sql', 'd.sql', 'b.sql', 'e.sql',
    ]);
  });

  it('works at both ends of the chain', () => {
    assert.deepEqual(applyOrderOverrides(base, [ov('e.sql', { before: 'a.sql' })]), [
      'e.sql', 'a.sql', 'b.sql', 'c.sql', 'd.sql',
    ]);
    assert.deepEqual(applyOrderOverrides(base, [ov('a.sql', { after: 'e.sql' })]), [
      'b.sql', 'c.sql', 'd.sql', 'e.sql', 'a.sql',
    ]);
  });

  it('applies entries in LIST order — a later entry may anchor on a file an earlier one moved', () => {
    const order = applyOrderOverrides(base, [ov('e.sql', { before: 'b.sql' }), ov('a.sql', { after: 'e.sql' })]);
    assert.deepEqual(order, ['e.sql', 'a.sql', 'b.sql', 'c.sql', 'd.sql']);
  });

  it('moves nothing but the named file, and does not mutate its input', () => {
    const input = [...base];
    const order = applyOrderOverrides(input, [ov('c.sql', { after: 'e.sql' })]);
    assert.deepEqual(without(order, ['c.sql']), without(base, ['c.sql']));
    assert.deepEqual(input, base, 'input not mutated');
  });

  it('with no overrides it is the identity', () => {
    assert.deepEqual(applyOrderOverrides(base, []), base);
  });
});

describe('applyOrderOverrides — refusals', () => {
  const base = ['a.sql', 'b.sql', 'c.sql'];

  it('refuses an override whose MOVED file is not in the list (a stale entry is never skipped)', () => {
    assert.throws(() => applyOrderOverrides(base, [ov('gone.sql', { before: 'b.sql' })]), /gone\.sql.*not in the migration list.*refused, never skipped/s);
  });

  it('refuses an override whose ANCHOR is not in the list', () => {
    assert.throws(() => applyOrderOverrides(base, [ov('a.sql', { after: 'gone.sql' })]), /gone\.sql.*not in the migration list/s);
  });

  it('refuses an entry with both or neither of before/after', () => {
    const both = { move: 'a.sql', before: 'b.sql', after: 'c.sql', why: 'w', evidence: 'e' };
    const neither = { move: 'a.sql', why: 'w', evidence: 'e' };
    assert.throws(() => applyOrderOverrides(base, [both]), /exactly one of "before" \/ "after"/);
    assert.throws(() => applyOrderOverrides(base, [neither]), /exactly one of "before" \/ "after"/);
  });

  it('refuses a file placed next to itself', () => {
    assert.throws(() => applyOrderOverrides(base, [ov('b.sql', { before: 'b.sql' })]), /next to itself/);
  });
});

describe('orderMigrations — byte-wise base, then the overrides', () => {
  it('sorts byte-wise BEFORE applying the overrides', () => {
    assert.deepEqual(
      orderMigrations(['2102_c.sql', '2100_a.sql', '2101_b.sql'], [ov('2102_c.sql', { before: '2100_a.sql' })]),
      ['2102_c.sql', '2100_a.sql', '2101_b.sql'],
    );
  });

  it('defaults to no overrides, which is the plain byte-wise order', () => {
    assert.deepEqual(orderMigrations(['2101_b.sql', '2100_a.sql']), ['2100_a.sql', '2101_b.sql']);
  });
});

describe('parseOrderOverrides — the file shape', () => {
  const valid = { _what: 'prose', overrides: [ov('a.sql', { before: 'b.sql' })] };

  it('accepts `_`-prefixed prose keys and the overrides list', () => {
    assert.deepEqual(parseOrderOverrides(valid), [ov('a.sql', { before: 'b.sql' })]);
  });

  it('refuses everything it cannot read unambiguously', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /top level must be an object/],
      [{ overrides: {} }, /"overrides" must be an array/],
      [{ overrides: [], extra: 1 }, /unknown top-level key "extra"/],
      [{ overrides: [{ ...ov('a.sql', { before: 'b.sql' }), note: 'x' }] }, /unknown key "note"/],
      [{ overrides: [{ ...ov('a.sql', { before: 'b.sql' }), after: 'c.sql' }] }, /exactly one of/],
      [{ overrides: [ov('a.txt', { before: 'b.sql' })] }, /"move" must be a migration filename/],
      [{ overrides: [ov('a.sql', { before: 'dir/b.sql' })] }, /"before" must be a migration filename/],
      [{ overrides: [{ ...ov('a.sql', { before: 'b.sql' }), why: ' ' }] }, /"why" must state the measured defect/],
      [{ overrides: [{ ...ov('a.sql', { before: 'b.sql' }), evidence: '' }] }, /"evidence" must state/],
      [{ overrides: [ov('a.sql', { before: 'b.sql' }), ov('a.sql', { after: 'c.sql' })] }, /moved by an earlier entry/],
    ];
    for (const [raw, re] of cases) assert.throws(() => parseOrderOverrides(raw), re, JSON.stringify(raw));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REAL TREE
// ─────────────────────────────────────────────────────────────────────────────

describe('the declared overrides on the real migration list', () => {
  const files = listMigrationFiles();
  const overrides = readOrderOverrides();
  const order = orderMigrations(files, overrides);

  it('premise: the canonical tree is populated and listMigrationFiles is the byte-wise base', () => {
    assert.ok(files.length > 600, `expected > 600 canonical files, found ${files.length}`);
    assert.deepEqual(files, [...files].sort(compareMigrationFilenames));
  });

  it('declares exactly the one measured entry', () => {
    assert.deepEqual(
      overrides.map((o) => [o.move, o.before !== undefined ? 'before' : 'after', o.before ?? o.after]),
      [[CONV_2136, 'after', TOMB_2139]],
    );
  });

  it('places 2136 after BOTH of its prerequisites (2138, 2139) and before its dependant 2140', () => {
    assert.deepEqual(order.slice(order.indexOf(PREP_2138), order.indexOf(RCPT_2140) + 1), [
      PREP_2138,
      TOMB_2139,
      CONV_2136,
      RCPT_2140,
    ]);
  });

  it('leaves 2137 in byte order — no position of it replays cleanly (docs/migrations.md)', () => {
    assert.ok(!overrides.some((o) => [o.move, o.before, o.after].includes(STMT_2137)));
    assert.equal(order[order.indexOf(STMT_2137) + 1], PREP_2138, 'still immediately before 2138, as in byte order');
  });

  it('is a permutation of the same files that moves nothing else', () => {
    assert.equal(order.length, files.length);
    assert.deepEqual([...order].sort(compareMigrationFilenames), files);
    assert.deepEqual(without(order, [CONV_2136]), without(files, [CONV_2136]));
  });

  it('the dry-run description names the neighbours the file landed between', () => {
    const lines = describeOrderOverrides(order, overrides, new Set([CONV_2136]));
    assert.deepEqual(lines, [
      `${CONV_2136} AFTER ${TOMB_2139} — now ${TOMB_2139} < ${CONV_2136} < ${RCPT_2140}` +
        ` [${CONV_2136}: pending; ${TOMB_2139}: not pending]`,
    ]);
  });

  it('planApply honours them on an empty ledger (a fresh database) ...', () => {
    const onDisk = files.map((filename) => ({ filename, sql: '' }));
    assert.deepEqual(planApply(onDisk, [], [], overrides).pending, order);
  });

  it('... and changes nothing when every file is already proven applied (portava-ci today)', () => {
    const onDisk = files.map((filename) => ({
      filename,
      sql: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'),
    }));
    const ledger: LedgerRow[] = onDisk.map((m) => ({ filename: m.filename, checksum: checksumOf(m.sql), applied_by: 'ci' }));
    const plan = planApply(onDisk, ledger, [], overrides);
    assert.deepEqual(plan.pending, []);
    assert.equal(plan.skipped.length, files.length);
  });

  it('planApply refuses, by throwing, an override that names a file not on disk', () => {
    const onDisk = files.filter((f) => f !== TOMB_2139).map((filename) => ({ filename, sql: '' }));
    assert.throws(() => planApply(onDisk, [], [], overrides), new RegExp(`${TOMB_2139}.*not in the migration list`, 's'));
  });

  it('the overrides file is not a migration: listMigrationFiles never returns it', () => {
    assert.ok(!files.includes(ORDER_OVERRIDES_FILE));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PARITY WITH resolve-order.mjs (what up.sh runs)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolve-order.mjs is the same algorithm', () => {
  it('prints exactly orderMigrations(listMigrationFiles(), readOrderOverrides()) for the real tree', () => {
    const run = spawnSync(process.execPath, [RESOLVER, MIGRATIONS_DIR], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const printed = run.stdout.split('\n').filter((l) => l !== '');
    assert.deepEqual(printed, orderMigrations(listMigrationFiles(), readOrderOverrides()));
    assert.match(run.stderr, new RegExp(`order override: ${CONV_2136} AFTER ${TOMB_2139} — now ${TOMB_2139} < ${CONV_2136} < ${RCPT_2140}`));
  });

  it('agrees with the TS function on synthetic inputs, including list-order chaining', () => {
    const input = ['e.sql', 'c.sql', 'a.sql', 'd.sql', 'b.sql'];
    const overrides = [ov('e.sql', { before: 'b.sql' }), ov('a.sql', { after: 'e.sql' }), ov('c.sql', { after: 'd.sql' })];
    assert.deepEqual(resolver.resolveOrder(input, overrides), orderMigrations(input, overrides));
  });

  it('refuses the same stale override the TS function refuses', () => {
    const stale = [ov('gone.sql', { before: 'a.sql' })];
    assert.throws(() => resolver.resolveOrder(['a.sql'], stale), /gone\.sql.*refused, never skipped/s);
    assert.throws(() => orderMigrations(['a.sql'], stale), /gone\.sql.*refused, never skipped/s);
  });

  it('exits 2 on a stale override, so up.sh cannot fall back to byte order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'order-overrides-'));
    try {
      writeFileSync(join(dir, '2100_a.sql'), '');
      writeFileSync(join(dir, ORDER_OVERRIDES_FILE), JSON.stringify({ overrides: [ov('2101_gone.sql', { before: '2100_a.sql' })] }));
      const run = spawnSync(process.execPath, [RESOLVER, dir], { encoding: 'utf8' });
      assert.equal(run.status, 2);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /2101_gone\.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when the overrides file is missing — absence is not "no overrides"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'order-overrides-'));
    try {
      writeFileSync(join(dir, '2100_a.sql'), '');
      const run = spawnSync(process.execPath, [RESOLVER, dir], { encoding: 'utf8' });
      assert.equal(run.status, 2);
      assert.equal(run.stdout, '');
      assert.throws(() => readOrderOverrides(dir), /ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
