/**
 * Migration-inventory classifier — the four dimensions, and the two traps that
 * produced a false zero, driven entirely by fixtures.
 *
 * NO DATABASE, and no Supabase credential variable named anywhere in this file.
 * Both are load-bearing, for the same reasons migrationLedger.test.ts states:
 *
 *   * It imports only src/scripts/lib/migrationInventoryCore.ts, which is
 *     guard-free. src/scripts/reportMigrationInventory.ts — the I/O shell —
 *     imports src/lib/ciProdReadOnlyAuditGuard.mjs as its FIRST import, and
 *     that guard calls process.exit(2) when it cannot establish the target. A
 *     test that imported the shell would die at import under the loopback
 *     target `pnpm run test` pins.
 *   * scripts/check-guard-coverage.mjs classifies any file under src/ that
 *     NAMES a Supabase credential env var as able to reach Supabase and then
 *     demands a guard import or a written exemption. This file names none,
 *     which is why requireCredentials() takes plain strings.
 *
 *
 * THE FIXTURES ARE THE REAL ROWS, AND THAT IS DELIBERATE
 * =====================================================
 * Every literal below was read out of production (ajrurzioarfkagpuxfnb),
 * read-only, on 2026-09-22. An invented fixture proves the classifier
 * self-consistent; these prove it correct about the database that was
 * misreported:
 *
 *   * 2201_map_projection_flag.sql carries checksum 'backfill' and the notes
 *     quoted in BACKFILL_NOTES below.
 *   * 2950_input_assistance_telemetry_events.sql carries checksum 42072bcd…
 *     and applied_at 2026-09-21 12:11:18.092654+00.
 *   * supabase_migrations.schema_migrations holds 7 bare serials ('2198' …
 *     '2272') and 96 fourteen-digit timestamps in ONE text column; its
 *     MAX(version) is '2272'.
 *   * 2890_rank_events_behavior_engine_columns.sql has NO hand-ledger row while
 *     all five of its rank_events columns are present.
 *
 * Each `it` states the rule it pins. Every rule here was mutated in the core
 * and the mutation was confirmed to make exactly the named test fail; the
 * mutation is recorded in the test's own comment so a future reader can redo
 * it without re-deriving what to break.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BACKFILL_CHECKSUM,
  CLI_LEDGER,
  EVIDENCE_DIMENSIONS,
  HAND_LEDGER,
  LedgerColumnError,
  assertNoAppliedInference,
  bandMembers,
  buildLedgerSelect,
  classifyLedgerEvidence,
  classifyMigration,
  compareVersions,
  decideInventoryExitCode,
  dimensionLabel,
  extractDeclaredObjects,
  formatInventoryReport,
  formatObservationWindow,
  inBand,
  isHistoricalBackfill,
  ledgerColumn,
  ledgerOwningColumn,
  newestApply,
  newestApplyByInstant,
  observeSchema,
  probeableObjects,
  profileVersionColumn,
  requireCredentials,
  requireObservationContext,
  serialFromCliRow,
  serialFromFilename,
  summariseInventory,
  versionFormat,
  type Attribution,
  type LedgerEvidence,
  type MigrationObservation,
  type ObjectProbe,
  type ObservationContext,
  type StatementCheck,
  type VersionedApply,
} from "../scripts/lib/migrationInventoryCore.js";

// ── Fixtures, taken from production 2026-09-22 ───────────────────────────────

const CTX: ObservationContext = {
  projectRef: "ajrurzioarfkagpuxfnb",
  observedAt: "2026-09-22T00:00:00.000Z",
};

/** 2201's own notes, verbatim. The sentence that makes a backfill row honest. */
const BACKFILL_NOTES =
  "Seeded by 2254_schema_migration_ledger.sql. Asserts only that this filename existed in " +
  "src/migrations/ when 2254 ran. NOT evidence that it was applied to this database; nothing " +
  "verified that it was.";

/** 2950's real checksum, as production holds it. */
const CHECKSUM_2950 =
  "42072bcd19ccbc5d314a556db02a52421be50b2adb372720cf4849a401b7295d";

const BACKFILL_ROW: LedgerEvidence = {
  ledger: "hand",
  identity: "2201_map_projection_flag.sql",
  checksum: BACKFILL_CHECKSUM,
  appliedBy: "backfill",
  appliedAt: "2026-09-15 04:55:05.199806+00",
  notes: BACKFILL_NOTES,
};

const VERIFIED_ROW: LedgerEvidence = {
  ledger: "hand",
  identity: "2950_input_assistance_telemetry_events.sql",
  checksum: CHECKSUM_2950,
  appliedBy: "manual",
  appliedAt: "2026-09-21 12:11:18.092654+00",
  notes: "REAL APPLY of the section-44 serve log.",
};

/**
 * The CLI table's version column as production holds it: seven bare serials
 * and a set of 14-digit timestamps, in one text column. The serial for a
 * timestamp row lives in `name`, not in `version`.
 */
const CLI_ROWS: VersionedApply[] = [
  { version: "2198", name: "feature_flag_metadata_audit", appliedAt: null },
  { version: "2199", name: "call_participants_rls_recursion", appliedAt: null },
  { version: "2260", name: "availability_windows", appliedAt: null },
  { version: "2261", name: "passport_travel_dna_prefs", appliedAt: null },
  { version: "2270", name: "wall_feature_flags", appliedAt: null },
  { version: "2271", name: "wall_session_intents", appliedAt: null },
  { version: "2272", name: "wall_context_thread_flags", appliedAt: null },
  { version: "20260823171308", name: "2142_phone_verification", appliedAt: null },
  {
    version: "20260914193020",
    name: "2900_intel_reward_ledger_reversals",
    appliedAt: null,
  },
  {
    version: "20260914193139",
    name: "2890_rank_events_behavior_engine_columns",
    appliedAt: null,
  },
  { version: "20260916075635", name: "coverage_state", appliedAt: null },
];

// ═══════════════════════════════════════════════════════════════════════════
// TRAP 1 — TWO LEDGERS, DISJOINT COLUMNS
// ═══════════════════════════════════════════════════════════════════════════

describe("trap 1: two ledgers, disjoint columns", () => {
  it("models the disjointness as a fact, not a comment", () => {
    // MUTATION: add "version" to HAND_LEDGER.columns → this fails.
    assert.ok(HAND_LEDGER.columns.includes("filename"));
    assert.ok(!HAND_LEDGER.columns.includes("version"));
    assert.ok(CLI_LEDGER.columns.includes("version"));
    assert.ok(!CLI_LEDGER.columns.includes("filename"));
    assert.equal(HAND_LEDGER.identityColumn, "filename");
    assert.equal(CLI_LEDGER.identityColumn, "version");
  });

  it("REFUSES 'version' against the hand ledger and names the table that has it", () => {
    // THE false zero, in one call: `where version >= '2890'` was written for
    // the hand ledger's question and run against the CLI table.
    // MUTATION: make ledgerColumn() return the column unchecked → this fails.
    assert.throws(
      () => ledgerColumn(HAND_LEDGER, "version"),
      (err: unknown) => {
        assert.ok(err instanceof LedgerColumnError);
        assert.equal(err.ledger, "hand");
        assert.equal(err.column, "version");
        assert.equal(err.belongsTo, "cli");
        assert.match(err.message, /supabase_migrations\.schema_migrations/);
        assert.match(err.message, /zero migrations at or above 2890/);
        return true;
      },
    );
  });

  it("REFUSES 'filename' against the CLI ledger, the inverse mistake", () => {
    assert.throws(
      () => ledgerColumn(CLI_LEDGER, "filename"),
      (err: unknown) => {
        assert.ok(err instanceof LedgerColumnError);
        assert.equal(err.belongsTo, "hand");
        return true;
      },
    );
  });

  it("says which ledger owns a column, and null for a column neither has", () => {
    assert.equal(ledgerOwningColumn("filename"), "hand");
    assert.equal(ledgerOwningColumn("checksum"), "hand");
    assert.equal(ledgerOwningColumn("version"), "cli");
    assert.equal(ledgerOwningColumn("applied_at"), "hand");
    assert.equal(ledgerOwningColumn("nonexistent_column"), null);
  });

  it("builds a select only out of columns the named table has", () => {
    assert.equal(
      buildLedgerSelect(HAND_LEDGER, ["filename", "checksum", "applied_at"]),
      "select filename, checksum, applied_at from public.schema_migration_ledger",
    );
    assert.equal(
      buildLedgerSelect(CLI_LEDGER, ["version", "name"]),
      "select version, name from supabase_migrations.schema_migrations",
    );
    assert.throws(
      () => buildLedgerSelect(CLI_LEDGER, ["version", "checksum"]),
      LedgerColumnError,
    );
  });

  it("refuses a select of no columns: it would establish nothing", () => {
    assert.throws(() => buildLedgerSelect(HAND_LEDGER, []), /establishes nothing/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRAP 2 — ONE TEXT COLUMN, TWO FORMATS
// ═══════════════════════════════════════════════════════════════════════════

describe("trap 2: a text version column holding two formats", () => {
  it("classifies each format, and refuses to guess at a third", () => {
    // MUTATION: loosen TIMESTAMP14_RE to /^[0-9]{4,}$/ → the serial cases below
    // start reading as timestamps and this fails.
    assert.equal(versionFormat("2272"), "serial");
    assert.equal(versionFormat("2890"), "serial");
    assert.equal(versionFormat("20260914193139"), "timestamp14");
    assert.equal(versionFormat("2026091419313"), "unrecognized"); // 13 digits
    assert.equal(versionFormat("202609141931390"), "unrecognized"); // 15 digits
    assert.equal(versionFormat("coverage_state"), "unrecognized");
    assert.equal(versionFormat(""), "unrecognized");
  });

  it("profiles production's real column as MIXED", () => {
    const profile = profileVersionColumn(CLI_ROWS.map((r) => r.version));
    assert.equal(profile.mixed, true);
    assert.deepEqual(profile.formats, ["serial", "timestamp14"]);
    assert.equal(profile.counts.serial, 7);
    assert.equal(profile.counts.timestamp14, 4);
    assert.equal(profile.total, 11);
  });

  it("a single-format column is NOT mixed", () => {
    const profile = profileVersionColumn(["20260914193020", "20260914193139"]);
    assert.equal(profile.mixed, false);
    assert.deepEqual(profile.formats, ["timestamp14"]);
  });

  it("PROVES the text >= that produced the zero, then refuses to do it", () => {
    // The collation fact itself, asserted so the trap is documented by a
    // passing assertion rather than by prose: a 14-digit timestamp sorts BELOW
    // the four-digit cutoff '2890'. The third character decides it — '0'
    // against '9' — and the remaining ten digits never get looked at.
    //
    // THESE FOUR LINES WERE RE-ESTABLISHED AGAINST PRODUCTION rather than
    // reasoned about. On ajrurzioarfkagpuxfnb (datcollate en_US.UTF-8),
    // 2026-09-22: `'2890' <= '20260915123045'` → false, `'20260915123045' <
    // '2950'` → true, `'289' < '20260915123045'` → FALSE. The last one is worth
    // keeping: it is the intuitive-but-wrong form of the same claim, and JS
    // and PostgreSQL agree on all three, so this fixture is a faithful
    // reproduction rather than an analogy.
    assert.ok("20260915123045" < "2890");
    assert.ok("20260915123045" < "2950");
    assert.ok(!("289" < "20260915123045"));

    // So a text `>= '2890'` over production's real column excludes every
    // post-cutover row. This is the query that answered 0.
    const textFiltered = CLI_ROWS.filter((r) => r.version >= "2890");
    assert.equal(textFiltered.length, 0);

    // And every one of those excluded rows is a real post-cutover apply.
    const actuallyPostCutover = CLI_ROWS.filter(
      (r) => versionFormat(r.version) === "timestamp14",
    );
    assert.equal(actuallyPostCutover.length, 4);

    // compareVersions REFUSES rather than reproducing that order.
    // MUTATION: make compareVersions() fall through to a plain text compare
    // when the formats differ → this fails.
    const refused = compareVersions("2890", "20260915123045");
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.match(refused.reason, /no common order/);
      assert.match(refused.reason, /BELOW the four-digit cutoff '2890'/);
      assert.match(refused.reason, /en_US\.UTF-8/);
    }
  });

  it("orders two versions of the SAME format, which is safe", () => {
    const a = compareVersions("20260914193020", "20260914193139");
    assert.equal(a.ok, true);
    if (a.ok) assert.equal(a.value, -1);
    const b = compareVersions("2272", "2198");
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.value, 1);
    const c = compareVersions("2272", "2272");
    assert.equal(c.ok, true);
    if (c.ok) assert.equal(c.value, 0);
  });

  it("refuses to order a value it does not recognise", () => {
    const r = compareVersions("20260916075635", "coverage_state");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /neither a/);
  });

  it("REFUSES MAX(version), and the refusal names the '2272' it would have said", () => {
    // Production's MAX(version) is '2272' — a PRE-cutover serial older than
    // every timestamp row. A freshness check built on it reports the database
    // months behind while staying green.
    const textMax = CLI_ROWS.map((r) => r.version).reduce((x, y) => (y > x ? y : x));
    assert.equal(textMax, "2272");
    assert.equal(versionFormat(textMax), "serial");

    // MUTATION: delete the `if (profile.mixed)` branch in newestApply() → this
    // fails, and the value it returns is the '2272' above.
    const answer = newestApply(CLI_ROWS);
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.match(answer.reason, /has no maximum/);
      assert.match(answer.reason, /'2272'/);
      assert.match(answer.reason, /serial=7/);
      assert.match(answer.reason, /timestamp14=4/);
    }
  });

  it("answers MAX over a single-format column — which is why CI never caught this", () => {
    // portava-ci's version column is SINGLE-FORMAT: 124 timestamps, 0 serials,
    // max '20260916193211'. Production's is mixed and its max is '2272'. So the
    // same query is right in CI and wrong in production, and a freshness check
    // built on it is green where it is rehearsed and silently months behind
    // where it matters. This case pins that the refusal is targeted at the
    // mixed column rather than at the question.
    const answer = newestApply([
      { version: "20260914193020", name: "2900", appliedAt: null },
      { version: "20260921121118", name: "2950", appliedAt: null },
    ]);
    assert.equal(answer.ok, true);
    if (answer.ok) assert.equal(answer.value.version, "20260921121118");
  });

  it("the band filter is broken on a SINGLE-format column too", () => {
    // Measured on both databases 2026-09-22: `count(*) where version >= '2890'`
    // is 0 on portava-ci AND on production, though CI's correct band answer is
    // 44 and production's is 20. Every 14-digit timestamp sorts below a
    // four-digit cutoff whether or not the column is mixed, so this defect is
    // independent of the mixing and NEITHER database exposes it. Only a rule
    // that refuses can.
    const ciLikeColumn = ["20260914193020", "20260916193211", "20260921121118"];
    assert.equal(profileVersionColumn(ciLikeColumn).mixed, false);
    assert.equal(ciLikeColumn.filter((v) => v >= "2890").length, 0);
    // The serials those rows really carry are all in the band.
    const rows: VersionedApply[] = [
      { version: "20260914193020", name: "2900_intel_reward_ledger_reversals" },
      { version: "20260916193211", name: "2955_media_asset_write_boundary" },
      { version: "20260921121118", name: "2950_input_assistance_telemetry_events" },
    ];
    assert.equal(bandMembers(rows, serialFromCliRow, { from: 2890, to: 2999 }).inBand.length, 3);
  });

  it("refuses a watermark over zero rows: an empty read establishes nothing", () => {
    const answer = newestApply([]);
    assert.equal(answer.ok, false);
    if (!answer.ok) assert.match(answer.reason, /empty ledger read/);
  });

  it("answers the freshness question by INSTANT, and refuses a partial one", () => {
    const ok = newestApplyByInstant([
      { version: "a.sql", appliedAt: "2026-09-16 15:42:03.286581+00" },
      { version: "b.sql", appliedAt: "2026-09-21 12:11:18.092654+00" },
    ]);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.version, "b.sql");

    // MUTATION: make newestApplyByInstant() skip rows with no instant instead
    // of refusing → this fails, and the answer silently becomes a max over a
    // subset.
    const partial = newestApplyByInstant([
      { version: "a.sql", appliedAt: "2026-09-16 15:42:03.286581+00" },
      { version: "b.sql", appliedAt: null },
    ]);
    assert.equal(partial.ok, false);
    if (!partial.ok) assert.match(partial.reason, /max over the rows that DO carry one/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE BAND FILTER — 20, not 0, and not 47
// ═══════════════════════════════════════════════════════════════════════════

describe("the serial band, computed over parsed serials", () => {
  it("reads a 4-digit serial off a filename and REFUSES a 14-digit prefix", () => {
    // MUTATION: relax MIGRATION_FILENAME_RE to /^([0-9]+)_/ → the imported
    // filename below starts parsing as serial 20260916075635 and this fails.
    assert.equal(serialFromFilename("2890_rank_events_behavior_engine_columns.sql"), 2890);
    assert.equal(serialFromFilename("2201_map_projection_flag.sql"), 2201);
    assert.equal(serialFromFilename("20260916075635_coverage_state.sql"), null);
    assert.equal(serialFromFilename("2890_no_extension"), null);
    assert.equal(serialFromFilename("README.md"), null);
  });

  it("reproduces the naive numeric cast that answered 47 where the answer is 20", () => {
    // The hand ledger's inverse hazard. `substring(filename from '^[0-9]+')::int`
    // accepts a 14-digit prefix, so every imported file lands above any 4-digit
    // band floor. Two of the five fixtures below are imports.
    const filenames = [
      "2890_rank_events_behavior_engine_columns.sql",
      "2950_input_assistance_telemetry_events.sql",
      "2201_map_projection_flag.sql",
      "20260916075635_coverage_state.sql",
      "20260823171308_phone_verification.sql",
    ];
    const naive = filenames.filter((f) => {
      const m = /^([0-9]+)/.exec(f);
      return m !== null && Number(m[1]) >= 2890;
    });
    assert.equal(naive.length, 4); // two real + two imports it should not see

    const correct = bandMembers(filenames, serialFromFilename, { from: 2890, to: 9999 });
    assert.equal(correct.inBand.length, 2);
    assert.deepEqual(correct.inBand, [
      "2890_rank_events_behavior_engine_columns.sql",
      "2950_input_assistance_telemetry_events.sql",
    ]);
    assert.deepEqual(correct.outOfBand, ["2201_map_projection_flag.sql"]);
    // The imports are UNATTRIBUTABLE, not out-of-band and not dropped.
    // MUTATION: make bandMembers() push a null serial into outOfBand → this
    // fails, because a dropped row is how a count becomes a zero.
    assert.equal(correct.unattributable.length, 2);
  });

  it("finds the repo serial of a CLI row in `name` when `version` is a timestamp", () => {
    assert.equal(
      serialFromCliRow({ version: "20260914193139", name: "2890_rank_events_behavior_engine_columns" }),
      2890,
    );
    assert.equal(serialFromCliRow({ version: "2272", name: "wall_context_thread_flags" }), 2272);
    // 2958's real production row: its name is the stem the file ARRIVED under,
    // so nothing in the row names 2958. Unknown, never guessed.
    assert.equal(serialFromCliRow({ version: "20260916075635", name: "coverage_state" }), null);
    assert.equal(serialFromCliRow({ version: "20260916075635", name: null }), null);
  });

  it("a null serial is neither in the band nor out of it", () => {
    assert.equal(inBand(2890, { from: 2890, to: 2999 }), true);
    assert.equal(inBand(2999, { from: 2890, to: 2999 }), true);
    assert.equal(inBand(2889, { from: 2890, to: 2999 }), false);
    assert.equal(inBand(null, { from: 0, to: 9999 }), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEDGER EVIDENCE — VERIFIED EXECUTION vs HISTORICAL BACKFILL
// ═══════════════════════════════════════════════════════════════════════════

describe("dimension: historical backfill", () => {
  it("2201's real row is a backfill, not an apply", () => {
    // MUTATION: drop the BACKFILL_CHECKSUM branch from
    // classifyLedgerEvidence() → 2201 reads as row-without-verification and
    // this fails; drop it from isHistoricalBackfill() too and 382 of 393 rows
    // start reading as applies, which is the core error itself.
    assert.equal(classifyLedgerEvidence(BACKFILL_ROW), "historical-backfill");
    assert.equal(isHistoricalBackfill(BACKFILL_ROW), true);
    assert.equal(BACKFILL_ROW.checksum, "backfill");
  });

  it("a backfill row carries an applied_at, and that still does not make it an apply", () => {
    // The trap inside the trap: 2201 HAS an applied_at (2026-09-15
    // 04:55:05.199806+00 — when 2254's backfill ran, not when 2201 ran). A
    // rule that asked only for an instant would call it verified.
    assert.ok(BACKFILL_ROW.appliedAt);
    assert.equal(classifyLedgerEvidence(BACKFILL_ROW), "historical-backfill");
  });

  it("a backfill that lost the sentinel checksum is still a backfill", () => {
    const row: LedgerEvidence = {
      ...BACKFILL_ROW,
      checksum: "0".repeat(64),
      appliedBy: "backfill",
    };
    // MUTATION: delete the applied_by branch in isHistoricalBackfill() → this
    // fails and a sha256-carrying backfill row reads as verified execution.
    assert.equal(isHistoricalBackfill(row), true);
  });

  it("2201's own notes say what the row does not establish", () => {
    assert.match(BACKFILL_ROW.notes ?? "", /Asserts only that this filename existed/);
    assert.match(BACKFILL_ROW.notes ?? "", /NOT evidence that it was applied/);
    assert.match(BACKFILL_ROW.notes ?? "", /nothing verified that it was/);
  });
});

describe("dimension: verified execution", () => {
  it("2950's real row is an observed apply", () => {
    assert.equal(classifyLedgerEvidence(VERIFIED_ROW), "verified-execution");
    assert.equal(isHistoricalBackfill(VERIFIED_ROW), false);
  });

  it("needs BOTH a real sha256 and an applied_at — neither alone", () => {
    // MUTATION: change classifyLedgerEvidence() to `hasHash || hasInstant` →
    // both cases below start reading as verified execution and this fails.
    assert.equal(
      classifyLedgerEvidence({ ...VERIFIED_ROW, appliedAt: null }),
      "row-without-verification",
    );
    assert.equal(
      classifyLedgerEvidence({ ...VERIFIED_ROW, appliedAt: "   " }),
      "row-without-verification",
    );
    assert.equal(
      classifyLedgerEvidence({ ...VERIFIED_ROW, checksum: null }),
      "row-without-verification",
    );
    assert.equal(
      classifyLedgerEvidence({ ...VERIFIED_ROW, checksum: CHECKSUM_2950.toUpperCase() }),
      "row-without-verification",
    );
  });

  it("a CLI row verifies nothing: that table has no checksum column", () => {
    const cli: LedgerEvidence = {
      ledger: "cli",
      identity: "20260914193139",
      checksum: null,
      appliedBy: "supabase-cli-or-management-api",
      appliedAt: null,
      notes: "2890_rank_events_behavior_engine_columns",
    };
    assert.equal(classifyLedgerEvidence(cli), "row-without-verification");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OBSERVED SCHEMA STATE — COMPATIBLE, MISSING, OR NEVER LOOKED AT
// ═══════════════════════════════════════════════════════════════════════════

const probe = (object: string, state: ObjectProbe["state"], property = "exists"): ObjectProbe => ({
  object,
  property,
  state,
});

describe("dimension: observed schema compatible / missing", () => {
  it("all probes present and every declared object probed → compatible", () => {
    const obs = observeSchema(["public.t.a", "public.t.b"], [
      probe("public.t.a", "present"),
      probe("public.t.b", "present"),
    ]);
    assert.equal(obs.dimension, "observed-schema-compatible");
    assert.equal(obs.coverage, 1);
    assert.deepEqual(obs.unprobed, []);
  });

  it("one absent probe → missing/incompatible, whatever else is present", () => {
    // MUTATION: make observeSchema() decide on presentCount > 0 instead of on
    // absent.length === 0 → this fails.
    const obs = observeSchema(["public.t.a", "public.t.b"], [
      probe("public.t.a", "present"),
      probe("public.t.b", "absent"),
    ]);
    assert.equal(obs.dimension, "schema-missing-or-incompatible");
    assert.equal(obs.presentCount, 1);
    assert.equal(obs.absent.length, 1);
  });

  it("present with the wrong shape is NOT compatible", () => {
    const obs = observeSchema(["public.t.a"], [
      {
        object: "public.t.a",
        property: "exists+not_null+default",
        state: "different-shape",
        expected: "text NOT NULL default 'unknown'",
        found: "text NULL default (none)",
      },
    ]);
    assert.equal(obs.dimension, "schema-missing-or-incompatible");
    assert.equal(obs.differentShape.length, 1);
  });

  it("no probes at all is 'not-probed' — neither compatible nor incompatible", () => {
    const obs = observeSchema(["public.t.a"], []);
    assert.equal(obs.dimension, "not-probed");
    assert.equal(obs.probedCount, 0);
    assert.deepEqual(obs.unprobed, ["public.t.a"]);
  });

  it("THE PARTIAL PROBE: 2 of 10 present never rounds up", () => {
    // A migration declaring ten objects, probed on two. Both present.
    const declared = Array.from({ length: 10 }, (_, i) => `public.t.c${i}`);
    const obs = observeSchema(declared, [
      probe("public.t.c0", "present"),
      probe("public.t.c1", "present"),
    ]);
    // MUTATION: make observeSchema() report coverage as
    // presentCount/probedCount instead of probedCount/declaredCount → coverage
    // becomes 1 and this fails.
    assert.equal(obs.declaredCount, 10);
    assert.equal(obs.probedCount, 2);
    assert.equal(obs.presentCount, 2);
    assert.equal(obs.coverage, 0.2);
    assert.equal(obs.unprobed.length, 8);
    // The strongest thing it may say is "the objects checked are present".
    assert.equal(obs.dimension, "observed-schema-compatible");
  });

  it("object probes alone can NEVER reach full statement coverage", () => {
    // The grade is not reachable from ObjectProbes, by construction — nothing
    // converts a probe into a StatementCheck. This is what keeps
    // reportMigrationInventory.ts, whose transport checks tables and columns
    // through information_schema, permanently in the partial grade.
    // MUTATION: make observeSchema() grant full coverage when absent.length ===
    // 0 and probedCount === declaredCount → this fails.
    const obs = observeSchema(["public.t.a"], [probe("public.t.a", "present")]);
    assert.equal(obs.dimension, "observed-schema-compatible");
    assert.equal(obs.coverageGrade, "partial-coverage");
    assert.equal(obs.executableStatementCount, null);
    assert.deepEqual(obs.statementChecks, []);
  });

  it("names the properties it compared, deduplicated and sorted", () => {
    const obs = observeSchema(["public.t.a", "public.t.b"], [
      probe("public.t.a", "present", "exists+data_type"),
      probe("public.t.b", "present", "exists"),
    ]);
    assert.deepEqual(obs.propertiesChecked, ["exists", "exists+data_type"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE COVERAGE GRADE — 2400 / 2401 / 2402, measured on production
// 2026-09-22 04:22:25 → 04:24:23 UTC
// ═══════════════════════════════════════════════════════════════════════════

/** The window the 2401/2402 reading was taken over. Two minutes, not an instant. */
const WINDOW: ObservationContext = {
  projectRef: "ajrurzioarfkagpuxfnb",
  observedAt: "2026-09-22T04:22:25Z",
  observedThrough: "2026-09-22T04:24:23Z",
};

/** 2401's two executable statements, both verified against what the file asserts. */
const STATEMENTS_2401: StatementCheck[] = [
  {
    index: 1,
    statement: "CREATE POLICY msg_select ON public.messages",
    property: "qual compared as text + permissive",
    verified: true,
    object: "msg_select",
  },
  {
    index: 2,
    statement: "CREATE POLICY messages_hide_blocked_sender ON public.messages AS RESTRICTIVE",
    property: "qual compared as text + permissive=RESTRICTIVE",
    verified: true,
    object: "messages_hide_blocked_sender",
  },
];

/**
 * 2401's attribution. `msg_select` is SHARED — 2402 recreates it — and
 * `messages_hide_blocked_sender` is the one object no other migration in the
 * tree creates, established by grep across src/migrations/*.sql.
 */
const ATTRIBUTION_2401: Attribution = {
  exclusive: ["messages_hide_blocked_sender"],
  shared: [{ object: "msg_select", alsoDeclaredBy: ["2402_telegraph_thread_authz.sql"] }],
  method: "grep across src/migrations/*.sql, 2026-09-22",
};

describe("coverage grade: the 2401/2402 class is not the 2890 class", () => {
  it("2400: in neither ledger AND no effect present — unambiguously missing", () => {
    const obs = classifyMigration(
      {
        filename: "2400_telegraph_history_bound.sql",
        declaredObjects: [
          "public.message_thread_members.visible_from_at",
          "trg_thread_members_visible_from",
          "telegraph_history_bound_enabled",
        ],
        probes: [
          probe("public.message_thread_members.visible_from_at", "absent"),
          probe("trg_thread_members_visible_from", "absent"),
          probe("telegraph_history_bound_enabled", "absent"),
        ],
        ledgerEvidence: [],
      },
      WINDOW,
    );
    assert.deepEqual(obs.dimensions, ["schema-missing-or-incompatible"]);
    assert.equal(obs.schema.absent.length, 3);
    assert.equal(obs.ledger.rowsByLedger.hand, 0);
    assert.equal(obs.ledger.rowsByLedger.cli, 0);
  });

  it("2401: FULL statement coverage — 2 of 2 statements, every one verified", () => {
    // MUTATION: make observeSchema() grant full coverage when
    // statementChecks.length > 0 without comparing against the declared total
    // → the 2402-partial case below stops failing and this suite's meaning is
    // gone; mutate `distinctChecked === total` to `>=` and a duplicate index
    // buys the grade.
    const obs = classifyMigration(
      {
        filename: "2401_telegraph_message_visibility.sql",
        declaredObjects: ["msg_select", "messages_hide_blocked_sender"],
        probes: [],
        ledgerEvidence: [],
        statements: { executableStatementCount: 2, checks: STATEMENTS_2401 },
        attribution: ATTRIBUTION_2401,
      },
      WINDOW,
    );
    assert.equal(obs.schema.dimension, "observed-schema-compatible");
    assert.equal(obs.schema.coverageGrade, "full-statement-coverage");
    assert.equal(obs.schema.executableStatementCount, 2);
    // It is STILL not an apply, and it still carries no ledger evidence.
    assert.ok(!obs.dimensions.includes("verified-execution"));
    assert.deepEqual(obs.dimensions, ["observed-schema-compatible"]);
    assert.equal(obs.ledger.verifiedExecution.length, 0);
  });

  it("2401's full-coverage line says what remains unknown, in the same breath", () => {
    const obs = classifyMigration(
      {
        filename: "2401_telegraph_message_visibility.sql",
        declaredObjects: ["msg_select", "messages_hide_blocked_sender"],
        probes: [],
        ledgerEvidence: [],
        statements: { executableStatementCount: 2, checks: STATEMENTS_2401 },
        attribution: ATTRIBUTION_2401,
      },
      WINDOW,
    );
    const line = obs.uncertainty.find((u) => u.startsWith("FULL STATEMENT COVERAGE"));
    // MUTATION: delete the FULL STATEMENT COVERAGE push in buildUncertainty()
    // → this fails, and the strongest observation in the vocabulary ships with
    // no statement of what it does not establish.
    assert.ok(line, `no full-coverage line: ${JSON.stringify(obs.uncertainty)}`);
    assert.match(line, /AND STILL NOT AN APPLY/);
    assert.match(line, /someone ran these statements by hand/);
    assert.match(line, /a later migration reproduced them/);
    assert.match(line, /whether the file executed, and when/);
  });

  it("full statement coverage suppresses the object-probe gap line, and only then", () => {
    // Under full coverage the statement that creates an unprobed object was
    // itself verified, so "object X was not probed" names no unknown. Printing
    // it beside the strongest claim in the vocabulary is noise, and noise
    // beside a strong claim is how the strong claim stops being read.
    // MUTATION: drop the `coverageGrade !== "full-statement-coverage"`
    // condition from the PARTIAL PROBE push → this fails.
    const full = classifyMigration(
      {
        filename: "2402_telegraph_membership_rls_recursion.sql",
        declaredObjects: ["authz.is_active_thread_member", "mtm_select", "mt_select"],
        probes: [],
        ledgerEvidence: [],
        statements: {
          executableStatementCount: 2,
          checks: STATEMENTS_2401,
        },
      },
      WINDOW,
    );
    assert.equal(full.schema.coverageGrade, "full-statement-coverage");
    assert.ok(!full.uncertainty.some((u) => u.startsWith("PARTIAL PROBE:")));

    // Partial coverage still prints it, and with correct grammar for one.
    const partial = classifyMigration(
      {
        filename: "2890_rank_events_behavior_engine_columns.sql",
        declaredObjects: ["public.rank_events.dwell_ms", "rank_events_dwell_pairing_check"],
        probes: [probe("public.rank_events.dwell_ms", "present")],
        ledgerEvidence: [],
      },
      WINDOW,
    );
    const line = partial.uncertainty.find((u) => u.startsWith("PARTIAL PROBE:"));
    assert.ok(line);
    assert.match(line, /1 was NOT looked at \(rank_events_dwell_pairing_check\)/);
  });

  it("a single unverified statement drops the grade AND the dimension", () => {
    const obs = observeSchema(
      ["msg_select", "messages_hide_blocked_sender"],
      [],
      {
        executableStatementCount: 2,
        checks: [STATEMENTS_2401[0], { ...STATEMENTS_2401[1], verified: false }],
      },
    );
    // MUTATION: drop `statementChecks.every((c) => c.verified)` from the grade
    // → coverageGrade stays full and this fails.
    assert.equal(obs.coverageGrade, "partial-coverage");
    assert.equal(obs.dimension, "schema-missing-or-incompatible");
  });

  it("checking 8 of 9 statements is PARTIAL, however many verify", () => {
    // 2402 has exactly 9 executable statements. Eight verified checks is not
    // coverage of the file; it is coverage of eight statements.
    const checks: StatementCheck[] = Array.from({ length: 8 }, (_, i) => ({
      index: i + 1,
      statement: `statement ${i + 1}`,
      property: "qual as text",
      verified: true,
    }));
    const obs = observeSchema(["msg_select"], [], {
      executableStatementCount: 9,
      checks,
    });
    assert.equal(obs.coverageGrade, "partial-coverage");
    assert.equal(obs.dimension, "observed-schema-compatible");
  });

  it("a declared total with NO checks is a claim about the file, not the database", () => {
    const obs = observeSchema(["msg_select"], [probe("msg_select", "present")], {
      executableStatementCount: 9,
      checks: [],
    });
    assert.equal(obs.coverageGrade, "partial-coverage");
  });

  it("labels the two grades apart wherever a dimension is printed", () => {
    // MUTATION: make dimensionLabel() return schema.dimension unconditionally
    // → this fails, and the report flattens 2401/2402 into 2890's class.
    const full = observeSchema([], [], {
      executableStatementCount: 2,
      checks: STATEMENTS_2401,
    });
    const partial = observeSchema(["public.t.a"], [probe("public.t.a", "present")]);
    assert.match(dimensionLabel(full), /FULL STATEMENT COVERAGE, 2 of 2 statements/);
    assert.match(dimensionLabel(full), /still not an apply/);
    assert.equal(dimensionLabel(partial), "observed-schema-compatible (PARTIAL COVERAGE)");
    assert.equal(
      dimensionLabel(observeSchema(["x"], [probe("x", "absent")])),
      "schema-missing-or-incompatible",
    );
  });
});

describe("attribution: which observed object is unique to this file", () => {
  it("names the exclusive object and the method that established it", () => {
    const obs = classifyMigration(
      {
        filename: "2401_telegraph_message_visibility.sql",
        declaredObjects: ["msg_select", "messages_hide_blocked_sender"],
        probes: [],
        ledgerEvidence: [],
        statements: { executableStatementCount: 2, checks: STATEMENTS_2401 },
        attribution: ATTRIBUTION_2401,
      },
      WINDOW,
    );
    const line = obs.uncertainty.find((u) => u.startsWith("ATTRIBUTABLE VIA"));
    assert.ok(line, `no attribution line: ${JSON.stringify(obs.uncertainty)}`);
    assert.match(line, /messages_hide_blocked_sender/);
    assert.match(line, /grep across src\/migrations/);
    // And the shared object is still named, because it credits this file no
    // more than it credits 2402.
    assert.ok(obs.uncertainty.some((u) => /SHARED OBJECTS/.test(u) && /msg_select/.test(u)));
  });

  it("refuses to attribute an observation whose every object is shared", () => {
    // 2402 recreates msg_select, so observing msg_select ALONE cannot tell
    // 2401-then-2402 from 2402-alone.
    // MUTATION: delete the exclusive.length === 0 branch in buildUncertainty()
    // → this fails, and a shared object silently credits the wrong migration.
    const obs = classifyMigration(
      {
        filename: "2401_telegraph_message_visibility.sql",
        declaredObjects: ["msg_select"],
        probes: [probe("msg_select", "present", "qual as text")],
        ledgerEvidence: [],
        attribution: {
          exclusive: [],
          shared: [
            { object: "msg_select", alsoDeclaredBy: ["2402_telegraph_thread_authz.sql"] },
          ],
          method: "grep across src/migrations/*.sql, 2026-09-22",
        },
      },
      WINDOW,
    );
    const line = obs.uncertainty.find((u) => u.startsWith("NOT ATTRIBUTABLE TO THIS FILE"));
    assert.ok(line, `no non-attribution line: ${JSON.stringify(obs.uncertainty)}`);
    assert.match(line, /2402 recreates 2401's/);
    assert.match(line, /msg_select ← 2402_telegraph_thread_authz\.sql/);
  });

  it("says 'not applicable' — not 'not attributable' — when nothing is present", () => {
    // 2400's every object is absent, so there is nothing to attribute to
    // anybody. The earlier wording printed "NOT ATTRIBUTABLE TO THIS FILE …
    // (…)" with an empty parenthesis, which reads as a finding about 2400
    // when it is only a consequence of an empty observation.
    // MUTATION: delete the `exclusive.length === 0 && shared.length === 0`
    // branch in buildUncertainty() → this fails.
    const obs = classifyMigration(
      {
        filename: "2400_telegraph_history_bound.sql",
        declaredObjects: ["public.message_thread_members.visible_from_at"],
        probes: [probe("public.message_thread_members.visible_from_at", "absent")],
        ledgerEvidence: [],
        attribution: { exclusive: [], shared: [], method: "grep" },
      },
      WINDOW,
    );
    assert.ok(obs.uncertainty.some((u) => u.startsWith("ATTRIBUTION NOT APPLICABLE")));
    assert.ok(!obs.uncertainty.some((u) => u.startsWith("NOT ATTRIBUTABLE TO THIS FILE")));
    assert.match(formatInventoryReport([obs], WINDOW), /attribution: n\/a — nothing was observed present/);
    // And it is NOT counted as a non-attribution finding.
    assert.equal(summariseInventory([obs], WINDOW).notAttributable, 0);

    // The same vacuous attribution on a COMPATIBLE observation — which is the
    // one the summary's filter actually looks at — is also not a finding.
    // MUTATION: drop `attribution.shared.length > 0` from the notAttributable
    // filter in summariseInventory() → this fails (it did not fail without
    // this half of the test, because the 2400 case above is incompatible and
    // the filter never reaches it).
    const compatibleButVacuous = classifyMigration(
      {
        filename: "2402_telegraph_membership_rls_recursion.sql",
        declaredObjects: [],
        probes: [],
        ledgerEvidence: [],
        statements: { executableStatementCount: 2, checks: STATEMENTS_2401 },
        attribution: { exclusive: [], shared: [], method: "grep" },
      },
      WINDOW,
    );
    assert.equal(compatibleButVacuous.schema.dimension, "observed-schema-compatible");
    assert.equal(summariseInventory([compatibleButVacuous], WINDOW).notAttributable, 0);
  });

  it("counts non-attributable compatible observations in the summary", () => {
    const shared = classifyMigration(
      {
        filename: "2401_telegraph_message_visibility.sql",
        declaredObjects: ["msg_select"],
        probes: [probe("msg_select", "present")],
        ledgerEvidence: [],
        attribution: {
          exclusive: [],
          shared: [
            { object: "msg_select", alsoDeclaredBy: ["2402_telegraph_thread_authz.sql"] },
          ],
          method: "grep",
        },
      },
      WINDOW,
    );
    const s = summariseInventory([shared], WINDOW);
    assert.equal(s.notAttributable, 1);
  });
});

describe("the observation window", () => {
  it("renders a window when the reading was not instantaneous", () => {
    assert.equal(
      formatObservationWindow(WINDOW),
      "2026-09-22T04:22:25Z → 2026-09-22T04:24:23Z",
    );
    assert.equal(formatObservationWindow(CTX), "2026-09-22T00:00:00.000Z");
    assert.equal(
      formatObservationWindow({ ...CTX, observedThrough: CTX.observedAt }),
      CTX.observedAt,
    );
  });

  it("carries the window onto every observation and into the report", () => {
    const obs = classifyMigration(
      {
        filename: "2402_telegraph_thread_authz.sql",
        declaredObjects: ["msg_select"],
        probes: [probe("msg_select", "present")],
        ledgerEvidence: [],
      },
      WINDOW,
    );
    assert.equal(obs.observedAt, "2026-09-22T04:22:25Z");
    assert.equal(obs.observedThrough, "2026-09-22T04:24:23Z");
    assert.match(
      formatInventoryReport([obs], WINDOW),
      /observed 2026-09-22T04:22:25Z → 2026-09-22T04:24:23Z/,
    );
  });

  it("refuses a window that ends before it begins", () => {
    assert.throws(
      () =>
        requireObservationContext({
          projectRef: "ajrurzioarfkagpuxfnb",
          observedAt: "2026-09-22T04:24:23Z",
          observedThrough: "2026-09-22T04:22:25Z",
        }),
      /ends \(.*\) before it begins/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CLASSIFIER — FOUR DIMENSIONS, NEVER COLLAPSED
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyMigration", () => {
  it("exposes exactly the four dimensions, and no 'applied'", () => {
    assert.deepEqual([...EVIDENCE_DIMENSIONS], [
      "verified-execution",
      "historical-backfill",
      "observed-schema-compatible",
      "schema-missing-or-incompatible",
    ]);
    assert.ok(!EVIDENCE_DIMENSIONS.includes("applied" as never));
  });

  it("2950: verified execution AND observed compatible, reported separately", () => {
    const obs = classifyMigration(
      {
        filename: "2950_input_assistance_telemetry_events.sql",
        declaredObjects: ["public.input_assistance_telemetry_events"],
        probes: [probe("public.input_assistance_telemetry_events", "present")],
        ledgerEvidence: [VERIFIED_ROW],
      },
      CTX,
    );
    assert.deepEqual(obs.dimensions, ["verified-execution", "observed-schema-compatible"]);
    assert.equal(obs.ledger.verifiedExecution.length, 1);
    assert.equal(obs.ledger.historicalBackfill.length, 0);
    assert.equal(obs.schema.dimension, "observed-schema-compatible");
    assert.equal(obs.serial, 2950);
  });

  it("2201: backfill only — and the uncertainty says so out loud", () => {
    const obs = classifyMigration(
      {
        filename: "2201_map_projection_flag.sql",
        declaredObjects: ["public.feature_flags"],
        probes: [probe("public.feature_flags", "present")],
        ledgerEvidence: [BACKFILL_ROW],
      },
      CTX,
    );
    assert.ok(!obs.dimensions.includes("verified-execution"));
    assert.ok(obs.dimensions.includes("historical-backfill"));
    assert.ok(obs.dimensions.includes("observed-schema-compatible"));
    // MUTATION: delete the "LEDGER EVIDENCE IS BACKFILL ONLY" push in
    // buildUncertainty() → this fails, and a backfill-plus-present-object
    // migration reads exactly like an apply.
    assert.ok(
      obs.uncertainty.some((u) => /LEDGER EVIDENCE IS BACKFILL ONLY/.test(u)),
      `uncertainty did not name the backfill: ${JSON.stringify(obs.uncertainty)}`,
    );
  });

  it("2298's class: a ledger row recording an apply whose objects are ABSENT", () => {
    const obs = classifyMigration(
      {
        filename: "2298_dead_check_vocabularies.sql",
        declaredObjects: ["rank_events_surface_check"],
        probes: [probe("rank_events_surface_check", "absent", "constraint_definition")],
        ledgerEvidence: [
          { ...VERIFIED_ROW, identity: "2298_dead_check_vocabularies.sql" },
        ],
      },
      CTX,
    );
    // BOTH dimensions, at once. Neither is dropped to make the other tidy.
    assert.ok(obs.dimensions.includes("verified-execution"));
    assert.ok(obs.dimensions.includes("schema-missing-or-incompatible"));
    assert.ok(
      obs.uncertainty.some((u) => /CONTRADICTION/.test(u)),
      `no contradiction recorded: ${JSON.stringify(obs.uncertainty)}`,
    );
  });

  it("2890's class: objects present, NO hand-ledger row — never 'verified'", () => {
    // Production's real state: all five rank_events columns present, and no
    // row in public.schema_migration_ledger. The CLI row exists but has no
    // checksum column to verify anything with.
    const declared = [
      "public.rank_events.dwell_kind",
      "public.rank_events.dwell_ms",
      "public.rank_events.privacy_class",
      "public.rank_events.retention_tier",
      "public.rank_events.schema_version",
    ];
    const obs = classifyMigration(
      {
        filename: "2890_rank_events_behavior_engine_columns.sql",
        declaredObjects: declared,
        probes: declared.map((o) => probe(o, "present", "exists+data_type+is_nullable+column_default")),
        ledgerEvidence: [
          {
            ledger: "cli",
            identity: "20260914193139",
            checksum: null,
            appliedBy: "supabase-cli-or-management-api",
            appliedAt: null,
            notes: "2890_rank_events_behavior_engine_columns",
          },
        ],
      },
      CTX,
    );
    // THE RULE: five of five objects present, and still not verified execution.
    // MUTATION: add `if (schema.dimension === "observed-schema-compatible")
    // dimensions.push("verified-execution")` to classifyMigration() → this
    // fails, and assertNoAppliedInference() throws before it can.
    assert.ok(!obs.dimensions.includes("verified-execution"));
    assert.deepEqual(obs.dimensions, ["observed-schema-compatible"]);
    assert.equal(obs.ledger.rowsByLedger.hand, 0);
    assert.equal(obs.ledger.rowsByLedger.cli, 1);
    assert.equal(obs.ledger.rowsWithoutVerification.length, 1);
    assert.equal(obs.schema.presentCount, 5);
  });

  it("2958's class: no row in EITHER ledger while the column exists", () => {
    const obs = classifyMigration(
      {
        filename: "2958_coverage_state.sql",
        declaredObjects: ["public.intel_coverage_snapshots.coverage_state"],
        probes: [
          {
            object: "public.intel_coverage_snapshots.coverage_state",
            property: "exists+data_type+is_nullable+column_default",
            state: "present",
            found: "text, nullable=NO, default='unknown'::text",
          },
        ],
        ledgerEvidence: [],
      },
      CTX,
    );
    assert.deepEqual(obs.dimensions, ["observed-schema-compatible"]);
    assert.equal(obs.ledger.rowsByLedger.hand, 0);
    assert.equal(obs.ledger.rowsByLedger.cli, 0);
    // MUTATION: delete the "NO LEDGER ROW IN EITHER TABLE" push → this fails,
    // and an absent row reads as evidence that the file never ran.
    assert.ok(
      obs.uncertainty.some((u) => /NO LEDGER ROW IN EITHER TABLE/.test(u)),
      `uncertainty did not name the absent rows: ${JSON.stringify(obs.uncertainty)}`,
    );
    assert.ok(obs.uncertainty.some((u) => /coverage_state/.test(u)));
  });

  it("a partial probe puts the gap in uncertainty, by object name", () => {
    const obs = classifyMigration(
      {
        filename: "2910_discovery_trails.sql",
        declaredObjects: [
          "public.discovery_trails",
          "discovery_trails_owner_read",
          "idx_discovery_trails_city",
        ],
        probes: [probe("public.discovery_trails", "present")],
        ledgerEvidence: [{ ...VERIFIED_ROW, identity: "2910_discovery_trails.sql" }],
      },
      CTX,
    );
    // MUTATION: delete the PARTIAL PROBE push in buildUncertainty() → this
    // fails, and "1 of 3 checked" ships as if it were three of three.
    const partial = obs.uncertainty.find((u) => u.startsWith("PARTIAL PROBE:"));
    assert.ok(partial, `no partial-probe line: ${JSON.stringify(obs.uncertainty)}`);
    assert.match(partial, /1 of 3 declared object\(s\) were examined/);
    assert.match(partial, /discovery_trails_owner_read/);
    assert.match(partial, /idx_discovery_trails_city/);
    assert.match(partial, /can create ten objects while a probe\s+checks two/);
  });

  it("records target, time, objects and properties on every observation", () => {
    const obs = classifyMigration(
      {
        filename: "2950_input_assistance_telemetry_events.sql",
        declaredObjects: ["public.input_assistance_telemetry_events"],
        probes: [
          probe("public.input_assistance_telemetry_events", "present", "exists+rls_enabled"),
        ],
        ledgerEvidence: [VERIFIED_ROW],
      },
      CTX,
    );
    assert.equal(obs.projectRef, "ajrurzioarfkagpuxfnb");
    assert.equal(obs.observedAt, "2026-09-22T00:00:00.000Z");
    assert.deepEqual(obs.schema.propertiesChecked, ["exists+rls_enabled"]);
    assert.ok(
      obs.uncertainty.some((u) => u.startsWith("PROPERTIES COMPARED: exists+rls_enabled")),
    );
  });

  it("refuses an unattributed observation: no project ref, no time, no answer", () => {
    // MUTATION: make requireObservationContext() return ctx unchecked → both
    // throws below stop happening and this fails. An unattributed measurement
    // is how "production carries zero" outlived the capture it came from.
    assert.throws(
      () => requireObservationContext({ projectRef: "", observedAt: "2026-09-22T00:00:00Z" }),
      /needs a project ref/,
    );
    assert.throws(
      () => requireObservationContext({ projectRef: "ajrurzioarfkagpuxfnb", observedAt: "  " }),
      /needs an observation time/,
    );
  });
});

describe("assertNoAppliedInference — the invariant, re-checked", () => {
  it("throws when 'verified-execution' is present with no qualifying row", () => {
    // Hand-built to simulate a future edit that routes a probe result into the
    // ledger dimension. This is the guard that makes the rule enforced rather
    // than documented.
    const forged: MigrationObservation = {
      filename: "2890_rank_events_behavior_engine_columns.sql",
      serial: 2890,
      projectRef: "ajrurzioarfkagpuxfnb",
      observedAt: "2026-09-22T00:00:00.000Z",
      ledger: {
        verifiedExecution: [],
        historicalBackfill: [],
        rowsWithoutVerification: [],
        rowsByLedger: { hand: 0, cli: 0 },
      },
      schema: observeSchema(["public.rank_events.dwell_ms"], [
        probe("public.rank_events.dwell_ms", "present"),
      ]),
      dimensions: ["verified-execution", "observed-schema-compatible"],
      uncertainty: [],
    };
    assert.throws(
      () => assertNoAppliedInference(forged),
      /Object existence is NOT evidence that a migration ran/,
    );
  });

  it("throws when the row in the verified bucket does not actually qualify", () => {
    const forged: MigrationObservation = {
      filename: "2298_dead_check_vocabularies.sql",
      serial: 2298,
      projectRef: "ajrurzioarfkagpuxfnb",
      observedAt: "2026-09-22T00:00:00.000Z",
      ledger: {
        // A backfill row smuggled into the verified bucket.
        verifiedExecution: [BACKFILL_ROW],
        historicalBackfill: [],
        rowsWithoutVerification: [],
        rowsByLedger: { hand: 1, cli: 0 },
      },
      schema: observeSchema([], []),
      dimensions: ["verified-execution"],
      uncertainty: [],
    };
    assert.throws(() => assertNoAppliedInference(forged), /with no ledger row carrying/);
  });

  it("passes an honest observation", () => {
    const honest = classifyMigration(
      {
        filename: "2950_input_assistance_telemetry_events.sql",
        declaredObjects: [],
        probes: [],
        ledgerEvidence: [VERIFIED_ROW],
      },
      CTX,
    );
    assert.doesNotThrow(() => assertNoAppliedInference(honest));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SUMMARY AND THE REPORT
// ═══════════════════════════════════════════════════════════════════════════

describe("summariseInventory", () => {
  const observations = (): MigrationObservation[] => [
    classifyMigration(
      {
        filename: "2950_input_assistance_telemetry_events.sql",
        declaredObjects: ["public.input_assistance_telemetry_events"],
        probes: [probe("public.input_assistance_telemetry_events", "present")],
        ledgerEvidence: [VERIFIED_ROW],
      },
      CTX,
    ),
    classifyMigration(
      {
        filename: "2201_map_projection_flag.sql",
        declaredObjects: ["public.feature_flags"],
        probes: [probe("public.feature_flags", "present")],
        ledgerEvidence: [BACKFILL_ROW],
      },
      CTX,
    ),
    classifyMigration(
      {
        filename: "2298_dead_check_vocabularies.sql",
        declaredObjects: ["rank_events_surface_check"],
        probes: [probe("rank_events_surface_check", "absent")],
        ledgerEvidence: [{ ...VERIFIED_ROW, identity: "2298_dead_check_vocabularies.sql" }],
      },
      CTX,
    ),
    classifyMigration(
      {
        filename: "2958_coverage_state.sql",
        declaredObjects: ["public.intel_coverage_snapshots.coverage_state"],
        probes: [probe("public.intel_coverage_snapshots.coverage_state", "present")],
        ledgerEvidence: [],
      },
      CTX,
    ),
  ];

  it("counts each dimension separately and offers NO combined 'applied' total", () => {
    const s = summariseInventory(observations(), CTX);
    assert.equal(s.total, 4);
    assert.equal(s.verifiedExecution, 2); // 2950 and 2298
    assert.equal(s.historicalBackfill, 1); // 2201
    // The two compatible grades are counted APART. Object probes cannot reach
    // full coverage, so all three land in partial.
    // MUTATION: collapse the two into one `observedSchemaCompatible` field →
    // this fails.
    assert.equal(s.observedSchemaCompatibleFullStatementCoverage, 0);
    assert.equal(s.observedSchemaCompatiblePartialCoverage, 3); // 2950, 2201, 2958
    assert.equal(s.schemaMissingOrIncompatible, 1); // 2298
    assert.equal(s.noLedgerRowEither, 1); // 2958
    // MUTATION: add an `applied` field summing verifiedExecution and the
    // compatible counts → this fails.
    assert.ok(!("applied" in s));
    assert.ok(!("observedSchemaCompatible" in s));
  });

  it("counts the two compatible GRADES apart when both are present", () => {
    // The previous case has no full-coverage observation, so a summary that
    // collapsed the grades would still produce the same numbers there. This
    // one has one of each, which is what makes the split load-bearing.
    // MUTATION: replace observedSchemaCompatiblePartialCoverage's filter with
    // `compatible.length` → this fails (it did not fail without this test).
    const full = classifyMigration(
      {
        filename: "2401_telegraph_message_visibility.sql",
        declaredObjects: ["msg_select", "messages_hide_blocked_sender"],
        probes: [],
        ledgerEvidence: [],
        statements: { executableStatementCount: 2, checks: STATEMENTS_2401 },
        attribution: ATTRIBUTION_2401,
      },
      CTX,
    );
    const partial = classifyMigration(
      {
        filename: "2958_coverage_state.sql",
        declaredObjects: ["public.intel_coverage_snapshots.coverage_state"],
        probes: [probe("public.intel_coverage_snapshots.coverage_state", "present")],
        ledgerEvidence: [],
      },
      CTX,
    );
    const s = summariseInventory([full, partial], CTX);
    assert.equal(s.observedSchemaCompatibleFullStatementCoverage, 1);
    assert.equal(s.observedSchemaCompatiblePartialCoverage, 1);
    // And the report prints them on two lines, with the "still not an apply"
    // clause attached to the stronger one.
    const report = formatInventoryReport([full, partial], CTX);
    assert.match(report, /compatible, FULL statement coverage 1/);
    assert.match(report, /compatible, PARTIAL coverage {8}1/);
    assert.match(report, /STILL NOT AN APPLY/);
  });

  it("counts BOTH directions of disagreement", () => {
    const s = summariseInventory(observations(), CTX);
    // 2298 (row, objects absent) and 2958 (objects present, no row anywhere).
    assert.equal(s.contradictions, 2);
    assert.equal(decideInventoryExitCode(s), 3);
  });

  it("exit 0 only when nothing disagrees", () => {
    const s = summariseInventory(
      [
        classifyMigration(
          {
            filename: "2950_input_assistance_telemetry_events.sql",
            declaredObjects: ["public.input_assistance_telemetry_events"],
            probes: [probe("public.input_assistance_telemetry_events", "present")],
            ledgerEvidence: [VERIFIED_ROW],
          },
          CTX,
        ),
      ],
      CTX,
    );
    assert.equal(s.contradictions, 0);
    assert.equal(decideInventoryExitCode(s), 0);
  });

  it("refuses to summarise without a target and a time", () => {
    assert.throws(() => summariseInventory([], { projectRef: "", observedAt: "x" }), /project ref/);
  });
});

describe("formatInventoryReport", () => {
  it("prints the two sections apart and refuses the sentence that caused this", () => {
    const report = formatInventoryReport(
      [
        classifyMigration(
          {
            filename: "2201_map_projection_flag.sql",
            declaredObjects: ["public.feature_flags", "idx_feature_flags_flag"],
            probes: [probe("public.feature_flags", "present")],
            ledgerEvidence: [BACKFILL_ROW],
          },
          CTX,
        ),
      ],
      CTX,
    );
    assert.match(report, /LEDGER EVIDENCE \(what a record says\)/);
    assert.match(report, /OBSERVED DATABASE STATE \(what the catalog holds\) — NOT proof anything ran/);
    assert.match(report, /ajrurzioarfkagpuxfnb/);
    assert.match(report, /2026-09-22T00:00:00\.000Z/);
    assert.match(report, /historical backfill 1/);
    assert.match(report, /verified execution  0/);
    assert.match(report, /NOT examined: idx_feature_flags_flag/);
    // MUTATION: delete the closing paragraph → this fails.
    assert.match(report, /NOTHING HERE SAYS 'N MIGRATIONS ARE APPLIED'/);
    // Both table names, so a reader cannot mistake which ledger a count came from.
    assert.match(report, /public\.schema_migration_ledger {2}keyed by filename/);
    assert.match(report, /supabase_migrations\.schema_migrations {2}keyed by version/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DECLARATION FLOOR
// ═══════════════════════════════════════════════════════════════════════════

describe("extractDeclaredObjects", () => {
  it("reads tables, added columns, indexes, functions, policies and triggers", () => {
    const declared = extractDeclaredObjects(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS public.discovery_trails (id uuid primary key, city text);
      ALTER TABLE public.rank_events
        ADD COLUMN IF NOT EXISTS dwell_ms integer,
        ADD COLUMN IF NOT EXISTS dwell_kind text,
        ADD CONSTRAINT rank_events_dwell_pairing_check CHECK (true);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_trails_city ON public.discovery_trails (city);
      CREATE OR REPLACE FUNCTION public.trail_touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE POLICY discovery_trails_owner_read ON public.discovery_trails FOR SELECT USING (true);
      CREATE TRIGGER trail_touch_trg BEFORE UPDATE ON public.discovery_trails FOR EACH ROW EXECUTE FUNCTION public.trail_touch();
      COMMIT;
    `);
    const keys = declared.map((d) => `${d.kind}:${d.key}`);
    assert.ok(keys.includes("table:public.discovery_trails"));
    assert.ok(keys.includes("column:public.rank_events.dwell_ms"));
    assert.ok(keys.includes("column:public.rank_events.dwell_kind"));
    assert.ok(keys.includes("constraint:rank_events_dwell_pairing_check"));
    assert.ok(keys.includes("index:idx_discovery_trails_city"));
    assert.ok(keys.includes("function:trail_touch"));
    assert.ok(keys.includes("policy:discovery_trails_owner_read"));
    assert.ok(keys.includes("trigger:trail_touch_trg"));
  });

  it("marks only tables and columns probeable, so the rest is declared-and-unexamined", () => {
    const declared = extractDeclaredObjects(`
      CREATE TABLE public.t (id uuid);
      ALTER TABLE public.t ADD COLUMN IF NOT EXISTS a text;
      CREATE INDEX idx_t_a ON public.t (a);
      CREATE POLICY t_read ON public.t FOR SELECT USING (true);
    `);
    // MUTATION: mark indexes probeable → this fails, and the report starts
    // claiming to have checked something the transport never looks at.
    const probeable = probeableObjects(declared).map((d) => d.kind);
    assert.deepEqual([...new Set(probeable)].sort(), ["column", "table"]);
    assert.equal(declared.length, 4);
    assert.equal(probeableObjects(declared).length, 2);
  });

  it("2890's commented-out rollback script is NOT a declaration", () => {
    // Verbatim shape of 2890's header: a complete DROP COLUMN rollback inside
    // `--` comments, plus the real ADD COLUMN below it. The caller strips
    // comments; this pins that a stripped input yields only the real claim.
    const withComments = `
      --   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS dwell_kind;
      --   ALTER TABLE public.rank_events DROP COLUMN IF EXISTS dwell_ms;
      ALTER TABLE public.rank_events
        ADD COLUMN IF NOT EXISTS schema_version smallint NOT NULL DEFAULT 1;
    `;
    const stripped = withComments
      .split("\n")
      .map((l) => (l.trimStart().startsWith("--") ? "" : l))
      .join("\n");
    const declared = extractDeclaredObjects(stripped);
    assert.deepEqual(
      declared.map((d) => d.key),
      ["public.rank_events.schema_version"],
    );
  });

  it("finds nothing in SQL that declares nothing", () => {
    assert.deepEqual(extractDeclaredObjects("SELECT 1;"), []);
    assert.deepEqual(extractDeclaredObjects(""), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIL CLOSED
// ═══════════════════════════════════════════════════════════════════════════

describe("requireCredentials", () => {
  it("refuses absent or empty credentials with exit 2, never 0", () => {
    const none = requireCredentials(undefined, undefined);
    assert.equal(none.ok, false);
    if (!none.ok) {
      assert.equal(none.exitCode, 2);
      assert.deepEqual(none.missing, ["url", "token"]);
    }
    const empty = requireCredentials("  ", "tok");
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.deepEqual(empty.missing, ["url"]);
  });

  it("trims and accepts a real pair", () => {
    const ok = requireCredentials(" https://ajrurzioarfkagpuxfnb.supabase.co ", " tok ");
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.url, "https://ajrurzioarfkagpuxfnb.supabase.co");
      assert.equal(ok.token, "tok");
    }
  });
});
