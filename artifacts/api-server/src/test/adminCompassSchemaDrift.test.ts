/**
 * Schema-drift guard for adminCompass.ts posts/events queries.
 *
 * Task background: adminCompass.ts once queried posts with dead columns
 * (post_type / is_verified / event_starts_at). PostgREST fails the whole
 * query on an unknown column, and Promise.allSettled + the "?? 0" defaults
 * silently zeroed the dashboard counts in production.
 *
 * This test statically extracts every column name referenced in query
 * chains rooted at `sc.from("posts")` / `sc.from("events")` inside
 * src/routes/adminCompass.ts — .select() lists and filter/order method
 * first arguments — and asserts each exists in the known LIVE schema
 * column list.
 *
 * Live column lists come from the generated snapshot
 * src/test/generated/liveColumns.json — refresh with:
 *   pnpm --filter @workspace/scripts run refresh:live-columns
 *
 * Run: node --import tsx/esm --test src/test/adminCompassSchemaDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractColumnRefs, lineOf } from "./helpers/schemaColumnExtractor.ts";
import { liveColumns } from "./helpers/liveColumns.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dir, "..", "routes", "adminCompass.ts");

// ── Live schema (generated snapshot — refresh with:
//    pnpm --filter @workspace/scripts run refresh:live-columns) ──────────────

const LIVE_POSTS_COLUMNS = liveColumns("posts");
const LIVE_EVENTS_COLUMNS = liveColumns("events");

const source = readFileSync(SOURCE_PATH, "utf8");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("adminCompass.ts schema drift — posts/events columns must exist live", () => {
  it("finds posts and events query chains (parser sanity check)", () => {
    const postsRefs = extractColumnRefs(source, "posts");
    const eventsRefs = extractColumnRefs(source, "events");
    assert.ok(
      postsRefs.length >= 3,
      `expected to extract column refs from posts queries — parser may be broken (got ${postsRefs.length})`,
    );
    assert.ok(
      eventsRefs.length >= 2,
      `expected to extract column refs from events queries — parser may be broken (got ${eventsRefs.length})`,
    );
  });

  it("every posts column referenced in adminCompass.ts exists in the live posts table", () => {
    const bad = extractColumnRefs(source, "posts")
      .filter((r) => !LIVE_POSTS_COLUMNS.has(r.column));
    assert.deepEqual(
      bad,
      [],
      `adminCompass.ts references posts columns missing from the live schema — ` +
      `PostgREST will fail these queries and the dashboard will silently zero out: ` +
      bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(source, r.index)})`).join(", "),
    );
  });

  it("every events column referenced in adminCompass.ts exists in the live events table", () => {
    const bad = extractColumnRefs(source, "events")
      .filter((r) => !LIVE_EVENTS_COLUMNS.has(r.column));
    assert.deepEqual(
      bad,
      [],
      `adminCompass.ts references events columns missing from the live schema — ` +
      `PostgREST will fail these queries and the dashboard will silently zero out: ` +
      bad.map((r) => `'${r.column}' via .${r.method}() (near line ${lineOf(source, r.index)})`).join(", "),
    );
  });

  it("catches the historical regression class (dead columns like post_type/is_verified/event_starts_at)", () => {
    // Guard the guard: the exact columns from the original bug must not be in
    // the live lists — if they ever appear here, this test's premise changed.
    for (const dead of ["post_type", "is_verified", "event_starts_at"]) {
      assert.ok(!LIVE_POSTS_COLUMNS.has(dead), `'${dead}' should not be a live posts column`);
    }
    // And the extractor would flag them: simulate a drifted query.
    const simulated = `sc.from("posts").select("id", { count: "exact", head: true }).eq("post_type", "event").eq("is_verified", true).lte("event_starts_at", now)`;
    const refs = extractColumnRefs(simulated, "posts");
    const flagged = refs.filter((r) => !LIVE_POSTS_COLUMNS.has(r.column)).map((r) => r.column);
    assert.deepEqual(
      flagged.sort(),
      ["event_starts_at", "is_verified", "post_type"],
      "extractor must flag the historical dead columns when present",
    );
  });
});
