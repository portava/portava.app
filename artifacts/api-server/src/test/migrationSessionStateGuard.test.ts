/**
 * check:migration-session-state — a migration block that runs as its own
 * request must not read state another request left behind.
 *
 * main 2de186f820 (#650), live-DB run 37737811561 stopped at 3974,
 * postcondition-failed: 42P01 relation "pg_temp._k3974_after" does not exist.
 * The applier sends the body and the post-COMMIT postconditions as separate
 * Management API requests (separate sessions); CI's psql replay runs a file in
 * one session and passed it. These tests run the REAL rule over the REAL 3974
 * and 3979 and over synthetic files for each case, with the applier's own
 * classifier (scripts/src/apply-migrations.ts) deciding what runs after the
 * COMMIT.
 *
 * Run: node --import tsx/esm --test src/test/migrationSessionStateGuard.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSessionStateFindings,
  separateRequestBlocks,
  type MigrationClassifier,
} from "../scripts/lib/migrationSessionState.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dir, "../..");
const MIGRATIONS = resolve(__dir, "../migrations");
const CHECKER = resolve(__dir, "../scripts/checkMigrationSessionState.ts");
const APPLIER = resolve(__dir, "../../../../scripts/src/apply-migrations.ts");
const { classifyMigration } = (await import(APPLIER)) as { classifyMigration: MigrationClassifier };

const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const scan = (sql: string, file = "9999_fixture.sql") => findSessionStateFindings(file, sql, classifyMigration).findings;
const rules = (sql: string) => scan(sql).map((f) => `${f.rule}:${f.name}`);

const BODY_TEMP = `BEGIN;
DO $mig$
DECLARE n int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _kx_after (what text PRIMARY KEY, n int);
  EXECUTE 'SELECT 1';
  INSERT INTO _kx_after VALUES ('k', 1);
END
$mig$;
COMMIT;
`;

describe("3974 — the incident — and 3979, its re-issue", () => {
  it("3974's post-COMMIT postcondition is caught: it reads the temp table its body made, in the applier's separate request", () => {
    const fs = scan(read("3974_trip_kernel_admin_restore_participant.sql"), "3974_trip_kernel_admin_restore_participant.sql");
    const temp = fs.find((f) => f.rule === "temp-table" && f.name === "_k3974_after");
    assert.ok(temp, `expected the _k3974_after finding, got ${JSON.stringify(fs)}`);
    assert.ok(temp.runBy.includes("applier post-phase"), "the live applier's phase 2 is what sent it");
    assert.ok(temp.line > 230, "the block after the COMMIT, not the body");
  });

  it("3974's untagged $base$ already-applied guard is caught too (certify stage 4 re-runs it after the commit)", () => {
    const fs = scan(read("3974_trip_kernel_admin_restore_participant.sql"));
    assert.ok(fs.some((f) => f.rule === "second-apply-guard" && f.name === "not idempotent by design" && f.runBy.join() === "certify stage 4"));
  });

  it("3979 has no finding: its postcondition recomputes from the catalog and its precondition is $pre$", () => {
    assert.deepEqual(scan(read("3979_trip_kernel_admin_restore_participant_reissue.sql")), []);
    const blocks = separateRequestBlocks(read("3979_trip_kernel_admin_restore_participant_reissue.sql"), "3979.sql", classifyMigration);
    assert.equal(blocks.length, 1, "only $post$ is sent on its own; $pre$ is held back and $mig$ is not assertion-only");
    assert.deepEqual(blocks[0].runBy, ["applier post-phase", "certify stage 4"]);
  });
});

describe("temp tables", () => {
  it("a post-COMMIT block reading the body's temp table by bare name is a finding", () => {
    assert.deepEqual(rules(BODY_TEMP + `DO $post$ BEGIN IF (SELECT n FROM _kx_after) <> 1 THEN RAISE EXCEPTION 'x'; END IF; END $post$;\n`), ["temp-table:_kx_after"]);
  });

  it("naming it through pg_temp is a finding even when no CREATE is visible", () => {
    assert.deepEqual(
      rules(`BEGIN;\nSELECT 1;\nCOMMIT;\nDO $post$ BEGIN IF (SELECT count(*) FROM pg_temp._elsewhere) > 0 THEN RAISE EXCEPTION 'x'; END IF; END $post$;\n`),
      ["temp-table:_elsewhere"],
    );
  });

  it("a block that probes for the table first (3390/3460/3504's shape) is not", () => {
    assert.deepEqual(
      rules(BODY_TEMP + `DO $post$ BEGIN IF to_regclass('pg_temp._kx_after') IS NOT NULL THEN IF (SELECT n FROM _kx_after) <> 1 THEN RAISE EXCEPTION 'x'; END IF; END IF; END $post$;\n`),
      [],
    );
  });

  it("an in-body assertion block reading a temp table is a finding as well: certify stage 4 re-runs it on its own", () => {
    const fs = scan(`BEGIN;\nCREATE TEMP TABLE _snap ON COMMIT DROP AS SELECT 1 AS n;\nDO $chk$ BEGIN IF (SELECT n FROM _snap) <> 1 THEN RAISE EXCEPTION 'x'; END IF; END $chk$;\nCOMMIT;\n`);
    assert.deepEqual(fs.map((f) => [f.rule, f.name, f.runBy.join()]), [["temp-table", "_snap", "certify stage 4"]]);
  });

  it("a block that writes (EXECUTE) runs inside the applying transaction, so its temp reads are not findings", () => {
    assert.deepEqual(rules(`BEGIN;\nCREATE TEMP TABLE _t (n int) ON COMMIT DROP;\nDO $w$ BEGIN EXECUTE 'SELECT 1'; PERFORM n FROM _t; RAISE NOTICE 'x'; END $w$;\nCOMMIT;\n`), []);
  });

  it("a file with no BEGIN/COMMIT has no applier post-phase, but certify still re-runs its assertion blocks", () => {
    const fs = scan(`CREATE TEMP TABLE _b (n int);\nDO $$ BEGIN IF (SELECT count(*) FROM _b) > 0 THEN RAISE EXCEPTION 'x'; END IF; END $$;\n`);
    assert.deepEqual(fs.map((f) => [f.rule, f.runBy.join()]), [["temp-table", "certify stage 4"]]);
  });
});

describe("session settings", () => {
  it("a setting the body stores and a separate block reads is a finding (2745's shape)", () => {
    assert.deepEqual(
      rules(`BEGIN;\nDO $a$ BEGIN PERFORM set_config('portava.mx_before', '3', true); END $a$;\nCOMMIT;\nDO $post$ BEGIN IF current_setting('portava.mx_before', true) IS NULL THEN RAISE EXCEPTION 'x'; END IF; END $post$;\n`),
      ["session-guc:portava.mx_before"],
    );
  });

  it("a setting the block sets for itself is not (3978's postcondition shape)", () => {
    assert.deepEqual(
      rules(`BEGIN;\nSELECT 1;\nCOMMIT;\nDO $post$ BEGIN PERFORM set_config('request.jwt.claim.sub', 'x', true); IF current_setting('request.jwt.claim.sub', true) = '' THEN RAISE EXCEPTION 'x'; END IF; END $post$;\n`),
      [],
    );
  });

  it("reading a setting the file never sets is not this rule's business", () => {
    assert.deepEqual(rules(`BEGIN;\nSELECT 1;\nCOMMIT;\nDO $post$ BEGIN IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'x'; END IF; END $post$;\n`), []);
  });
});

describe("already-applied guards", () => {
  const guard = (tag: string) =>
    `BEGIN;\nDO ${tag} BEGIN IF true THEN RAISE EXCEPTION 'x: already present; this migration is not idempotent by design'; END IF; END ${tag};\nSELECT 1;\nCOMMIT;\n`;

  it("untagged, certify stage 4 re-runs it after the commit — a finding", () => {
    assert.deepEqual(rules(guard("$base$")), ["second-apply-guard:not idempotent by design"]);
  });

  it("tagged $pre$, it is held back — not a finding", () => {
    assert.deepEqual(rules(guard("$pre$")), []);
  });
});

describe("the checker over the real tree", () => {
  it("exits 0, names the skipped 3974 and the three KNOWN applied files, and states what it inspected", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], { cwd: PKG, encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /3974_trip_kernel_admin_restore_participant\.sql: SKIPPED by ORDER_OVERRIDES\.json \(never run; superseded by 3979_/);
    for (const f of ["2570_", "2745_", "2798_"]) assert.match(run.stdout, new RegExp(`KNOWN ${f}`));
    const m = /PASSED — (\d+) separately-run block\(s\) inspected/.exec(run.stdout);
    assert.ok(m && Number(m[1]) > 600, run.stdout);
  });

  it("exits 1 on a tree carrying 3974's shape, and on KNOWN entries whose finding is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-state-"));
    try {
      writeFileSync(join(dir, "ORDER_OVERRIDES.json"), JSON.stringify({ overrides: [] }));
      writeFileSync(
        join(dir, "3999_fixture.sql"),
        BODY_TEMP + `DO $post$ BEGIN IF (SELECT b.n FROM pg_temp._kx_after b) <> 1 THEN RAISE EXCEPTION 'x'; END IF; END $post$;\n`,
      );
      const run = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
        cwd: PKG,
        encoding: "utf8",
        env: { ...process.env, MIGRATION_SESSION_STATE_DIR: dir },
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /3999_fixture\.sql:\d+ \(applier post-phase \+ certify stage 4\) reads temp table "_kx_after"/);
      assert.match(run.stderr, /STALE KNOWN entry 2570_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
