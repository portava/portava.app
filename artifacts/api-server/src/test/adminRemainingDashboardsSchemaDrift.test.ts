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
 * COVERAGE FOLLOWS THE QUERY INTO lib/
 * ------------------------------------
 * These routes used to hold their own `requireAdmin`, so the
 * `.from("profiles").select("role")` chain lived in the route file and this
 * test guarded it there. The admin-guard consolidation moved that query into
 * the shared lib/requireAdmin.ts — at which point the route files stopped
 * matching and the `profiles` sanity checks failed.
 *
 * That failure was correct and it was NOT a parser bug: no schema-drift test
 * reads src/lib/, so consolidating the query moved it out of drift coverage
 * entirely. Deleting the `profiles` entries would have turned a real loss of
 * coverage on an AUTHORISATION query into a silent one.
 *
 * So the guard's source is appended to any route that imports it (see
 * `sourceFor`), and lib/requireAdmin.ts is additionally checked in its own
 * right below. The invariant: moving a query into a shared module moves its
 * drift coverage with it.
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

/** The shared admin guard — where the per-route `profiles` query now lives. */
const SHARED_GUARD = join(__dir, "..", "lib", "requireAdmin.ts");
const sharedGuardSource = readFileSync(SHARED_GUARD, "utf8");

/**
 * Source to extract from for a given route: the route itself, plus the shared
 * admin guard when the route imports it.
 *
 * Concatenating is sound for this extractor — it scans `.from("<table>")`
 * chains, which do not span a file boundary. It means a route's `profiles`
 * coverage keeps working whether the guard is local or shared, so this test
 * does not have to be edited again the next time a query is hoisted.
 */
function sourceFor(file: string): string {
  const src = readFileSync(routePath(file), "utf8");
  return src.includes("lib/requireAdmin.js")
    ? src + "\n" + sharedGuardSource
    : src;
}

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
  const source = sourceFor(file);

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

// ── The shared admin guard, in its own right ─────────────────────────────────
//
// The routes above cover it by import, but that coverage disappears the moment
// the last route in this file stops being listed. The guard gates ~30 route
// groups, so it gets a check that does not depend on who happens to import it.

describe("lib/requireAdmin.ts schema drift — the shared admin guard's profiles query", () => {
  it("finds the profiles query chain (parser sanity check)", () => {
    const refs = extractColumnRefs(sharedGuardSource, "profiles");
    assert.ok(
      refs.length >= 1,
      `expected to extract profiles column refs from lib/requireAdmin.ts — ` +
      `parser may be broken or the guard no longer queries profiles (got ${refs.length})`,
    );
  });

  it("every profiles column the guard selects exists in the live profiles table", () => {
    const live = LIVE_COLUMNS.profiles!;
    const bad = extractColumnRefs(sharedGuardSource, "profiles")
      .filter((r) => !live.has(r.column));
    assert.deepEqual(
      bad,
      [],
      `lib/requireAdmin.ts references profiles columns missing from the live schema — ` +
      `PostgREST fails the whole query on one unknown column, and this query is the ` +
      `admin authorisation check for every admin route: ` +
      bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(sharedGuardSource, r.index)})`).join(", "),
    );
  });

  it("covers the withDisplayName column list, not just the default one", () => {
    // The guard picks its select list with a ternary:
    //   opts.withDisplayName ? "role, display_name, username, handle" : "role"
    // Only `role` is on the default path, so a drift guard that saw literals
    // alone would silently skip the other three. admin.ts and
    // adminPlaceImages.ts both take the withDisplayName path.
    const cols = new Set(
      extractColumnRefs(sharedGuardSource, "profiles").map((r) => r.column),
    );
    for (const col of ["role", "display_name", "username", "handle"]) {
      assert.ok(
        cols.has(col),
        `'${col}' is selected by lib/requireAdmin.ts but the extractor did not ` +
        `see it — the withDisplayName branch is going unchecked`,
      );
    }
  });
});

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
