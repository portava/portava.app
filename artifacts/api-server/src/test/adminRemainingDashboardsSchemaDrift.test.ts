/**
 * Schema-drift guard for the remaining admin dashboard routes:
 * adminStamps.ts, adminRankingMetrics.ts, trust-admin.ts, adminGeocode.ts.
 *
 * Same bug class as adminCompassSchemaDrift.test.ts and
 * adminGeoModerationSchemaDrift.test.ts: PostgREST fails the WHOLE query on
 * an unknown column, and admin dashboards using Promise.all/allSettled +
 * "?? 0" defaults silently zero their counts in production when a queried
 * column drifts from the live schema.
 *
 * This test statically extracts every column name referenced in query
 * chains rooted at `.from("<table>")` in each route file and asserts each
 * exists in the known LIVE schema column list.
 *
 * Live column lists come from the generated snapshot
 * src/test/generated/liveColumns.json — refresh with:
 *   pnpm --filter @workspace/scripts run refresh:live-columns
 *
 * Run: node --import tsx/esm --test src/test/adminRemainingDashboardsSchemaDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractColumnRefs, lineOf } from "./helpers/schemaColumnExtractor.ts";
import { liveColumns } from "./helpers/liveColumns.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const routePath = (name: string) => join(__dir, "..", "routes", name);

// ── Live schema (generated snapshot — refresh with:
//    pnpm --filter @workspace/scripts run refresh:live-columns) ──────────────

const LIVE_COLUMNS: Record<string, Set<string>> = Object.fromEntries(
  [
    "profiles", "stamp_award_events", "stamp_campaigns", "stamp_definitions",
    "rank_events", "trust_events", "trust_profiles", "trust_restrictions",
    "trust_reviews", "trust_settings",
  ].map((t) => [t, liveColumns(t)]),
);

// Route file → tables it queries (from `.from("<table>")` call sites).
const ROUTE_TABLES: Record<string, string[]> = {
  "adminStamps.ts": [
    "profiles", "stamp_award_events", "stamp_campaigns", "stamp_definitions",
  ],
  "adminRankingMetrics.ts": ["profiles", "rank_events"],
  "trust-admin.ts": [
    // trust_admin_actions is insert-only in this route (no select/filter
    // chains), so the read-path extractor has nothing to guard there.
    "profiles", "trust_events", "trust_profiles",
    "trust_restrictions", "trust_reviews", "trust_settings",
  ],
  "adminGeocode.ts": ["profiles"],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

for (const [file, tables] of Object.entries(ROUTE_TABLES)) {
  const source = readFileSync(routePath(file), "utf8");

  describe(`${file} schema drift — queried columns must exist live`, () => {
    it("finds query chains for every guarded table (parser sanity check)", () => {
      for (const table of tables) {
        const refs = extractColumnRefs(source, table);
        assert.ok(
          refs.length >= 1,
          `expected to extract column refs from ${table} queries in ${file} — ` +
          `parser may be broken or the route no longer queries this table (got ${refs.length})`,
        );
      }
    });

    for (const table of tables) {
      const live = LIVE_COLUMNS[table]!;
      it(`every ${table} column referenced in ${file} exists in the live ${table} table`, () => {
        const bad = extractColumnRefs(source, table).filter((r) => !live.has(r.column));
        assert.deepEqual(
          bad,
          [],
          `${file} references ${table} columns missing from the live schema — ` +
          `PostgREST will fail these queries and the dashboard will silently zero out: ` +
          bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(source, r.index)})`).join(", "),
        );
      });
    }
  });
}

describe("extractor guard-the-guard", () => {
  it("flags a simulated dead column in a trust query", () => {
    const simulated =
      `sc.from("trust_reviews").select("id", { count: "exact", head: true })` +
      `.eq("reviewer_id", userId).eq("status", "pending")`;
    const flagged = extractColumnRefs(simulated, "trust_reviews")
      .filter((r) => !LIVE_COLUMNS.trust_reviews!.has(r.column))
      .map((r) => r.column);
    assert.deepEqual(flagged, ["reviewer_id"],
      "extractor must flag a dead column referenced in a count query");
  });
});
