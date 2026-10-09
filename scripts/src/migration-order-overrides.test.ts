/**
 * migration-order-overrides.test.ts
 *
 * The declared apply-order overrides (artifacts/api-server/src/migrations/
 * ORDER_OVERRIDES.json): the algorithm in scripts/src/apply-migrations.ts (moves
 * AND skips), the entries' effect on the REAL file list, the refusals, the
 * skip's ledger semantics, the shape of 2134 (the file 2137's skip relies on),
 * and parity with the plain-Node copy up.sh runs (artifacts/api-server/scripts/
 * local-db/resolve-order.mjs).
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
  LEDGER_TABLE,
  applyOrderOverrides,
  buildSkipRecordStatement,
  checksumOf,
  classifyMigration,
  compareMigrationFilenames,
  describeOrderOverrides,
  formatDryRun,
  isProofOfApply,
  isSkipOverride,
  listMigrationFiles,
  orderMigrations,
  parseOrderOverrides,
  planApply,
  readOrderOverrides,
  usesConcurrently,
  type LedgerRow,
  type MoveOverride,
  type OrderOverride,
  type SkipOverride,
} from './apply-migrations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVER = resolve(HERE, '..', '..', 'artifacts', 'api-server', 'scripts', 'local-db', 'resolve-order.mjs');
const resolver = (await import(pathToFileURL(RESOLVER).href)) as {
  resolveOrder: (filenames: readonly string[], overrides: readonly OrderOverride[]) => string[];
};

const INTEL_2130 = '2130_intel_storage.sql';
const REISSUE_2134 = '2134_intel_stmt_triggers_dropped_before_campaign.sql';
const CONV_2136 = '2136_profiles_auth_users_convergence.sql';
const STMT_2137 = '2137_intel_stmt_trigger_removal.sql';
const PREP_2138 = '2138_profiles_fk_convergence_prep.sql';
const TOMB_2139 = '2139_shared_content_tombstones.sql';
const RCPT_2140 = '2140_deletion_receipt.sql';
const CHECK_2178 = '2178_deletion_status_check_converge.sql';
const PRES_2276 = '2276_intel_presence_verification.sql';
const HIST_2279 = '2279_intel_historical_patterns.sql';
const CAMP_2292 = '2292_intel_stmt_trigger_removal_ig_campaign.sql';
const KERNEL_3974 = '3974_trip_kernel_admin_restore_participant.sql';
const REISSUE_3979 = '3979_trip_kernel_admin_restore_participant_reissue.sql';

const ov = (move: string, where: { before: string } | { after: string }): MoveOverride => ({
  move,
  ...where,
  why: 'measured',
  evidence: 'ledger',
});

const sk = (skip: string, superseded_by: string[]): SkipOverride => ({
  skip,
  superseded_by,
  why: 'no position replays',
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

describe('applyOrderOverrides — skip semantics', () => {
  const base = ['a.sql', 'b.sql', 'c.sql', 'd.sql'];

  it('leaves the skipped file out of the chain and moves nothing else', () => {
    assert.deepEqual(applyOrderOverrides(base, [sk('b.sql', ['a.sql', 'd.sql'])]), ['a.sql', 'c.sql', 'd.sql']);
  });

  it('composes with moves in list order', () => {
    assert.deepEqual(
      applyOrderOverrides(base, [ov('a.sql', { after: 'c.sql' }), sk('b.sql', ['d.sql']), ov('d.sql', { before: 'c.sql' })]),
      ['d.sql', 'c.sql', 'a.sql'],
    );
  });

  it('refuses a skip whose skipped file is not in the list (stale)', () => {
    assert.throws(() => applyOrderOverrides(base, [sk('gone.sql', ['a.sql'])]), /gone\.sql.*not in the migration list.*refused, never skipped/s);
  });

  it('refuses a skip whose successor is not in the list (stale)', () => {
    assert.throws(() => applyOrderOverrides(base, [sk('b.sql', ['a.sql', 'gone.sql'])]), /gone\.sql.*not in the migration list/s);
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

  it('accepts a skip entry and tells it apart from a move', () => {
    const parsed = parseOrderOverrides({ overrides: [sk('a.sql', ['b.sql', 'c.sql']), ov('c.sql', { after: 'b.sql' })] });
    assert.deepEqual(parsed.map(isSkipOverride), [true, false]);
    assert.deepEqual(parsed[0], sk('a.sql', ['b.sql', 'c.sql']));
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
      [{ overrides: [ov('a.sql', { before: 'b.sql' }), ov('a.sql', { after: 'c.sql' })] }, /named by an earlier entry/],
      [{ overrides: [sk('a.sql', [])] }, /"superseded_by" must be a non-empty array/],
      [{ overrides: [sk('a.sql', ['b.txt'])] }, /"superseded_by" must be a non-empty array of migration filenames/],
      [{ overrides: [sk('a.sql', ['a.sql'])] }, /cannot supersede itself/],
      [{ overrides: [{ ...sk('a.sql', ['b.sql']), before: 'c.sql' }] }, /unknown key "before"/],
      [{ overrides: [sk('a.sql', ['b.sql']), ov('a.sql', { after: 'c.sql' })] }, /named by an earlier entry/],
      [{ overrides: [sk('a.sql', ['b.sql']), ov('c.sql', { after: 'a.sql' })] }, /a\.sql is skipped, so it cannot anchor or supersede/],
      [{ overrides: [sk('a.sql', ['b.sql']), sk('b.sql', ['c.sql'])] }, /b\.sql is skipped, so it cannot anchor or supersede/],
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
  const at = (f: string) => order.indexOf(f);

  it('premise: the canonical tree is populated and listMigrationFiles is the byte-wise base', () => {
    assert.ok(files.length > 600, `expected > 600 canonical files, found ${files.length}`);
    assert.deepEqual(files, [...files].sort(compareMigrationFilenames));
  });

  it('declares exactly the four measured entries, in this order', () => {
    assert.deepEqual(
      overrides.map((o) =>
        isSkipOverride(o)
          ? ['skip', o.skip, o.superseded_by.join(',')]
          : [o.move, o.before !== undefined ? 'before' : 'after', o.before ?? o.after],
      ),
      [
        [CONV_2136, 'after', TOMB_2139],
        ['skip', STMT_2137, `${REISSUE_2134},${CAMP_2292}`],
        [RCPT_2140, 'after', CHECK_2178],
        ['skip', KERNEL_3974, REISSUE_3979],
      ],
    );
  });

  it('places 2136 after BOTH of its prerequisites (2138, 2139)', () => {
    assert.deepEqual(order.slice(at(PREP_2138), at(CONV_2136) + 1), [PREP_2138, TOMB_2139, CONV_2136]);
  });

  it('places 2140 immediately after 2178, the file that adds \'completed\' to the status CHECK', () => {
    assert.equal(order[at(CHECK_2178) + 1], RCPT_2140);
  });

  it('leaves 2137 out of the chain, with 2134 after 2130 and the function-dependants between 2134 and 2292', () => {
    assert.equal(at(STMT_2137), -1);
    assert.ok(at(INTEL_2130) < at(REISSUE_2134), '2130 creates the triggers 2134 drops');
    assert.ok(at(REISSUE_2134) < at(PRES_2276), '2134 runs before the campaign files');
    assert.ok(at(PRES_2276) < at(HIST_2279) && at(HIST_2279) < at(CAMP_2292), '2276-2279 find the function; 2292 drops it');
  });

  it('leaves 3974 out of the chain; 3979, which supersedes it, is in byte position and nothing between them touches the kernel', () => {
    assert.equal(at(KERNEL_3974), -1);
    assert.ok(at(REISSUE_3979) > 0);
    const between = files.filter((f) => compareMigrationFilenames(f, KERNEL_3974) > 0 && compareMigrationFilenames(f, REISSUE_3979) < 0);
    assert.ok(between.length > 0, 'premise: 3975-3978 sit between them');
    for (const f of between) {
      assert.doesNotMatch(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'), /trip_kernel_execute/, `${f} sits between 3974 and its re-issue and must not touch the kernel`);
    }
  });

  it('is the byte-wise list minus 2137 and 3974, and moves nothing but 2136 and 2140', () => {
    assert.equal(order.length, files.length - 2);
    assert.deepEqual([...order].sort(compareMigrationFilenames), without(files, [STMT_2137, KERNEL_3974]));
    assert.deepEqual(without(order, [CONV_2136, RCPT_2140]), without(files, [CONV_2136, RCPT_2140, STMT_2137, KERNEL_3974]));
  });

  it('the dry-run description names each move\'s neighbours and each skip\'s successors', () => {
    const lines = describeOrderOverrides(order, overrides, new Set([CONV_2136]), new Set([STMT_2137]));
    assert.equal(lines.length, 4);
    assert.equal(
      lines[0],
      `${CONV_2136} AFTER ${TOMB_2139} — now ${TOMB_2139} < ${CONV_2136} < ${order[at(CONV_2136) + 1]}` +
        ` [${CONV_2136}: pending; ${TOMB_2139}: not pending]`,
    );
    assert.equal(
      lines[1],
      `${STMT_2137} SKIPPED — never applied; superseded by ${REISSUE_2134}, ${CAMP_2292}` +
        ` [no ledger row: one is recorded with applied_by='backfill']`,
    );
    assert.match(lines[2], new RegExp(`^${RCPT_2140} AFTER ${CHECK_2178} — now ${CHECK_2178} < ${RCPT_2140} < \\S+ \\[`));
    assert.equal(
      lines[3],
      `${KERNEL_3974} SKIPPED — never applied; superseded by ${REISSUE_3979} [ledger row present: left untouched]`,
      'portava-ci holds 3974 applied by run 37737811561; its row is left exactly as it is',
    );
    assert.match(describeOrderOverrides(order, overrides)[1], /\[ledger row present: left untouched\]$/);
  });

  it('planApply on an empty ledger (a fresh database): pending is the chain; 2137 and 3974 are superseded and unrecorded', () => {
    const onDisk = files.map((filename) => ({ filename, sql: '' }));
    const plan = planApply(onDisk, [], [], overrides);
    assert.deepEqual(plan.pending, order);
    assert.deepEqual(plan.superseded, [STMT_2137, KERNEL_3974]);
    assert.deepEqual(plan.supersededUnrecorded, [STMT_2137, KERNEL_3974]);
    assert.ok(plan.pending.includes(REISSUE_3979) && !plan.pending.includes(KERNEL_3974));
  });

  it('planApply on portava-ci\'s shape: every file proven except 2137 (backfill) and the new 2134 and 3979 (no row)', () => {
    const onDisk = files.map((filename) => ({
      filename,
      sql: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'),
    }));
    const ledger: LedgerRow[] = onDisk
      .filter((m) => m.filename !== REISSUE_2134 && m.filename !== REISSUE_3979)
      .map((m) =>
        m.filename === STMT_2137
          ? { filename: m.filename, checksum: 'backfill', applied_by: 'backfill' }
          : { filename: m.filename, checksum: checksumOf(m.sql), applied_by: 'ci' },
      );
    const plan = planApply(onDisk, ledger, [], overrides);
    assert.deepEqual(plan.pending, [REISSUE_2134, REISSUE_3979], 'only the new files are pending');
    assert.deepEqual(plan.unproven, [], '2137 is not reported as an unproven candidate for --apply-unproven');
    assert.deepEqual(plan.superseded, [STMT_2137, KERNEL_3974]);
    assert.deepEqual(plan.supersededUnrecorded, [], 'existing rows (2137 backfill, 3974 applied) are left untouched');
    assert.deepEqual(plan.drifted, [], '3974 is out of the chain, but its file is unchanged, so its recorded checksum still matches');
    assert.equal(plan.skipped.length, files.length - 4);
  });

  it('3974 as committed at 2de186f820 is byte-identical on disk (portava-ci recorded its checksum; it must never be edited)', () => {
    assert.equal(
      checksumOf(readFileSync(join(MIGRATIONS_DIR, KERNEL_3974), 'utf8')),
      'e40ae0463085a5a4683332c888113dcf5ae70369b23e36f7a20e9f497d72a47c',
    );
  });

  it('a skipped file stays out of pending even when its ledger row is missing or forced', () => {
    const onDisk = files.map((filename) => ({ filename, sql: '' }));
    assert.ok(!planApply(onDisk, [], [STMT_2137], overrides).pending.includes(STMT_2137));
    assert.ok(!planApply(onDisk, [], [KERNEL_3974], overrides).pending.includes(KERNEL_3974));
  });

  it('planApply refuses, by throwing, a skip whose successor is not on disk', () => {
    const onDisk = files.filter((f) => f !== REISSUE_2134).map((filename) => ({ filename, sql: '' }));
    assert.throws(() => planApply(onDisk, [], [], overrides), new RegExp(`${REISSUE_2134}.*not in the migration list`, 's'));
  });

  it('planApply refuses, by throwing, a skip whose skipped file is not on disk', () => {
    const onDisk = files.filter((f) => f !== STMT_2137).map((filename) => ({ filename, sql: '' }));
    assert.throws(() => planApply(onDisk, [], [], overrides), new RegExp(`${STMT_2137}.*not in the migration list`, 's'));
  });

  it('the overrides file is not a migration: listMigrationFiles never returns it', () => {
    assert.ok(!files.includes(ORDER_OVERRIDES_FILE));
  });
});

describe('a skipped file\'s ledger row and dry-run line', () => {
  const skip = sk(STMT_2137, [REISSUE_2134, CAMP_2292]);
  const statement = buildSkipRecordStatement(skip);

  it('records 2254\'s backfill semantics — existence, never an apply — and never overwrites', () => {
    assert.match(statement, new RegExp(`^INSERT INTO ${LEDGER_TABLE.replace('.', '\\.')} \\(filename, checksum, applied_by, notes\\)`));
    assert.match(statement, new RegExp(`VALUES \\('${STMT_2137}', 'backfill', 'backfill', '`));
    assert.match(statement, new RegExp(`superseded by ${REISSUE_2134}, ${CAMP_2292}`));
    assert.match(statement, /ON CONFLICT \(filename\) DO NOTHING;$/);
    assert.doesNotMatch(statement, /DO UPDATE/);
    assert.equal(isProofOfApply({ filename: STMT_2137, checksum: 'backfill', applied_by: 'backfill' }), false);
  });

  it('quotes the note safely', () => {
    const quoted = buildSkipRecordStatement({ ...skip, superseded_by: ["2134_o'clock.sql"] });
    assert.match(quoted, /2134_o''clock\.sql/);
  });

  it('the dry run lists skipped files and which of them a real run records', () => {
    const files = ['2100_a.sql', '2101_b.sql', '2102_c.sql'];
    const onDisk = files.map((filename) => ({ filename, sql: '' }));
    const overrides: OrderOverride[] = [sk('2101_b.sql', ['2102_c.sql'])];
    const unrecorded = formatDryRun(planApply(onDisk, [], [], overrides), () => ({ kind: 'bare', body: '', postconditions: '' }));
    assert.match(unrecorded, /SKIPPED by ORDER_OVERRIDES\.json \(never applied\): 1 \(2101_b\.sql\)\. Without a ledger row, so a real run records one with applied_by='backfill': 2101_b\.sql\./);
    assert.doesNotMatch(unrecorded, /^\s+\d+\. 2101_b\.sql/m, 'never in the would-apply list');
    const ledger: LedgerRow[] = [{ filename: '2101_b.sql', checksum: 'backfill', applied_by: 'backfill' }];
    const recorded = formatDryRun(planApply(onDisk, ledger, [], overrides), () => ({ kind: 'bare', body: '', postconditions: '' }));
    assert.match(recorded, /applied_by='backfill': none\./);
  });
});

describe('2134 — the trigger half of 2137, without the function drop', () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, REISSUE_2134), 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');

  it('is one BEGIN/COMMIT transaction the applier can wrap, with no CONCURRENTLY', () => {
    const cls = classifyMigration(sql, REISSUE_2134);
    assert.equal(cls.kind, 'unwrapped', cls.kind === 'refuse' ? cls.reason : '');
    assert.equal(usesConcurrently(sql), false);
  });

  it('drops only the three 2130 statement triggers, IF EXISTS', () => {
    assert.match(code, /ARRAY\['intel_observations','intel_evidence','intel_confirmations'\]/);
    assert.match(code, /DROP TRIGGER IF EXISTS %I ON public\.%I', t \|\| '_no_update_delete_stmt'/);
    assert.equal((code.match(/DROP TRIGGER/g) ?? []).length, 1);
  });

  it('never touches the function 2276-2279 need and 2292 owns', () => {
    assert.doesNotMatch(code, /DROP\s+FUNCTION/i);
    assert.doesNotMatch(code, /intel_append_only_stmt/);
    assert.doesNotMatch(code, /CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)/i);
  });

  it('asserts the six guards that matter survive, like 2137 does', () => {
    assert.match(code, /expected 3 row-level append-only triggers/);
    assert.match(code, /expected 3 TRUNCATE guards/);
    assert.match(code, /statement-level trigger\(s\) remain/);
  });
});

describe('3979 — 3974 re-issued so the live applier can apply it', () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, REISSUE_3979), 'utf8');
  const orig = readFileSync(join(MIGRATIONS_DIR, KERNEL_3974), 'utf8');
  const cls = classifyMigration(sql, REISSUE_3979);

  it('is one BEGIN/COMMIT transaction with a post-COMMIT postcondition, no CONCURRENTLY', () => {
    assert.equal(cls.kind, 'unwrapped', cls.kind === 'refuse' ? cls.reason : '');
    assert.equal(usesConcurrently(sql), false);
    assert.ok(cls.kind === 'unwrapped' && /DO \$post\$/.test(cls.postconditions));
  });

  it('carries 3974\'s transform literals byte for byte: the branch, the dispatch entry, the declarations', () => {
    const branch = (s: string) => /\$branches\$([\s\S]*?)\$branches\$/.exec(s)?.[1];
    assert.ok(branch(orig) && branch(orig)!.length > 3000);
    assert.equal(branch(sql), branch(orig));
    assert.ok(sql.includes("$a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin' WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$"));
    assert.ok(orig.includes("$a$    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin' WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$"));
    for (const decl of ["'  v_rst_event  uuid;'", "'  v_rst_seq    bigint;'", "'  v_rst_access text;'"]) {
      assert.ok(sql.includes(decl) && orig.includes(decl), decl);
    }
  });

  it('its postcondition reads no session state: no temp table, no pg_temp, no GUC — and the body creates none', () => {
    assert.ok(cls.kind === 'unwrapped');
    const post = cls.kind === 'unwrapped' ? cls.postconditions.replace(/--[^\n]*/g, '') : '';
    assert.doesNotMatch(post, /pg_temp|_k3974|_k3979|current_setting/i);
    assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /CREATE\s+(TEMP|TEMPORARY)\s+TABLE/i);
    assert.match(orig, /pg_temp\._k3974_after/, 'premise: 3974 is the file that read one');
  });

  it('its precondition is tagged $pre$ (certify stage 4 holds it back); the "already present" refusal is gone', () => {
    const code = sql.replace(/--[^\n]*/g, '');
    assert.match(code, /^DO \$pre\$$/m);
    assert.doesNotMatch(code, /\$base\$/);
    assert.doesNotMatch(code, /not idempotent by design/);
    assert.match(orig, /DO \$base\$/, 'premise: 3974 carried the untagged precondition');
  });

  it('where 3974 already ran it adopts ONLY 3974\'s exact text, and otherwise refuses', () => {
    assert.match(sql, /IF position\('ADMIN_RESTORE_PARTICIPANT' in d\) > 0 THEN\n {4}n := \(length\(d\) - length\(replace\(d, v_branch, ''\)\)\) \/ length\(v_branch\);/);
    assert.match(sql, /refusing to adopt it/);
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
    assert.match(run.stderr, new RegExp(`order override: ${CONV_2136} AFTER ${TOMB_2139} — now ${TOMB_2139} < ${CONV_2136} < `));
    assert.match(run.stderr, new RegExp(`order override: ${STMT_2137} SKIPPED — never applied; superseded by ${REISSUE_2134}, ${CAMP_2292}`));
    assert.match(run.stderr, new RegExp(`order override: ${RCPT_2140} AFTER ${CHECK_2178} — now ${CHECK_2178} < ${RCPT_2140} < `));
    assert.match(run.stderr, new RegExp(`order override: ${KERNEL_3974} SKIPPED — never applied; superseded by ${REISSUE_3979}`));
    assert.ok(!printed.includes(STMT_2137), 'the harness never runs a skipped file');
    assert.ok(!printed.includes(KERNEL_3974) && printed.includes(REISSUE_3979), 'the harness runs the re-issue, never 3974');
  });

  it('agrees with the TS function on synthetic inputs, including list-order chaining', () => {
    const input = ['e.sql', 'c.sql', 'a.sql', 'd.sql', 'b.sql'];
    const overrides: OrderOverride[] = [
      ov('e.sql', { before: 'b.sql' }),
      sk('d.sql', ['c.sql']),
      ov('a.sql', { after: 'e.sql' }),
      ov('c.sql', { after: 'b.sql' }),
    ];
    assert.deepEqual(resolver.resolveOrder(input, overrides), orderMigrations(input, overrides));
  });

  it('refuses the same stale overrides the TS function refuses', () => {
    for (const stale of [[ov('gone.sql', { before: 'a.sql' })], [sk('gone.sql', ['a.sql'])], [sk('a.sql', ['gone.sql'])]]) {
      assert.throws(() => resolver.resolveOrder(['a.sql'], stale), /gone\.sql.*refused, never skipped/s);
      assert.throws(() => orderMigrations(['a.sql'], stale), /gone\.sql.*refused, never skipped/s);
    }
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
