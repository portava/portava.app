/**
 * The Highlights/Memories storage spine, measured against the PRODUCTION
 * schema snapshot rather than against a sentence in a census.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `docs/architecture/census-highlights-memories.md` carries, across §A to §N,
 * one blocker repeated on more than a hundred rows: *"migration 27xx — written,
 * and applied to no database."* §M.2 turned it into the document's headline
 * number — *"117 of 205 are one `supabase migration up` away"*.
 *
 * That sentence was true when it was written and is FALSE at this commit.
 * `artifacts/api-server/src/lib/capability/production-applied-migrations.json`
 * records 2710, 2711, 2720, 2721, 2722, 2723, 2724, 2730, 2338 and 2339 as
 * applied to production on 2026-09-15, and
 * `src/lib/capability/snapshots/20260915-production-schema.json` — a generated
 * read-only capture of `information_schema.columns`, not a hand edit — holds
 * every table and column they create.
 *
 * A census sentence cannot be re-checked by a build. THIS CAN. Every assertion
 * below reads the committed snapshot, so the next reader does not have to take
 * §O's word for it, and the claim cannot quietly rot back into being true.
 *
 * IT IS ALSO A DRIFT GUARD, AND THAT IS THE HALF THAT WILL EARN ITS KEEP.
 * Each module below names the columns it SELECTs. `probeHighlightObject`
 * classifies a missing column as `absent` — "this control is not deployed" —
 * which means one renamed column would silently turn an enforced §11 control
 * back into a no-op, logged as a migration nobody ran, with no test failing
 * anywhere. Asserting the code's column list against the deployed one is the
 * only thing standing between that and a silent fail-open.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It reads a SNAPSHOT of production, committed
 * on 2026-09-15, not production itself. If the snapshot is stale the assertions
 * are stale with it. It says nothing about ROW counts — a deployed table can be
 * empty, and `highlight_resurfacing_preferences` holding no rows suppresses
 * nothing however correct the schema is. And it says nothing about whether any
 * code WRITES these tables, which is a separate question and, for several of
 * them, still answered "nothing does".
 *
 * Run: node --import tsx/esm --test src/test/highlightsMemoriesDeployedStorage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RESURFACING_TABLE, RESURFACING_COLUMNS } from "../services/highlights/highlightResurfacing.js";
import { PROJECTION_POLICY_TABLE, PROJECTION_POLICY_COLUMNS } from "../services/highlights/highlightProjectionPolicy.js";
import { MEMORY_OUTBOX_TABLE, MEMORY_EVENT_TABLE } from "../lib/memoryOutbox.js";
import { DERIVATIVE_REGISTRY_TABLE } from "../services/memoryProjections/derivativeRegistry.js";

const SNAPSHOT = new URL("../lib/capability/snapshots/20260915-production-schema.json", import.meta.url);
const APPLIED = new URL("../lib/capability/production-applied-migrations.json", import.meta.url);

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
  productionMigrationWatermark: string;
  tables: Record<string, string[]>;
  flags: Record<string, boolean>;
};
const applied = JSON.parse(readFileSync(APPLIED, "utf8")) as {
  migrations: Array<{ version: string; name: string }>;
};
const appliedNames = new Set(applied.migrations.map((m) => m.name));

/**
 * The ten migrations the census names as unapplied, each with the object it
 * creates that proves it ran. A migration in the applied LIST and absent from
 * the SCHEMA would be a bookkeeping entry, not a deployment, so both are
 * asserted and the second is the one that matters.
 */
const MIGRATIONS: ReadonlyArray<{
  readonly migration: string;
  readonly table: string;
  readonly column?: string;
  readonly censusRows: string;
}> = [
  { migration: "2710_memory_command_kernel_tables", table: "memory_domain_events", censusRows: "H29, H30, H130-H141, H160, H175" },
  { migration: "2710_memory_command_kernel_tables", table: "memory_command_receipts", censusRows: "H29, H175" },
  { migration: "2710_memory_command_kernel_tables", table: "memory_event_outbox", censusRows: "H30, H147-H154, H160" },
  { migration: "2711_memory_kernel_execute", table: "memory_domain_events", column: "sequence", censusRows: "H147-H154, H160, H178" },
  { migration: "2720_highlight_resurfacing_preferences", table: "highlight_resurfacing_preferences", censusRows: "H86-H92, H187, H188, H210, H240, H260" },
  { migration: "2721_highlight_projection_policies", table: "highlight_projection_policies", censusRows: "H75, H81, H82, H200, H201, H241" },
  { migration: "2722_highlight_sources", table: "highlight_sources", censusRows: "H32, H93, H238" },
  { migration: "2723_highlight_class_lifecycle_and_pin", table: "highlights", column: "lifetime_class", censusRows: "H46, H94-H98, H142, H143, H257" },
  { migration: "2723_highlight_class_lifecycle_and_pin", table: "highlights", column: "pinned_at", censusRows: "H100, H142, H143" },
  { migration: "2724_highlight_revocation_log", table: "highlight_revocation_log", censusRows: "H192, H193" },
  { migration: "2730_memory_derivative_registry", table: "memory_derivative_registry", censusRows: "H34, H13, H110-H114, H174, H223, H258" },
  { migration: "2338_memory_location_precision", table: "memories", column: "location_precision", censusRows: "H44, H76, H79, H1" },
];

describe("the §3 / §12 storage spine is DEPLOYED — the census's repeated blocker is false at this commit", () => {
  for (const m of MIGRATIONS) {
    const what = m.column ? `${m.table}.${m.column}` : m.table;
    it(`${m.migration} is applied and ${what} exists in production (census ${m.censusRows})`, () => {
      assert.ok(
        appliedNames.has(m.migration),
        `${m.migration} is not in production-applied-migrations.json`,
      );
      const cols = snapshot.tables[m.table];
      assert.ok(Array.isArray(cols), `production has no table \`${m.table}\``);
      if (m.column) {
        assert.ok(
          cols.includes(m.column),
          `production \`${m.table}\` has no column \`${m.column}\`; it holds ${JSON.stringify(cols)}`,
        );
      }
    });
  }

  it("the snapshot's watermark is at or beyond the newest migration it claims", () => {
    // Without this, every assertion above could be satisfied by a snapshot that
    // predates the migrations and a list that was edited ahead of the database
    // — which is the exact failure `checkFlagSchemaPrerequisites` exists to
    // catch, asserted here for the ten migrations this census turns on.
    const newest = applied.migrations
      .map((x) => x.version)
      .sort()
      .at(-1)!;
    assert.ok(
      snapshot.productionMigrationWatermark >= newest,
      `snapshot watermark ${snapshot.productionMigrationWatermark} is behind the applied list's newest entry ${newest}`,
    );
  });
});

describe("every column these modules SELECT exists in the deployed table", () => {
  const CONTRACTS: ReadonlyArray<{ readonly module: string; readonly table: string; readonly columns: readonly string[] }> = [
    { module: "services/highlights/highlightResurfacing.ts", table: RESURFACING_TABLE, columns: RESURFACING_COLUMNS },
    { module: "services/highlights/highlightProjectionPolicy.ts", table: PROJECTION_POLICY_TABLE, columns: PROJECTION_POLICY_COLUMNS },
  ];
  for (const c of CONTRACTS) {
    it(`${c.module} → ${c.table}`, () => {
      const cols = snapshot.tables[c.table];
      assert.ok(Array.isArray(cols), `production has no table \`${c.table}\``);
      const missing = c.columns.filter((x) => !cols.includes(x));
      assert.deepEqual(
        missing,
        [],
        `${c.module} probes ${c.table} for ${JSON.stringify(missing)}, which production does not have — ` +
          "`probeHighlightObject` would classify that as `absent`, i.e. \"this control is not deployed\", " +
          "and the control would silently stop being enforced",
      );
    });
  }

  it("the tables the outbox and the derivative registry name are the deployed ones", () => {
    for (const t of [MEMORY_OUTBOX_TABLE, MEMORY_EVENT_TABLE, DERIVATIVE_REGISTRY_TABLE]) {
      assert.ok(Array.isArray(snapshot.tables[t]), `production has no table \`${t}\``);
    }
  });
});

describe("what deployment did NOT change, asserted so §O cannot be read as more than it says", () => {
  it("every flag that gates a Memory read path is still OFF in production", () => {
    // Applying a migration is not turning a feature on. Four of this census's
    // rows are blocked on a FLAG and not on a table, and after 2026-09-15 that
    // is the whole of their blocker. If one of these flips, the rows that name
    // it have to be re-read — so the fact is asserted rather than described.
    for (const flag of [
      "memory_kernel_enabled",
      "memory_location_precision_enabled",
      "memory_public_feed_projection_enabled",
      "highlights_feed_bounded_enabled",
    ]) {
      assert.equal(
        snapshot.flags[flag], false,
        `${flag} is no longer false in production; the census rows blocked on it must be re-read`,
      );
    }
  });

  it("`highlights` still carries NO trip reference, which is HIDE_TRIP's real blocker", () => {
    // Census H90 says HIDE_TRIP is blocked because "storage is 2720,
    // unapplied". 2720 IS applied, and the control still cannot be enforced on
    // the Highlights feed: `highlights` has no trip_id, so no trip-keyed
    // subject can be resolved for a Highlight at all. The blocker is a column
    // on a DIFFERENT table from the one the row names, which is why it is
    // asserted here rather than left as prose.
    const cols = snapshot.tables["highlights"]!;
    const tripish = cols.filter((c) => c.includes("trip"));
    assert.deepEqual(tripish, [], `highlights now carries ${JSON.stringify(tripish)}; HIDE_TRIP may be wirable`);
  });

  it("migration 2970 is still applied NOWHERE, so §K.4's presence filter reads undefined everywhere", () => {
    // §N.5 states this as a live risk and it is unchanged. It is asserted in
    // this file because this file is where "which migrations are applied" is
    // now mechanically checked, and a reader who sees ten of them turn green
    // must not infer the eleventh did.
    assert.equal(
      appliedNames.has("2970_stamp_definitions_evidences_presence"), false,
      "2970 is now applied; §K.4 / §L.4 / §N.4 must be re-read",
    );
  });
});
