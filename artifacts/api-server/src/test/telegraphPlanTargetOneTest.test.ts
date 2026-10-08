/**
 * Lead ruling D-24a — ONE solo/group test. Telegraph's `readPlanTarget` (the shape `canCreatePlan` reads
 * under a hosting restriction) is now a call to lane C's `readTripShape` (lib/tripTrustGate.ts, on main
 * through #650), the function every Trips door and lane L's Compass gate call. Before, Telegraph carried
 * its own copy of the rule (census-telegraph §51.6 / §52.3), and two copies can drift apart.
 *
 * WHAT IS EXERCISED: both functions over the same certification-harness worlds, case by case, and the
 * policy source (no second read of trip membership in it).
 *
 * Run: node --import tsx/esm --test src/test/telegraphPlanTargetOneTest.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readPlanTarget } from "../domain/telegraph/policies/restrictionSendPolicy.js";
import { readTripShape } from "../lib/tripTrustGate.js";
import { makeFakeClient, type FakeDbOptions } from "./telegraphCertificationHarness.js";

const ANA = "22222222-0000-4000-8000-000000000002";
const BEN = "33333333-0000-4000-8000-000000000003";
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";

type Rows = Array<Record<string, unknown>>;
const CASES: Array<{ name: string; trips: Rows; members: Rows; opts?: FakeDbOptions; expect: "solo_trip" | "group_trip" | "unknown_trip" }> = [
  { name: "the actor alone", trips: [{ id: TRIP, owner_id: ANA }], members: [{ trip_id: TRIP, user_id: ANA, role: "owner", status: "accepted" }], expect: "solo_trip" },
  { name: "another accepted member", trips: [{ id: TRIP, owner_id: ANA }], members: [{ trip_id: TRIP, user_id: ANA, role: "owner", status: "accepted" }, { trip_id: TRIP, user_id: BEN, role: "member", status: "accepted" }], expect: "group_trip" },
  { name: "an invited (not accepted) person does not make it a group", trips: [{ id: TRIP, owner_id: ANA }], members: [{ trip_id: TRIP, user_id: ANA, role: "owner", status: "accepted" }, { trip_id: TRIP, user_id: BEN, role: "invited", status: "pending" }], expect: "solo_trip" },
  { name: "the owner counts even without a trip_members row", trips: [{ id: TRIP, owner_id: BEN }], members: [{ trip_id: TRIP, user_id: ANA, role: "member", status: "accepted" }], expect: "group_trip" },
  { name: "a status left unset counts as accepted", trips: [{ id: TRIP, owner_id: ANA }], members: [{ trip_id: TRIP, user_id: ANA, role: "owner" }, { trip_id: TRIP, user_id: BEN, role: "viewer" }], expect: "group_trip" },
  { name: "the trip row is not there", trips: [], members: [{ trip_id: TRIP, user_id: ANA, role: "owner", status: "accepted" }], expect: "unknown_trip" },
  { name: "trip_members unreadable", trips: [{ id: TRIP, owner_id: ANA }], members: [], opts: { errors: { trip_members: { message: "down" } } }, expect: "unknown_trip" },
  { name: "trips unreadable", trips: [{ id: TRIP, owner_id: ANA }], members: [], opts: { errors: { trips: { message: "down" } } }, expect: "unknown_trip" },
];

const KIND_TO_TARGET = { solo: "solo_trip", group: "group_trip", unreadable: "unknown_trip" } as const;

describe("D-24a — Telegraph's plan target IS lane C's solo/group test", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.expect}, the same answer readTripShape gives`, async () => {
      const db = makeFakeClient({ trips: c.trips, trip_members: c.members }, c.opts) as unknown as SupabaseClient;
      const target = await readPlanTarget(db, { tripId: TRIP, threadType: "trip", actorId: ANA });
      const shape = await readTripShape(db, TRIP, ANA);
      assert.equal(target, c.expect);
      assert.equal(target, KIND_TO_TARGET[shape.kind]);
    });
  }

  it("no trip id: a conversation, unless the thread says it is a trip's (then unknown, never solo)", async () => {
    const db = makeFakeClient({}) as unknown as SupabaseClient;
    assert.equal(await readPlanTarget(db, { tripId: null, threadType: "direct", actorId: ANA }), "conversation");
    assert.equal(await readPlanTarget(db, { tripId: null, threadType: "trip", actorId: ANA }), "unknown_trip");
  });

  it("the policy keeps no copy of the rule: it reads no trip membership itself", () => {
    const src = readFileSync(new URL("../domain/telegraph/policies/restrictionSendPolicy.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function readPlanTarget("), src.indexOf("export async function decideRestrictedSendInThread("));
    assert.match(fn, /await readTripShape\(sc, input\.tripId, input\.actorId\)/);
    assert.doesNotMatch(fn, /from\("trip_members"\)|from\("trips"\)/);
  });
});
