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
  buildManualLedgerRowSql,
  firstSentence,
  jsonField,
  manualApplyNotes,
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
  type EmptinessState,
  type ReferenceSnapshot,
  type ReferenceTablePlan,
} from "./beta-db-core.js";
import { MIGRATIONS_DIR, checksumOf, listMigrationFiles, maskNonCode } from "./apply-migrations.js";
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
describe("the files the applier refuses by shape (applied verbatim by the bootstrap)", () => {
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

  it("records the hand apply as 'manual' with the applier's checksum and a reason, never overwriting", () => {
    const f = "2182_close_authz_rpc_oracle.sql";
    const sum = checksumOf(read(f));
    const notes = manualApplyNotes(refusedChainFiles(files, read)[0].reason);
    assert.equal(
      notes,
      "beta-bootstrap 2026-10-06: applied verbatim by the bootstrap because the applier refuses its shape " +
        "(2182_close_authz_rpc_oracle.sql contains a top-level ROLLBACK at line 167.)",
    );
    const sql = buildManualLedgerRowSql(f, sum, notes);
    assert.match(sql, new RegExp(`VALUES \\('${f}', '${sum}', 'manual', '`));
    assert.match(sql, /ON CONFLICT \(filename\) DO NOTHING RETURNING 1\)/);
    assert.throws(() => buildManualLedgerRowSql(f, "backfill", notes), /sha256/);
  });

  it("--check-refused accepts exactly the refused set and nothing else", () => {
    assert.deepEqual(checkRefusedProblems(["2182_close_authz_rpc_oracle.sql", "2190_memory_lifecycle_fixes.sql"], files), []);
    assert.equal(checkRefusedProblems(["2093_discovery_shadow_serves_grants.sql"], files).length, 1);
    assert.match(checkRefusedProblems(["9999_nope.sql"], files)[0], /not a canonical migration file/);
  });
});
