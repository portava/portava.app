/**
 * migrationApplyOrder.test.ts — unit tests over the migration applier's PURE
 * logic: ordering, skip-if-in-ledger (idempotence), stop-on-failure, dry-run,
 * and the transaction/ledger atomicity rules.
 *
 * NO LIVE DATABASE. Every test here is over pure functions exported by
 * scripts/src/apply-migrations.ts, with the one exception of a conformance test
 * that reads the canonical migrations directory off disk.
 *
 * WHY THIS TEST NEEDS NO CREDENTIALS AND NAMES NO CREDENTIAL VARIABLE
 * ===================================================================
 *
 * scripts/src/apply-migrations.ts WRITES DDL, and it asserts its Supabase
 * target with the repo's strict front door before it constructs anything. That
 * assertion is taken as an ENTRY-POINT import — a dynamic
 * `await import("…/ciSupabaseGuard.mjs")` guarded by RUN_DIRECTLY, immediately
 * before main() — precisely so that importing the module for its pure functions
 * does not trip it. Nothing at module scope in that file reaches a network, so
 * the guard still runs before any client or query in the real invocation.
 *
 * The consequence here is the good one: this suite constructs no client, issues
 * no request, and mentions no Supabase credential variable, which is what
 * artifacts/api-server/scripts/check-guard-coverage.mjs requires of an
 * unguarded file it scans.
 *
 * Run:
 *   node --import tsx/esm --test src/test/migrationApplyOrder.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const APPLIER = resolve(__dir, "../../../../scripts/src/apply-migrations.ts");
const MIGRATIONS_DIR = resolve(__dir, "../migrations");

const mod = await import(APPLIER);

const {
  compareMigrationFilenames,
  orderMigrations,
  listMigrationFiles,
  checksumOf,
  classifyMigration,
  findTransactionStatements,
  analyseTail,
  planApply,
  buildApplyStatement,
  runPlan,
  decideExitCode,
  formatDryRun,
  assertUnambiguousOrder,
  maskNonCode,
  isProofOfApply,
  parseApplyUnproven,
  LEDGER_TABLE,
} = mod as typeof import("../../../../scripts/src/apply-migrations.js");

/** A ledger row the applier wrote: real provenance, real hash. */
const proven = (filename: string, sql: string) => ({
  filename,
  checksum: checksumOf(sql),
  applied_by: "ci",
});

/** A row 2254 seeded: asserts the filename existed, nothing more. */
const backfilled = (filename: string) => ({
  filename,
  checksum: "backfill",
  applied_by: "backfill",
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const WRAPPED = `-- 2300_thing.sql
BEGIN;
CREATE TABLE public.thing (id uuid PRIMARY KEY);
COMMIT;
`;

const BARE = `CREATE TABLE public.bare (id uuid PRIMARY KEY);
`;

const WRAPPED_WITH_POSTCONDITION = `BEGIN;
CREATE TABLE public.thing (id uuid PRIMARY KEY);
COMMIT;

-- Postconditions (separate transaction).
DO $$
BEGIN
  IF to_regclass('public.thing') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: thing missing';
  END IF;
END $$;
`;

function disk(entries: Array<[string, string]>) {
  return entries.map(([filename, sql]) => ({ filename, sql }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORDER
// ─────────────────────────────────────────────────────────────────────────────

describe("ordering — the canonical chain order", () => {
  it("is byte-wise, not locale-aware", () => {
    // 'B' (0x42) sorts BEFORE 'a' (0x61) byte-wise. Every locale-aware collator
    // in Node's ICU does the opposite. If the comparator ever becomes
    // localeCompare, this flips.
    assert.equal(compareMigrationFilenames("B.sql", "a.sql"), -1);
    assert.ok("B.sql".localeCompare("a.sql") > 0, "premise: ICU puts 'a' first");
    assert.deepEqual(orderMigrations(["a.sql", "B.sql"]), ["B.sql", "a.sql"]);
  });

  it("places the 8-digit dated convention where a length-blind compare puts it", () => {
    // This is the case migrationPrefixRules.ts exists to keep unambiguous:
    // "20260720…" < "2059…" < "2100…" byte-wise, because the second character
    // decides. The applier must agree with every auditor in the repo.
    assert.deepEqual(
      orderMigrations([
        "2253_z.sql",
        "0010_a.sql",
        "2100_m.sql",
        "20260720_d.sql",
        "2059_c.sql",
      ]),
      [
        "0010_a.sql",
        "20260720_d.sql",
        "2059_c.sql",
        "2100_m.sql",
        "2253_z.sql",
      ],
    );
  });

  it("is stable and idempotent", () => {
    const input = ["2101_b.sql", "2100_a.sql", "2102_c.sql"];
    const once = orderMigrations(input);
    assert.deepEqual(orderMigrations(once), once);
    assert.deepEqual(input, ["2101_b.sql", "2100_a.sql", "2102_c.sql"], "input not mutated");
  });

  it("matches the order every other reader in this repo computes", () => {
    // checkMigrationPrefixes.ts, checkMissingLiveColumns.ts and
    // auditMigrationsVsLive.ts all use readdirSync(...).filter(.sql).sort().
    // An applier that disagreed with the auditors would be applying a chain
    // nothing else believes in.
    const auditorOrder = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    assert.deepEqual(listMigrationFiles(MIGRATIONS_DIR), auditorOrder);
    assert.ok(auditorOrder.length > 300, "premise: the canonical tree is populated");
  });

  it("refuses a PENDING set whose relative order is undefined", () => {
    const problems = assertUnambiguousOrder(["2300_a.sql", "2300_b.sql", "2301_c.sql"]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /prefix 2300/);
    assert.match(problems[0], /2300_a\.sql, 2300_b\.sql/);
  });

  it("accepts a pending set with distinct prefixes", () => {
    assert.deepEqual(assertUnambiguousOrder(["2300_a.sql", "2301_b.sql"]), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. IDEMPOTENCE
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotence — skip anything already in the ledger", () => {
  const files = disk([
    ["2300_a.sql", WRAPPED],
    ["2301_b.sql", BARE],
    ["2302_c.sql", WRAPPED],
  ]);

  it("plans every file when the ledger is empty", () => {
    const plan = planApply(files, []);
    assert.deepEqual(plan.pending, ["2300_a.sql", "2301_b.sql", "2302_c.sql"]);
    assert.deepEqual(plan.skipped, []);
  });

  it("plans nothing when the ledger already accounts for every file", () => {
    const ledger = files.map((f) => proven(f.filename, f.sql));
    const plan = planApply(files, ledger);
    assert.deepEqual(plan.pending, [], "a re-run must be a no-op");
    assert.deepEqual(plan.skipped, ["2300_a.sql", "2301_b.sql", "2302_c.sql"]);
  });

  it("plans only the gap when the ledger is partial, and keeps canonical order", () => {
    const plan = planApply(files, [proven("2301_b.sql", BARE)]);
    assert.deepEqual(plan.pending, ["2300_a.sql", "2302_c.sql"]);
    assert.deepEqual(plan.skipped, ["2301_b.sql"]);
  });

  it("PROVES the no-op end to end: apply, re-plan, nothing is attempted", async () => {
    // Round one: an empty ledger, a fake applier that records what it was asked
    // to run and appends the ledger rows the SQL would have written.
    const ledger: Array<{ filename: string; checksum: string; applied_by: string }> = [];
    const attempts: string[] = [];
    const read = (f: string) => files.find((x) => x.filename === f)!.sql;

    const outcomes = await runPlan(
      planApply(files, ledger).pending,
      read,
      async (filename, _stmt, phase) => {
        if (phase === "apply") {
          attempts.push(filename);
          ledger.push(proven(filename, read(filename)));
        }
      },
      { appliedBy: "ci", notes: "test" },
    );
    assert.equal(outcomes.length, 3);
    assert.deepEqual(attempts, ["2300_a.sql", "2301_b.sql", "2302_c.sql"]);
    assert.equal(decideExitCode(outcomes), 0);

    // Round two: same tree, the ledger round one produced.
    attempts.length = 0;
    const second = await runPlan(
      planApply(files, ledger).pending,
      read,
      async (filename) => {
        attempts.push(filename);
      },
      { appliedBy: "ci", notes: "test" },
    );
    assert.deepEqual(second, [], "second run planned nothing");
    assert.deepEqual(attempts, [], "second run TOUCHED NOTHING");
    assert.equal(decideExitCode(second), 0);
  });

  it("reports a checksum mismatch as drift, and never as pending", () => {
    const plan = planApply(files, [
      { filename: "2300_a.sql", checksum: "0".repeat(64), applied_by: "ci" },
    ]);
    assert.deepEqual(plan.drifted.map((d) => d.filename), ["2300_a.sql"]);
    assert.ok(
      !plan.pending.includes("2300_a.sql"),
      "a drifted file must not be silently re-applied over a schema it cannot account for",
    );
  });

  it("reports ledger rows whose file is gone from disk", () => {
    const plan = planApply(files, [
      { filename: "9999_vanished.sql", checksum: "x", applied_by: "backfill" },
    ]);
    assert.deepEqual(plan.orphaned, ["9999_vanished.sql"]);
  });

  it("checksums the exact bytes, so whitespace is a different file", () => {
    assert.notEqual(checksumOf(WRAPPED), checksumOf(WRAPPED + "\n"));
    assert.equal(checksumOf(WRAPPED), checksumOf(WRAPPED));
    assert.match(checksumOf(WRAPPED), /^[0-9a-f]{64}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. PROVENANCE — a ledger ROW is not the same thing as an APPLY
// ─────────────────────────────────────────────────────────────────────────────

describe("provenance — 2254's backfill rows are not proof of an apply", () => {
  /**
   * THE DEFECT THIS PREVENTS. 2254_schema_migration_ledger.sql seeds a row for
   * EVERY filename that existed when it ran — including 2220, 2222, 2223, 2224,
   * 2250, 2251, 2252 and 2253, the files that had never been applied. Its own
   * table comment says those rows "are NOT evidence that the file was applied".
   * An applier that skipped on row-presence would skip those six forever, apply
   * nothing, and leave CI (live DB) red on main for the original reason.
   */
  it("classifies a backfill row as NOT proof", () => {
    assert.equal(isProofOfApply(backfilled("2220_x.sql")), false);
  });

  it("classifies an applier-written row as proof", () => {
    assert.equal(isProofOfApply(proven("2220_x.sql", BARE)), true);
    assert.equal(
      isProofOfApply({ filename: "x", checksum: checksumOf(BARE), applied_by: "manual" }),
      true,
    );
  });

  it("requires BOTH a real provenance and a real sha256", () => {
    assert.equal(
      isProofOfApply({ filename: "x", checksum: "backfill", applied_by: "ci" }),
      false,
      "a well-provenanced row with a sentinel checksum proves nothing about content",
    );
    assert.equal(
      isProofOfApply({ filename: "x", checksum: checksumOf(BARE), applied_by: "backfill" }),
      false,
    );
    assert.equal(
      isProofOfApply({ filename: "x", checksum: "ABCD".repeat(16), applied_by: "ci" }),
      false,
      "uppercase hex is not the documented form (64 LOWERCASE hex chars)",
    );
  });

  it("does NOT skip a backfilled file, and does NOT silently apply it either", () => {
    const files = disk([["2220_x.sql", WRAPPED]]);
    const plan = planApply(files, [backfilled("2220_x.sql")]);
    assert.deepEqual(plan.skipped, [], "a backfill row must not count as applied");
    assert.deepEqual(plan.pending, [], "replaying it unasked is the destructive direction");
    assert.deepEqual(plan.unproven, ["2220_x.sql"]);
  });

  it("never reports drift for a backfill row", () => {
    // Comparing a sha256 against the literal 'backfill' would report ~380 false
    // mismatches and take the applier permanently red.
    const files = disk([["2220_x.sql", WRAPPED]]);
    const plan = planApply(files, [backfilled("2220_x.sql")]);
    assert.deepEqual(plan.drifted, []);
  });

  it("applies an unproven file only when it is named explicitly", () => {
    const files = disk([
      ["2220_x.sql", WRAPPED],
      ["2223_y.sql", BARE],
    ]);
    const ledger = [backfilled("2220_x.sql"), backfilled("2223_y.sql")];
    const plan = planApply(files, ledger, ["2223_y.sql"]);
    assert.deepEqual(plan.pending, ["2223_y.sql"]);
    assert.deepEqual(plan.unproven, ["2220_x.sql"]);
  });

  it("upgrades the row in place rather than leaving the backfill standing", () => {
    const stmt = buildApplyStatement({
      filename: "2220_x.sql",
      body: "SELECT 1;",
      checksum: checksumOf(WRAPPED),
      appliedBy: "ci",
      notes: "n",
    });
    assert.match(stmt, /ON CONFLICT \(filename\) DO UPDATE SET/);
    assert.match(stmt, /checksum\s+= EXCLUDED\.checksum/);
    assert.match(stmt, /applied_by\s+= EXCLUDED\.applied_by/);
    // DO NOTHING would leave applied_by='backfill' after a real apply, so the
    // same file would be offered as unproven on every subsequent run.
    assert.ok(!/ON CONFLICT[\s\S]*DO NOTHING/.test(stmt));
  });

  it("writes an applied_by the ledger's CHECK constraint accepts", () => {
    // schema_migration_ledger_applied_by_check: applied_by IN ('ci','manual','backfill').
    for (const appliedBy of ["ci", "manual"]) {
      const stmt = buildApplyStatement({
        filename: "2220_x.sql",
        body: "SELECT 1;",
        checksum: checksumOf(WRAPPED),
        appliedBy,
        notes: "n",
      });
      assert.match(stmt, new RegExp(`'${appliedBy}'`));
    }
  });

  it("--apply-unproven parses a list and is never a bare switch", () => {
    assert.deepEqual(parseApplyUnproven(["node", "x", "--apply-unproven", "a.sql,b.sql"]), [
      "a.sql",
      "b.sql",
    ]);
    assert.deepEqual(parseApplyUnproven(["node", "x", "--apply-unproven"]), []);
    assert.deepEqual(parseApplyUnproven(["node", "x", "--apply-unproven", "--dry-run"]), []);
    assert.deepEqual(parseApplyUnproven(["node", "x"]), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. STOP AT THE FIRST FAILURE
// ─────────────────────────────────────────────────────────────────────────────

describe("stop-on-failure — later migrations are not attempted", () => {
  const five = disk([
    ["2300_a.sql", BARE],
    ["2301_b.sql", BARE],
    ["2302_c.sql", BARE],
    ["2303_d.sql", BARE],
    ["2304_e.sql", BARE],
  ]);
  const read = (f: string) => five.find((x) => x.filename === f)!.sql;

  it("stops at the failing file and attempts nothing after it", async () => {
    const attempts: string[] = [];
    const outcomes = await runPlan(
      five.map((f) => f.filename),
      read,
      async (filename) => {
        attempts.push(filename);
        if (filename === "2302_c.sql") throw new Error("relation does not exist");
      },
      { appliedBy: "ci", notes: "t" },
    );
    assert.deepEqual(attempts, ["2300_a.sql", "2301_b.sql", "2302_c.sql"]);
    assert.deepEqual(
      outcomes.map((o) => `${o.filename}:${o.status}`),
      ["2300_a.sql:applied", "2301_b.sql:applied", "2302_c.sql:failed"],
    );
    assert.match(outcomes[2].detail ?? "", /relation does not exist/);
    assert.equal(decideExitCode(outcomes), 1);
  });

  it("stops at a REFUSED file without attempting it at all", async () => {
    const withRefusal = disk([
      ["2300_a.sql", BARE],
      ["2301_b.sql", "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\n"], // SQL after COMMIT
      ["2302_c.sql", BARE],
    ]);
    const attempts: string[] = [];
    const outcomes = await runPlan(
      withRefusal.map((f) => f.filename),
      (f) => withRefusal.find((x) => x.filename === f)!.sql,
      async (filename) => {
        attempts.push(filename);
      },
      { appliedBy: "ci", notes: "t" },
    );
    assert.deepEqual(attempts, ["2300_a.sql"], "the refused file was never sent");
    assert.equal(outcomes.at(-1)!.status, "refused");
    assert.equal(decideExitCode(outcomes), 1);
  });

  it("a postcondition failure stops the run and is NOT reported as 'failed'", async () => {
    const withPost = disk([
      ["2300_a.sql", WRAPPED_WITH_POSTCONDITION],
      ["2301_b.sql", BARE],
    ]);
    const phases: string[] = [];
    const outcomes = await runPlan(
      withPost.map((f) => f.filename),
      (f) => withPost.find((x) => x.filename === f)!.sql,
      async (filename, _stmt, phase) => {
        phases.push(`${filename}:${phase}`);
        if (phase === "postcondition") throw new Error("POSTCONDITION FAILED: thing missing");
      },
      { appliedBy: "ci", notes: "t" },
    );
    assert.deepEqual(phases, ["2300_a.sql:apply", "2300_a.sql:postcondition"]);
    assert.equal(
      outcomes.at(-1)!.status,
      "postcondition-failed",
      "the migration DID apply and IS recorded; calling that 'failed' would send " +
        "the next operator looking for a rollback that is not needed",
    );
    assert.equal(decideExitCode(outcomes), 1);
  });

  it("decideExitCode is 0 only when every outcome applied", () => {
    assert.equal(decideExitCode([]), 0);
    assert.equal(decideExitCode([{ filename: "a", status: "applied" }]), 0);
    assert.equal(decideExitCode([{ filename: "a", status: "refused" }]), 1);
    assert.equal(decideExitCode([{ filename: "a", status: "failed" }]), 1);
    assert.equal(
      decideExitCode([
        { filename: "a", status: "applied" },
        { filename: "b", status: "postcondition-failed" },
      ]),
      1,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. TRANSACTION / LEDGER ATOMICITY
// ─────────────────────────────────────────────────────────────────────────────

describe("atomicity — one transaction per migration, ledger row inside it", () => {
  it("puts the ledger INSERT after the body and before the COMMIT", () => {
    const stmt = buildApplyStatement({
      filename: "2300_a.sql",
      body: "CREATE TABLE public.thing (id uuid);",
      checksum: "abc",
      appliedBy: "ci",
      notes: "n",
    });
    const iBegin = stmt.indexOf("BEGIN;");
    const iBody = stmt.indexOf("CREATE TABLE");
    const iInsert = stmt.indexOf(`INSERT INTO ${LEDGER_TABLE}`);
    const iCommit = stmt.lastIndexOf("COMMIT;");
    assert.ok(iBegin >= 0 && iBody > iBegin, "body follows BEGIN");
    assert.ok(iInsert > iBody, "ledger INSERT follows the body");
    assert.ok(iCommit > iInsert, "COMMIT follows the ledger INSERT");
  });

  it("emits exactly one top-level BEGIN and one top-level COMMIT", () => {
    // Classification is a union and only the applicable arms carry a `body`.
    // Reading it unnarrowed would have handed buildApplyStatement `undefined`
    // for a refused migration and still counted the wrapper's own BEGIN/COMMIT.
    const classified = classifyMigration(WRAPPED, "2300_a.sql");
    assert.ok(
      classified.kind !== "refuse",
      `WRAPPED must be applicable: ${JSON.stringify(classified)}`,
    );
    const stmt = buildApplyStatement({
      filename: "2300_a.sql",
      body: classified.body,
      checksum: "abc",
      appliedBy: "ci",
      notes: "n",
    });
    const tcl = findTransactionStatements(stmt);
    assert.deepEqual(
      tcl.map((t) => t.keyword),
      ["BEGIN", "COMMIT"],
      "an interior COMMIT would commit the outer transaction early and leave " +
        "the ledger INSERT outside it — the 'applied but unrecorded' state",
    );
  });

  it("strips a file's own BEGIN/COMMIT wrapper rather than nesting it", () => {
    const cls = classifyMigration(WRAPPED, "2300_a.sql");
    assert.equal(cls.kind, "unwrapped");
    assert.deepEqual(findTransactionStatements(cls.body), []);
    assert.match(cls.body, /CREATE TABLE public\.thing/);
  });

  it("leaves a bare file alone", () => {
    const cls = classifyMigration(BARE, "2301_b.sql");
    assert.equal(cls.kind, "bare");
    assert.equal(cls.body, BARE);
    assert.equal(cls.postconditions, "");
  });

  it("SQL-escapes single quotes in the ledger values", () => {
    const stmt = buildApplyStatement({
      filename: "2300_a.sql",
      body: "SELECT 1;",
      checksum: "abc",
      appliedBy: "ci",
      notes: "it's fine",
    });
    assert.match(stmt, /'it''s fine'/);
  });
});

describe("transaction-control parsing", () => {
  it("ignores COMMIT inside a line comment", () => {
    assert.deepEqual(findTransactionStatements("-- COMMIT;\nSELECT 1;"), []);
  });

  it("ignores COMMIT inside a block comment", () => {
    assert.deepEqual(findTransactionStatements("/* COMMIT; */ SELECT 1;"), []);
  });

  it("ignores COMMIT inside a string literal", () => {
    assert.deepEqual(findTransactionStatements("SELECT 'COMMIT;';"), []);
  });

  it("ignores BEGIN/COMMIT inside a dollar-quoted body", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $fn$
BEGIN
  RAISE NOTICE 'COMMIT';
END
$fn$ LANGUAGE plpgsql;`;
    assert.deepEqual(findTransactionStatements(sql), []);
  });

  it("does not mistake a non-statement-initial keyword for transaction control", () => {
    assert.deepEqual(findTransactionStatements("SELECT begin_at FROM t;"), []);
  });

  it("reports real top-level statements with their line numbers", () => {
    const tcl = findTransactionStatements("BEGIN;\nSELECT 1;\nCOMMIT;\n");
    assert.deepEqual(tcl, [
      { keyword: "BEGIN", line: 1 },
      { keyword: "COMMIT", line: 3 },
    ]);
  });

  it("maskNonCode preserves offsets and line count", () => {
    const src = "SELECT 'aaa'; -- x\nSELECT 1;";
    const masked = maskNonCode(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked.split("\n").length, src.split("\n").length);
    assert.ok(!masked.includes("aaa"));
  });
});

describe("refusals — shapes that cannot be applied atomically", () => {
  const refusalCases: Array<[string, string, RegExp]> = [
    [
      "an interior COMMIT",
      "BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;\n",
      /transaction-control statements this script will not interpret/,
    ],
    [
      "a top-level ROLLBACK",
      "BEGIN;\nSELECT 1;\nROLLBACK;\n",
      /top-level ROLLBACK/,
    ],
    [
      "a SAVEPOINT",
      "BEGIN;\nSAVEPOINT s;\nCOMMIT;\n",
      /top-level SAVEPOINT/,
    ],
    [
      "START TRANSACTION",
      "START TRANSACTION;\nSELECT 1;\nCOMMIT;\n",
      /transaction-control statements this script will not interpret/,
    ],
    [
      "CREATE INDEX CONCURRENTLY",
      "CREATE INDEX CONCURRENTLY i ON t (c);\n",
      /CONCURRENTLY/,
    ],
    [
      "an empty file",
      "-- nothing but a comment\n",
      /contains no SQL/,
    ],
    [
      "SQL before the opening BEGIN",
      "SELECT 1;\nBEGIN;\nSELECT 2;\nCOMMIT;\n",
      /SQL BEFORE its opening BEGIN/,
    ],
    [
      "a non-assertion statement after the COMMIT",
      "BEGIN;\nSELECT 1;\nCOMMIT;\nCREATE TABLE t (id int);\n",
      /not a postcondition/,
    ],
    [
      "a MUTATING DO block after the COMMIT",
      "BEGIN;\nSELECT 1;\nCOMMIT;\nDO $$ BEGIN CREATE TABLE t (id int); END $$;\n",
      /contains a schema-changing statement/,
    ],
  ];

  for (const [label, sql, pattern] of refusalCases) {
    it(`refuses ${label}`, () => {
      const cls = classifyMigration(sql, "2300_x.sql");
      assert.equal(cls.kind, "refuse", `expected a refusal for: ${label}`);
      assert.match(cls.reason, pattern);
      assert.match(cls.reason, /2300_x\.sql/, "the refusal names the file");
    });
  }

  it("does NOT refuse a CONCURRENTLY mentioned only in a comment", () => {
    // 0186_geo_indexes.sql does exactly this.
    const cls = classifyMigration(
      "-- CREATE INDEX CONCURRENTLY (run outside a transaction)\nCREATE INDEX i ON t (c);\n",
      "0186_geo_indexes.sql",
    );
    assert.equal(cls.kind, "bare");
  });
});

describe("the postcondition convention (BEGIN … COMMIT; then DO assertions)", () => {
  it("accepts it and keeps the assertions OUT of the applying transaction", () => {
    const cls = classifyMigration(WRAPPED_WITH_POSTCONDITION, "2224_route_hop_signal.sql");
    assert.equal(cls.kind, "unwrapped");
    assert.match(cls.body, /CREATE TABLE public\.thing/);
    assert.ok(!/RAISE EXCEPTION/.test(cls.body), "the assertion is not in the body");
    assert.match(cls.postconditions, /RAISE EXCEPTION/);
  });

  it("analyseTail accepts an assertion-only DO block", () => {
    assert.deepEqual(
      analyseTail("DO $$ BEGIN IF false THEN RAISE EXCEPTION 'x'; END IF; END $$;"),
      { ok: true },
    );
  });

  it("analyseTail is not fooled by mutation keywords inside string literals", () => {
    // 2224 lists privilege names in a literal: IN ('INSERT','UPDATE','DELETE').
    const tail =
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.role_table_grants " +
      "WHERE privilege_type IN ('INSERT','UPDATE','DELETE')) THEN " +
      "RAISE EXCEPTION 'client can write'; END IF; END $$;";
    assert.deepEqual(analyseTail(tail), { ok: true });
  });

  it("analyseTail rejects a tail whose last statement has no semicolon", () => {
    const v = analyseTail("DO $$ BEGIN RAISE EXCEPTION 'x'; END $$");
    assert.equal(v.ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DRY RUN
// ─────────────────────────────────────────────────────────────────────────────

describe("--dry-run", () => {
  const files = disk([
    ["2300_a.sql", WRAPPED],
    ["2301_b.sql", BARE],
    ["2302_c.sql", WRAPPED_WITH_POSTCONDITION],
  ]);
  const classify = (f: string) =>
    classifyMigration(files.find((x) => x.filename === f)!.sql, f);

  it("lists what would be applied, in order, numbered from 1", () => {
    const out = formatDryRun(planApply(files, []), classify);
    assert.match(out, /NOTHING IS WRITTEN/);
    assert.match(out, /Would apply 3 migration\(s\), IN THIS ORDER/);
    const idxA = out.indexOf("2300_a.sql");
    const idxB = out.indexOf("2301_b.sql");
    const idxC = out.indexOf("2302_c.sql");
    assert.ok(idxA < idxB && idxB < idxC, "listed in canonical order");
    assert.match(out, /1\. 2300_a\.sql/);
    assert.match(out, /3\. 2302_c\.sql/);
  });

  it("labels each file's shape, including postconditions", () => {
    const out = formatDryRun(planApply(files, []), classify);
    assert.match(out, /2301_b\.sql\s+\[shape=bare\]/);
    assert.match(out, /2302_c\.sql\s+\[shape=unwrapped \+postconditions\]/);
  });

  it("says so plainly when there is nothing to do", () => {
    const ledger = files.map((f) => proven(f.filename, f.sql));
    const out = formatDryRun(planApply(files, ledger), classify);
    assert.match(out, /Would apply: NOTHING/);
    assert.match(out, /Proven applied, skipped: 3/);
  });

  it("surfaces a refusal rather than listing it as appliable", () => {
    const bad = disk([["2300_a.sql", "BEGIN;\nSELECT 1;\nROLLBACK;\n"]]);
    const out = formatDryRun(planApply(bad, []), (f) =>
      classifyMigration(bad.find((x) => x.filename === f)!.sql, f),
    );
    assert.match(out, /REFUSED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CONFORMANCE OF THE REAL TREE
// ─────────────────────────────────────────────────────────────────────────────

describe("the canonical tree conforms to what the applier can apply", () => {
  /**
   * Files the applier CANNOT apply, with the reason. Both are long applied, so
   * they sit in the ledger and never enter the pending set — but a NEW file of
   * either shape must fail HERE, in a unit test, rather than at 2am in the
   * live-DB workflow after a merge to main.
   *
   * THIS LIST MAY ONLY SHRINK. Adding to it means adding a migration that
   * cannot be replayed onto a fresh database.
   */
  const KNOWN_UNREPLAYABLE = new Set([
    // A BEGIN/…/ROLLBACK verification probe follows its body.
    "2182_close_authz_rpc_oracle.sql",
    // Two separate BEGIN/COMMIT blocks; the second creates a function.
    "2190_memory_lifecycle_fixes.sql",
  ]);

  it("every canonical migration is either appliable or a known-unreplayable file", () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const refused: string[] = [];
    for (const f of files) {
      const cls = classifyMigration(readFileSync(join(MIGRATIONS_DIR, f), "utf8"), f);
      if (cls.kind === "refuse") refused.push(f);
    }
    const unexpected = refused.filter((f) => !KNOWN_UNREPLAYABLE.has(f));
    assert.deepEqual(
      unexpected,
      [],
      "A new migration has a shape the applier refuses. It cannot be applied " +
        "atomically with its ledger row, so `CI (live DB)` would go red on main " +
        "the moment it merged. Reshape it as `BEGIN; … COMMIT;` with, at most, " +
        "trailing postcondition DO blocks.",
    );
  });

  it("the known-unreplayable list has not gone stale", () => {
    const files = new Set(listMigrationFiles(MIGRATIONS_DIR));
    for (const f of KNOWN_UNREPLAYABLE) {
      assert.ok(files.has(f), `${f} is listed as unreplayable but no longer exists`);
      const cls = classifyMigration(readFileSync(join(MIGRATIONS_DIR, f), "utf8"), f);
      assert.equal(
        cls.kind,
        "refuse",
        `${f} is listed as unreplayable but the applier now accepts it — delete the entry`,
      );
    }
  });

  it("no two canonical files that share a prefix could ever be pending together undetected", () => {
    // The documented collisions (2059, 2089) are both fully applied. This
    // asserts the applier's own ambiguity check sees them if they ever were
    // pending, rather than silently picking an order.
    const problems = assertUnambiguousOrder([
      "2059_content_distribution_stats.sql",
      "2059_stamp_artwork_generation_source_placeholder.sql",
    ]);
    assert.equal(problems.length, 1);
  });
});
