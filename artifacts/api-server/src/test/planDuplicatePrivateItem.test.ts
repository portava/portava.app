/**
 * Lead ruling D-65 at the add-to-plan doors' DUPLICATE GUARDS (census-trips §87.3;
 * lane L's finding on the Compass proposal confirm, carried to the Trips doors).
 *
 * THE DEFECT. Each door below refused an add with 409 "already in your trip plan"
 * (the event door answered 200 `alreadyAdded` with the existing item's id) when ANY
 * live plan item on the trip carried the same source — including another member's
 * PRIVATE item. D-65 makes a private item's place and source identifiers owner-only,
 * so the refusal told the caller where that member privately plans to be (and the
 * event door handed over the item's id).
 *
 * THE RULE: only an item the caller may see — public, their own, or shared with them
 * while sharing is on — is a duplicate. Otherwise the caller's own item is added.
 *
 * Per door, through the real routes over the certification harness (caller ANA):
 *   P1. THE POINT: BEN's PRIVATE item for the same source → not a duplicate: ANA's own
 *       item is written, and nothing in the answer names BEN's item;
 *   P2. BEN's PUBLIC item → still a duplicate (nothing written);
 *   P3. ANA's own PRIVATE item → still a duplicate;
 *   P4. BEN's private item SHARED with ANA, sharing on → a duplicate;
 *   P5. the same grant with sharing OFF → not a duplicate (ANA's item written).
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/planDuplicatePrivateItem.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import planRouter from "../routes/plan.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import eventsRouter from "../routes/events.js";
import tripsRouter from "../routes/trips.js";
import { makeFakeClient, startRouter, call, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";

const ORGANIZER = "11111111-0000-4000-8000-000000000001";
const ANA = "22222222-0000-4000-8000-000000000002";
const BEN = "33333333-0000-4000-8000-000000000003";
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const EXISTING = "bbbbbbbb-0000-4000-8000-0000000000e1"; // the plan item already carrying the source
const GEM = "99999999-0000-4000-8000-000000000099";
const PLACE = "ffffffff-0000-4000-8000-00000000000f";
const MEETUP = "eeeeeeee-0000-4000-8000-00000000000e";
const EVENT = "e0e0e0e0-0000-4000-8000-0000000000e0";
const day = new Date().toISOString().slice(0, 10);
const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

type Rows = Array<Record<string, unknown>>;
interface Existing { creator: string; isPrivate: boolean; shared?: boolean; sharing?: boolean }

interface Door {
  name: string;
  path: string;
  body: Record<string, unknown>;
  sourceType: string;
  sourceId: string;
  /** Did the answer refuse (or short-circuit) as a duplicate? */
  duplicate: (r: { status: number; body: any }) => boolean;
}

const DOORS: Door[] = [
  { name: "meetup-add-to-plan", path: `/meetups/${MEETUP}/add-to-trip-plan`, body: { tripId: TRIP }, sourceType: "meetup", sourceId: MEETUP,
    duplicate: (r) => r.status === 409 && r.body?.error === "duplicate" },
  { name: "place-add-to-plan", path: `/places/${PLACE}/add-to-trip-plan`, body: { tripId: TRIP }, sourceType: "place", sourceId: PLACE,
    duplicate: (r) => r.status === 409 && r.body?.error === "duplicate" },
  { name: "gem-add-to-plan", path: `/hidden-gems/${GEM}/plan`, body: { tripId: TRIP }, sourceType: "hidden_gem", sourceId: GEM,
    duplicate: (r) => r.status === 409 && r.body?.error === "duplicate" },
  { name: "event-add-to-trip", path: `/events/${EVENT}/add-to-trip`, body: { tripId: TRIP }, sourceType: "event", sourceId: EVENT,
    duplicate: (r) => r.body?.alreadyAdded === true },
  { name: "plan-items-sourced", path: `/trips/${TRIP}/plan/items`, body: { title: "Cafe", category: "dining", sourceType: "place", sourceId: PLACE },
    sourceType: "place", sourceId: PLACE, duplicate: (r) => r.status === 409 && r.body?.error === "duplicate" },
];

function seed(d: Door, ex: Existing): Record<string, Rows> {
  const flags: Rows = [{ flag: "hidden_gems_enabled", enabled: true }, { flag: "trip_operational_projections_enabled", enabled: true }];
  if (ex.sharing) flags.push({ flag: "trip_private_anchor_sharing_enabled", enabled: true });
  return {
    feature_flags: flags,
    profiles: [ORGANIZER, ANA, BEN].map((id) => ({ id, handle: id.slice(0, 4), name: id.slice(0, 4), role: "user" })),
    trust_restrictions: [],
    trips: [{ id: TRIP, owner_id: ORGANIZER, version: 3, status: "active", plan_edit_permission: "all_members", start_date: day, end_date: day, title: "Group" }],
    trip_members: [
      { trip_id: TRIP, user_id: ORGANIZER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: ANA, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BEN, role: "member", status: "accepted" },
    ],
    trip_plan_items: [{
      id: EXISTING, trip_id: TRIP, creator_id: ex.creator, title: "Secret pick", category: "activity", status: "tentative",
      source_type: d.sourceType, source_id: d.sourceId, location_is_private: ex.isPrivate, lat: 38.7, lng: -9.1,
      day_date: day, starts_at: iso(2), ends_at: iso(3), sort_order: 0, removed_at: null,
    }],
    trip_private_anchor_shares: ex.shared ? [{ plan_item_id: EXISTING, trip_id: TRIP, owner_id: ex.creator, member_id: ANA, created_at: iso(-1) }] : [],
    events: [{ id: EVENT, host_id: BEN, state: "published", visibility: "public", title: "Fado night", starts_at: iso(6), ends_at: iso(8) }],
    hidden_gems: [{ id: GEM, status: "active", title: "Gem", submitted_by: BEN, created_at: iso(-72) }],
    places: [{ id: PLACE, name: "Cafe", category: "dining", latitude: 38.7, longitude: -9.1 }],
    discovery_places: [{ id: PLACE, name: "Cafe", category: "dining", city: "Lisbon", status: "active" }],
    meetups: [{ id: MEETUP, title: "Meetup", starts_at: iso(4), trip_id: null }],
  };
}

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  for (const r of [planRouter, hiddenGemsRouter, eventsRouter, tripsRouter]) all.use(r);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null as never);
  await harness.close();
});

function use(s: Record<string, Rows>): FakeClient {
  const c = makeFakeClient(s);
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
  return c;
}
const planInserts = (c: FakeClient) => c._observed.inserts.filter((w: any) => w.table === "trip_plan_items").length;

async function add(d: Door, ex: Existing) {
  const c = use(seed(d, ex));
  const r = await call(harness.base, "POST", d.path, ANA, d.body);
  return { c, r };
}

for (const d of DOORS) {
  describe(`D-65 duplicate guard: ${d.name}`, () => {
    it(`${d.name} P1. THE POINT: another member's PRIVATE item for the same source is not a duplicate — the caller's own item is added, and the answer names nothing of it`, async () => {
      const { c, r } = await add(d, { creator: BEN, isPrivate: true });
      assert.equal(d.duplicate(r), false, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(planInserts(c), 1, "the caller's own plan item is written");
      assert.doesNotMatch(JSON.stringify(r.body), new RegExp(`${EXISTING}|Secret pick`), "the answer names the private item");
    });
    it(`${d.name} P2. another member's PUBLIC item is still a duplicate`, async () => {
      const { c, r } = await add(d, { creator: BEN, isPrivate: false });
      assert.equal(d.duplicate(r), true, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(planInserts(c), 0);
    });
    it(`${d.name} P3. the caller's own PRIVATE item is still a duplicate`, async () => {
      const { c, r } = await add(d, { creator: ANA, isPrivate: true });
      assert.equal(d.duplicate(r), true, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(planInserts(c), 0);
    });
    it(`${d.name} P4. a private item SHARED with the caller, sharing on, is a duplicate`, async () => {
      const { c, r } = await add(d, { creator: BEN, isPrivate: true, shared: true, sharing: true });
      assert.equal(d.duplicate(r), true, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(planInserts(c), 0);
    });
    it(`${d.name} P5. the same grant with sharing OFF is not one`, async () => {
      const { c, r } = await add(d, { creator: BEN, isPrivate: true, shared: true, sharing: false });
      assert.equal(d.duplicate(r), false, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(planInserts(c), 1);
    });
  });
}
