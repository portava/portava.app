/**
 * Schema-drift guard for admin.ts geo/moderation dashboard queries.
 *
 * Same bug class as adminCompassSchemaDrift.test.ts: PostgREST fails the
 * WHOLE query on an unknown column, and admin dashboards using
 * Promise.all/allSettled + "?? 0" defaults silently zero their counts in
 * production when a queried column drifts from the live schema.
 *
 * This test statically extracts every column name referenced in query
 * chains rooted at `.from("<table>")` inside src/routes/admin.ts for the
 * high-traffic geo/moderation tables and asserts each exists in the known
 * LIVE schema column list.
 *
 * Live column lists come from the generated snapshot
 * src/test/generated/liveColumns.json — refresh with:
 *   pnpm --filter @workspace/scripts run refresh:live-columns
 *
 * Run: node --import tsx/esm --test src/test/adminGeoModerationSchemaDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractColumnRefs, lineOf } from "./helpers/schemaColumnExtractor.ts";
import { liveColumns } from "./helpers/liveColumns.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dir, "..", "routes", "admin.ts");

// ── Live schema (generated snapshot — refresh with:
//    pnpm --filter @workspace/scripts run refresh:live-columns) ──────────────

const LIVE_COLUMNS: Record<string, Set<string>> = Object.fromEntries(
  ["geo_zones", "discovery_places", "reports", "moderation_actions", "user_account_states"]
    .map((t) => [t, liveColumns(t)]),
);

const source = readFileSync(SOURCE_PATH, "utf8");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("admin.ts schema drift — geo/moderation columns must exist live", () => {
  it("finds query chains for every guarded table (parser sanity check)", () => {
    for (const table of Object.keys(LIVE_COLUMNS)) {
      const refs = extractColumnRefs(source, table);
      assert.ok(
        refs.length >= 1,
        `expected to extract column refs from ${table} queries in admin.ts — ` +
        `parser may be broken or the route no longer queries this table (got ${refs.length})`,
      );
    }
  });

  for (const [table, live] of Object.entries(LIVE_COLUMNS)) {
    it(`every ${table} column referenced in admin.ts exists in the live ${table} table`, () => {
      const bad = extractColumnRefs(source, table).filter((r) => !live.has(r.column));
      assert.deepEqual(
        bad,
        [],
        `admin.ts references ${table} columns missing from the live schema — ` +
        `PostgREST will fail these queries and the dashboard will silently zero out: ` +
        bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(source, r.index)})`).join(", "),
      );
    });
  }

  it("flags a simulated dead column (guard-the-guard)", () => {
    const simulated =
      `sc.from("reports").select("id", { count: "exact", head: true })` +
      `.eq("reported_user_id", userId).eq("status", "open")`;
    const flagged = extractColumnRefs(simulated, "reports")
      .filter((r) => !LIVE_COLUMNS.reports!.has(r.column))
      .map((r) => r.column);
    assert.deepEqual(flagged, ["reported_user_id"],
      "extractor must flag a dead column referenced in a count query");
  });

  it("handles concatenated select strings and embedded resources", () => {
    // Mirrors the real admin.ts patterns: string-concat select lists and
    // embedded relations like discovery_place_reports(count).
    const simulated =
      `sc.from("discovery_places").select(` +
      `"id, name, place_type, " + "status, submitted_by, " + "discovery_place_reports(count)",` +
      `).gt("discovery_place_reports.count", 0).order("created_at", { ascending: false })`;
    const refs = extractColumnRefs(simulated, "discovery_places");
    const cols = refs.map((r) => r.column).sort();
    assert.deepEqual(cols, ["created_at", "id", "name", "place_type", "status", "submitted_by"],
      "must collect all concatenated literals, skip embedded resources/paths");
    const bad = refs.filter((r) => !LIVE_COLUMNS.discovery_places!.has(r.column));
    assert.deepEqual(bad, []);
  });
});
