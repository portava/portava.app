/**
 * census-discovery §81 (lane W10-S2) — A10: Discovery reads the two Trip-owned
 * projections Trips now publishes, behind `discovery_trip_viewer_projections_enabled`.
 * Register: D-W10S2-4 (and §57.10 Q3's answer).
 *
 * node:test + node:assert. Fake table-backed DB, no network.
 *
 * WHAT IS PINNED
 *   V1  `?context=going_soon`, flag OFF: the legacy reader's answer (owned trips
 *       in `planning`/`active` only) — byte-identical, and the Trips projection
 *       is not asked.
 *   V2  flag ON: Trips' definition — `upcoming` counts, a trip the viewer JOINED
 *       counts, cancelled/completed/draft/archived do not, no start date sorts
 *       last, ties by id.
 *   V3  flag ON, a failed read of either source: the projection REFUSES and the
 *       city is null — what the legacy reader's catch answered — never a
 *       different trip.
 *   V4  plan-item search, ON equals OFF byte for byte (same predicate, stated by
 *       Trips), including a removed item staying out; a refused projection is
 *       the same named read error the legacy read raised.
 *   V5  the plan-item projection carries exactly its six fields.
 *   V6  structure: each of the two direct reads now sits in the flag-OFF arm
 *       of a branch whose other arm calls the Trip-owned projection.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryTripViewerProjections.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { buildDiscoveryContext } from "../services/location/DiscoveryLocationContext.js";
import { dispatchSearch, DiscoverySearchReadError } from "../lib/inputAssistance/searchCandidates.js";
import { DISCOVERY_TRIP_VIEWER_PROJECTIONS_FLAG } from "../lib/discoveryTripViewerConsumer.js";
import { searchTripPlanItemProjections, readViewerNextTrip } from "../domain/trips/contracts/tripViewerProjections.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const VIEWER = "viewer-1";
const OTHER = "owner-2";
type Rows = Record<string, Array<Record<string, unknown>>>;

function trip(id: string, owner: string, status: string, start: string | null, city: string, over: Record<string, unknown> = {}) {
  return { id, owner_id: owner, status, start_date: start, destination_city: city, visibility: "public", show_in_discovery: true, ...over };
}

/** The viewer owns a planning trip to Osaka and an UPCOMING one to Tokyo, and JOINED one to Seoul that starts first. */
function tripsWorld(flag: boolean, over: Partial<Rows> = {}): Rows {
  return {
    feature_flags: flag ? [{ flag: DISCOVERY_TRIP_VIEWER_PROJECTIONS_FLAG, enabled: true }] : [],
    trips: [
      trip("t-osaka", VIEWER, "planning", "2026-11-20", "Osaka"),
      trip("t-tokyo", VIEWER, "upcoming", "2026-10-10", "Tokyo"),
      trip("t-seoul", OTHER, "active", "2026-10-01", "Seoul"),
      trip("t-old", VIEWER, "completed", "2026-01-01", "Lisbon"),
      trip("t-cancel", VIEWER, "cancelled", "2026-09-30", "Hanoi"),
    ],
    trip_members: [
      { trip_id: "t-seoul", user_id: VIEWER, role: "member", status: "accepted" },
      { trip_id: "t-pending", user_id: VIEWER, role: "member", status: "pending" },
    ],
    place_profiles: [],
    ...over,
  };
}

async function goingSoonCity(db: SupabaseClient): Promise<string | null> {
  const ctx = await buildDiscoveryContext({
    db, userId: VIEWER,
    prefs: { locationMode: "city_only", sharingPaused: false } as Parameters<typeof buildDiscoveryContext>[0]["prefs"],
    mode: "going_soon", currentCity: "Manila", currentCountry: "PH",
  });
  return ctx.targetCity === "Manila" ? null : ctx.targetCity;
}

function tracked(tables: Rows, failures: Record<string, { message: string }> = {}) {
  const fake = makeLayoverDb(tables, { failures });
  const reads: string[] = [];
  const from = fake.from.bind(fake);
  fake.from = (t: string) => { reads.push(t); return from(t); };
  return { db: fake as unknown as SupabaseClient, reads };
}

describe("V1 — going_soon, flag OFF: the legacy reader, byte-identical", () => {
  it("owned planning/active only: Osaka (the joined Seoul and the upcoming Tokyo are not counted), and trip_members is never read", async () => {
    const { db, reads } = tracked(tripsWorld(false));
    assert.equal(await goingSoonCity(db), "Osaka");
    assert.ok(!reads.includes("trip_members"), `the flag-off arm asked the projection: ${reads.join(",")}`);
  });
});

describe("V2 — going_soon, flag ON: Trips' definition of the viewer's next trip", () => {
  it("the joined trip that starts first wins: Seoul", async () => {
    assert.equal(await goingSoonCity(tracked(tripsWorld(true)).db), "Seoul");
  });

  it("without the membership, the UPCOMING owned trip wins over the later planning one: Tokyo", async () => {
    assert.equal(await goingSoonCity(tracked(tripsWorld(true, { trip_members: [] })).db), "Tokyo");
  });

  it("a pending membership is not a trip of the viewer's; completed/cancelled never count", async () => {
    const r = await readViewerNextTrip(tracked(tripsWorld(true, {
      trips: [trip("t-pending", OTHER, "active", "2026-09-01", "Busan"), trip("t-cancel", VIEWER, "cancelled", "2026-09-02", "Hanoi")],
    })).db, VIEWER);
    assert.ok(r.ok);
    assert.equal(r.ok ? r.trip : "refused", null);
  });

  it("no start date sorts LAST; equal starts break by trip id", async () => {
    const r = await readViewerNextTrip(tracked(tripsWorld(true, {
      trip_members: [],
      trips: [
        trip("t-b", VIEWER, "planning", "2026-10-10", "B-city"),
        trip("t-a", VIEWER, "planning", "2026-10-10", "A-city"),
        trip("t-none", VIEWER, "planning", null, "Nowhere"),
      ],
    })).db, VIEWER);
    assert.ok(r.ok && r.trip);
    assert.equal(r.ok && r.trip ? r.trip.tripId : null, "t-a");
  });
});

describe("V3 — going_soon, flag ON, a failed read: null, never another trip", () => {
  for (const failing of ["trips:select", "trip_members:select"]) {
    it(`${failing} unreadable → the projection refuses → the viewer's current city`, async () => {
      const { db } = tracked(tripsWorld(true), { [failing]: { message: "down" } });
      const r = await readViewerNextTrip(db, VIEWER);
      assert.equal(r.ok, false);
      assert.equal(await goingSoonCity(db), null);
    });
  }
});

// ── plan items ───────────────────────────────────────────────────────────────

function planWorld(flag: boolean): Rows {
  return {
    feature_flags: flag ? [{ flag: DISCOVERY_TRIP_VIEWER_PROJECTIONS_FLAG, enabled: true }] : [],
    trip_plan_items: [
      { id: "p1", title: "Harbour cruise", trip_id: "t-1", creator_id: OTHER, location_is_private: false, created_at: "2026-09-01T00:00:00.000Z", removed_at: null, notes: "secret", cost: 90 },
      { id: "p2", title: "Harbour walk", trip_id: "t-1", creator_id: OTHER, location_is_private: false, created_at: "2026-09-02T00:00:00.000Z", removed_at: null },
      { id: "p3", title: "Harbour dinner (removed)", trip_id: "t-1", creator_id: OTHER, location_is_private: false, created_at: "2026-09-03T00:00:00.000Z", removed_at: "2026-09-04T00:00:00.000Z" },
      { id: "p4", title: "Harbour private", trip_id: "t-2", creator_id: OTHER, location_is_private: false, created_at: "2026-09-05T00:00:00.000Z", removed_at: null },
    ],
    trips: [
      trip("t-1", OTHER, "planning", "2026-10-01", "Sydney"),
      trip("t-2", OTHER, "planning", "2026-10-01", "Sydney", { visibility: "private" }),
    ],
    profiles: [{ id: OTHER, account_status: "active" }],
  };
}

describe("V4 — plan-item search: ON equals OFF, and a refusal is the same named error", () => {
  it("the same results, byte for byte", async () => {
    const off = await dispatchSearch(tracked(planWorld(false)).db, "harbour", VIEWER, new Set(), new Set(), "plans", 0, 20);
    const on = await dispatchSearch(tracked(planWorld(true)).db, "harbour", VIEWER, new Set(), new Set(), "plans", 0, 20);
    assert.ok(off.length > 0, "fixture: the search must match something");
    assert.ok(!off.some((r) => r.id === "p3"), "fixture: a removed item is not a plan item");
    assert.equal(JSON.stringify(on), JSON.stringify(off));
  });

  it("flag ON with trip_plan_items unreadable: DiscoverySearchReadError('trip_plan_items'), exactly as OFF", async () => {
    for (const flag of [false, true]) {
      const { db } = tracked(planWorld(flag), { "trip_plan_items:select": { message: "down" } });
      await assert.rejects(
        dispatchSearch(db, "harbour", VIEWER, new Set(), new Set(), "plans", 0, 20),
        (e: unknown) => e instanceof DiscoverySearchReadError && e.message.includes("trip_plan_items"),
        `flag ${flag}`,
      );
    }
  });
});

describe("V5 — the plan-item projection carries its fields and nothing else", () => {
  it("six keys; no notes, cost or any other column", async () => {
    const r = await searchTripPlanItemProjections(tracked(planWorld(true)).db, { pattern: "%harbour%", offset: 0, limit: 20 });
    assert.ok(r.ok);
    if (!r.ok) return;
    for (const p of r.items) {
      assert.deepEqual(Object.keys(p).sort(), ["createdAt", "creatorId", "planItemId", "projectionSchemaVersion", "title", "tripId"]);
    }
    assert.deepEqual(r.items.map((p) => p.planItemId), ["p4", "p2", "p1"], "removed items out, newest first");
  });
});

describe("V6 — each remaining direct read is the flag-OFF arm beside a Trip-owned projection", () => {
  it("searchPlans: trip_plan_items is read only when the projection flag is off", () => {
    const src = readFileSync(path.join(SRC, "lib", "inputAssistance", "searchCandidates.ts"), "utf8");
    const at = src.indexOf('.from("trip_plan_items")');
    const stmt = src.lastIndexOf("const { data, error } =", at);
    assert.ok(stmt > 0 && at - stmt < 400, "the plan-item read must be one statement");
    assert.match(src.slice(stmt, at), /\(await discoveryTripViewerProjectionsOn\(sc\)\)\s*\?\s*await planItemRowsFromProjection\(sc,/);
  });

  it("getNextTripCity: the trips read is reached only when the projection flag is off", () => {
    const src = readFileSync(path.join(SRC, "services", "location", "DiscoveryLocationContext.ts"), "utf8");
    const fn = src.indexOf("async function getNextTripCity(");
    const at = src.indexOf('.from("trips")', fn);
    const between = src.slice(fn, at);
    assert.match(between, /if \(await discoveryTripViewerProjectionsOn\(db\)\) return nextTripCityFromProjection\(db, userId\);/);
  });
});
