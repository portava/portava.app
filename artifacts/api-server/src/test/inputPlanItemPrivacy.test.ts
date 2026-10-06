/**
 * OD-TRIP-3 — another member's PRIVATE place is never a plan-item suggestion.
 *
 * `searchPlans` (lib/inputAssistance/searchCandidates.ts) matched plan-item
 * titles across every admitted trip and returned each row to whoever typed,
 * whatever its `location_is_private` — and that column DEFAULTS TO TRUE
 * (baseline: `location_is_private boolean DEFAULT true NOT NULL`). The owner's
 * rule: owner-only by default; membership or organizer status grants nothing.
 *
 * Driven through the real `dispatchSearch` over the shared fake client, on both
 * sources of plan rows: the legacy table read (flag off, production today) and
 * the Trips projection (flag on).
 *
 *   node --import tsx/esm --test src/test/inputPlanItemPrivacy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { dispatchSearch, DiscoverySearchReadError } from "../lib/inputAssistance/searchCandidates.js";
import { DISCOVERY_TRIP_VIEWER_PROJECTIONS_FLAG } from "../lib/discoveryTripViewerConsumer.js";
import {
  canSeePlanItemLocation,
  ownerOnlyAccess,
  planItemAccessFor,
  withholdPrivatePlanItems,
  type PlanItemAccess,
} from "../lib/inputAssistance/planItemAccess.js";

const VIEWER = "viewer-1";
const OTHER = "owner-2";
type Rows = Record<string, Array<Record<string, unknown>>>;

const trip = (id: string, owner: string) => ({
  id, owner_id: owner, status: "planning", start_date: "2026-11-01", destination_city: "Kyoto",
  visibility: "public", show_in_discovery: true,
});
const item = (id: string, creator: string, isPrivate: boolean | undefined, title: string) => ({
  id, trip_id: "t-1", creator_id: creator, title, created_at: `2026-09-0${id.slice(-1)}T00:00:00.000Z`, removed_at: null,
  ...(isPrivate === undefined ? {} : { location_is_private: isPrivate }),
});

/** One public trip, owned by OTHER, with the viewer on it. */
function world(flagOn: boolean): Rows {
  return {
    feature_flags: flagOn ? [{ flag: DISCOVERY_TRIP_VIEWER_PROJECTIONS_FLAG, enabled: true }] : [],
    trips: [trip("t-1", OTHER)],
    trip_members: [{ trip_id: "t-1", user_id: VIEWER, role: "member", status: "accepted" }],
    profiles: [{ id: OTHER, account_status: "active" }, { id: VIEWER, account_status: "active" }],
    trip_plan_items: [
      item("p1", OTHER, true, "Ryokan Kyoto secret"),      // another member's PRIVATE place
      item("p2", OTHER, false, "Ryokan Kyoto shared"),     // another member's place, shared with the crew
      item("p3", VIEWER, true, "Ryokan Kyoto mine"),       // the viewer's own private place
      item("p4", OTHER, undefined, "Ryokan Kyoto unknown"), // a row that does not say — fail closed
    ],
  };
}

function db(rows: Rows, failures: Record<string, { message: string }> = {}): SupabaseClient {
  return makeLayoverDb(rows, { failures }) as unknown as SupabaseClient;
}

const ids = (rs: Array<{ id: string }>) => rs.map((r) => r.id).sort();

describe("OD-TRIP-3 — plan-item suggestions, legacy table read (flag off, production today)", () => {
  it("another member's PRIVATE place is not suggested; the shared one and the viewer's own are", async () => {
    const out = await dispatchSearch(db(world(false)), "ryokan", VIEWER, new Set(), new Set(), "plans", 0, 20);
    assert.deepEqual(ids(out), ["p2", "p3"]);
    assert.ok(!JSON.stringify(out).includes("secret"), "nothing of the private place — not even its title — is served");
  });

  it("a row that does not carry location_is_private is treated as private (fail closed)", async () => {
    const out = await dispatchSearch(db(world(false)), "unknown", VIEWER, new Set(), new Set(), "plans", 0, 20);
    assert.deepEqual(ids(out), []);
  });

  it("the creator sees their own private place", async () => {
    const out = await dispatchSearch(db(world(false)), "ryokan", OTHER, new Set(), new Set(), "plans", 0, 20);
    assert.deepEqual(ids(out), ["p1", "p2", "p4"]);
  });

  it("the read still asks for the two columns the rule decides on", async () => {
    const reads: string[] = [];
    const fake = makeLayoverDb(world(false)) as unknown as { from(t: string): { select(c: string): unknown } };
    const from = fake.from.bind(fake);
    fake.from = (t: string) => {
      const q = from(t) as { select(c: string): unknown };
      const sel = q.select.bind(q);
      q.select = (c: string) => { if (t === "trip_plan_items") reads.push(c); return sel(c); };
      return q;
    };
    await dispatchSearch(fake as unknown as SupabaseClient, "ryokan", VIEWER, new Set(), new Set(), "plans", 0, 20);
    assert.equal(reads.length, 1);
    assert.match(reads[0]!, /\bcreator_id\b/);
    assert.match(reads[0]!, /\blocation_is_private\b/);
  });

  it("an unreadable parent-trip read is still a named refusal, not an empty answer — even when every match is withheld", async () => {
    // "secret" matches only another member's private place. The rule is applied
    // AFTER the parent-trip read, so withholding it cannot turn an outage into
    // an empty list (D11's masquerade).
    await assert.rejects(
      dispatchSearch(db(world(false), { "trips:select": { message: "down" } }), "secret", VIEWER, new Set(), new Set(), "plans", 0, 20),
      (e: unknown) => e instanceof DiscoverySearchReadError,
    );
  });
});

describe("OD-TRIP-3 — plan-item suggestions, Trips projection (flag on)", () => {
  it("another member's place is withheld — the projection carries no location_is_private, so the rule fails closed", async () => {
    const out = await dispatchSearch(db(world(true)), "ryokan", VIEWER, new Set(), new Set(), "plans", 0, 20);
    // p2 is not private, but the projection cannot say so (dependency: Trips adds
    // the column to searchTripPlanItemProjections). Over-withholding is the safe
    // direction; the viewer's own place still surfaces.
    assert.deepEqual(ids(out), ["p3"]);
  });
});

describe("the seam's contract — lane C's, byte for byte where it is pure", () => {
  const rows = world(false).trip_plan_items as Array<Record<string, unknown>>;
  it("owner-only on this tree: no grant can exist, so no read is made and status is ok", async () => {
    const access = await planItemAccessFor(null, "t-1", VIEWER);
    assert.deepEqual(access, ownerOnlyAccess(VIEWER));
  });
  it("a grant from the creator, while sharing is on, admits exactly that item", () => {
    const granted: PlanItemAccess = { viewerId: VIEWER, status: "ok", grants: new Map([["p1", OTHER]]) };
    assert.deepEqual(rows.filter((r) => canSeePlanItemLocation(granted, r)).map((r) => r.id), ["p1", "p2", "p3"]);
    const forged: PlanItemAccess = { viewerId: VIEWER, status: "ok", grants: new Map([["p1", "someone-else"]]) };
    assert.ok(!canSeePlanItemLocation(forged, rows[0]!), "a grant not made by the creator admits nothing");
  });
  it("unreadable access withholds everything private of anyone else", () => {
    const out = withholdPrivatePlanItems(rows, ownerOnlyAccess(VIEWER, "unread", "shares could not be read"));
    assert.deepEqual(out.filter((r) => r.location_withheld === true).map((r) => r.id), ["p1", "p4"]);
    assert.ok(out.every((r) => r.location_withheld !== true || r.title === "Private plan"));
  });
  it("unread access fails closed EVEN WITH a non-empty grants map — the predicate does not lean on 'unread ⇒ no grants'", () => {
    // Re-verification of 62f960a7c (finding 3): only ownerOnlyAccess keeps the
    // invariant; a reader that returned status "unread" WITH grants admitted p1.
    const unread: PlanItemAccess = { viewerId: VIEWER, status: "unread", reason: "shares could not be read", grants: new Map([["p1", OTHER]]) };
    assert.ok(!canSeePlanItemLocation(unread, rows[0]!), "a grant carried on unread access admits nothing");
    assert.deepEqual(withholdPrivatePlanItems(rows, unread).filter((r) => r.location_withheld === true).map((r) => r.id), ["p1", "p4"]);
    assert.ok(canSeePlanItemLocation(unread, rows[2]!), "the viewer's own private place is still theirs");
    assert.ok(canSeePlanItemLocation(unread, rows[1]!), "a place that is not private is still not private");
  });
});
