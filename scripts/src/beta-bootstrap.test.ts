/**
 * beta-bootstrap.test.ts — unit tests over the beta bootstrap's PURE logic:
 * the statement split of the real baseline, the skip rules and their measured
 * counts, dollar-tag selection, batching, the ledger backfill set and the 2254
 * DDL extraction, the reference snapshot's projection / FK-nulling /
 * flag-forcing / allowlist, and the emptiness decision.
 *
 * NO DATABASE, NO NETWORK, NO CREDENTIALS. Everything imported here is a
 * parser, a planner or a SQL-text builder; beta-bootstrap.ts and
 * beta-reference-snapshot.ts only reach the guard and the network under
 * RUN_DIRECTLY, which is false when this file is the entry point.
 *
 * The measured numbers are pinned on purpose. A refreshed baseline that moves
 * any of them must turn this red, so a human re-reads the skip rules against
 * the new dump instead of a statement silently changing rule.
 *
 * Run:
 *   pnpm --dir scripts run test:beta-bootstrap
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BASELINE_PATH,
  BASELINE_SHAPE,
  BATCH_PRELUDE,
  BATCH_SIZE,
  BETA_PROJECT_REF,
  CHAIN_START_PREFIX,
  EXCLUDED_REFERENCE_TABLES,
  EXTENSION_CENSUS,
  FORCED_VALUES,
  LEDGER_MIGRATION_FILE,
  PRODUCTION_PROJECT_REF,
  REFERENCE_PUBLIC_TABLES,
  REFERENCE_ROW_CAP,
  REPO_ROOT,
  SNAPSHOT_FORMAT,
  TOLERATED_SQLSTATES,
  assertAllowlisted,
  assertReadOnlySelect,
  boolField,
  MANUAL_VERIFICATION,
  buildManualApplySql,
  buildManualLedgerInsertSql,
  buildProbeSql,
  planManualApply,
  firstSentence,
  jsonField,
  refusedChainFiles,
  unrecordedPredecessors,
  backfillFilenames,
  baselineShapeProblems,
  buildBaselineModel,
  buildBatchQuery,
  buildLedgerPrecreationSql,
  buildReadingRoleSql,
  buildReferenceImportSql,
  buildResetSql,
  buildRunFunctionSql,
  buildSnapshotCountSql,
  buildSnapshotSelectSql,
  chooseDollarTag,
  classifyBaselineStatement,
  decideEmptiness,
  diffMultiset,
  extensionCensusProblems,
  extractLedgerDdl,
  isSafeDollarTag,
  lastResultRows,
  loadBaselineModel,
  measureBaselineShape,
  parseRunFailureOrdinal,
  planBatches,
  planReferenceTables,
  resolveProjectRef,
  splitTopLevelStatements,
  validateSnapshot,
  chainApplyOrder,
  loadChainSource,
  withoutChainSeededRows,
  type ChainSource,
  type EmptinessState,
  type ReferenceSnapshot,
  type ReferenceTablePlan,
} from "./beta-db-core.js";
import {
  keyText,
  maskForSeedScan,
  otherUniqueKeysInSql,
  plainLiteralValue,
  scanSeedsInSql,
  type SeedTableSpec,
} from "./beta-chain-seeds.js";
import { preBaselineFlagDefinitions, seededFlagPopulation } from "./beta-config-core.js";
import { MIGRATIONS_DIR, checksumOf, compareMigrationFilenames, listMigrationFiles, maskNonCode } from "./apply-migrations.js";
import { bootstrapTargetRefusal, checkRefusedProblems, parseBootstrapArgs } from "./beta-bootstrap.js";
import { missingSourceColumns } from "./beta-reference-snapshot.js";

const BASELINE_SQL = readFileSync(BASELINE_PATH, "utf8");
const model = loadBaselineModel();

// ─────────────────────────────────────────────────────────────────────────────
describe("the baseline splits into 5,200 statements", () => {
  it("splits the real baseline into exactly 5,200 terminated statements", () => {
    const { statements, unterminated } = splitTopLevelStatements(BASELINE_SQL);
    assert.equal(statements.length, 5200);
    assert.equal(unterminated, null, "no code may follow the last top-level semicolon");
  });

  it("measures the longest statement both ways", () => {
    const longestCode = Math.max(...model.statements.map((s) => Buffer.byteLength(s.code, "utf8")));
    assert.equal(longestCode, 11338, "from its first code character");
    // The same statement's raw span between semicolons, including the pg_dump
    // header comment above it — the 11,461 the brief quoted.
    const masked = maskNonCode(BASELINE_SQL);
    let start = 0;
    let longestRaw = 0;
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] !== ";") continue;
      longestRaw = Math.max(longestRaw, Buffer.byteLength(BASELINE_SQL.slice(start, i).trim(), "utf8"));
      start = i + 1;
    }
    assert.equal(longestRaw, 11461);
  });

  it("does not end a statement at a semicolon inside a body, literal or comment", () => {
    const sql = [
      "-- a; comment",
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;",
      "COMMENT ON TABLE public.t IS 'a; b';",
      "/* x; y */ SELECT 1;",
      "SELECT 2",
    ].join("\n");
    const r = splitTopLevelStatements(sql);
    assert.equal(r.statements.length, 3);
    assert.match(r.statements[0].code, /RETURN 1; END \$\$$/);
    assert.equal(r.statements[1].code, "COMMENT ON TABLE public.t IS 'a; b'");
    assert.equal(r.statements[2].code, "SELECT 1");
    assert.equal(r.statements[0].line, 2);
    assert.equal(r.unterminated, "SELECT 2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the skip rules, measured", () => {
  const m = measureBaselineShape(model);

  it("matches BASELINE_SHAPE exactly (the runtime self-check)", () => {
    assert.deepEqual(baselineShapeProblems(model), []);
  });

  it("skips the dump's 13-statement session preamble", () => {
    assert.equal(m.skipped["dump-session-preamble"], 13);
    const pre = model.statements.filter(
      (s) => s.decision.action === "skip" && s.decision.rule === "dump-session-preamble",
    );
    assert.equal(pre.filter((s) => /^SET\s/.test(s.code)).length, 12);
    assert.equal(pre.filter((s) => /^SELECT pg_catalog\.set_config\('search_path', '', false\)$/.test(s.code)).length, 1);
  });

  it("skips exactly CREATE SCHEMA public and CREATE SCHEMA storage", () => {
    const sch = model.statements.filter((s) => s.decision.action === "skip" && s.decision.rule === "platform-schema");
    assert.deepEqual(sch.map((s) => s.code), ["CREATE SCHEMA public", "CREATE SCHEMA storage"]);
  });

  it("skips the 12 ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin, and executes postgres's 12 in public", () => {
    const adm = model.statements.filter(
      (s) => s.decision.action === "skip" && s.decision.rule === "supabase-admin-default-privileges",
    );
    assert.equal(adm.length, 12);
    assert.ok(adm.every((s) => /^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public /.test(s.code)));
    const pg = model.statements.filter(
      (s) => /^ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public /.test(s.code),
    );
    assert.equal(pg.length, 12);
    assert.ok(pg.every((s) => s.decision.action === "execute"));
  });

  it("covers 111 storage-targeted statements: 93 name a storage.* object (4 kept), 18 name the schema", () => {
    const storage = model.statements.filter(
      (s) =>
        (s.decision.action === "skip" && s.decision.rule === "storage-platform-object") ||
        (s.decision.action === "execute" && s.decision.appStoragePolicy),
    );
    assert.equal(storage.length, 111);
    const qualified = storage.filter((s) => /\bstorage\./.test(s.masked));
    assert.equal(qualified.length, 93, "the brief's figure: statements naming a storage.-qualified object");
    const schemaLevel = storage.filter((s) => !/\bstorage\./.test(s.masked));
    assert.equal(schemaLevel.filter((s) => /^GRANT .* ON SCHEMA storage /.test(s.code)).length, 6);
    assert.equal(
      schemaLevel.filter((s) => /^ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage /.test(s.code)).length,
      12,
    );
    assert.equal(m.skipped["storage-platform-object"], 107);
    assert.equal(m.appStoragePolicies, 4);
  });

  it("keeps exactly the four app policies on storage.objects, measured from the baseline", () => {
    const kept = model.policies.filter((p) => p.schema === "storage").map((p) => `${p.table}.${p.name}`).sort();
    assert.deepEqual(kept, [
      "objects.post_media_storage_owner_delete",
      "objects.post_media_storage_owner_insert",
      "objects.stamp_artwork_public_read",
      "objects.stamp_artwork_service_write",
    ]);
  });

  it("executes nothing else that names schema storage in code", () => {
    const leaks = model.statements.filter(
      (s) =>
        s.decision.action === "execute" &&
        !s.decision.appStoragePolicy &&
        /\bstorage\.|\bSCHEMA storage\b/.test(s.masked),
    );
    assert.deepEqual(leaks.map((s) => s.code.slice(0, 80)), []);
  });

  it("executes 5,066 statements and declares 395 tables, 387 of them public", () => {
    assert.equal(m.executed, 5066);
    assert.equal(m.statements - m.executed, 13 + 2 + 107 + 12);
    assert.equal(m.createTableStatements, 395);
    assert.equal(m.publicTables, 387);
    assert.equal([...model.tables.values()].filter((t) => t.schema === "storage").length, 8);
    assert.equal(m.publicPolicies, 737);
    assert.equal(m.publicFunctions, 59);
    assert.equal(m.publicTypes, 69);
    assert.equal(m.publicViews, 10);
    assert.deepEqual({ ...BASELINE_SHAPE.skipped }, { ...m.skipped });
  });

  it("decides individual shapes the way the rules say", () => {
    const d = (sql: string) => classifyBaselineStatement(maskNonCode(sql));
    assert.deepEqual(d("SET statement_timeout = 0"), { action: "skip", rule: "dump-session-preamble" });
    assert.deepEqual(d("CREATE SCHEMA storage"), { action: "skip", rule: "platform-schema" });
    assert.deepEqual(d("CREATE SCHEMA app_private"), { action: "execute", appStoragePolicy: false });
    assert.deepEqual(d("CREATE TABLE storage.objects (id uuid)"), { action: "skip", rule: "storage-platform-object" });
    assert.deepEqual(
      d("CREATE TRIGGER t BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.f()"),
      { action: "skip", rule: "storage-platform-object" },
    );
    assert.deepEqual(
      d("CREATE TRIGGER t AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.f()"),
      { action: "execute", appStoragePolicy: false },
    );
    assert.deepEqual(d("GRANT USAGE ON SCHEMA storage TO anon"), { action: "skip", rule: "storage-platform-object" });
    assert.deepEqual(d("GRANT USAGE ON SCHEMA public TO anon"), { action: "execute", appStoragePolicy: false });
    assert.deepEqual(d('CREATE POLICY "x y" ON storage.objects FOR SELECT USING (true)'), {
      action: "execute",
      appStoragePolicy: true,
    });
    assert.deepEqual(d("CREATE POLICY p ON storage.buckets FOR SELECT USING (true)"), {
      action: "skip",
      rule: "storage-platform-object",
    });
    assert.deepEqual(d("COMMENT ON FUNCTION public.f() IS 'reads storage.objects'"), {
      action: "execute",
      appStoragePolicy: false,
    });
    assert.deepEqual(d("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon"), {
      action: "skip",
      rule: "supabase-admin-default-privileges",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("dollar tags and batches", () => {
  it("avoids a tag present in a statement", () => {
    assert.equal(chooseDollarTag(["SELECT 1", "SELECT $$x$$"], "bb"), "bb");
    assert.equal(chooseDollarTag(["SELECT $bb$x$bb$"], "bb"), "bb1");
    assert.equal(chooseDollarTag(["$bb$", "$bb1$"], "bb"), "bb2");
  });

  it("refuses a tag the statement's tail would complete early", () => {
    assert.equal(isSafeDollarTag("SELECT 'x' AS $bb", "bb"), false, "…$bb + $bb$ closes at the first $bb$");
    assert.equal(isSafeDollarTag("END $$", "bb"), true, "…$$ + $bb$ still closes at the appended delimiter");
    assert.equal(isSafeDollarTag("x", "1bad"), false);
  });

  it("builds ONE SELECT over run() behind the prelude, and round-trips every statement", () => {
    const stmts = ["CREATE TABLE public.a (x int)", "COMMENT ON TABLE public.a IS 'it''s; $bb$'", "SELECT $$;$$"];
    const q = buildBatchQuery(stmts);
    assert.equal(q.tag, "bb1");
    const d = `$${q.tag}$`;
    const top = maskNonCode(q.sql).split(";").map((x) => x.trim()).filter(Boolean);
    assert.equal(top.length, BATCH_PRELUDE.length + 1);
    assert.ok(q.sql.startsWith(BATCH_PRELUDE.join("\n")));
    assert.match(top[top.length - 1], /^SELECT ord, err_code, err_message, stmt_head FROM beta_bootstrap\.run\(ARRAY\[/);
    const inner = q.sql.slice(q.sql.indexOf("ARRAY[\n") + 7, q.sql.lastIndexOf("\n]::text[])"));
    assert.deepEqual(inner.split(`${d},\n${d}`).map((x, i, a) => {
      let s = x;
      if (i === 0) s = s.slice(d.length);
      if (i === a.length - 1) s = s.slice(0, -d.length);
      return s;
    }), stmts);
  });

  it("plans the real baseline as 26 batches of at most 200, each with a safe tag", () => {
    const exec = model.statements.filter((s) => s.decision.action === "execute").map((s) => s.code);
    const batches = planBatches(exec, BATCH_SIZE);
    assert.equal(BATCH_SIZE, 200);
    assert.equal(batches.length, 26);
    assert.ok(batches.every((b) => b.length > 0 && b.length <= 200));
    assert.equal(batches.flat().length, 5066);
    for (const b of batches) {
      const q = buildBatchQuery(b);
      assert.ok(b.every((s) => isSafeDollarTag(s, q.tag)));
    }
  });

  it("creates run() tolerating exactly the four already-exists SQLSTATEs and re-raising the rest", () => {
    assert.deepEqual(Object.keys(TOLERATED_SQLSTATES).sort(), ["42710", "42723", "42P06", "42P07"]);
    const sql = buildRunFunctionSql();
    const when = /WHEN ((?:[a-z_]+ OR )*[a-z_]+) THEN\n\s+GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;/.exec(sql);
    assert.ok(when, "the tolerated-condition handler is missing");
    assert.deepEqual(when[1].split(" OR ").sort(), ["duplicate_function", "duplicate_object", "duplicate_schema", "duplicate_table"]);
    assert.match(sql, /WHEN OTHERS THEN[\s\S]*RAISE EXCEPTION USING[\s\S]*ERRCODE = v_code/);
    assert.match(sql, /SET search_path = ''[\s\S]*SET check_function_bodies = off/);
    assert.equal(parseRunFailureOrdinal("ERROR:  42P01: beta_bootstrap.run: statement #17 of 200 failed [SQLSTATE 42P01]: x"), 17);
    assert.equal(parseRunFailureOrdinal("some other error"), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the ledger pre-creation", () => {
  const files = listMigrationFiles();
  const backfill = backfillFilenames(files);

  it("backfills exactly the 280 files sorting before 2093_ and nothing at or after it", () => {
    assert.equal(CHAIN_START_PREFIX, "2093_");
    assert.equal(backfill.length, 280);
    assert.ok(backfill.every((f) => f < CHAIN_START_PREFIX));
    const rest = files.filter((f) => !backfill.includes(f));
    assert.equal(backfill.length + rest.length, files.length);
    assert.ok(rest.every((f) => f >= CHAIN_START_PREFIX));
    assert.ok(rest[0].startsWith("2093_"), `first chain file is ${rest[0]}`);
    assert.ok(backfill.includes("2092_discovery_shadow_serves.sql"));
    assert.ok(model.tables.has("public.discovery_shadow_serves"), "2092's table is in the baseline");
    assert.ok(rest.includes(LEDGER_MIGRATION_FILE), "2254 is applied later as an ordinary pending file");
  });

  it("uses the same boundary as the local replay", () => {
    const up = readFileSync(join(REPO_ROOT, "artifacts/api-server/scripts/local-db/up.sh"), "utf8");
    const m = /FROM="\$\{LOCAL_DB_FROM:-(\d+)\}"/.exec(up);
    assert.ok(m, "up.sh no longer declares its chain start");
    assert.equal(`${m[1]}_`, CHAIN_START_PREFIX);
  });

  const ddl = extractLedgerDdl(readFileSync(join(MIGRATIONS_DIR, LEDGER_MIGRATION_FILE), "utf8"));

  it("extracts 2254's table, CHECK, index, RLS, revokes, grant and comments", () => {
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS public\.schema_migration_ledger \(/);
    assert.match(ddl, /ADD CONSTRAINT schema_migration_ledger_applied_by_check\s+CHECK \(applied_by IN \('ci', 'manual', 'backfill'\)\)/);
    assert.match(ddl, /CREATE INDEX IF NOT EXISTS schema_migration_ledger_applied_at_idx/);
    assert.match(ddl, /ALTER TABLE public\.schema_migration_ledger ENABLE ROW LEVEL SECURITY;/);
    assert.match(ddl, /REVOKE ALL ON TABLE public\.schema_migration_ledger FROM anon;/);
    assert.match(ddl, /REVOKE ALL ON TABLE public\.schema_migration_ledger FROM authenticated;/);
    assert.match(ddl, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.schema_migration_ledger TO service_role;/);
    assert.match(ddl, /COMMENT ON TABLE public\.schema_migration_ledger IS/);
    assert.equal((ddl.match(/COMMENT ON COLUMN public\.schema_migration_ledger\./g) ?? []).length, 2);
  });

  it("carries no INSERT, no BEGIN/COMMIT and not 2254's 382-row postcondition", () => {
    const code = maskNonCode(ddl);
    assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i);
    assert.doesNotMatch(code, /^\s*(BEGIN|COMMIT)\s*;/im);
    assert.doesNotMatch(ddl, /n_backfill/);
    assert.doesNotMatch(ddl, /'0010_trip_plan\.sql'/);
  });

  it("wraps the DDL and one backfill row per file in ONE transaction, in 2254's vocabulary", () => {
    const sql = buildLedgerPrecreationSql(ddl, backfill);
    assert.ok(sql.startsWith("BEGIN;\n") && sql.endsWith("\nCOMMIT;"));
    assert.equal(maskNonCode(sql).match(/^\s*(BEGIN|COMMIT);/gm)?.length, 2);
    assert.match(sql, /SELECT f, 'backfill', 'backfill', 'beta-bootstrap 2026-10-06: covered by baseline\/20260819_baseline_structure\.sql \(\+reference snapshot\); not individually replayed'/);
    assert.match(sql, /ON CONFLICT \(filename\) DO NOTHING;/);
    for (const f of backfill) assert.ok(sql.includes(`'${f}'`), f);
    assert.ok(!sql.includes("'2093_"), "no chain file gets a row");
    assert.throws(() => buildLedgerPrecreationSql(ddl, ["x'; DROP TABLE y; --.sql"]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const FIXTURE = `
CREATE TABLE public.profiles (
    id uuid NOT NULL
);
CREATE TABLE public.places (
    id uuid NOT NULL
);
CREATE TABLE public.feature_flags (
    flag text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    metadata jsonb,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    note text DEFAULT 'a, b NOT NULL'::text,
    owner_id uuid,
    flag_lower text GENERATED ALWAYS AS (lower(flag)) STORED
);
CREATE TABLE public.rent_buddy_city_rollouts (
    id uuid NOT NULL,
    status_changed_by uuid,
    city text NOT NULL
);
CREATE TABLE public.stamp_definitions (
    id uuid NOT NULL,
    place_id uuid
);
CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text NOT NULL,
    owner uuid,
    public boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[]
);
ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (flag);
ALTER TABLE ONLY public.rent_buddy_city_rollouts
    ADD CONSTRAINT rent_buddy_city_rollouts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.stamp_definitions
    ADD CONSTRAINT stamp_definitions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.rent_buddy_city_rollouts
    ADD CONSTRAINT rent_buddy_city_rollouts_status_changed_by_fkey FOREIGN KEY (status_changed_by) REFERENCES public.profiles(id);
ALTER TABLE ONLY public.stamp_definitions
    ADD CONSTRAINT stamp_definitions_place_id_fkey FOREIGN KEY (place_id) REFERENCES public.places(id);
`;

describe("the reference snapshot plan (fixture)", () => {
  const fx = buildBaselineModel(FIXTURE);
  const plans = planReferenceTables(fx, ["feature_flags", "rent_buddy_city_rollouts"]);
  const ff = plans.find((p) => p.table === "feature_flags")!;
  const rb = plans.find((p) => p.table === "rent_buddy_city_rollouts")!;

  it("projects only the baseline's columns, without generated ones", () => {
    assert.deepEqual(ff.columns, ["flag", "enabled", "metadata", "tags", "note", "owner_id"]);
    assert.deepEqual(ff.jsonColumns, ["metadata"]);
    assert.deepEqual(ff.primaryKey, ["flag"]);
    const note = fx.tables.get("public.feature_flags")!.columns.find((c) => c.name === "note")!;
    assert.equal(note.notNull, false, "a NOT NULL inside a default literal is not a constraint");
  });

  it("nulls every column that is an FK to profiles or auth.users", () => {
    assert.deepEqual(Object.keys(ff.nulledColumns), ["owner_id"]);
    assert.deepEqual(Object.keys(rb.nulledColumns), ["status_changed_by"]);
    const sql = buildSnapshotSelectSql(rb);
    assert.match(sql, /NULL::text AS "status_changed_by"/);
    assert.match(sql, /"city"::text AS "city"/);
    assert.doesNotMatch(sql, /"status_changed_by"::text/);
  });

  it("forces feature_flags.enabled to 'false' in the SELECT itself", () => {
    assert.deepEqual(ff.forcedValues, { enabled: "false" });
    assert.deepEqual(FORCED_VALUES.feature_flags, { enabled: "false" });
    const sql = buildSnapshotSelectSql(ff);
    assert.match(sql, /'false'::text AS "enabled"/);
    assert.doesNotMatch(sql, /"enabled"::text/);
    assert.doesNotMatch(sql, /flag_lower/);
    assert.match(sql, /ORDER BY s\."flag"/);
  });

  it("refuses an allowlisted table whose FK points at a table that is not copied", () => {
    assert.throws(() => planReferenceTables(fx, ["stamp_definitions"]), /public\.places/);
  });

  it("refuses an unlisted table everywhere", () => {
    assert.throws(() => assertAllowlisted("public", "profiles"), /not on the reference allowlist/);
    assert.throws(() => planReferenceTables(fx, ["profiles"]), /not on the reference allowlist/);
    const rogue: ReferenceTablePlan = { ...ff, table: "profiles" };
    assert.throws(() => buildSnapshotCountSql(rogue), /not on the reference allowlist/);
    assert.throws(() => buildSnapshotSelectSql(rogue), /not on the reference allowlist/);
    assert.throws(() => buildReferenceImportSql(rogue, []), /not on the reference allowlist/);
    assert.doesNotThrow(() => assertAllowlisted("storage", "buckets"));
    assert.throws(() => assertAllowlisted("storage", "objects"));
  });

  it("sends only read-only single SELECTs", () => {
    for (const p of plans) {
      assert.doesNotThrow(() => assertReadOnlySelect(buildSnapshotCountSql(p)));
      assert.doesNotThrow(() => assertReadOnlySelect(buildSnapshotSelectSql(p)));
    }
    assert.doesNotThrow(() => assertReadOnlySelect(buildReadingRoleSql()));
    assert.throws(() => assertReadOnlySelect("SELECT 1"), /READ ONLY/);
    assert.throws(() => assertReadOnlySelect("SET TRANSACTION READ ONLY;\nSELECT 1; SELECT 2"), /exactly one/);
    assert.throws(() => assertReadOnlySelect("SET TRANSACTION READ ONLY;\nDELETE FROM public.x"), /SELECT/);
    assert.throws(() => assertReadOnlySelect("SET TRANSACTION READ ONLY;\nSELECT * FROM t FOR UPDATE"), /UPDATE/);
    assert.throws(
      () => assertReadOnlySelect("SET TRANSACTION READ ONLY;\nSELECT 1 FROM (SELECT 1) s WHERE EXISTS (SELECT 1) AND $x$ INSERT INTO t VALUES (1) $x$ = ''"),
      /INSERT/,
      "a write hidden in a dollar body is still seen",
    );
  });

  it("imports with ON CONFLICT on the primary key and re-parses json columns", () => {
    const sql = buildReferenceImportSql(ff, [
      { flag: "x", enabled: "false", metadata: '{"n": 12345678901234567890}', tags: "{a,b}", note: null, owner_id: null },
    ]);
    assert.match(sql, /INSERT INTO public\."feature_flags" \("flag", "enabled", "metadata", "tags", "note", "owner_id"\)/);
    assert.match(sql, /ON CONFLICT \("flag"\) DO NOTHING RETURNING 1/);
    assert.match(sql, /jsonb_build_object\('metadata', \(e\.r ->> 'metadata'\)::jsonb\)/);
    assert.match(sql, /jsonb_populate_record\(NULL::public\."feature_flags", e\.r \|\| /);
    assert.match(sql, /SELECT "flag", "enabled", "metadata", "tags", "note", "owner_id" FROM src ON CONFLICT/);
    assert.match(sql, /12345678901234567890/, "big numbers inside jsonb travel as text, untouched");
    const tricky = buildReferenceImportSql(rb, [{ id: "1", status_changed_by: null, city: "$ref$" }]);
    assert.match(tricky, /\$ref1\$\[/, "a payload containing $ref$ gets another tag");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the reference snapshot plan (real baseline)", () => {
  const plans = planReferenceTables(model);

  it("covers the allowlist plus storage.buckets, in a dependency-safe order", () => {
    assert.deepEqual(
      plans.map((p) => `${p.schema}.${p.table}`),
      [...REFERENCE_PUBLIC_TABLES.map((t) => `public.${t}`), "storage.buckets"],
    );
    const buckets = plans[plans.length - 1];
    assert.deepEqual(buckets.columns, ["id", "name", "public", "file_size_limit", "allowed_mime_types"]);
  });

  it("nulls exactly the measured user-id columns and forces exactly feature_flags.enabled", () => {
    const nulled = plans.flatMap((p) => Object.keys(p.nulledColumns).map((c) => `${p.table}.${c}`)).sort();
    assert.deepEqual(nulled, [
      "price_baselines.verified_by",
      "rent_buddy_city_rollouts.status_changed_by",
      "rent_buddy_global_controls.updated_by_admin_id",
    ]);
    const forced = plans.flatMap((p) => Object.entries(p.forcedValues).map(([c, v]) => `${p.table}.${c}=${v}`));
    assert.deepEqual(forced, ["feature_flags.enabled=false"]);
  });

  it("accounts for every uuid column of every allowlisted table", () => {
    for (const p of plans.filter((x) => x.schema === "public")) {
      const t = model.tables.get(`public.${p.table}`)!;
      for (const c of t.columns.filter((x) => x.type === "uuid")) {
        const isKey = p.primaryKey.includes(c.name);
        const isNulled = c.name in p.nulledColumns;
        const fkToAllowlisted = model.foreignKeys.some(
          (fk) =>
            fk.table === `public.${p.table}` &&
            fk.columns.includes(c.name) &&
            (REFERENCE_PUBLIC_TABLES as readonly string[]).includes(fk.refTable.replace(/^public\./, "")),
        );
        assert.ok(isKey || isNulled || fkToAllowlisted, `public.${p.table}.${c.name} is an unclassified uuid`);
      }
    }
  });

  it("excludes place_coverage_buckets, whose primary key is an FK to places", () => {
    assert.ok(!(REFERENCE_PUBLIC_TABLES as readonly string[]).includes("place_coverage_buckets"));
    assert.ok("place_coverage_buckets" in EXCLUDED_REFERENCE_TABLES);
    const fk = model.foreignKeys.find((f) => f.table === "public.place_coverage_buckets");
    assert.equal(fk?.refTable, "public.places");
    assert.deepEqual(model.primaryKeys.get("public.place_coverage_buckets"), ["canonical_place_id", "bucket"]);
  });

  it("names a source column a later migration dropped", () => {
    const live = plans.flatMap((p) => p.columns.map((c) => ({ schema: p.schema, table: p.table, column: c })));
    assert.deepEqual(missingSourceColumns(plans, live), []);
    const minus = live.filter((c) => !(c.table === "feature_flags" && c.column === "metadata"));
    assert.deepEqual(missingSourceColumns(plans, minus), ["public.feature_flags.metadata"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("snapshot validation (the bootstrap's gate on the file)", () => {
  const plans = planReferenceTables(model);
  const good = (): ReferenceSnapshot => ({
    format: SNAPSHOT_FORMAT,
    takenAt: "2026-10-06T00:00:00.000Z",
    sourceProjectRef: "hwokxgbmezheskbzskfr",
    baselineSha256: model.sha256,
    rowCap: REFERENCE_ROW_CAP,
    tables: plans.map((p) => ({
      ...p,
      rowCount: p.table === "feature_flags" ? 1 : 0,
      rows:
        p.table === "feature_flags"
          ? [{ flag: "a", enabled: "false", description: null, updated_at: "2026-10-06 00:00:00+00", metadata: null }]
          : [],
    })),
  });

  it("accepts a well-formed snapshot", () => {
    const s = validateSnapshot(good(), plans, model.sha256);
    assert.equal(s.tables.length, plans.length);
  });

  it("rejects an enabled flag, a non-null nulled column, an extra table, a missing table and a stale baseline", () => {
    const enabled = good();
    enabled.tables[0].rows[0].enabled = "true";
    assert.throws(() => validateSnapshot(enabled, plans, model.sha256), /enabled must be 'false'/);

    const leaked = good();
    const rb = leaked.tables.find((t) => t.table === "rent_buddy_global_controls")!;
    rb.rows = [{ ...Object.fromEntries(rb.columns.map((c) => [c, "1"])), updated_by_admin_id: "00000000-0000-0000-0000-000000000001" }];
    rb.rowCount = 1;
    assert.throws(() => validateSnapshot(leaked, plans, model.sha256), /updated_by_admin_id must be NULL/);

    const extra = good();
    extra.tables.push({ ...extra.tables[0], table: "profiles" });
    assert.throws(() => validateSnapshot(extra, plans, model.sha256), /not on the reference allowlist/);

    const missing = good();
    missing.tables.pop();
    assert.throws(() => validateSnapshot(missing, plans, model.sha256), /storage\.buckets is missing/);

    assert.throws(() => validateSnapshot(good(), plans, "0".repeat(64)), /different baseline/);

    const prod = { ...good(), sourceProjectRef: PRODUCTION_PROJECT_REF };
    assert.throws(() => validateSnapshot(prod, plans, model.sha256), /production/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// beta-db run 38070135058 (2026-10-10) stopped here: the snapshot imported
// layover_crowd_reports_enabled (enabled forced 'false') BEFORE the chain, so
// 3513's `ON CONFLICT (flag) DO NOTHING` kept the imported FALSE row and 3513's
// postcondition ("is not TRUE") rolled the apply back. A RESET rebuild starts
// from an empty schema and would meet it again.
describe("a row the CHAIN seeds is never imported from the snapshot (3513, run 38070135058)", () => {
  const plans = planReferenceTables(model);
  const ff = plans.find((p) => p.table === "feature_flags")!;
  const X = "layover_crowd_reports_enabled";
  const SEEDER = "3513_layover_crowd_reports_flag.sql";
  const PRE_BASELINE = "ACTIVITY_DISCOVERY_BOOST_ENABLED"; // seeded by 2084 only, before CHAIN_START_PREFIX
  const flagRow = (flag: string): Record<string, string | null> => ({
    flag, enabled: "false", description: null, updated_at: "2026-10-06 00:00:00+00", metadata: null,
  });
  const snapshotWith = (rows: Array<Record<string, string | null>>): ReferenceSnapshot => ({
    format: SNAPSHOT_FORMAT,
    takenAt: "2026-10-14T00:00:00.000Z",
    sourceProjectRef: "hwokxgbmezheskbzskfr",
    baselineSha256: model.sha256,
    rowCap: REFERENCE_ROW_CAP,
    tables: plans.map((p) => ({ ...p, rowCount: p === ff ? rows.length : 0, rows: p === ff ? rows : [] })),
  });
  /** 3513's seed and postcondition, as the chain runs them after the import: ON CONFLICT (flag) DO NOTHING, then "is TRUE". */
  const after3513 = (imported: ReadonlyArray<Record<string, string | null>>): boolean => {
    const table = new Map(imported.map((r) => [r.flag, r.enabled === "true"]));
    if (!table.has(X)) table.set(X, true);
    return table.get(X) === true;
  };

  it("the fact this guards: 3513 seeds the flag TRUE with ON CONFLICT (flag) DO NOTHING, then asserts it is ON", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, SEEDER), "utf8");
    assert.match(sql, /\(\s*'layover_crowd_reports_enabled',\s*true,/);
    assert.match(sql, /\)\s*ON CONFLICT \(flag\) DO NOTHING;/);
    assert.match(sql, /POSTCONDITION FAILED \(3513\): layover_crowd_reports_enabled is not TRUE/);
    assert.ok(compareMigrationFilenames(SEEDER, CHAIN_START_PREFIX) > 0, "3513 is a chain file: it runs AFTER the import");
  });

  it("the bootstrap refuses a snapshot carrying it — or 3513's postcondition would fail on what it imported", () => {
    let imported: ReadonlyArray<Record<string, string | null>> | null = null;
    let refusal: Error | null = null;
    try {
      imported = validateSnapshot(snapshotWith([flagRow(PRE_BASELINE), flagRow(X)]), plans, model.sha256)
        .tables.find((t) => t.table === "feature_flags")!.rows;
    } catch (err) {
      refusal = err as Error;
    }
    if (imported !== null) {
      assert.ok(after3513(imported), `imported ${X}=false; 3513's DO NOTHING keeps it and its postcondition rolls the apply back`);
    }
    assert.ok(refusal !== null, `the bootstrap accepted a snapshot carrying ${X}, which ${SEEDER} seeds itself`);
    assert.match(refusal.message, /layover_crowd_reports_enabled/);
    assert.match(refusal.message, /3513_layover_crowd_reports_flag\.sql/);
    // A flag only a pre-baseline migration seeds is still copied: that is what the snapshot is for.
    const pre = validateSnapshot(snapshotWith([flagRow(PRE_BASELINE)]), plans, model.sha256);
    assert.deepEqual(pre.tables.find((t) => t.table === "feature_flags")!.rows.map((r) => r.flag), [PRE_BASELINE]);
  });

  it("the import statement never writes a chain-seeded row, whatever validated it", () => {
    assert.throws(() => buildReferenceImportSql(ff, [flagRow(PRE_BASELINE), flagRow(X)]), /3513_layover_crowd_reports_flag\.sql/);
    assert.match(buildReferenceImportSql(ff, [flagRow(PRE_BASELINE)]), /ACTIVITY_DISCOVERY_BOOST_ENABLED/);
  });

  it("end to end: CI's rows → the snapshot's filter → validation and import → 3513's own seed → its postcondition holds", () => {
    // portava-ci holds both rows, 3513's ON (3513 ran there).
    const ci = [{ ...flagRow(PRE_BASELINE), enabled: "true" }, { ...flagRow(X), enabled: "true" }];
    // The snapshot's SELECT forces enabled (FORCED_VALUES); then it drops what the chain seeds itself.
    const projected = ci.map((r) => ({ ...r, enabled: ff.forcedValues.enabled }));
    const { rows, dropped } = withoutChainSeededRows(ff, projected);
    assert.deepEqual(dropped, [{ key: X, seededIn: `${SEEDER}:146` }]);
    const imported = validateSnapshot(snapshotWith(rows), plans, model.sha256).tables.find((t) => t.table === "feature_flags")!.rows;
    assert.doesNotThrow(() => buildReferenceImportSql(ff, imported));
    // The chain then runs 3513's seed exactly as the parser reads it from the file.
    const seed = scanSeedsInSql(readFileSync(join(MIGRATIONS_DIR, SEEDER), "utf8"), SEEDER, [{ schema: "public", table: "feature_flags", primaryKey: ["flag"] }]);
    assert.deepEqual(seed.problems, []);
    assert.deepEqual(seed.seeds.map((x) => [x.key[0], x.values.enabled, x.onConflict, x.line]), [[X, "true", "nothing", 146]]);
    assert.ok(after3513(imported), "3513's postcondition: layover_crowd_reports_enabled is TRUE");
    assert.equal(imported.find((r) => r.flag === PRE_BASELINE)?.enabled, "false", "a pre-baseline flag still arrives OFF");
  });

  it("every flag the chain seeds is left to the chain — not just 3513's", () => {
    const keys = Object.keys(ff.chainSeeded);
    const { rows, dropped } = withoutChainSeededRows(ff, [...keys, PRE_BASELINE].map(flagRow));
    assert.deepEqual(rows.map((r) => r.flag), [PRE_BASELINE]);
    assert.equal(dropped.length, keys.length);
    for (const k of keys) {
      assert.throws(() => validateSnapshot(snapshotWith([flagRow(k)]), plans, model.sha256), /which the chain seeds itself/, k);
    }
  });

  it("a snapshot planned against another migration tree is refused (its chain-seeded keys differ)", () => {
    const snap = snapshotWith([flagRow(PRE_BASELINE)]);
    const t = snap.tables.find((x) => x.table === "feature_flags")!;
    const fewer = { ...t.chainSeeded };
    delete fewer[X];
    t.chainSeeded = fewer;
    assert.throws(() => validateSnapshot(snap, plans, model.sha256), /chain-seeded keys differ/);
    const old = { ...snapshotWith([flagRow(PRE_BASELINE)]), format: "portava-beta-reference-snapshot/1" };
    assert.throws(() => validateSnapshot(old, plans, model.sha256), /format/, "a v1 snapshot (no exclusions) is refused");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the chain-seed parser (beta-chain-seeds.ts): which reference rows the chain seeds itself", () => {
  const FF: SeedTableSpec = { schema: "public", table: "feature_flags", primaryKey: ["flag"] };
  const BK: SeedTableSpec = { schema: "storage", table: "buckets", primaryKey: ["id"] };
  const scan = (sql: string, specs: SeedTableSpec[] = [FF]) => scanSeedsInSql(sql, "9000_x.sql", specs);

  it("masks comments and literals to the same length, and reads dollar-quoted bodies as code", () => {
    const sql = "SELECT 'a;b' -- c\n/* d */ $$ INSERT 'e' $$ E'f\\'g' \"h'i\"";
    const m = maskForSeedScan(sql);
    assert.equal(m.length, sql.length);
    assert.doesNotMatch(m, /a;b|-- c|\/\* d|'e'|f\\'g/);
    assert.match(m, /INSERT/, "a body is code");
    assert.match(m, /"h'i"/, "a quoted identifier is kept, and its quote does not open a literal");
    assert.equal(plainLiteralValue("'it''s'::text"), "it's");
    assert.equal(plainLiteralValue("42"), "42");
    assert.equal(plainLiteralValue("lower('x')"), null);
    assert.equal(plainLiteralValue("E'x'"), null);
  });

  it("keys every VALUES row — top level and inside a DO body, qualified or not, quoted or not, any column order", () => {
    const sql = [
      "-- INSERT INTO feature_flags (flag, enabled) VALUES ('in_a_comment', true);",
      "/* INSERT INTO public.feature_flags (flag, enabled) VALUES ('in_a_block_comment', true); */",
      "INSERT INTO public.feature_flags (flag, enabled, description) VALUES",
      "  ('a_enabled', true, 'has a ; a ) and (''quoted'', true'),",
      "  ('b_enabled', false, NULL)",
      "ON CONFLICT (flag) DO NOTHING;",
      "SELECT 'INSERT INTO feature_flags (flag, enabled) VALUES (''in_a_literal'', true)';",
      "DO $$ BEGIN INSERT INTO feature_flags AS f (enabled, flag) VALUES (false, 'c_enabled') ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled; END $$;",
      'INSERT INTO "public"."feature_flags" ("flag", "enabled") VALUES (\'d_enabled\'::text, true) RETURNING flag;',
      "SELECT $q$ it's a body with a stray quote $q$;",
      "INSERT INTO public.feature_flags_audit_log (flag, enabled) VALUES ('not_this_table', true);",
      "INSERT INTO feature_flags (flag, enabled) VALUES ('e_enabled', true);",
    ].join("\n");
    const r = scan(sql);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(
      r.seeds.map((s) => [keyText(s.key), s.line, s.onConflict, s.values.enabled]),
      [["a_enabled", 3, "nothing", "true"], ["b_enabled", 3, "nothing", "false"], ["c_enabled", 8, "update", "false"], ["d_enabled", 9, "none", "true"], ["e_enabled", 12, "none", "true"]],
    );
  });

  it("refuses what it cannot key exactly, naming the line — never a guess", () => {
    const cases: Array<[string, RegExp]> = [
      ["INSERT INTO feature_flags VALUES ('x', true);", /without a column list/],
      ["INSERT INTO feature_flags (flag, enabled) SELECT 'x', true;", /not INSERT … VALUES/],
      ["INSERT INTO feature_flags (flag, enabled) DEFAULT VALUES;", /not INSERT … VALUES/],
      ["INSERT INTO feature_flags (flag, enabled) OVERRIDING SYSTEM VALUE VALUES ('x', true);", /OVERRIDING/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES (p_flag, true);", /flag is not a plain literal/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES ('ok', true), (p_flag, true);", /flag is not a plain literal/],
      ["INSERT INTO feature_flags (enabled) VALUES (true);", /flag is not in the column list/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES ('x', true, 'extra');", /3 value\(s\) for 2 column/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES ('x', true) ON CONFLICT DO NOTHING;", /without a conflict target/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES ('x', true) ON CONFLICT ON CONSTRAINT feature_flags_pkey DO NOTHING;", /ON CONSTRAINT/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES ('x', true) ON CONFLICT (enabled) DO NOTHING;", /is not the primary key/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES ('x', true) ON CONFLICT (lower(flag)) DO NOTHING;", /not a plain column list/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES ('x', true) ON CONFLICT (flag) WHERE enabled DO NOTHING;", /partial-index/],
      ["INSERT INTO feature_flags (flag, enabled) VALUES (E'x\\'y', true);", /not a plain literal/],
      ["COPY public.feature_flags (flag, enabled) FROM stdin;", /COPY/],
      ["MERGE INTO feature_flags f USING s ON (true) WHEN NOT MATCHED THEN INSERT VALUES ('x', true);", /MERGE INTO/],
    ];
    for (const [sql, why] of cases) {
      const r = scan(`\n${sql}`);
      assert.equal(r.problems.length, 1, `${sql} → ${JSON.stringify(r.problems)}`);
      assert.match(r.problems[0].why, why, sql);
      assert.equal(r.problems[0].line, 2, sql);
      assert.equal(r.problems[0].table, "public.feature_flags");
    }
  });

  it("keys any reference table by its own primary key, schema included", () => {
    const r = scan("INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true) ON CONFLICT (id) DO NOTHING;\nINSERT INTO public.buckets (id) VALUES ('not_storage');", [FF, BK]);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.seeds.map((s) => `${s.schema}.${s.table}:${keyText(s.key)}`), ["storage.buckets:avatars"]);
    assert.equal(keyText(["a", "b"]), '["a","b"]', "a composite key is a JSON array");
  });

  it("names a unique key besides the primary key, in a CREATE UNIQUE INDEX or an ALTER TABLE", () => {
    assert.deepEqual(otherUniqueKeysInSql("ALTER TABLE ONLY public.feature_flags\n    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (flag);", FF), []);
    assert.equal(otherUniqueKeysInSql("CREATE UNIQUE INDEX ff_lower ON public.feature_flags USING btree (lower(flag));", FF).length, 1);
    assert.equal(otherUniqueKeysInSql("ALTER TABLE feature_flags ADD CONSTRAINT x UNIQUE (description);", FF).length, 1);
    assert.equal(otherUniqueKeysInSql("ALTER TABLE ONLY public.feature_flags ADD CONSTRAINT y PRIMARY KEY (flag, enabled);", FF).length, 1);
    assert.deepEqual(otherUniqueKeysInSql("CREATE UNIQUE INDEX o ON public.other_table (flag);\n-- CREATE UNIQUE INDEX x ON feature_flags (flag);", FF), []);
  });

  it("the planner: chain-seeded keys per table, first seed in apply order; refuses an unkeyable seed, another unique key, a non-text key", () => {
    const fx = buildBaselineModel(FIXTURE);
    const chainOf = (files: Record<string, string>): ChainSource => ({ files: Object.keys(files), read: (f) => files[f] });
    const plansFor = (files: Record<string, string>) => planReferenceTables(fx, ["feature_flags", "rent_buddy_city_rollouts"], chainOf(files));
    const p = plansFor({
      "2100_a.sql": "INSERT INTO feature_flags (flag, enabled) VALUES ('z_enabled', false), ('a_enabled', true) ON CONFLICT (flag) DO NOTHING;",
      "2200_b.sql": "\nINSERT INTO feature_flags (flag, enabled) VALUES ('a_enabled', false) ON CONFLICT (flag) DO UPDATE SET enabled = false;",
      "2300_c.sql": "INSERT INTO PUBLIC.FEATURE_FLAGS (FLAG, ENABLED) VALUES ('m_enabled', true) ON CONFLICT (FLAG) DO NOTHING;",
    });
    assert.deepEqual(p.find((x) => x.table === "feature_flags")!.chainSeeded, { a_enabled: "2100_a.sql:1", m_enabled: "2300_c.sql:1", z_enabled: "2100_a.sql:1" });
    assert.deepEqual(p.find((x) => x.table === "rent_buddy_city_rollouts")!.chainSeeded, {});
    assert.deepEqual(p.find((x) => x.table === "buckets")!.chainSeeded, {});
    assert.deepEqual(plansFor({}).find((x) => x.table === "feature_flags")!.chainSeeded, {});
    assert.throws(() => plansFor({ "2100_a.sql": "INSERT INTO feature_flags (flag, enabled) SELECT f, false FROM t;" }), /2100_a\.sql:1 public\.feature_flags: not INSERT … VALUES/);
    assert.throws(
      () => plansFor({ "2100_a.sql": "INSERT INTO feature_flags (flag, enabled) VALUES ('x', true) ON CONFLICT (flag) DO NOTHING;", "2101_b.sql": "CREATE UNIQUE INDEX ff_l ON public.feature_flags (lower(flag));" }),
      /unique key besides its primary key \(2101_b\.sql: CREATE UNIQUE INDEX/,
    );
    assert.throws(
      () => plansFor({ "2100_a.sql": "INSERT INTO rent_buddy_city_rollouts (id, city) VALUES ('00000000-0000-0000-0000-000000000001', 'x');" }),
      /primary-key column id is uuid, not text/,
    );
  });

  it("the chain is read in APPLY order from CHAIN_START_PREFIX on: files before it and skipped files are not in it", () => {
    const skip = { skip: "2100_c.sql", superseded_by: ["2101_d.sql"], why: "w", evidence: "e" };
    assert.deepEqual(chainApplyOrder(["2101_d.sql", "2092_a.sql", "2093_b.sql", "2100_c.sql"], [skip]), ["2093_b.sql", "2101_d.sql"]);
    const real = loadChainSource().files;
    assert.equal(real[0].startsWith(CHAIN_START_PREFIX), true);
    assert.ok(!real.includes("2137_intel_stmt_trigger_removal.sql") && !real.includes("3974_trip_kernel_admin_restore_participant.sql"), "ORDER_OVERRIDES skips");
    assert.ok(real.indexOf("2136_profiles_auth_users_convergence.sql") > real.indexOf("2139_shared_content_tombstones.sql"), "ORDER_OVERRIDES moves");
  });

  it("on this tree: 197 flags, all keyed exactly — every flag the policy's own scanner sees the chain leave, plus the two 2962 retires", () => {
    const plans = planReferenceTables(model);
    const ff = plans.find((p) => p.table === "feature_flags")!;
    const seeded = Object.keys(ff.chainSeeded);
    assert.equal(seeded.length, 197, "pinned (2026-10-14): a migration that seeds a flag moves this; read what it seeds, then update"); // 194 -> 196: 3803 seeds memory_type_enabled and 3804 memory_place_occurrence_name_enabled, both FALSE (B58 MEM-CANON, PR #716); 196 -> 197: 3787 seeds layover_crew_location_sharing_enabled FALSE (B58 LAY-C1, census-layover L166/L203)
    const chain = loadChainSource();
    const live = seededFlagPopulation([...chain.files], chain.read);
    for (const f of live.keys()) assert.ok(f in ff.chainSeeded, `${f} is left in feature_flags by the chain but not keyed`);
    assert.deepEqual(seeded.filter((f) => !live.has(f)).sort(), ["intel_sensing_credentials_enabled", "intel_sensing_device_enrollment_enabled"]);
    assert.equal(ff.chainSeeded.layover_crowd_reports_enabled, "3513_layover_crowd_reports_flag.sql:146");
    for (const at of Object.values(ff.chainSeeded)) {
      assert.ok(compareMigrationFilenames(at.split(":")[0], CHAIN_START_PREFIX) >= 0, `${at} is not a chain file`);
    }
    // The rows the snapshot still copies are exactly the pre-baseline ones beta-config's b2 can also create.
    for (const f of preBaselineFlagDefinitions().keys()) assert.ok(!(f in ff.chainSeeded), `${f}: b2 creates it, the chain does not seed it`);
  });

  it("no other allowlisted table, and not storage.buckets, is seeded by the chain today — a chain file that starts to turns this red", () => {
    const plans = planReferenceTables(model);
    const others = plans.filter((p) => p.table !== "feature_flags");
    assert.equal(others.length, REFERENCE_PUBLIC_TABLES.length);
    for (const p of others) assert.deepEqual(p.chainSeeded, {}, `${p.schema}.${p.table}: the chain seeds rows the snapshot copies; check their postconditions and keys`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("emptiness, reset, census and arguments", () => {
  const empty: EmptinessState = {
    authUsers: 0,
    publicTables: [],
    publicFunctions: 0,
    publicTypes: 0,
    publicExtensions: [],
    scratchSchema: false,
    ledgerFiles: null,
  };

  it("proceeds on a fresh project and calls it fresh", () => {
    assert.deepEqual(decideEmptiness(empty, { reset: false }), { action: "proceed", fresh: true, notes: [] });
  });

  it("refuses a project with sign-ins even when reset is confirmed", () => {
    const v = decideEmptiness({ ...empty, authUsers: 1 }, { reset: true });
    assert.equal(v.action, "refuse");
  });

  it("refuses tables other than the ledger unless reset, and tolerates only ledger + scratch leftovers", () => {
    assert.equal(decideEmptiness({ ...empty, publicTables: ["profiles"] }, { reset: false }).action, "refuse");
    assert.equal(decideEmptiness({ ...empty, publicTables: ["profiles"] }, { reset: true }).action, "reset");
    const leftover = decideEmptiness(
      { ...empty, publicTables: ["schema_migration_ledger"], scratchSchema: true, ledgerFiles: ["0010_trip_plan.sql"] },
      { reset: false },
    );
    assert.equal(leftover.action, "proceed");
    assert.equal(leftover.action === "proceed" && leftover.fresh, false);
    const chain = decideEmptiness(
      { ...empty, publicTables: ["schema_migration_ledger"], ledgerFiles: ["2093_discovery_shadow_serves_grants.sql"] },
      { reset: false },
    );
    assert.equal(chain.action, "refuse");
  });

  it("resets with the measured storage policy names and every extension in public", () => {
    const names = model.policies.filter((p) => p.schema === "storage").map((p) => p.name);
    const sql = buildResetSql(names, ["pg_trgm", "postgis"]);
    for (const n of names) assert.match(sql, new RegExp(`DROP POLICY IF EXISTS "${n}" ON storage\\.objects;`));
    assert.match(sql, /DROP EXTENSION IF EXISTS "postgis" CASCADE;[\s\S]*DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;/);
    assert.match(sql, /GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;/);
    assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;/);
    assert.match(sql, /DROP SCHEMA IF EXISTS beta_bootstrap CASCADE;/);
    assert.throws(() => buildResetSql([], ["x; DROP"]));
  });

  it("requires postgis and pg_trgm in public, and does not install unaccent", () => {
    assert.ok(!EXTENSION_CENSUS.some((e) => e.name === "unaccent"));
    assert.deepEqual(EXTENSION_CENSUS.filter((e) => e.create).map((e) => `${e.name}@${e.schema}`), ["postgis@public", "pg_trgm@public"]);
    const ci = [
      ["postgis", "public"], ["pg_trgm", "public"], ["uuid-ossp", "extensions"], ["pgcrypto", "extensions"],
      ["pg_stat_statements", "extensions"], ["supabase_vault", "vault"], ["plpgsql", "pg_catalog"],
    ].map(([name, schema]) => ({ name, schema }));
    assert.deepEqual(extensionCensusProblems(ci), { errors: [], warnings: [] });
    const misplaced = ci.map((e) => (e.name === "postgis" ? { ...e, schema: "extensions" } : e));
    assert.equal(extensionCensusProblems(misplaced).errors.length, 1);
    // The one unaccent reference is inside a plpgsql body that already tolerates its absence.
    const uses = model.statements.filter((s) => /unaccent/.test(s.code));
    assert.equal(uses.length, 1);
    assert.doesNotMatch(uses[0].masked, /unaccent/, "it is in a dollar-quoted body, not in code resolved at CREATE");
  });

  it("diffs multisets both ways", () => {
    assert.deepEqual(diffMultiset(["a", "a", "b"], ["a", "b", "c", "ledger"], ["ledger"]), {
      missing: ["a"],
      unexpected: ["c"],
    });
  });

  it("reads the last result of a multi-statement response", () => {
    assert.deepEqual(lastResultRows([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(lastResultRows([]), []);
    assert.deepEqual(lastResultRows([[], [{ a: 2 }]]), [{ a: 2 }]);
    assert.throws(() => lastResultRows({ message: "x" }));
  });

  it("reads json and boolean columns whether or not the endpoint parsed them", () => {
    assert.deepEqual(jsonField({ a: '["x"]' }, "a"), ["x"]);
    assert.deepEqual(jsonField({ a: ["x"] }, "a"), ["x"]);
    assert.equal(boolField({ b: true }, "b"), true);
    assert.equal(boolField({ b: "f" }, "b"), false);
    assert.throws(() => boolField({}, "b"));
  });

  it("hard-wires the bootstrap to portava-beta: portava-ci and production are refused", () => {
    assert.equal(bootstrapTargetRefusal(`https://${BETA_PROJECT_REF}.supabase.co`), null);
    assert.match(bootstrapTargetRefusal("https://hwokxgbmezheskbzskfr.supabase.co") ?? "", /not portava-beta/);
    assert.match(bootstrapTargetRefusal(`https://${PRODUCTION_PROJECT_REF}.supabase.co`) ?? "", /PRODUCTION/);
    assert.match(bootstrapTargetRefusal(undefined) ?? "", /no target/);
    assert.match(bootstrapTargetRefusal("postgresql://postgres@db.emfpckykpzfturllshly.supabase.co:5432/postgres") ?? "", /no target/);
  });

  it("resolves refs strictly", () => {
    assert.equal(resolveProjectRef(`https://${BETA_PROJECT_REF}.supabase.co`), BETA_PROJECT_REF);
    assert.equal(resolveProjectRef(`https://${BETA_PROJECT_REF}.supabase.co/`), BETA_PROJECT_REF);
    assert.equal(resolveProjectRef("https://evil.example/emfpckykpzfturllshly.supabase.co"), null);
    assert.equal(resolveProjectRef(undefined), null);
  });

  it("parses the bootstrap's flags fail-closed", () => {
    assert.deepEqual(parseBootstrapArgs(["--snapshot", "/tmp/s.json"]), { mode: "bootstrap", snapshot: "/tmp/s.json", reset: false });
    assert.deepEqual(parseBootstrapArgs(["--snapshot=/tmp/s.json", "--reset", "--confirm-reset=RESET-BETA"]), {
      mode: "bootstrap",
      snapshot: "/tmp/s.json",
      reset: true,
    });
    assert.deepEqual(parseBootstrapArgs(["--apply-refused", "2182_close_authz_rpc_oracle.sql"]), {
      mode: "apply-refused",
      file: "2182_close_authz_rpc_oracle.sql",
    });
    assert.deepEqual(parseBootstrapArgs(["--check-refused", "a.sql,b.sql"]), { mode: "check-refused", files: ["a.sql", "b.sql"] });
    assert.equal(typeof parseBootstrapArgs(["--apply-refused", "x.sql", "--snapshot", "s"]), "string", "modes are exclusive");
    assert.equal(typeof parseBootstrapArgs(["--apply-refused", "x.sql", "--reset", "--confirm-reset=RESET-BETA"]), "string");
    assert.equal(typeof parseBootstrapArgs(["--apply-refused"]), "string");
    assert.equal(typeof parseBootstrapArgs(["--apply-refused", "x'; DROP TABLE y; --"]), "string");
    assert.equal(typeof parseBootstrapArgs(["--check-refused", ""]), "string");
    assert.equal(typeof parseBootstrapArgs([]), "string");
    assert.equal(typeof parseBootstrapArgs(["--snapshot", "s", "--reset"]), "string");
    assert.equal(typeof parseBootstrapArgs(["--snapshot", "s", "--reset", "--confirm-reset=yes"]), "string");
    assert.equal(typeof parseBootstrapArgs(["--snapshot", "s", "--confirm-reset=RESET-BETA"]), "string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the files the applier refuses by shape (hand-applied by the bootstrap)", () => {
  const files = listMigrationFiles();
  const read = (f: string) => readFileSync(join(MIGRATIONS_DIR, f), "utf8");

  it("is exactly 2182 and 2190 today — a newly refused file must turn this red", () => {
    const refused = refusedChainFiles(files, read);
    assert.deepEqual(refused.map((r) => r.filename), [
      "2182_close_authz_rpc_oracle.sql",
      "2190_memory_lifecycle_fixes.sql",
    ]);
    assert.equal(
      firstSentence(refused[0].reason),
      "2182_close_authz_rpc_oracle.sql contains a top-level ROLLBACK at line 167.",
    );
    assert.equal(
      firstSentence(refused[1].reason),
      "2190_memory_lifecycle_fixes.sql has transaction-control statements this script will not interpret: BEGIN@61, COMMIT@362, BEGIN@376, COMMIT@407.",
    );
  });

  it("never includes a file before 2093_ or one that already has a ledger row", () => {
    // Fixture: every file has a shape the applier refuses (an interior ROLLBACK).
    const refusedShape = () => "BEGIN;\nCREATE TABLE public.t (x int);\nCOMMIT;\nBEGIN;\nSELECT 1;\nROLLBACK;\n";
    assert.deepEqual(
      refusedChainFiles(["0186_geo_indexes.sql", "2092_x.sql", "2093_a.sql", "2200_b.sql"], refusedShape, new Set(["2200_b.sql"]))
        .map((r) => r.filename),
      ["2093_a.sql"],
    );
    const backfilled = new Set(backfillFilenames(files));
    assert.ok(refusedChainFiles(files, read).every((r) => !backfilled.has(r.filename)));
    assert.deepEqual(
      refusedChainFiles(files, read, new Set(["2182_close_authz_rpc_oracle.sql"])).map((r) => r.filename),
      ["2190_memory_lifecycle_fixes.sql"],
    );
  });

  it("applies only where the applier stopped: every earlier chain file must be recorded", () => {
    const chain = files.filter((f) => f >= CHAIN_START_PREFIX);
    const before2182 = chain.filter((f) => f < "2182_");
    assert.deepEqual(unrecordedPredecessors(files, "2182_close_authz_rpc_oracle.sql", new Set(before2182)), []);
    const gap = new Set(before2182.filter((f) => !f.startsWith("2181_")));
    assert.deepEqual(
      unrecordedPredecessors(files, "2182_close_authz_rpc_oracle.sql", gap),
      before2182.filter((f) => f.startsWith("2181_")),
    );
    assert.deepEqual(unrecordedPredecessors(files, chain[0], new Set()), [], "nothing before the chain start counts");
  });

  it("cuts 2182 into one COMMIT block (the apply) and its four checks A–D (the probes)", () => {
    const plan = planManualApply(read("2182_close_authz_rpc_oracle.sql"), "2182");
    assert.equal(plan.applyBlocks, 1);
    assert.equal(plan.applyStatements.length, 6);
    assert.match(plan.applyStatements[0], /^CREATE SCHEMA IF NOT EXISTS authz$/);
    assert.match(plan.applyStatements[5], /SET search_path TO 'authz', 'public', 'pg_catalog'$/);
    assert.deepEqual(plan.probes.map((p) => p.origin), ["bare", "bare", "bare", "rollback-block"]);
    assert.deepEqual(plan.probes[3].statements.map((s) => s.split(/\s+/).slice(0, 3).join(" ")), [
      "SET LOCAL ROLE",
      "SELECT set_config('request.jwt.claims', NULL,",
      "SELECT count(*) AS",
    ]);
    assert.equal(plan.probes.length, MANUAL_VERIFICATION["2182_close_authz_rpc_oracle.sql"]().probes);
  });

  it("cuts 2190 into its two COMMIT blocks and no probes; its own postcondition DO block stays in the apply", () => {
    const plan = planManualApply(read("2190_memory_lifecycle_fixes.sql"), "2190");
    assert.equal(plan.applyBlocks, 2);
    assert.equal(plan.probes.length, 0);
    assert.ok(plan.applyStatements.some((s) => /POSTCONDITION FAILED: lifecycle functions missing/.test(s)));
    assert.match(plan.applyStatements[plan.applyStatements.length - 1], /^GRANT EXECUTE ON FUNCTION public\.project_all_memory\(boolean\) TO service_role$/);
    assert.ok(!plan.applyStatements.some((s) => /^(BEGIN|COMMIT)$/i.test(s.trim())), "no transaction control survives the cut");
  });

  it("refuses shapes it cannot cut safely", () => {
    const bad: Array<[string, RegExp]> = [
      ["BEGIN; SELECT 1;", /never closed/],
      ["BEGIN; BEGIN; SELECT 1; COMMIT; COMMIT;", /BEGIN inside/],
      ["COMMIT;", /no open block/],
      ["BEGIN; SAVEPOINT a; COMMIT;", /savepoints/],
      ["BEGIN; CREATE TABLE t(); COMMIT; INSERT INTO t DEFAULT VALUES;", /read-only SELECT/],
      ["BEGIN; CREATE TABLE t(); COMMIT; BEGIN; DELETE FROM t; ROLLBACK;", /read-only SELECT/],
      ["BEGIN; CREATE TABLE t(); COMMIT; SELECT 1 FROM t FOR UPDATE;", /must not write/],
      ["SELECT 1;", /no BEGIN … COMMIT block/],
      ["BEGIN; SELECT 1; COMMIT; SELECT 2", /after the last/],
    ];
    for (const [sql, re] of bad) assert.throws(() => planManualApply(sql, "x.sql"), re, sql);
  });

  it("sends probes read-only and rolled back, and the apply as ONE transaction ending in a plain ledger INSERT", () => {
    const f = "2182_close_authz_rpc_oracle.sql";
    const plan = planManualApply(read(f), f);
    const probe = buildProbeSql(plan.probes[3]);
    assert.match(probe, /^BEGIN TRANSACTION READ ONLY;\n/);
    assert.match(probe, /\nROLLBACK;$/);
    const sum = checksumOf(read(f));
    const insert = buildManualLedgerInsertSql(f, sum, "n");
    assert.doesNotMatch(insert, /ON CONFLICT/, "an existing row must abort the transaction, not be skipped");
    assert.match(insert, new RegExp(`VALUES \\('${f}', '${sum}', 'manual', 'n'\\)$`));
    assert.throws(() => buildManualLedgerInsertSql(f, "backfill", "n"), /sha256/);
    assert.throws(() => buildManualLedgerInsertSql("x'; --.sql", sum, "n"), /refusing/);
    const sql = buildManualApplySql(plan, ["DO $v$ BEGIN END $v$"], insert);
    const top = splitTopLevelStatements(sql).statements.map((s) => s.masked.replace(/\s+/g, " ").trim());
    assert.equal(top[0], "BEGIN");
    assert.equal(top[top.length - 1], "COMMIT");
    assert.equal(top.filter((t) => /^(BEGIN|COMMIT|ROLLBACK|END)$/i.test(t)).length, 2, "exactly one transaction");
    assert.match(top[top.length - 2], /^INSERT INTO public\.schema_migration_ledger/);
    assert.equal(top.length, 1 + plan.applyStatements.length + 1 + 1 + 1);
    assert.match(top[1 + plan.applyStatements.length], /^DO\b/, "verification sits after the body, inside the transaction");
  });

  it("2182's pre-press check accepts exactly check A's stated caller set (as measured on beta 2026-10-10)", () => {
    const v = MANUAL_VERIFICATION["2182_close_authz_rpc_oracle.sql"]();
    assert.deepEqual(v.rpcClosedAfter?.map((r) => r.fn), ["is_blocked", "can_see_location", "in_accepted_circle"]);
    assert.deepEqual(Object.keys(v.rpcClosedAfter![0].body), ["a", "b"], "the file's own probe body for is_blocked");
    const a = [
      { kind: "function", obj: "can_see_location(uuid,uuid)" },
      { kind: "policy", obj: "highlights / highlights_select" },
      { kind: "policy", obj: "highlights / highlights_select_active" },
      { kind: "policy", obj: "messages / messages_hide_blocked_sender" },
      { kind: "policy", obj: "user_locations / loc_select" },
    ];
    const c = [
      { tablename: "highlights", policyname: "highlights_select" },
      { tablename: "highlights", policyname: "highlights_select_active" },
      { tablename: "messages", policyname: "messages_hide_blocked_sender" },
      { tablename: "user_locations", policyname: "loc_select" },
    ];
    const d = [{ anon_visible_locations: "0" }];
    assert.deepEqual(v.checkBefore([a, [], c, d]), []);
    assert.equal(v.checkBefore([[...a, { kind: "view", obj: "public.v" }], [], c, d]).length, 1, "an extra caller stops the press");
    assert.equal(v.checkBefore([a.slice(1), [], c, d]).length, 1);
    assert.equal(v.checkBefore([a, [], c.slice(1), d]).length, 1);
    assert.equal(v.checkBefore([a, [], c, []]).length, 1);
    const inTxn = v.inTransaction([a, [], c, [{ anon_visible_locations: 7 }]]).join("\n");
    assert.match(inTxn, /IF n <> 7 THEN/, "D compares against the count measured before the apply");
    assert.match(inTxn, /IS DISTINCT FROM 'highlights \/ highlights_select\nhighlights \/ highlights_select_active\nmessages/);
    assert.match(inTxn, /SET LOCAL ROLE anon[\s\S]*RESET ROLE$/, "the ledger row is not written as anon");
    assert.match(inTxn, /'search_path=authz, public, pg_catalog' = ANY \(proconfig\)/);
    assert.match(inTxn, /n\.nspname = 'public' AND p\.proname IN \('is_blocked','in_accepted_circle','can_see_location'\)\) THEN/);
    assert.match(inTxn, /n\.nspname = 'authz' AND p\.proname IN \('is_blocked','in_accepted_circle','can_see_location'\)\) <> 3 THEN/);
    assert.match(inTxn, /to_regprocedure\('public\.viewer_is_blocked\(uuid\)'\) IS NULL THEN/);
  });

  it("every refused-by-shape file has a verification entry, and nothing else does", () => {
    assert.deepEqual(
      Object.keys(MANUAL_VERIFICATION).sort(),
      refusedChainFiles(files, read).map((r) => r.filename).sort(),
    );
    assert.match(MANUAL_VERIFICATION["2190_memory_lifecycle_fixes.sql"]().inTransaction([]).join("\n"), /has_function_privilege\('anon'/);
  });

  it("--check-refused accepts exactly the refused set and nothing else", () => {
    assert.deepEqual(checkRefusedProblems(["2182_close_authz_rpc_oracle.sql", "2190_memory_lifecycle_fixes.sql"], files), []);
    assert.equal(checkRefusedProblems(["2093_discovery_shadow_serves_grants.sql"], files).length, 1);
    assert.match(checkRefusedProblems(["9999_nope.sql"], files)[0], /not a canonical migration file/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// beta-db.yml — the APPLY-PENDING mode (lead ruling, 2026-10-07). The workflow
// cannot run here (it needs the beta token), so its contract is tested two ways:
// the preflight's and the verdict's bash are EXTRACTED and executed for every
// input combination, and the job's shape is asserted on the file itself.
// ─────────────────────────────────────────────────────────────────────────────
describe("beta-db.yml apply-pending mode — only what beta lacks, never a reset, a dry run unless apply=yes", async () => {
  const { spawnSync } = await import("node:child_process");
  const WF = readFileSync(join(REPO_ROOT, ".github/workflows/beta-db.yml"), "utf8");

  /** One top-level job's block. */
  const job = (id: string): string => {
    const i = WF.indexOf(`\n  ${id}:\n`);
    assert.ok(i >= 0, `no job ${id}`);
    const rest = WF.slice(i + 1);
    const end = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };
  /** The dedented `run: |` script of the step whose name contains `stepName`, inside `block`. */
  const runScript = (block: string, stepName: string): string => {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => /^\s+- name: /.test(l) && l.includes(stepName));
    assert.ok(at >= 0, `no step "${stepName}"`);
    const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
    const indent = /^(\s*)/.exec(lines[runAt])![1].length + 2;
    const body: string[] = [];
    for (let i = runAt + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() !== "" && /^(\s*)/.exec(l)![1].length < indent) break;
      body.push(l.slice(indent));
    }
    return body.join("\n");
  };
  // EXACTLY how GitHub runs a `shell: bash` step: `bash --noprofile --norc -eo pipefail {0}`. Plain `bash -c`
  // hid that a step's own `set -uo pipefail` does NOT clear -e (run 38057476281 died on the dry run's expected exit 1).
  const GH_BASH = ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];
  const bash = (script: string, env: Record<string, string>) =>
    spawnSync("bash", [...GH_BASH, script], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" });

  it("preflight: exactly the two modes; apply-pending refuses a reset and any apply but '' or yes; the bootstrap refuses apply", () => {
    const script = runScript(job("preflight"), "Dispatch inputs must be exact");
    const cases: Array<[Record<string, string>, number]> = [
      [{ CONFIRM: "BOOTSTRAP-BETA", RESET: "", APPLY: "" }, 0],
      [{ CONFIRM: "BOOTSTRAP-BETA", RESET: "RESET-BETA", APPLY: "" }, 0],
      [{ CONFIRM: "BOOTSTRAP-BETA", RESET: "", APPLY: "yes" }, 1],
      [{ CONFIRM: "APPLY-PENDING-BETA", RESET: "", APPLY: "" }, 0],
      [{ CONFIRM: "APPLY-PENDING-BETA", RESET: "", APPLY: "yes" }, 0],
      [{ CONFIRM: "APPLY-PENDING-BETA", RESET: "RESET-BETA", APPLY: "yes" }, 1],
      [{ CONFIRM: "APPLY-PENDING-BETA", RESET: "", APPLY: "YES" }, 1],
      [{ CONFIRM: "apply-pending-beta", RESET: "", APPLY: "" }, 1],
      [{ CONFIRM: "", RESET: "", APPLY: "" }, 1],
    ];
    for (const [env, want] of cases) {
      const r = bash(script, env);
      assert.equal(r.status, want, `${JSON.stringify(env)} → ${r.status}\n${r.stdout}${r.stderr}`);
    }
    assert.match(bash(script, { CONFIRM: "APPLY-PENDING-BETA", RESET: "", APPLY: "" }).stdout, /DRY RUN/);
  });

  it("verdict: each mode is judged on its own jobs; the other mode's skipped jobs do not fail it, its own skipped job does", () => {
    const script = runScript(job("verdict"), "Classify the run");
    const v = (env: Record<string, string>) => bash(script, env).status;
    const base = { PREFLIGHT_RESULT: "success", SNAPSHOT_RESULT: "skipped", BOOTSTRAP_RESULT: "skipped", APPLY_PENDING_RESULT: "skipped" };
    assert.equal(v({ ...base, CONFIRM: "APPLY-PENDING-BETA", APPLY_PENDING_RESULT: "success" }), 0);
    assert.equal(v({ ...base, CONFIRM: "APPLY-PENDING-BETA", APPLY_PENDING_RESULT: "failure" }), 1);
    assert.equal(v({ ...base, CONFIRM: "APPLY-PENDING-BETA" }), 1, "its own job skipped is NOT a pass");
    assert.equal(v({ ...base, CONFIRM: "BOOTSTRAP-BETA", SNAPSHOT_RESULT: "success", BOOTSTRAP_RESULT: "success" }), 0);
    assert.equal(v({ ...base, CONFIRM: "BOOTSTRAP-BETA", SNAPSHOT_RESULT: "success", BOOTSTRAP_RESULT: "cancelled" }), 1);
    assert.equal(v({ ...base, CONFIRM: "garbage", PREFLIGHT_RESULT: "failure" }), 1);
  });

  it("every step that reads PIPESTATUS clears the -e GitHub's `shell: bash` supplies, before its pipeline", () => {
    const blocks = WF.split(/\n(?= {6}- name: )/).filter((b) => b.includes("PIPESTATUS"));
    assert.equal(blocks.length, 4, "bootstrap dry run + apply loop, apply-pending dry run + apply");
    for (const b of blocks) {
      const plusE = b.search(/\n\s+set \+e\n/);
      assert.ok(plusE >= 0 && plusE < b.indexOf("2>&1 | tee"), b.slice(0, 120));
    }
  });

  // Run 38057476281, reproduced: the bootstrap's dry run exits 1 listing exactly the two refused-by-shape files. That
  // is the ACCEPTED outcome — the step must read RC, extract the list and hand it to --check-refused.
  it("bootstrap dry-run step: exit 1 with exactly the known refusals passes and forwards the list; other failures do not", async () => {
    const { chmodSync, mkdtempSync, mkdirSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const script = runScript(job("beta-bootstrap"), "migrations — dry run");
    const runWith = (dryRc: number, dryOut: string) => {
      const dir = mkdtempSync(join(tmpdir(), "beta-bootstrap-dry-"));
      try {
        mkdirSync(join(dir, ".github/scripts"), { recursive: true });
        mkdirSync(join(dir, "runner"));
        const calls = join(dir, "calls.log");
        writeFileSync(calls, "");
        const outFile = join(dir, "dry-run.out");
        writeFileSync(outFile, `${dryOut}\n`);
        const fake = join(dir, ".github/scripts/pnpm-run.sh");
        writeFileSync(fake, [
          "#!/usr/bin/env bash",
          `echo "$3 \${4:-} \${5:-}" >> ${JSON.stringify(calls)}`,
          'case "$3" in',
          `  db:apply-migrations:dry-run) cat ${JSON.stringify(outFile)}; exit ${dryRc} ;;`,
          "  db:beta-bootstrap) exit 0 ;;",
          "  *) exit 97 ;;",
          "esac",
        ].join("\n"));
        chmodSync(fake, 0o755);
        const r = spawnSync("bash", [...GH_BASH, script], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RUNNER_TEMP: join(dir, "runner") }, encoding: "utf8" });
        return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: read(calls, "utf8").trim().split("\n") };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const refusals = [
      "   61. 2182_close_authz_rpc_oracle.sql   [REFUSED — contains a top-level ROLLBACK at line 167.]",
      "   69. 2190_memory_lifecycle_fixes.sql   [REFUSED — has transaction-control statements]",
      "  462. 3979_trip_kernel_admin_restore_participant_reissue.sql   [shape=unwrapped +postconditions]",
    ].join("\n");
    const ok = runWith(1, refusals);
    assert.equal(ok.status, 0, ok.out);
    assert.deepEqual(ok.calls, [
      "db:apply-migrations:dry-run  ",
      "db:beta-bootstrap --check-refused 2182_close_authz_rpc_oracle.sql,2190_memory_lifecycle_fixes.sql",
    ]);
    assert.equal(runWith(0, "nothing refused").status, 0);
    assert.equal(runWith(1, "no refusal lines at all").status, 1, "exit 1 without a refusal is a real failure");
    assert.equal(runWith(2, refusals).status, 1, "exit 2 is never accepted");
  });

  it("the job: runs only for APPLY-PENDING-BETA, never reaches the bootstrap's build or reset, writes only with apply=yes", () => {
    const j = job("beta-apply-pending");
    assert.match(j, /\n {4}if: \$\{\{ inputs\.confirm == 'APPLY-PENDING-BETA' \}\}\n/);
    assert.match(j, /\n {4}needs: preflight\n/);
    // the target: beta by literal, the beta token only
    assert.match(j, /SUPABASE_URL: 'https:\/\/emfpckykpzfturllshly\.supabase\.co'/);
    assert.match(j, /CI_SUPABASE_PROJECT_REF: 'emfpckykpzfturllshly'/);
    assert.match(j, /SUPABASE_PROJECT_TOKEN: \$\{\{ secrets\.BETA_SUPABASE_PROJECT_TOKEN \}\}/);
    // never a reset, never the bootstrap build: only the two refused-file modes of db:beta-bootstrap
    assert.doesNotMatch(j, /--reset|--confirm-reset|RESET-BETA|--snapshot|db:beta-reference-snapshot|download-artifact/);
    for (const m of j.matchAll(/db:beta-bootstrap ([^\n]*)/g)) assert.match(m[1], /^--(check-refused|apply-refused) /, m[0]);
    // the allowlist step carries no condition (ci.yml's self-check enforces this too)
    const allow = j.slice(j.indexOf("assert-nonprod-supabase.sh") - 200, j.indexOf("assert-nonprod-supabase.sh"));
    assert.doesNotMatch(allow.slice(allow.lastIndexOf("- name:")), /\n\s+if:/);
    // every writing step is conditioned on apply == 'yes'; the dry run is unconditional
    const steps = j.split(/\n(?= {6}- )/);
    const writing = steps.filter((st) => /db:apply-migrations(?!:dry-run)|--apply-refused|certify:migrations|audit:schema/.test(st));
    assert.equal(writing.length, 3, "apply loop, certify, audit");
    for (const st of writing) assert.match(st, /\n {8}if: \$\{\{ inputs\.apply == 'yes' \}\}\n/, st.slice(0, 120));
    // the unconditional dry-run step (the apply step re-runs a dry run as its own no-ledger check; that one is a writing step)
    const dry = steps.filter((st) => st.includes("db:apply-migrations:dry-run") && !writing.includes(st));
    assert.equal(dry.length, 1);
    assert.doesNotMatch(dry[0], /\n {8}if:/, "the dry run runs in both cases");
    assert.ok(steps.some((st) => st.includes("DRY RUN: nothing was written") && /inputs\.apply != 'yes'/.test(st)));
  });

  // Verifier BETA2b F1: on a project with NO ledger table the UNCHANGED applier does not refuse — its dry run prints
  // "BOOTSTRAP REQUIRED" and exits 0, and its apply run creates the ledger (2254) and continues down the chain. So the
  // two apply-pending steps are executed here, extracted from the workflow, against the REAL applier whose Management
  // API is stubbed: the ledger read answers 42P01 (an unbuilt beta), and every other statement is recorded as SENT.
  describe("an UNBUILT beta (no ledger) is refused by both apply-pending steps, and nothing is ever sent", async () => {
    const { chmodSync, mkdtempSync, mkdirSync, readFileSync: read, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dryStep = runScript(job("beta-apply-pending"), "apply-pending — dry run");
    const applyStep = runScript(job("beta-apply-pending"), "apply-pending — apply what beta lacks");
    const APPLIER = join(REPO_ROOT, "scripts/src/apply-migrations.ts");

    /** A work dir standing in for the checkout: its .github/scripts/pnpm-run.sh runs the real applier under the stub. */
    function world(ledger: "missing" | "unreadable" | "complete") {
      const dir = mkdtempSync(join(tmpdir(), "beta-apply-pending-"));
      mkdirSync(join(dir, ".github/scripts"), { recursive: true });
      mkdirSync(join(dir, "runner"));
      const sent = join(dir, "sent.log");
      const calls = join(dir, "calls.log");
      writeFileSync(sent, "");
      writeFileSync(calls, "");
      let ledgerJson = "";
      if (ledger === "complete") {
        ledgerJson = join(dir, "ledger.json");
        writeFileSync(ledgerJson, JSON.stringify(listMigrationFiles().map((filename) => ({
          filename, checksum: checksumOf(readFileSync(join(MIGRATIONS_DIR, filename), "utf8")), applied_by: "ci",
        }))));
      }
      const stub = join(dir, "management-api-stub.mts");
      writeFileSync(stub, [
        `import { appendFileSync, readFileSync } from "node:fs";`,
        `import { pathToFileURL } from "node:url";`,
        `const mode = ${JSON.stringify(ledger)};`,
        `globalThis.fetch = (async (_url: string, init: { body?: string }) => {`,
        `  const q = String(JSON.parse(init.body ?? "{}").query ?? "");`,
        `  if (/^\\s*select\\b/i.test(q) && /from public\\.schema_migration_ledger/i.test(q)) {`,
        `    if (mode === "missing") return { ok: false, status: 400, text: async () => JSON.stringify({ code: "42P01", message: 'relation "public.schema_migration_ledger" does not exist' }) };`,
        `    if (mode === "unreadable") return { ok: false, status: 500, text: async () => "upstream error" };`,
        `    const rows = readFileSync(${JSON.stringify(ledgerJson)}, "utf8");`,
        `    return { ok: true, status: 200, text: async () => rows, json: async () => JSON.parse(rows) };`,
        `  }`,
        `  appendFileSync(${JSON.stringify(sent)}, q.replace(/\\s+/g, " ").slice(0, 160) + "\\n");`,
        `  return { ok: true, status: 200, text: async () => "[]", json: async () => [] };`,
        `}) as unknown as typeof fetch;`,
        `process.argv = [process.argv[0], ${JSON.stringify(APPLIER)}, ...process.argv.slice(2)];`,
        `await import(pathToFileURL(${JSON.stringify(APPLIER)}).href);`,
      ].join("\n"));
      const fake = join(dir, ".github/scripts/pnpm-run.sh");
      writeFileSync(fake, [
        "#!/usr/bin/env bash",
        `echo "$3" >> ${JSON.stringify(calls)}`,
        `cd ${JSON.stringify(join(REPO_ROOT, "scripts"))} || exit 98`,
        'case "$3" in',
        `  db:apply-migrations:dry-run) exec node --import tsx/esm ${JSON.stringify(stub)} --dry-run ;;`,
        `  db:apply-migrations) exec node --import tsx/esm ${JSON.stringify(stub)} ;;`,
        '  *) echo "pnpm-run stub: $3 is not expected here" >&2; exit 97 ;;',
        "esac",
      ].join("\n"));
      chmodSync(fake, 0o755);
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? dir, RUNNER_TEMP: join(dir, "runner"),
        SUPABASE_URL: "https://emfpckykpzfturllshly.supabase.co", CI_SUPABASE_PROJECT_REF: "emfpckykpzfturllshly",
        KNOWN_PROD_PROJECT_REF: "ajrurzioarfkagpuxfnb", SUPABASE_PROJECT_TOKEN: "stub-token-never-sent-anywhere",
      };
      const step = (script: string) => {
        const r = spawnSync("bash", [...GH_BASH, script], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      };
      return {
        dir, step,
        sent: () => read(sent, "utf8").split("\n").filter(Boolean),
        calls: () => read(calls, "utf8").split("\n").filter(Boolean),
        refusedListExists: () => { try { read(join(dir, "runner/refused-by-shape.txt")); return true; } catch { return false; } },
        done: () => rmSync(dir, { recursive: true, force: true }),
      };
    }

    it("the dry-run step FAILS on an unbuilt beta (the applier itself exits 0 there) and sends nothing", () => {
      const w = world("missing");
      try {
        const r = w.step(dryStep);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /BOOTSTRAP REQUIRED/, "the applier's own report is shown");
        assert.match(r.out, /::error::portava-beta has no migration ledger.*Dispatch confirm=BOOTSTRAP-BETA instead\. Nothing was written\./);
        assert.deepEqual(w.calls(), ["db:apply-migrations:dry-run"]);
        assert.deepEqual(w.sent(), [], "no statement beyond the ledger read");
      } finally { w.done(); }
    });

    it("the apply step REFUSES on an unbuilt beta before starting the applier — even if the dry-run step were bypassed — and sends nothing", () => {
      const w = world("missing");
      try {
        writeFileSync(join(w.dir, "runner/refused-by-shape.txt"), ""); // as if the dry-run step had passed
        const r = w.step(applyStep);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /::error::portava-beta has no migration ledger \(checked again before the first write\)/);
        assert.deepEqual(w.calls(), ["db:apply-migrations:dry-run"], "the applier is never started in apply mode");
        assert.deepEqual(w.sent(), [], "not one statement — in particular not 2254's");
      } finally { w.done(); }
    });

    it("the apply step refuses when the dry-run step left no result, and when the ledger cannot be read", () => {
      const noResult = world("complete");
      try {
        const r = noResult.step(applyStep);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /dry-run step's result .* is missing/);
        assert.deepEqual(noResult.calls(), []);
      } finally { noResult.done(); }
      const unreadable = world("unreadable");
      try {
        const d = unreadable.step(dryStep);
        assert.equal(d.status, 1, d.out);
        assert.match(d.out, /refused before planning \(exit 2\)/);
        writeFileSync(join(unreadable.dir, "runner/refused-by-shape.txt"), "");
        const a = unreadable.step(applyStep);
        assert.equal(a.status, 1, a.out);
        assert.match(a.out, /could not read beta's ledger \(exit 2\)/);
        assert.deepEqual(unreadable.sent(), []);
      } finally { unreadable.done(); }
    });

    it("control: a BUILT beta with nothing pending passes both steps — the refusal is the missing ledger, not the stub", () => {
      const w = world("complete");
      try {
        const d = w.step(dryStep);
        assert.equal(d.status, 0, d.out);
        assert.match(d.out, /no pending file is refused by shape/);
        assert.ok(w.refusedListExists());
        const a = w.step(applyStep);
        assert.equal(a.status, 0, a.out);
        assert.match(a.out, /NOTHING TO DO/);
        assert.deepEqual(w.calls(), ["db:apply-migrations:dry-run", "db:apply-migrations:dry-run", "db:apply-migrations"]);
        assert.deepEqual(w.sent(), []);
      } finally { w.done(); }
    });
  });

  it("the bootstrap jobs stay BOOTSTRAP-BETA only, the verdict needs every job, and the title names the mode and the write", () => {
    for (const id of ["reference-snapshot", "beta-bootstrap"]) assert.match(job(id), /\n {4}if: \$\{\{ inputs\.confirm == 'BOOTSTRAP-BETA' \}\}\n/, id);
    const needs = /needs:\n((?:\s+- .*\n)+)/.exec(job("verdict"))![1];
    for (const id of ["preflight", "reference-snapshot", "beta-bootstrap", "beta-apply-pending"]) assert.match(needs, new RegExp(`- ${id}\\n`));
    assert.match(WF, /^run-name: "beta-db · \$\{\{ inputs\.confirm \}\}\$\{\{ inputs\.apply == 'yes' && ' · apply' \|\| '' \}\}/m);
  });
});
