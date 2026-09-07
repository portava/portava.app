/**
 * check:deletion-coverage — proves the guard actually bites.
 *
 * The property that matters is not "the manifest parses". It is that a NEW
 * user-keyed table cannot be added without someone stating what happens to it on
 * account deletion — and that the pre-existing backlog is never a hiding place
 * for one.
 *
 * It did not achieve that until 2026-09-06. The subject set came from
 * `userKeyedTablesFromBaseline(BASELINE)` — a 2026-08-19 SNAPSHOT — so every
 * table created by a later migration was invisible, and covered only if someone
 * remembered to hand-add it. Nobody checked. The second half of this file drives
 * `evaluate()`, where the baseline and the migrations are combined, because that
 * is the part a parser test cannot see.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_PATH } from "../scripts/parseBaselineSchema.js";
import {
  MIGRATIONS_DIR,
  MIN_PLAUSIBLE_MIGRATIONS,
  VacuousMigrationReadError,
  computeProblems,
  evaluate,
  loadMigrations,
  migrationPostDatesBaseline,
  untriagedParkingProblems,
  userKeyedTablesFromBaseline,
  userKeyedTablesFromMigrations,
  type MigrationFile,
} from "../scripts/checkDeletionCoverage.js";
import {
  ERASED_BY_CASCADE,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  UNCLASSIFIED_BACKLOG,
  POST_BASELINE_UNTRIAGED,
  UNTRIAGED_HIGH_WATER,
  POST_BASELINE_TABLES,
} from "../lib/deletionDispositions.js";

const BASELINE = readFileSync(BASELINE_PATH, "utf8");

/** The real chain, read the way the guard reads it. */
const REAL_MIGRATIONS: MigrationFile[] = loadMigrations(MIGRATIONS_DIR);

describe("deletion coverage — the manifest matches the schema", () => {
  it("parses a non-empty set of user-keyed tables", () => {
    const t = userKeyedTablesFromBaseline(BASELINE);
    assert.ok(t.size > 200, `expected the baseline to carry many user-keyed tables, got ${t.size}`);
  });

  it("is currently clean — every table in baseline AND migrations is classified exactly once", () => {
    // Deliberately evaluate(), not computeProblems(userKeyedTablesFromBaseline(...)).
    // The old form asked the manifest about 2026-08-19 and got a confident answer
    // about a schema that had moved on by thirty-one tables.
    const { problems } = evaluate(BASELINE, REAL_MIGRATIONS);
    assert.deepEqual(problems, [], `manifest is out of sync:\n${problems.map((p) => `${p.kind}: ${p.table}`).join("\n")}`);
  });

  it("no table appears in two buckets", () => {
    const seen = new Map<string, string>();
    const add = (name: string, bucket: string) => {
      assert.ok(!seen.has(name), `${name} is in both ${seen.get(name)} and ${bucket}`);
      seen.set(name, bucket);
    };
    for (const t of ERASED_BY_CASCADE) add(t, "ERASED_BY_CASCADE");
    for (const t of DELETION_FLOW_TABLES) add(t, "DELETION_FLOW_TABLES");
    for (const r of RETAINED_WITH_REASON) add(r.table, "RETAINED_WITH_REASON");
    for (const t of UNCLASSIFIED_BACKLOG) add(t, "UNCLASSIFIED_BACKLOG");
    for (const u of POST_BASELINE_UNTRIAGED) add(u.table, "POST_BASELINE_UNTRIAGED");
  });
});

describe("deletion coverage — the guard bites", () => {
  it("FAILS when a new user-keyed table is added and left unclassified", () => {
    const withNew = new Map(evaluate(BASELINE, REAL_MIGRATIONS).tables);
    // A name that is deliberately in NO bucket. (intel_observations was used
    // here until IG-02 classified it — which is the guard working, not failing.)
    withNew.set("future_unclassified_table", ["actor_id"]);
    const problems = computeProblems(withNew);
    const hit = problems.find((p) => p.table === "future_unclassified_table");
    assert.ok(hit, "a new user-keyed table passed unclassified — the guard does not bite");
    assert.equal(hit!.kind, "UNCLASSIFIED NEW TABLE");
    assert.match(hit!.detail, /Do NOT add it to UNCLASSIFIED_BACKLOG/,
      "the failure must steer a new table away from the pre-existing-debt list");
  });

  it("FLAGS a stale entry when a listed table leaves the schema", () => {
    const shrunk = new Map(evaluate(BASELINE, REAL_MIGRATIONS).tables);
    // Must be an entry the guard can actually SEE — POST_BASELINE_TABLES names
    // the ones declared somewhere this repo cannot read, and they are
    // deliberately exempt from the stale check until recapture.
    const victim = ERASED_BY_CASCADE.find((t) => !POST_BASELINE_TABLES.includes(t))!;
    assert.ok(victim, "expected at least one erased table the schema declares");
    assert.ok(shrunk.has(victim),
      `${victim} must be present before it is removed, or this test proves nothing`);
    shrunk.delete(victim);
    const problems = computeProblems(shrunk);
    assert.ok(problems.some((p) => p.table === victim && p.kind === "STALE ENTRY"),
      "a manifest entry for a table that no longer exists went unreported");
  });

  it("the backlog is a dated record of debt, not a decision", () => {
    // If this ever reaches zero the program is done with D6; until then the
    // number is the honest measure of how much survives account deletion.
    assert.ok(UNCLASSIFIED_BACKLOG.length > 0);
    // Updated deliberately (IG unit I1, migration 2273): the ONE decided
    // retention is the append-only projection history, which carries no actor
    // column at all — it is retained because nothing in it is a person's row,
    // not because a person's row was ruled kept. Any further entry here must
    // come with the same kind of written reason.
    assert.equal(RETAINED_WITH_REASON.length, 1,
      "once retentions are decided, update this expectation deliberately");
    assert.equal(RETAINED_WITH_REASON[0].table, "intel_state_snapshot_versions");
    assert.ok(RETAINED_WITH_REASON[0].reason.length > 40, "a retention needs a reason a user could be shown");
    assert.match(RETAINED_WITH_REASON[0].reason, /no actor column/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE WIRING — the part that was actually broken
// ══════════════════════════════════════════════════════════════════════════════
//
// `userKeyedTablesFromBaseline` was correct the whole time, and unit-tested
// green above. It answers a question about 2026-08-19. The guard asked it the
// question "what is user-keyed in the schema", and so a table created by a
// later migration could not be seen at all: migration 2311 declares
// `intel_claim_reviews` with `reviewer_id uuid NOT NULL REFERENCES
// auth.users(id) ON DELETE CASCADE` on a table whose COMMENT says it carries
// "reviewer identity and free-text moderation reasons", it was in no bucket, and
// check:deletion-coverage was green.
//
// A test of the parser cannot catch that, because the parser was never the
// broken part. These drive the combination.

const FIXTURE_BASELINE = [
  "CREATE TABLE public.already_here (",
  "    id uuid NOT NULL,",
  "    user_id uuid NOT NULL",
  ");",
].join("\n");

const mig = (name: string, sql: string): MigrationFile => ({ name, sql });

describe("evaluate() — the guard reads the migrations, not just the snapshot", () => {
  it("DETECTS a post-baseline table whose user column is only visible as a REFERENCE", () => {
    // 2311's shape exactly: `reviewer_id` is in no USER_IDENTIFYING_COLUMNS
    // list, and never would have been. The inline FK is the whole signal.
    const found = userKeyedTablesFromMigrations(
      [mig("2311_intel_claim_reviews.sql", [
        "CREATE TABLE IF NOT EXISTS public.intel_claim_reviews (",
        "  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),",
        "  claim_id    uuid NOT NULL REFERENCES public.intel_claims(id) ON DELETE CASCADE,",
        "  reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,",
        "  reason      text",
        ");",
      ].join("\n"))],
      new Set(["already_here"]),
    );
    assert.deepEqual(found.get("intel_claim_reviews")?.columns, ["reviewer_id"],
      "a post-baseline table keyed to auth.users went undetected — this is the defect");
    assert.equal(found.get("intel_claim_reviews")?.migration, "2311_intel_claim_reviews.sql");
    assert.equal(found.has("intel_claims"), false,
      "referencing another table is not the same as carrying a user column");
  });

  it("REPORTS a post-baseline table that is in no bucket", () => {
    const { problems } = evaluate(FIXTURE_BASELINE, [
      mig("2400_future.sql", [
        "CREATE TABLE public.future_unclassified_table (",
        "  id uuid PRIMARY KEY,",
        "  approver_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE",
        ");",
      ].join("\n")),
    ]);
    const hit = problems.find((p) => p.table === "future_unclassified_table");
    assert.ok(hit, "a new post-baseline table passed unclassified — the guard still does not bite");
    assert.equal(hit!.kind, "UNCLASSIFIED NEW TABLE");
    assert.match(hit!.detail, /Do NOT add it to UNCLASSIFIED_BACKLOG/);
    assert.match(hit!.detail, /POST_BASELINE_UNTRIAGED is closed/,
      "the failure must close both hiding places, not one");
  });

  it("does NOT report a post-baseline table that IS classified", () => {
    const { problems, tables } = evaluate(FIXTURE_BASELINE, [
      mig("2311_intel_claim_reviews.sql", [
        "CREATE TABLE IF NOT EXISTS public.intel_claim_reviews (",
        "  id uuid PRIMARY KEY,",
        "  reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE",
        ");",
      ].join("\n")),
    ]);
    assert.ok(tables.has("intel_claim_reviews"), "the table must be in the subject set to be cleared");
    assert.equal(problems.some((p) => p.table === "intel_claim_reviews"), false,
      "a classified table must not be reported — the guard would be crying wolf");
  });

  it("a table CREATED then DROPPED by a later migration is not outstanding", () => {
    const { problems, tables } = evaluate(FIXTURE_BASELINE, [
      mig("2400_add.sql", "CREATE TABLE public.temp_thing (id uuid PRIMARY KEY, user_id uuid NOT NULL);"),
      mig("2401_remove.sql", "DROP TABLE IF EXISTS public.temp_thing;"),
    ]);
    assert.equal(tables.has("temp_thing"), false, "a dropped table is not part of the schema");
    assert.equal(problems.some((p) => p.table === "temp_thing"), false,
      "demanding a deletion fate for a table that no longer exists is a false accusation");
  });

  it("a commented-out rollback recipe does not delete a table from the subject set", () => {
    // Several migrations end with `-- DROP TABLE IF EXISTS public.<name>;` as a
    // rollback note. Read as DDL, 2308 would look like it created
    // wall_telemetry_events and immediately dropped it.
    const { tables } = evaluate(FIXTURE_BASELINE, [
      mig("2400_add.sql", [
        "CREATE TABLE public.kept_thing (id uuid PRIMARY KEY, user_id uuid NOT NULL);",
        "-- ROLLBACK:",
        "--   DROP TABLE IF EXISTS public.kept_thing;",
      ].join("\n")),
    ]);
    assert.ok(tables.has("kept_thing"),
      "a rollback note in a comment was read as a DROP — the fix reintroduced a blind spot");
  });

  it("a PRE-baseline migration cannot introduce a table the snapshot lacks", () => {
    // 0050_rent_a_buddy.sql declares `buddy_profiles`; production has
    // `rent_buddy_profiles`. Reading 0050 as current invents nine tables that do
    // not exist and demands a deletion fate for each.
    assert.equal(migrationPostDatesBaseline("0050_rent_a_buddy.sql"), false);
    assert.equal(migrationPostDatesBaseline("20260814_media_stamp_reactions.sql"), false);
    assert.equal(migrationPostDatesBaseline("2311_intel_claim_reviews.sql"), true);
    assert.equal(migrationPostDatesBaseline("20260901_later.sql"), true);

    const found = userKeyedTablesFromMigrations(
      [mig("0050_rent_a_buddy.sql",
        "CREATE TABLE IF NOT EXISTS buddy_profiles (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES profiles(id));")],
      new Set(["rent_buddy_profiles"]),
    );
    assert.equal(found.size, 0, "the baseline is authoritative for everything up to its capture");
  });

  it("the baseline stays authoritative for tables it already contains", () => {
    const found = userKeyedTablesFromMigrations(
      [mig("2400_touch.sql", "CREATE TABLE IF NOT EXISTS public.already_here (id uuid PRIMARY KEY, owner_id uuid NOT NULL);")],
      new Set(["already_here"]),
    );
    assert.equal(found.has("already_here"), false,
      "re-reading a stale CREATE TABLE for a table the snapshot has would be a second stale source");
  });
});

describe("the vacuity guard — a broken read REFUSES, it does not fall back", () => {
  it("refuses an implausibly small migrations directory rather than passing", () => {
    const dir = mkdtempSync(join(tmpdir(), "delcov-"));
    writeFileSync(join(dir, "2400_only.sql"), "CREATE TABLE public.x (id uuid);");
    assert.throws(
      () => loadMigrations(dir),
      (err: unknown) => err instanceof VacuousMigrationReadError && /read is broken, not empty/.test((err as Error).message),
      "a one-file read silently restored snapshot-only behaviour — the defect wearing a hat",
    );
  });

  it("refuses a directory it cannot read at all", () => {
    assert.throws(
      () => loadMigrations(join(tmpdir(), "delcov-does-not-exist-9d1f")),
      (err: unknown) => err instanceof VacuousMigrationReadError,
    );
  });

  it("accepts the real chain, which is far above the floor", () => {
    assert.ok(REAL_MIGRATIONS.length >= MIN_PLAUSIBLE_MIGRATIONS,
      `the real chain has ${REAL_MIGRATIONS.length} files; the floor is ${MIN_PLAUSIBLE_MIGRATIONS}`);
  });
});

describe("POST_BASELINE_UNTRIAGED is closed — it cannot become a hiding place", () => {
  const declaredBy = new Map([
    ["old_debt", "2202_map_telemetry.sql"],
    ["brand_new", "2311_intel_claim_reviews.sql"],
  ]);

  it("REFUSES a table declared above the high-water mark", () => {
    const problems = untriagedParkingProblems(
      [{ table: "brand_new", migration: "2311_intel_claim_reviews.sql" }], declaredBy, UNTRIAGED_HIGH_WATER);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].kind, "PARKED ABOVE THE HIGH-WATER MARK");
    assert.match(problems[0].detail, /not a place to park a new table/);
  });

  it("accepts a genuinely pre-existing entry at or below it", () => {
    assert.deepEqual(
      untriagedParkingProblems([{ table: "old_debt", migration: "2202_map_telemetry.sql" }], declaredBy, UNTRIAGED_HIGH_WATER),
      [],
    );
  });

  it("flags an entry that names the wrong declaring migration", () => {
    const problems = untriagedParkingProblems(
      [{ table: "old_debt", migration: "2120_canonical_events.sql" }], declaredBy, UNTRIAGED_HIGH_WATER);
    assert.equal(problems[0]?.kind, "WRONG DECLARING MIGRATION");
  });

  it("every parked entry sits at or below the high-water mark, and 2311 is above it", () => {
    for (const u of POST_BASELINE_UNTRIAGED) {
      const prefix = Number(/^(\d+)_/.exec(u.migration)![1]);
      assert.ok(prefix <= UNTRIAGED_HIGH_WATER, `${u.table} is parked by ${u.migration}, above the mark`);
    }
    assert.ok(2311 > UNTRIAGED_HIGH_WATER,
      "intel_claim_reviews must be un-parkable, or the whole point is lost");
  });
});

describe("the REAL schema — what the snapshot-only guard could not see", () => {
  const { tables, fromMigrations } = evaluate(BASELINE, REAL_MIGRATIONS);

  it("finds post-baseline tables the baseline cannot", () => {
    const baselineOnly = userKeyedTablesFromBaseline(BASELINE);
    assert.ok(fromMigrations.size >= 25,
      `expected the migrations to carry many post-baseline user-keyed tables, got ${fromMigrations.size}`);
    assert.equal(tables.size, baselineOnly.size + fromMigrations.size);
    for (const name of fromMigrations.keys()) {
      assert.equal(baselineOnly.has(name), false, `${name} is in the baseline; it must not be counted twice`);
    }
  });

  it("sees the tables that were only ever covered by a hand-written list", () => {
    // Each of these was classified because a person remembered. Now the schema
    // says so. If this fails, the migration scan has stopped working and the
    // manifest is back to being trusted rather than checked.
    for (const t of ["intel_observations", "memory_projections", "wall_telemetry_events", "availability_windows"]) {
      assert.ok(fromMigrations.has(t), `${t} is declared by a migration and the scan missed it`);
    }
  });

  it("sees phone_verification_challenges, which the recapture note said it could not", () => {
    assert.ok(fromMigrations.has("phone_verification_challenges"));
    assert.ok((ERASED_BY_CASCADE as readonly string[]).includes("phone_verification_challenges"),
      "2142's table is deleted by AccountDeletionService today; the deferral was the guard's blindness, not a doubt");
  });

  it("classifies intel_claim_reviews even though 2311 is on another branch", () => {
    // 2311 is not on main. POST_BASELINE_TABLES is what keeps the STALE check
    // quiet here — the same role it plays for the journey_* family — so the
    // guard is green on main AND green once #456 merges and the scan finds it.
    assert.ok((ERASED_BY_CASCADE as readonly string[]).includes("intel_claim_reviews"));
    assert.ok((POST_BASELINE_TABLES as readonly string[]).includes("intel_claim_reviews"));
    assert.equal(tables.has("intel_claim_reviews"), false,
      "2311 is not on this branch; if this fails the branch state changed and the exemption should be reconsidered");
  });

  it("every parked untriaged table is really declared by the migration it names", () => {
    for (const u of POST_BASELINE_UNTRIAGED) {
      assert.equal(fromMigrations.get(u.table)?.migration, u.migration,
        `${u.table} is not declared by ${u.migration} — the parking record is wrong`);
    }
  });
});
