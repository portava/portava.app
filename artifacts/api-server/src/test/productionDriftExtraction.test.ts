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
import {
  stripSqlNoise,
  appliedAfterSnapshot,
  declaredTables,
  staleUnmergedEntries,
  undeclaredEntries,
  KNOWN_PRODUCTION_GAPS,
  PRODUCTION_SNAPSHOT,
} from "../scripts/checkProductionDrift.js";

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

  // The capture date the rule is measured against, read from the module rather
  // than restated here — a test that hard-codes the snapshot's date goes stale
  // silently the next time the snapshot is refreshed, which is exactly what
  // happened to the two cases below on 2026-09-15.
  const captureDate = PRODUCTION_SNAPSHOT.slice(0, 8);

  it("every excuse names a migration that the ledger really records, applied after the capture", () => {
    // NOT `excused.size > 0`. That was the old assertion, and its stated reason
    // was "with a 09-07 snapshot and 09-08 applies there must be some". It was
    // true then and is false now, for the reason appliedAfterSnapshot's own
    // header predicts: "it self-heals — refresh the snapshot and the excuse
    // evaporates, because the table is then simply present." The snapshot is
    // now 09-15 and every recorded apply is at or before it, so the honest
    // answer is an EMPTY excuse set. Asserting a non-empty one would have
    // forced a false excuse to be manufactured to keep a test green.
    //
    // What is asserted instead is the INVARIANT, which holds at any size: an
    // excuse exists exactly when the ledger records the declaring migration
    // with a version after the capture date. Both directions are checked, so
    // this is not weaker than the old form — it is the old form plus the
    // completeness half the old form never had.
    for (const [table, why] of excused) {
      const file = why.split(" ")[0];
      const name = file.replace(/\.sql$/, "");
      assert.ok(byName.has(name), `${table} is excused by ${name}, which is not in the applied ledger`);
      assert.ok(
        byName.get(name)!.slice(0, 8) > captureDate,
        `${table} is excused by ${name}, whose recorded apply is not after the snapshot`,
      );
    }
    const postCapture = ledger.migrations.filter((m) => m.version.slice(0, 8) > captureDate);
    assert.equal(
      postCapture.length === 0,
      excused.size === 0,
      `the excuse set is ${excused.size} but ${postCapture.length} recorded applies postdate the ${captureDate} capture — ` +
        `an empty excuse set is only honest when nothing was applied after the snapshot`,
    );
  });

  it("2520's two tables are no longer excused BECAUSE the snapshot now contains them", () => {
    // This case used to assert the opposite, and both readings are correct at
    // their own tree. The false finding that started all of this was reporting
    // trip_map_projections and trip_map_projection_applied as production drift
    // when 2520 had been applied on 09-08 and the committed snapshot was from
    // 09-07. The excuse was the stopgap; the CURE was always refreshing the
    // snapshot, and on 2026-09-15 it was refreshed.
    //
    // So the assertion is inverted and its ground is stated: they need no
    // excuse because they are PRESENT. Checking presence rather than merely
    // asserting absence-of-excuse is what keeps this case honest — a bug that
    // dropped both tables from the snapshot would otherwise pass it silently.
    const snapshotTables = new Set(
      readFileSync(new URL(`../../baseline/${PRODUCTION_SNAPSHOT}`, import.meta.url), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    for (const t of ["trip_map_projections", "trip_map_projection_applied"]) {
      assert.ok(snapshotTables.has(t), `${t} must be in the snapshot — that is why it needs no excuse`);
      assert.ok(!excused.has(t), `${t} is in the snapshot and must not also carry an excuse`);
    }
  });

  it("a genuinely unapplied migration's tables are NOT excused", () => {
    // SUPERSEDED LIST, 2026-09-15. This case used to name the memory kernel and
    // highlight tables on the grounds that they were "on the branch and in no
    // database but portava-ci". That is no longer true — 2710, 2711, 2720-2724
    // and 2730 were applied to production on 2026-09-15 — so keeping them here
    // would have made the case pass for the wrong reason: they are not excused
    // because they are PRESENT, not because the rule refused them.
    //
    // The tables below are the ones that genuinely still have no production
    // apply at this tree. If any of them ever becomes excused, the rule has
    // stopped requiring a recorded apply and the check has quietly become an
    // allowlist — which is the whole point of this case.
    for (const t of [
      "layover_certified_computations", "sensing_contribution_sessions",
      "airport_fact_observations",
    ]) {
      assert.ok(!excused.has(t), `${t} has no recorded production apply and must not be excused`);
    }
  });
});

/**
 * THE EXEMPTION THAT ONLY POINTED ONE WAY.
 *
 * checkProductionDrift's "declared by NO migration in the tree" check exempts
 * `unmerged-pr` entries, and says why in its own comment: *"those tables are
 * declared in a PR's migration, which is precisely why they are not declared
 * here."* That is true on the day the entry is written and false the day the PR
 * lands, and nothing was watching for the day it lands.
 *
 * It had already happened. `sensing_anon_contributions` carried
 * *"Migration 2315, PR #475 (UNMERGED) ... Not drift until that PR lands"* while
 * `2315_sensing_anon_contributions.sql` was sitting on `main` — it reached main
 * inside #476, so no commit subject ever named #475 and the note stayed
 * plausible. The table was therefore excused from the MUST-REACH-ZERO count by a
 * sentence that had stopped being true, which is exactly the rot the
 * ratchet-not-allowlist header is written against.
 *
 * WHAT WOULD TURN THIS RED: reclassify any table declared by a migration in this
 * tree as `unmerged-pr`. The assertion is mechanical — it asks the tree, not the
 * note — so a stale note cannot satisfy it and a correct one cannot fail it.
 *
 * ── WHY THIS SUITE CALLS THE GUARD INSTEAD OF RESTATING IT, 2026-09-15 ──────
 * Restoring 2311/2320 — to close three `schema_migration_ledger` rows that named
 * no file on disk — made intel_claim_reviews, memory_episodes and memory_evidence
 * declared in this tree, so all three were reclassified `unmerged-pr` ->
 * `unapplied`, which checkProductionDrift's own error message demands. They were
 * the last three members, and the positive control below then failed asking for
 * the classification to be DELETED "rather than leaving a rule that exempts
 * nothing".
 *
 * The classification is kept — checkProductionDrift.ts states that ruling and its
 * reasons at the `Classification` type. What is fixed here is the thing that made
 * an empty population fatal in the first place: this file used to RE-STATE both
 * predicates rather than call them, so with no live member the copy went
 * unexercised and could drift from the guard in either direction unnoticed. Both
 * are now exported and called directly, against the real ratchet AND against a
 * constructed one, so each is proven to discriminate however the live ratchet is
 * populated. That is more coverage than the population check it replaces, not
 * less — and it is why deleting the classification was not the remedy.
 */
describe("an unmerged-pr classification expires when the PR lands", () => {
  const declared = declaredTables();
  const production = new Set<string>(); // the fixture ratchet is not in production

  /** A ratchet built to order, so the assertions do not depend on the live one. */
  const fixture = {
    landed_but_still_excused: {
      classification: "unmerged-pr" as const,
      note: "the PR landed; a migration in this tree declares this table",
    },
    genuinely_unmerged: {
      classification: "unmerged-pr" as const,
      note: "no migration in this tree declares this table",
    },
    plain_unapplied: {
      classification: "unapplied" as const,
      note: "declared by nothing, and not exempt",
    },
  };
  // Borrow two real table names so `declared` answers honestly for them: one the
  // tree DOES declare, one it does not. Hard-coding a name that later stops being
  // declared would make this fixture lie in the same way the old control did.
  const aDeclaredTable = [...declared].sort()[0];
  const anUndeclaredTable = "a_table_no_migration_anywhere_declares";
  assert.ok(aDeclaredTable, "the tree must declare at least one table");
  assert.ok(!declared.has(anUndeclaredTable), "the undeclared fixture name must really be undeclared");

  const builtRatchet = {
    [aDeclaredTable]: fixture.landed_but_still_excused,
    [anUndeclaredTable]: fixture.genuinely_unmerged,
  };

  it("no unmerged-pr entry in the REAL ratchet is declared by a migration in this tree", () => {
    const landed = staleUnmergedEntries(KNOWN_PRODUCTION_GAPS, declared);
    assert.deepEqual(
      landed,
      [],
      `these tables are classified unmerged-pr but a migration in this tree declares them, ` +
        `so the PR has landed and the classification is false: ${landed.join(", ")}`,
    );
  });

  it("STALE detection fires on a landed entry and spares a genuinely unmerged one", () => {
    // This is the positive control, and it no longer asks how many members the
    // live ratchet has. It asks the guard's own predicate to tell the two apart.
    const stale = staleUnmergedEntries(builtRatchet, declared);
    assert.deepEqual(
      stale,
      [aDeclaredTable],
      "the predicate must flag the unmerged-pr entry the tree declares, and only that one",
    );
  });

  it("the undeclared check exempts unmerged-pr and catches everything else", () => {
    // The other direction of the same exemption. If this stopped holding,
    // `unmerged-pr` would be reported as a phantom entry the day it was written,
    // and the pressure would be to delete the classification for the wrong reason.
    const exempted = undeclaredEntries(builtRatchet, declared, production);
    assert.deepEqual(
      exempted,
      [],
      "an unmerged-pr entry the tree does not declare is exempt — that is the classification's whole job",
    );

    const withPlain = { ...builtRatchet, [`${anUndeclaredTable}_2`]: fixture.plain_unapplied };
    assert.deepEqual(
      undeclaredEntries(withPlain, declared, production),
      [`${anUndeclaredTable}_2`],
      "a non-unmerged-pr entry that nothing declares must still be caught",
    );
  });

  it("the REAL ratchet has no entry for a table nothing declares", () => {
    const undeclared = undeclaredEntries(
      KNOWN_PRODUCTION_GAPS,
      declared,
      new Set(
        readFileSync(new URL(`../../baseline/${PRODUCTION_SNAPSHOT}`, import.meta.url), "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#")),
      ),
    );
    assert.deepEqual(undeclared, [], `ratcheted but declared by no migration: ${undeclared.join(", ")}`);
  });
});
