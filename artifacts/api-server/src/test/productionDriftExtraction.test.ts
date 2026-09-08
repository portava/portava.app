/**
 * check:production-drift used to report GRAMMAR as storage, and to blame a
 * snapshot for not seeing the future.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * Two defects, both of which made the check produce findings that were not true:
 *
 *   1. The `CREATE TABLE` regex ran over whole .sql files, comments included, so
 *      2490's "the next CREATE TABLE re-issues" declared a table called `re` and
 *      2370's "that every CREATE TABLE receives" declared one called `receives`.
 *      The standing remedy was a denylist of English words -- "if", "above",
 *      "ran", "returns", "silently", "time" -- which every new comment made
 *      longer. That is a ratchet turning into an allowlist. stripSqlNoise blanks
 *      comments, string literals and dollar-quoted bodies before the regex runs.
 *
 *   2. A gap was reported for `trip_map_projections` and
 *      `trip_map_projection_applied` on 2026-09-08. They were in production the
 *      whole time: 2520 was applied on 09-08 and the committed snapshot was
 *      captured on 09-07. Recording those as "unapplied" would have committed a
 *      false statement to the repository. appliedAfterSnapshot excuses exactly
 *      the tables whose declaring migration is RECORDED as applied, by name and
 *      version, after the snapshot's capture date -- and nothing else.
 *
 * WHAT WOULD TURN THIS RED: drop the stripSqlNoise call from declaredTables and
 * the prose cases below fail. Widen appliedAfterSnapshot to excuse on anything
 * softer than a recorded apply -- a date guess, a filename heuristic -- and the
 * "not excused" cases fail, because those migrations are real, recent, and
 * absent from the ledger.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/productionDriftExtraction.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripSqlNoise, appliedAfterSnapshot, declaredTables } from "../scripts/checkProductionDrift.js";

const TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi;
const namesIn = (sql: string) => [...stripSqlNoise(sql).matchAll(TABLE_RE)].map((m) => m[1].toLowerCase());

describe("stripSqlNoise reports storage, not grammar", () => {
  it("a CREATE TABLE inside a -- comment declares nothing", () => {
    assert.deepEqual(namesIn("-- the next CREATE TABLE re-issues the blanket set\n"), []);
  });

  it("the two real cases that were being denylisted are gone", () => {
    // Verbatim from 2490:165 and 2370:30 -- the lines that produced `re` and
    // `receives`. Read from the files so a rewording cannot quietly un-test this.
    const m2490 = readFileSync(new URL("../migrations/2490_destructive_privilege_boundary.sql", import.meta.url), "utf8");
    const m2370 = readFileSync(new URL("../migrations/2370_trust_tables_privileges.sql", import.meta.url), "utf8");
    assert.ok(/CREATE TABLE re-issues/.test(m2490), "the prose that caused `re` must still be present, or this test proves nothing");
    assert.ok(/CREATE TABLE receives/.test(m2370), "the prose that caused `receives` must still be present");
    assert.ok(!namesIn(m2490).includes("re"));
    assert.ok(!namesIn(m2370).includes("receives"));
  });

  it("block comments, including nested ones, declare nothing", () => {
    assert.deepEqual(namesIn("/* create table ghost_a /* create table ghost_b */ create table ghost_c */\n"), []);
  });

  it("a string literal declares nothing", () => {
    assert.deepEqual(namesIn("select 'create table ghost_d';\n"), []);
  });

  it("a dollar-quoted function body declares nothing", () => {
    assert.deepEqual(namesIn("create function f() returns void as $fn$ create table ghost_e; $fn$ language sql;\n"), []);
  });

  it("real SQL after a comment is still found", () => {
    assert.deepEqual(namesIn("-- create table decoy\ncreate table real_one (id uuid);\n"), ["real_one"]);
  });

  it("real SQL after an apostrophe on a comment line is still found", () => {
    // The direction a naive strip gets wrong: a lone quote inside a comment must
    // not open a string that swallows the statements after it.
    assert.deepEqual(
      namesIn("-- don't let this eat the file\ncreate table real_two (id uuid);\n"),
      ["real_two"],
    );
  });

  it("the whole migration corpus declares no English words", () => {
    const declared = declaredTables();
    for (const word of ["re", "receives", "if", "not", "exists", "above", "below", "ran", "returns", "silently", "time", "storage"]) {
      assert.ok(!declared.has(word), `\`${word}\` is a word, not a table`);
    }
  });
});

describe("appliedAfterSnapshot excuses a recorded apply and nothing else", () => {
  const excused = appliedAfterSnapshot();
  const ledger = JSON.parse(
    readFileSync(new URL("../lib/capability/production-applied-migrations.json", import.meta.url), "utf8"),
  ) as { migrations: Array<{ version: string; name: string }> };
  const byName = new Map(ledger.migrations.map((m) => [m.name, m.version]));

  it("every excuse names a migration that the ledger really records", () => {
    assert.ok(excused.size > 0, "with a 09-07 snapshot and 09-08 applies there must be some");
    for (const [table, why] of excused) {
      const file = why.split(" ")[0];
      const name = file.replace(/\.sql$/, "");
      assert.ok(byName.has(name), `${table} is excused by ${name}, which is not in the applied ledger`);
      assert.ok(
        byName.get(name)!.slice(0, 8) > "20260907",
        `${table} is excused by ${name}, whose recorded apply is not after the snapshot`,
      );
    }
  });

  it("2520's two tables are excused — the false finding that started this", () => {
    assert.ok(excused.has("trip_map_projections"));
    assert.ok(excused.has("trip_map_projection_applied"));
  });

  it("a genuinely unapplied migration's tables are NOT excused", () => {
    // 2710 and 2720-2724 are on the branch and in no database but portava-ci.
    // If any of these ever becomes excused, the rule has stopped requiring a
    // recorded apply and the check has quietly become an allowlist.
    for (const t of [
      "memory_domain_events", "memory_event_outbox", "memory_command_receipts",
      "memory_command_audit", "memory_derivative_registry",
      "highlight_sources", "highlight_revocation_log",
      "layover_certified_computations", "sensing_contribution_sessions",
    ]) {
      assert.ok(!excused.has(t), `${t} has no recorded production apply and must not be excused`);
    }
  });
});
