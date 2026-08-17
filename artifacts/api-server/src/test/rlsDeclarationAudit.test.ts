/**
 * RLS declaration audit — a table with no RLS declaration must be an ERROR.
 *
 * The class of bug under test is an absence. auditMigrationsVsLive verifies
 * claims parsed out of migrations, so a table that never declares RLS produces
 * no claim, and no claim means nothing to check: the audit passes. These tests
 * pin the opposite question — does every created table declare RLS at all —
 * and, critically, that the check fires against the REAL migration tree rather
 * than only against fixtures.
 *
 * Run: node --import tsx/esm --test src/test/rlsDeclarationAudit.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  scanMigrations,
  findUndeclaredRlsTables,
  findStaleAllowlistEntries,
  findUnreasonedAllowlistEntries,
  stripSqlComments,
  RLS_DECLARATION_ALLOWLIST,
  MIN_REASON_LENGTH,
} from "../scripts/rlsDeclarationAudit.js";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../migrations");

function realTree(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));
}

describe("scanMigrations", () => {
  it("records a created table and a separate later RLS declaration", () => {
    const scan = scanMigrations([
      { file: "001.sql", sql: "create table public.widgets (id uuid primary key);" },
      { file: "002.sql", sql: "alter table public.widgets enable row level security;" },
    ]);
    assert.equal(scan.created.get("widgets"), "001.sql");
    assert.ok(scan.rlsDeclared.has("widgets"));
    assert.deepEqual(findUndeclaredRlsTables(scan, {}), []);
  });

  it("flags a table whose creating migration never declares RLS", () => {
    const scan = scanMigrations([
      { file: "003.sql", sql: "create table public.secrets (id uuid primary key);" },
    ]);
    const found = findUndeclaredRlsTables(scan, {});
    assert.equal(found.length, 1);
    assert.equal(found[0]!.table, "secrets");
    assert.equal(found[0]!.file, "003.sql");
  });

  it("handles the quoting and IF NOT EXISTS forms the tree actually uses", () => {
    const scan = scanMigrations([
      { file: "a.sql", sql: 'create table if not exists "public"."quoted_tbl" (id int);' },
      { file: "b.sql", sql: 'alter table only public."quoted_tbl" enable row level security;' },
      { file: "c.sql", sql: "CREATE TABLE Public.MixedCase (id int);" },
    ]);
    assert.ok(scan.created.has("quoted_tbl"));
    assert.ok(scan.rlsDeclared.has("quoted_tbl"));
    assert.ok(scan.created.has("mixedcase"), "table names are compared case-insensitively");
  });

  it("does NOT count a commented-out declaration as a declaration", () => {
    const scan = scanMigrations([
      {
        file: "d.sql",
        sql: `create table public.commented (id int);
              -- alter table public.commented enable row level security;
              /* alter table public.commented enable row level security; */`,
      },
    ]);
    assert.equal(scan.rlsDeclared.has("commented"), false);
    assert.equal(findUndeclaredRlsTables(scan, {}).length, 1);
  });

  it("stripSqlComments removes both comment forms", () => {
    assert.doesNotMatch(stripSqlComments("select 1; -- enable row level security"), /enable/);
    assert.doesNotMatch(stripSqlComments("/* enable row level security */ select 1;"), /enable/);
  });
});

describe("allowlist discipline", () => {
  it("suppresses a table only when it is listed", () => {
    const scan = scanMigrations([
      { file: "e.sql", sql: "create table public.service_only (id int);" },
    ]);
    assert.equal(findUndeclaredRlsTables(scan, {}).length, 1);
    assert.equal(
      findUndeclaredRlsTables(scan, {
        service_only: "Written only by the service role from the ingest worker; no client grant exists.",
      }).length,
      0,
    );
  });

  it("rejects an entry with no written reason — a bare name is not an entry", () => {
    assert.deepEqual(findUnreasonedAllowlistEntries({ tbl: "" }), ["tbl"]);
    assert.deepEqual(findUnreasonedAllowlistEntries({ tbl: "   " }), ["tbl"]);
    assert.deepEqual(findUnreasonedAllowlistEntries({ tbl: "service role" }), ["tbl"]);
    assert.deepEqual(
      findUnreasonedAllowlistEntries({
        tbl: "Service-role-only cache table with no client grant; contents are derived and public.",
      }),
      [],
    );
  });

  it("MIN_REASON_LENGTH is long enough to exclude a label", () => {
    assert.ok(MIN_REASON_LENGTH >= 20, "a one-word excuse must not pass as a reason");
  });

  it("flags an allowlist entry that has gone stale", () => {
    const scan = scanMigrations([
      { file: "f.sql", sql: "create table public.now_secured (id int);" },
      { file: "g.sql", sql: "alter table public.now_secured enable row level security;" },
    ]);
    assert.deepEqual(
      findStaleAllowlistEntries(scan, { now_secured: "was service-role only, long enough reason here" }),
      ["now_secured"],
    );
  });
});

describe("against the real canonical migration tree", () => {
  it("scans a real tree, not an empty one (the check must not pass vacuously)", () => {
    const files = realTree();
    assert.ok(files.length > 200, `expected the canonical tree, found ${files.length} file(s)`);
    const scan = scanMigrations(files);
    assert.ok(scan.created.size > 200, `expected many created tables, got ${scan.created.size}`);
    assert.ok(scan.rlsDeclared.size > 200, `expected many RLS declarations, got ${scan.rlsDeclared.size}`);
  });

  it("FAILS on public.compass_memories — the table this check exists for", () => {
    const scan = scanMigrations(realTree());
    assert.ok(scan.created.has("compass_memories"), "compass_memories must be found as created");
    assert.equal(
      scan.rlsDeclared.has("compass_memories"),
      false,
      "compass_memories must NOT be recorded as declaring RLS",
    );
    const found = findUndeclaredRlsTables(scan, RLS_DECLARATION_ALLOWLIST);
    const hit = found.find((t) => t.table === "compass_memories");
    assert.ok(hit, "compass_memories must be reported as undeclared");
    assert.match(hit!.file, /compass_memories\.sql$/);
  });

  it("compass_memories is not allowlisted — allowlisting it would defeat the check", () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(RLS_DECLARATION_ALLOWLIST, "compass_memories"),
      false,
      "compass_memories must fail this check, not be excused from it",
    );
  });

  it("every shipped allowlist entry is reasoned and non-stale", () => {
    const scan = scanMigrations(realTree());
    assert.deepEqual(findUnreasonedAllowlistEntries(RLS_DECLARATION_ALLOWLIST), []);
    assert.deepEqual(findStaleAllowlistEntries(scan, RLS_DECLARATION_ALLOWLIST), []);
  });

  it("the allowlist suppresses exactly the two ruled-on tables and nothing else", () => {
    // Pinned by name rather than by count: an allowlist that quietly grows is the
    // failure mode this check exists to prevent, so a third entry must break a
    // test and force the reasoning to be written down again.
    assert.deepEqual(Object.keys(RLS_DECLARATION_ALLOWLIST).sort(), [
      "geofence_admin_settings",
      "place_cache_invalidation_queue",
    ]);

    const scan = scanMigrations(realTree());
    const failing = findUndeclaredRlsTables(scan, RLS_DECLARATION_ALLOWLIST).map((t) => t.table);
    for (const suppressed of ["geofence_admin_settings", "place_cache_invalidation_queue"]) {
      assert.equal(failing.includes(suppressed), false, `${suppressed} should be allowlisted`);
    }
    // The allowlist must not suppress anything beyond its own two keys.
    const withoutAllowlist = findUndeclaredRlsTables(scan, {}).map((t) => t.table);
    const suppressedByList = withoutAllowlist.filter((t) => !failing.includes(t));
    assert.deepEqual(suppressedByList.sort(), [
      "geofence_admin_settings",
      "place_cache_invalidation_queue",
    ]);
  });

  it("place_coverage_buckets still FAILS — considered and refused, not overlooked", () => {
    // last_post_at is recency at one specific place; with a small contributor set
    // that is an observation about a person. Refusing it was a ruling, so a future
    // reader who thinks it was an oversight finds this test instead.
    const scan = scanMigrations(realTree());
    const failing = findUndeclaredRlsTables(scan, RLS_DECLARATION_ALLOWLIST).map((t) => t.table);
    assert.ok(failing.includes("place_coverage_buckets"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(RLS_DECLARATION_ALLOWLIST, "place_coverage_buckets"),
      false,
    );
  });
});
