/**
 * Owner ruling 2026-10-12 (verbatim): "Keep `home_timezone` private by default.
 * Public schedules may show their destination/event timezone."
 * census-trips §94; the verifier's N1 on 3768 (VERIFY-STG e9c124100).
 *
 * `trips.home_timezone` (3768) is the OWNER's home zone: a fact about a person,
 * not about the trip. `trips.timezone` and `trip_stages.timezone` are the
 * destination's and the event's, and those are what schedules show.
 *
 * WHAT THIS FILE PINS
 * ===================
 * 1. ONE READER. Outside tests, migrations and census scripts, the tokens
 *    `home_timezone` / `homeTimezone` occur only in the files listed below. A
 *    new file naming them (a serializer, a projection, a schedule, the mobile
 *    app) fails here and has to be reviewed against the ruling. This is also
 *    why no schedule can show the home zone: none can name it.
 * 2. THE TRIP SERIALIZERS are allow-lists. Fed a row carrying the zone, neither
 *    the authorized view nor the private preview emits it.
 * 3. THE `select("*")` READS of `trips` in the server are an inventory. Each one
 *    is mapped through an allow-list serializer or never leaves the server; a
 *    new one fails here (it would carry the zone the moment its result is sent).
 * 4. 3769 strips the zone from every trip event, and its rollback exists.
 *
 * The visibility rule itself (owner only, by trips.owner_id) is pinned in
 * tripStageAnchors.test.ts and, through the route, in tripStructureRoute.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/tripHomeTimezonePrivacy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { toAuthorizedTripView, toPrivateTripPreview } from "../lib/privacy/tripSerializers.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const API_SRC = join(ROOT, "artifacts/api-server/src");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const isTestOrTooling = (rel: string) =>
  /(^|\/)(test|tests|__tests__|e2e|__mocks__)\//.test(rel) || /\.test\.(ts|tsx|js|mjs)$/.test(rel)
  || rel.startsWith("artifacts/api-server/src/migrations/") || rel.startsWith("artifacts/api-server/src/scripts/");

/** Every non-test source file that may name the home zone, and why. */
const HOME_TIMEZONE_READERS: Record<string, string> = {
  "artifacts/api-server/src/domain/trips/services/tripStageAnchors.ts":
    "the one read door; withholds the value from anyone but trips.owner_id",
  "artifacts/api-server/src/routes/tripStructure.ts":
    "serves it only when the anchors say the viewer is the owner",
  "artifacts/api-server/src/routes/trips.ts":
    "PATCH /trips/:id, owner-only (canEditTrip), echoes what the owner sent",
  "artifacts/api-server/src/domain/trips/contracts/tripReasonCodes.ts":
    "a comment naming the column in the availability marker's description",
};

describe("1. the home zone has one reader", () => {
  const roots = [API_SRC, join(ROOT, "lib"), join(ROOT, "travel-buddy-standalone/src"), join(ROOT, "travel-buddy-standalone/app")];
  const files = roots.flatMap((r) => walk(r));

  it("the scan saw the server and the app (not a vacuous pass)", () => {
    assert.ok(files.some((f) => f.endsWith("routes/trips.ts")), "routes/trips.ts was scanned");
    assert.ok(files.some((f) => f.includes("travel-buddy-standalone/src/services/trips.ts")), "the app's trips service was scanned");
  });

  it("only the listed files name home_timezone / homeTimezone", () => {
    const naming = files
      .map((f) => relative(ROOT, f))
      .filter((rel) => !isTestOrTooling(rel))
      .filter((rel) => /home_timezone|homeTimezone/.test(readFileSync(join(ROOT, rel), "utf8")))
      .sort();
    assert.deepEqual(naming, Object.keys(HOME_TIMEZONE_READERS).sort(),
      "a file outside the list names the owner's home zone. Owner ruling 2026-10-12: it is private by default — serve it to trips.owner_id only (domain/trips/services/tripStageAnchors.ts homeTimezoneVisibleTo), then add the file here with the reason.");
  });

  it("the structure route serves the value only under the anchors' visibility verdict", () => {
    const src = readFileSync(join(API_SRC, "routes/tripStructure.ts"), "utf8");
    assert.match(src, /readTripStageAnchors\(sc, tripId, user\.id\)/, "the route says who is looking");
    assert.match(src, /anchors\.homeTimezoneVisible\s*\?/, "the zone is behind the visibility verdict");
  });

  it("Today never asks for it (no viewer is named, so the reader withholds it)", () => {
    const src = readFileSync(join(API_SRC, "domain/trips/projections/TripTodayProjection.ts"), "utf8");
    assert.match(src, /readTripStageAnchors\(sc, tripId, null\)/);
  });
});

describe("2. the trip serializers are allow-lists", () => {
  const row = {
    id: "t1", owner_id: "u1", title: "T", destination_city: "Lisboa", destination_country: "Portugal",
    status: "planning", visibility: "public", timezone: "Europe/Lisbon", home_timezone: "Pacific/Chatham",
    show_destination_city: true, show_exact_dates: true, start_date: "2026-11-01", end_date: "2026-11-05",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  it("the authorized view keeps the destination zone and drops the home zone", () => {
    const v = toAuthorizedTripView(row) as unknown as Record<string, unknown>;
    assert.equal(v.timezone, "Europe/Lisbon");
    assert.equal(JSON.stringify(v).includes("Pacific/Chatham"), false);
  });
  it("the private preview drops it", () => {
    const v = toPrivateTripPreview(row, null, {});
    assert.equal(JSON.stringify(v).includes("Pacific/Chatham"), false);
  });
});

describe("3. select(\"*\") on trips in the server is an inventory", () => {
  /** file → number of `.from("trips")…select("*")` reads, and where each result goes. */
  const EXPECTED: Record<string, { count: number; why: string }> = {
    "artifacts/api-server/src/domain/trips/services/tripReadiness.ts": { count: 1, why: "computeReadiness reads dates/country/owner; the row is never returned" },
    "artifacts/api-server/src/lib/mapProjectionTripRead.ts": { count: 1, why: "mapped through toAuthorizedTripView" },
    "artifacts/api-server/src/routes/trips-expansion.ts": { count: 7, why: "every one mapped through toAuthorizedTripView / toPrivateTripPreview" },
  };
  it("no new select(\"*\") read of trips", () => {
    const found: Record<string, number> = {};
    for (const f of walk(API_SRC)) {
      const rel = relative(ROOT, f);
      if (isTestOrTooling(rel)) continue;
      const s = readFileSync(f, "utf8");
      const re = /from\(\s*["'`]trips["'`]\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const tail = s.slice(m.index, m.index + 400);
        const sel = /\.select\(\s*([^,)]*)/.exec(tail);
        if (sel && /^["'`]\s*\*/.test(sel[1]!.trim())) found[rel] = (found[rel] ?? 0) + 1;
      }
    }
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v.count]));
    assert.deepEqual(found, expected,
      "a select(\"*\") on trips carries trips.home_timezone (the owner's home zone). Name the columns, or map the row through an allow-list serializer and add it here.");
  });
  it("trips-expansion.ts answers trips only through the allow-list serializers", () => {
    const s = readFileSync(join(API_SRC, "routes/trips-expansion.ts"), "utf8");
    // every response that names a trips row variable goes through a serializer
    for (const m of s.matchAll(/res\.json\(\s*\{?\s*trips?\s*:\s*([^)}]*)/g)) {
      assert.match(m[1]!, /toAuthorizedTripView|toPrivateTripPreview|\[\]/, `unserialized trips response: ${m[0]}`);
    }
  });
});

describe("4. 3769 strips the zone from every trip event", () => {
  const sql = readFileSync(join(API_SRC, "migrations/3769_trip_events_home_timezone_minimised.sql"), "utf8");
  it("a BEFORE INSERT trigger on trip_events, its own (3976 replaces trip_event_minimised after it on a fresh chain)", () => {
    assert.match(sql, /CREATE TRIGGER trg_trip_events_home_timezone_minimise\s+BEFORE INSERT ON public\.trip_events/);
    assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.trip_event_minimised\b/);
  });
  it("result, payload, payload.patch and the top level", () => {
    assert.match(sql, /r := r - 'home_timezone';/);
    assert.match(sql, /'\{result\}', \(r->'result'\) - 'home_timezone'/);
    assert.match(sql, /'\{payload\}', \(r->'payload'\) - 'home_timezone'/);
    assert.match(sql, /'\{payload,patch\}', \(r->'payload'->'patch'\) - 'home_timezone'/);
  });
  it("no client role may execute it; postconditions recompute from the catalog", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.trip_event_home_timezone_removed\(jsonb\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.trip_events_home_timezone_minimise_on_insert\(\) FROM PUBLIC, anon, authenticated;/);
    const post = sql.slice(sql.indexOf("DO $post$"));
    assert.ok(post.length > 0 && !/pg_temp|current_setting\(/.test(post));
  });
  it("does not weaken append-only or any policy", () => {
    assert.doesNotMatch(sql, /trip_events_refuse_update|DROP POLICY|GRANT SELECT|DISABLE TRIGGER/);
  });
  it("its rollback exists and removes every object", () => {
    const rb = readFileSync(join(ROOT, "db/rollback/2026-10-12-3769-trip-events-home-timezone-minimised-rollback.sql"), "utf8");
    for (const t of ["DROP TRIGGER IF EXISTS trg_trip_events_home_timezone_minimise", "DROP FUNCTION IF EXISTS public.trip_events_home_timezone_minimise_on_insert()",
      "DROP FUNCTION IF EXISTS public.trip_event_home_timezone_removed(jsonb)", "a trace of 3769 survived"]) {
      assert.ok(rb.includes(t), t);
    }
  });
});
