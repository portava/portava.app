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
import { createHash } from "node:crypto";
import {
  stripSqlNoise,
  appliedAfterSnapshot,
  declaredTables,
  staleUnmergedEntries,
  undeclaredEntries,
  KNOWN_PRODUCTION_GAPS,
  PRODUCTION_SNAPSHOT,
  PRODUCTION_CHECK_SNAPSHOT,
  KNOWN_VOCABULARY_GAPS,
  parseProductionCheckSnapshot,
  treeCheckVocabularies,
  treeVocabularies,
  enumVsCheckDivergences,
  missingVocabularyLabels,
  closedVocabularyGaps,
  phantomVocabularyGaps,
  unexplainedVocabularyGaps,
  splitVocabularyKey,
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

/**
 * ─── THE VOCABULARY HALF ──────────────────────────────────────────────────────
 *
 * What check:production-drift could not see until 2026-09-20, and what it cost.
 *
 * 2298_dead_check_vocabularies.sql widens two CHECK vocabularies and sat
 * unapplied on production while CI stayed green. `rank_events.surface` did not
 * admit 'wall', so every analytics row the Wall's For You page wrote was refused
 * 23514 — fire-and-forget, warn-only, invisible in the product and in the ranking
 * data. `circle_presence.status` did not admit 'paused', so the explicit "stop
 * sharing my presence" endpoint 500ed and the deactivation path's server-side
 * pause silently left a deactivating user visible on other members' maps.
 *
 * check:enum-literals could not catch either: its source of truth is the baseline
 * plus the migration chain, and by that source BOTH labels were legal. The code
 * was right and the tree's schema was right. Production had not applied the
 * migration, and nothing compared the two.
 *
 * WHAT WOULD TURN THIS SUITE RED, which is the only thing that makes it worth
 * having:
 *
 *   - declare a label in a migration's CHECK that the production capture does not
 *     admit, without recording it in KNOWN_VOCABULARY_GAPS → the "every missing
 *     label is recorded" case fails;
 *   - leave an entry on the ratchet after production learns the label → the
 *     "nothing on the ratchet is already admitted" case fails;
 *   - keep an entry for a label the tree stopped declaring → the phantom case
 *     fails;
 *   - re-transcribe the capture with a byte wrong → the digest case fails;
 *   - break the comparison so that it reaches nothing → the floor cases fail,
 *     which is what stops a collapsed rule from passing once the ratchet reaches
 *     zero.
 *
 * The three predicates are CALLED here, never restated. The table half's own
 * docblock above records why: a copy in the test file can drift from the guard in
 * either direction, and proves nothing at all whenever the live population is
 * empty. Each one is therefore driven against a CONSTRUCTED capture as well as
 * against the real one, so its discrimination is proven whatever the real ratchet
 * happens to contain — including, one day, nothing.
 *
 * The mutation log for the rule itself is in checkProductionDrift.ts's header,
 * beside the code it was measured against.
 */

const CAPTURE = readFileSync(
  new URL(`../../baseline/${PRODUCTION_CHECK_SNAPSHOT}`, import.meta.url),
  "utf8",
);

describe("the CHECK-vocabulary capture is the capture it claims to be", () => {
  it("the payload hashes to the sha256 recorded in its own header", () => {
    // The capture was transcribed through the Management API rather than piped to
    // disk, and production computed this digest over the same expression BEFORE
    // the transcription. Recomputing it here is what makes "verbatim" a checked
    // claim instead of an assertion about care taken.
    const lines = CAPTURE.split("\n").filter((l) => !l.startsWith("#") && l.trim().length > 0);
    const payload = `${lines.join("\n")}\n`;
    const declared = /^#\s*sha256\s*:\s*([0-9a-f]{64})\s*$/m.exec(CAPTURE)?.[1];
    assert.ok(declared, "the capture's header must record a sha256 of its payload");
    assert.equal(
      createHash("sha256").update(payload, "utf8").digest("hex"),
      declared,
      "the capture's payload does not hash to the digest its header records — it has been edited, " +
        "or a refresh changed the bytes without updating the header",
    );
    // And the parser's own answer must agree with the one computed here. The
    // duplication is deliberate: over a payload this trivially defined, two
    // independent computations agreeing is a real cross-check, and the digest the
    // CHECK acts on is the parser's, not this one.
    const parsed = parseProductionCheckSnapshot(CAPTURE);
    assert.equal(parsed.payloadSha256, declared, "the parser reads a different payload than the header describes");
    assert.equal(parsed.declaredSha256, declared);
  });

  it("every payload line parses, and the header's own count is the truth", () => {
    const parsed = parseProductionCheckSnapshot(CAPTURE);
    const payloadLines = CAPTURE.split("\n").filter((l) => !l.startsWith("#") && l.trim().length > 0);
    assert.equal(
      parsed.constraints,
      payloadLines.length,
      "a payload line was skipped, which means the file's format and the parser have diverged",
    );
    const claimed = /^#\s*count\s*:\s*(\d+)\s+constraint/m.exec(CAPTURE)?.[1];
    assert.equal(Number(claimed), parsed.constraints, "the header's count disagrees with the payload");
    // Floors, so a capture that stopped parsing cannot pass this file quietly.
    assert.ok(parsed.constraints >= 250, `only ${parsed.constraints} constraint(s) parsed`);
    assert.ok(parsed.values.size >= 250, `only ${parsed.values.size} column vocabular(ies) parsed`);
  });

  it("a comment cannot declare a constraint, and a blank line is nothing", () => {
    const parsed = parseProductionCheckSnapshot(
      [
        "# posts|posts_status_check|CHECK ((status = ANY (ARRAY['ghost'::text])))",
        "",
        "posts|posts_status_check|CHECK ((status = ANY (ARRAY['real'::text])))",
        "",
      ].join("\n"),
    );
    assert.equal(parsed.constraints, 1);
    assert.deepEqual([...(parsed.values.get("posts.status") ?? [])], ["real"]);
  });
});

/**
 * The two labels this whole instrument exists for, asserted against the REAL
 * capture rather than a fixture.
 *
 * This is the positive control that cannot go vacuous. The vocabulary ratchet
 * opens with no entry for either label — 2298 reached production on 2026-09-20,
 * before the capture — so nothing in the ratchet mentions them and a bug that
 * stopped reading the capture entirely would otherwise pass every case above.
 * Here the capture must positively SAY that production admits both, and the tree
 * must still declare both, which is what makes the comparison live on those two
 * columns instead of merely defined.
 */
describe("the 2298 labels are admitted by production and still declared by the tree", () => {
  const production = parseProductionCheckSnapshot(CAPTURE);
  const tree = treeCheckVocabularies();

  for (const [column, label] of [
    ["rank_events.surface", "wall"],
    ["circle_presence.status", "paused"],
  ] as const) {
    it(`${column} admits "${label}" in production and declares it in the tree`, () => {
      assert.ok(
        tree.get(column)?.has(label),
        `the tree must still declare ${column} = "${label}" — migration 2298 is what adds it`,
      );
      assert.ok(
        production.values.get(column)?.has(label),
        `the capture must show production admitting ${column} = "${label}". If a fresh capture ` +
          "genuinely shows otherwise, 2298 has been reverted on production and this is a live " +
          "defect, not a stale test: the Wall's analytics and two Circle privacy controls are broken.",
      );
    });
  }
});

describe("a vocabulary gap fails in BOTH directions", () => {
  const production = parseProductionCheckSnapshot(CAPTURE);
  const tree = treeCheckVocabularies();

  /**
   * A capture built to order, so the assertions below do not depend on what
   * production happens to hold today. `narrow_table.status` admits two labels;
   * the fixture tree declares three.
   */
  const fixtureCapture = parseProductionCheckSnapshot(
    [
      "narrow_table|narrow_table_status_check|CHECK ((status = ANY (ARRAY['kept'::text, 'closed'::text])))",
      "other_table|other_table_kind_check|CHECK ((kind = ANY (ARRAY['a'::text])))",
      "",
    ].join("\n"),
  );
  const fixtureTree = new Map<string, Set<string>>([
    ["narrow_table.status", new Set(["kept", "closed", "refused"])],
    // A column the fixture capture constrains nothing for: production accepts
    // every label there, so it must never be reported as a gap.
    ["unconstrained_table.status", new Set(["anything"])],
  ]);

  it("DIRECTION 1 — a label the tree declares and the capture does not admit is reported", () => {
    assert.deepEqual(
      missingVocabularyLabels(fixtureTree, fixtureCapture),
      ["narrow_table.status:refused"],
      "the predicate must report exactly the label production cannot hold",
    );
  });

  it("DIRECTION 1 declines to judge a column the capture does not constrain", () => {
    // The over-permissive direction, and the one that keeps this check from
    // manufacturing findings: an unconstrained column refuses nothing, so a
    // tree-declared label for it is not a 23514 risk.
    assert.ok(
      !missingVocabularyLabels(fixtureTree, fixtureCapture).some((k) =>
        k.startsWith("unconstrained_table."),
      ),
      "a column production leaves unconstrained must never be reported as refusing a label",
    );
  });

  it("DIRECTION 2 — a ratcheted label the capture DOES admit is reported", () => {
    const stale = closedVocabularyGaps(
      {
        "narrow_table.status:refused": { classification: "unapplied", note: "still refused" },
        "narrow_table.status:kept": { classification: "unapplied", note: "production learned this one" },
      },
      fixtureCapture,
    );
    assert.deepEqual(
      stale,
      ["narrow_table.status:kept"],
      "the predicate must flag the entry production now admits, and spare the one it still refuses",
    );
  });

  it("DIRECTION 3 — an entry describing no gap is reported, for either reason", () => {
    const phantom = phantomVocabularyGaps(
      {
        "narrow_table.status:refused": { classification: "unapplied", note: "a real gap" },
        "narrow_table.status:never_declared": { classification: "unapplied", note: "the tree does not declare this" },
        "unconstrained_table.status:anything": { classification: "unapplied", note: "production constrains nothing here" },
      },
      fixtureTree,
      fixtureCapture,
    );
    assert.deepEqual(phantom, [
      "narrow_table.status:never_declared",
      "unconstrained_table.status:anything",
    ]);
  });

  it("a key is split at the FIRST colon, so a label may contain one", () => {
    assert.deepEqual(splitVocabularyKey("t.c:a:b"), { column: "t.c", label: "a:b" });
  });

  it("an ENUM column production CHECK-constrains is separated out, not counted as a gap", () => {
    // The filter in treeVocabularies keeps two defect classes apart, and this is
    // the invariant that says it works. Asserted as a property rather than as a
    // list of today's five columns: a case that named them would have to be edited
    // the day one is fixed, and the property holds at any population.
    const { check, enumTyped } = treeVocabularies();
    const divergent = enumVsCheckDivergences(enumTyped, production);
    const gaps = missingVocabularyLabels(check, production);
    for (const { column, treeOnly } of divergent) {
      assert.ok(treeOnly.length > 0, `${column} was reported as divergent with no divergent label`);
      assert.ok(
        !gaps.some((k) => splitVocabularyKey(k).column === column),
        `${column} is reported BOTH as an enum/CHECK divergence and as a vocabulary gap — the two ` +
          "classes have been conflated, and one of the two verdicts is unsupported by the capture",
      );
    }
    // And the separation is not achieved by reporting nothing: the fixture proves
    // the predicate discriminates.
    const fixtureEnum = new Map<string, Set<string>>([
      ["narrow_table.status", new Set(["kept", "closed", "not_in_the_check"])],
      ["other_table.kind", new Set(["a"])],
    ]);
    assert.deepEqual(enumVsCheckDivergences(fixtureEnum, fixtureCapture), [
      { column: "narrow_table.status", treeOnly: ["not_in_the_check"] },
    ]);
  });

  // ── The same three questions, asked of the REAL ratchet ────────────────────

  it("every label the tree declares and production refuses is ON the ratchet", () => {
    const missing = missingVocabularyLabels(tree, production);
    const unrecorded = missing.filter((k) => !(k in KNOWN_VOCABULARY_GAPS));
    assert.deepEqual(
      unrecorded,
      [],
      "these labels are declared by a migration in this tree and refused by production, with " +
        `nothing recording them: ${unrecorded.join(", ")}`,
    );
    // Not a tautology in the other direction either: the comparison must actually
    // be reaching the columns it claims to. 300 were compared on 2026-09-20.
    const compared = [...tree.keys()].filter((c) => production.values.has(c));
    assert.ok(
      compared.length >= 200,
      `only ${compared.length} column(s) were compared on both sides — the derivation has collapsed`,
    );
  });

  it("nothing on the ratchet is already admitted by production", () => {
    const closed = closedVocabularyGaps(KNOWN_VOCABULARY_GAPS, production);
    assert.deepEqual(
      closed,
      [],
      `production admits these and they were not struck off: ${closed.join(", ")}`,
    );
  });

  it("every ratchet entry describes a gap that exists", () => {
    const phantom = phantomVocabularyGaps(KNOWN_VOCABULARY_GAPS, tree, production);
    assert.deepEqual(
      phantom,
      [],
      `these entries describe no gap: ${phantom.join(", ")}`,
    );
  });

  it("every ratchet entry is EXPLAINED by one of the three rules — the finder's positive control", () => {
    // FOUND BY MUTATION TESTING, and the reason this case exists is worth stating
    // where it is asserted: `missingVocabularyLabels` was mutated to skip every
    // column, so it found nothing, and the check still exited 0 with every other
    // case green. The other two predicates ask production and the tree directly,
    // so all thirty entries stayed valid and "no unrecorded gaps" was trivially
    // true of a rule that had stopped looking.
    //
    // The three rules are exhaustive over any entry, so landing in none of them
    // is not a fact about production — it means the comparison is broken.
    const unexplained = unexplainedVocabularyGaps(
      KNOWN_VOCABULARY_GAPS,
      missingVocabularyLabels(tree, production),
      closedVocabularyGaps(KNOWN_VOCABULARY_GAPS, production),
      phantomVocabularyGaps(KNOWN_VOCABULARY_GAPS, tree, production),
    );
    assert.deepEqual(
      unexplained,
      [],
      `the comparison no longer explains these recorded gaps at all: ${unexplained.join(", ")}`,
    );
  });

  it("the control fires when the finder stops finding, and spares an accounted entry", () => {
    const ratchet = {
      "narrow_table.status:refused": { classification: "unapplied" as const, note: "a real gap, migration 9999" },
    };
    const found = missingVocabularyLabels(fixtureTree, fixtureCapture);
    assert.deepEqual(found, ["narrow_table.status:refused"], "the fixture's premise");
    assert.deepEqual(
      unexplainedVocabularyGaps(ratchet, found, [], []),
      [],
      "an entry the finder still finds must not be reported as unexplained",
    );
    // A finder that has stopped finding: the entry is accounted for by nothing,
    // while remaining neither closed nor phantom. This is the shape the mutation
    // had, and the shape no other case in this file can see.
    assert.deepEqual(
      unexplainedVocabularyGaps(ratchet, [], [], []),
      ["narrow_table.status:refused"],
    );
  });

  it("every entry carries a note that names the migration that would close it", () => {
    // The ratchet's own rule, mechanised: "do not add an entry without a reason —
    // an entry with no reason is how this becomes an allowlist."
    //
    // WHAT IS ASSERTED AND WHAT IS NOT. The migration number is required, because
    // an entry that names no file leaves the next reader to guess which apply
    // closes it. A LENGTH FLOOR IS NOT. The first draft of this case required 40
    // characters and failed on "Migration 2309. Same block as 'city'." — a note
    // that is short because the block comment above it carries the shared
    // reasoning for all nine labels, which is the same idiom the table ratchet
    // uses ("Same block as trip_stages."). A threshold that forces padding buys
    // nothing and teaches the next author to write filler, so the floor is only
    // wide enough to catch an empty or placeholder note.
    for (const [key, gap] of Object.entries(KNOWN_VOCABULARY_GAPS)) {
      const note = gap.note.trim();
      assert.ok(note.length >= 20, `${key}: the note is a placeholder, not a reason`);
      assert.ok(
        /\b\d{4}\b/.test(note),
        `${key}: the note names no migration number, so nothing says which apply closes it`,
      );
      assert.ok(
        note.replace(/\b\d{4}\b/g, "").trim().split(/\s+/).length >= 4,
        `${key}: the note is a bare migration number with no reason attached`,
      );
    }
  });

  it("the must-reach-zero total is exactly the `unapplied` entries", () => {
    // `staged-by-ruling` is the only other classification, and it exists for one
    // entry: 2880's `place`, whose own header says NOT READY TO APPLY and names
    // owner decision D-STAMP. If that ever becomes the majority classification,
    // the ratchet has started excusing rather than counting.
    const byClass = Object.values(KNOWN_VOCABULARY_GAPS).reduce<Record<string, number>>((acc, g) => {
      acc[g.classification] = (acc[g.classification] ?? 0) + 1;
      return acc;
    }, {});
    const total = Object.keys(KNOWN_VOCABULARY_GAPS).length;
    assert.equal(
      (byClass.unapplied ?? 0) + (byClass["staged-by-ruling"] ?? 0),
      total,
      "an entry carries a classification this suite does not know about",
    );
    assert.ok(
      (byClass.unapplied ?? 0) > (byClass["staged-by-ruling"] ?? 0),
      "more entries are excused by a ruling than counted toward zero — check each ruling is real",
    );
  });
});
