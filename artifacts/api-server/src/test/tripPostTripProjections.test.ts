/**
 * Trips spec §20 post-trip projections, pure and read. census-trips TR362
 * (TripMemoryProjection: trip → Memory candidates), TR363
 * (TripPassportProjection: trip → Passport), TR382 (durable outcomes are the
 * input), TR388 (the closeout projects the candidates).
 *
 * Run: node --import tsx/esm --test src/test/tripPostTripProjections.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildTripMemoryProjection, buildTripPassportProjection, latestOutcomeByPlan, readPostTripInputs, type PostTripInputs,
} from "../services/trips/TripPostTripProjections.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const PLACE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const NOW = new Date("2026-09-16T12:00:00.000Z");

const plan = (id: string, o: Partial<PostTripInputs["planItems"][number]> = {}): PostTripInputs["planItems"][number] => ({
  id, title: id, category: "activity", status: "done", dayDate: "2026-09-13", startsAt: null, endsAt: null, locationName: null, sourceType: "manual", sourceId: null, ...o,
});
const outcome = (id: string, planId: string, outcomeType: string, occurredAt: string, createdAt = occurredAt): PostTripInputs["outcomes"] extends readonly (infer T)[] | null ? T : never => ({
  id, planId, stageId: null, outcomeType, occurredAt, createdAt, evidence: {},
});
function inputs(over: Partial<PostTripInputs> = {}): PostTripInputs {
  return {
    trip: { id: TRIP_ID, title: "Paris", status: "completed", destinationCity: "Paris", destinationCountry: "France", startDate: "2026-09-12", endDate: "2026-09-15" },
    viewerId: OWNER_ID,
    planItems: [], outcomes: [], checkpoints: [], crew: [{ userId: OWNER_ID, role: "owner" }, { userId: MEMBER_ID, role: "member" }],
    memories: [], stamps: [], unread: [], now: NOW, ...over,
  };
}

describe("TripMemoryProjection — trip → Memory candidates (TR362, TR382)", () => {
  it("a done plan anchored to a place is a place_visited candidate carrying the POST /memories draft; one without a place is an activity; an uncertain plan is not offered", () => {
    const p = buildTripMemoryProjection(inputs({ planItems: [
      plan("louvre", { sourceType: "place", sourceId: PLACE_A, locationName: "Louvre", startsAt: "2026-09-13T09:00:00.000Z", endsAt: "2026-09-13T12:00:00.000Z" }),
      plan("picnic", { title: "Picnic" }),
      plan("maybe", { status: "tentative", title: "Maybe" }),
    ] }));
    const kinds = p.candidates.map((c) => [c.id, c.kind]);
    assert.deepEqual(kinds, [["plan:louvre", "place_visited"], ["plan:picnic", "activity_completed"], ["people", "people"]]);
    const louvre = p.candidates[0]!;
    assert.deepEqual(louvre.memoryDraft, { tripId: TRIP_ID, title: "Louvre", placeId: PLACE_A, startsAt: "2026-09-13T09:00:00.000Z", endsAt: "2026-09-13T12:00:00.000Z", locationCity: "Paris", locationCountry: "France" });
    assert.deepEqual(louvre.evidence, { source: "plan_status", ids: ["louvre"] });
    assert.equal(louvre.realized, null);
    assert.deepEqual(p.unrecordedDonePlanIds, ["louvre", "picnic"], "done plans with no outcome row are what the closeout records");
    assert.deepEqual(p.candidates[2]!.peopleUserIds, [MEMBER_ID], "never the viewer");
    assert.equal(p.realizedCount, 0);
  });
  it("the newest outcome row is the crew's last word: completed after skipped offers the plan, skipped after completed withdraws it, and a recorded plan is not unrecorded", () => {
    const p = buildTripMemoryProjection(inputs({
      planItems: [plan("a", { status: "confirmed" }), plan("b", { status: "done" }), plan("c", { status: "done" })],
      outcomes: [
        outcome("o1", "a", "skipped", "2026-09-13T20:00:00.000Z"), outcome("o2", "a", "completed", "2026-09-13T21:00:00.000Z"),
        outcome("o3", "b", "completed", "2026-09-13T20:00:00.000Z"), outcome("o4", "b", "skipped", "2026-09-13T20:00:00.000Z", "2026-09-14T00:00:01.000Z"),
      ],
    }));
    assert.deepEqual(p.candidates.filter((c) => c.kind !== "people").map((c) => [c.id, c.evidence.source, c.evidence.ids[0]]), [["plan:a", "outcome", "o2"], ["plan:c", "plan_status", "c"]]);
    assert.deepEqual(p.unrecordedDonePlanIds, ["c"], "a and b have outcome rows; only c has none");
    assert.equal(latestOutcomeByPlan(p.candidates.length ? [] : []).size, 0);
  });
  it("a memory of the viewer's at the same place, or on the same day with the same title, realizes the candidate; a deleted one does not", () => {
    const p = buildTripMemoryProjection(inputs({
      planItems: [plan("louvre", { sourceType: "place", sourceId: PLACE_A, locationName: "Louvre" }), plan("picnic", { title: "Picnic", dayDate: "2026-09-14" }), plan("gone", { title: "Gone" })],
      memories: [
        { id: "m1", title: "Anything", placeId: PLACE_A, startsAt: "2026-09-01T00:00:00.000Z", state: "published", mediaCount: 3 },
        { id: "m2", title: "picnic", placeId: null, startsAt: "2026-09-14T15:00:00.000Z", state: "published", mediaCount: 0 },
        { id: "m3", title: "Gone", placeId: null, startsAt: "2026-09-13T15:00:00.000Z", state: "deleted", mediaCount: 9 },
      ],
    }));
    // Same day: ordered by id, so "gone" precedes "louvre".
    assert.deepEqual(p.candidates.map((c) => [c.id, c.realized?.memoryId ?? null]), [["plan:gone", null], ["plan:louvre", "m1"], ["plan:picnic", "m2"], ["people", null]]);
    assert.equal(p.realizedCount, 2);
    assert.equal(p.candidates[1]!.realized?.mediaCount, 3);
    assert.deepEqual(p.media, { memories: 2, items: 3 }, "the deleted memory and its media are not counted");
  });
  it("a checkpoint the crew met at is a regroup_met candidate naming who arrived; one closed cancelled, or met by nobody, is not; a revoked stamp is not", () => {
    const p = buildTripMemoryProjection(inputs({
      checkpoints: [
        { id: "cp1", label: "Fountain", status: "met", placeId: null, meetAt: "2026-09-13T13:30:00.000Z", arrivedUserIds: [OWNER_ID, MEMBER_ID] },
        { id: "cp2", label: "Café", status: "cancelled", placeId: null, meetAt: null, arrivedUserIds: [] },
        { id: "cp3", label: "Gate", status: "met", placeId: null, meetAt: null, arrivedUserIds: [] },
      ],
      stamps: [
        { id: "s1", definitionId: "d1", slug: "first_trip_completed", name: "First Trip", city: "Paris", country: "France", earnedAt: "2026-09-15T20:00:00.000Z", revoked: false },
        { id: "s2", definitionId: "d2", slug: "long_haul", name: "Long Haul", city: null, country: null, earnedAt: "2026-09-15T20:00:00.000Z", revoked: true },
      ],
    }));
    assert.deepEqual(p.candidates.map((c) => c.id), ["checkpoint:cp1", "people", "stamp:s1"]);
    assert.equal(p.candidates[0]!.title, "Met the crew at Fountain");
    assert.deepEqual(p.candidates[0]!.peopleUserIds, [MEMBER_ID]);
    assert.equal(p.candidates[0]!.memoryDraft?.startsAt, "2026-09-13T13:30:00.000Z");
  });
  it("what was not read is said, not assumed: without outcomes nothing is unrecorded and the reading says plan status alone decides", () => {
    const p = buildTripMemoryProjection(inputs({ planItems: [plan("a")], outcomes: null, checkpoints: null, memories: null, stamps: null, unread: ["trip_outcomes", "trip_meeting_checkpoints", "memories", "user_stamps"] }));
    assert.equal(p.candidates[0]!.id, "plan:a");
    assert.deepEqual(p.unrecordedDonePlanIds, [], "no outcome row was read, so none can be said to be missing");
    assert.deepEqual(p.unread, ["trip_outcomes", "trip_meeting_checkpoints", "memories", "user_stamps"]);
    assert.match(p.reading, /trip_outcomes not read: plan status alone decides, nothing to record/);
    assert.match(p.reading, /memories not read: nothing is marked realized/);
    assert.equal(p.media, null);
  });
});

describe("TripPassportProjection — trip → Passport (TR363)", () => {
  it("countries and cities from the destination and the trip's stamps, de-duplicated; completion is the trip's recorded status", () => {
    const p = buildTripPassportProjection(inputs({ stamps: [
      { id: "s1", definitionId: "d1", slug: "first_trip_completed", name: "First Trip", city: "paris", country: "France", earnedAt: "2026-09-15T20:00:00.000Z", revoked: false },
      { id: "s2", definitionId: "d2", slug: "international_voyager", name: "Voyager", city: "Lyon", country: "France", earnedAt: "2026-09-15T20:00:00.000Z", revoked: false },
      { id: "s3", definitionId: "d3", slug: "x", name: "X", city: "Berlin", country: "Germany", earnedAt: null, revoked: true },
    ] }));
    assert.equal(p.projectionId, "TripPassportProjection");
    assert.equal(p.completed, true);
    assert.deepEqual(p.countries, ["France"]);
    assert.deepEqual(p.cities, ["Paris", "Lyon"]);
    assert.deepEqual(p.stamps!.map((s) => s.slug), ["first_trip_completed", "international_voyager"]);
  });
  it("an active trip has contributed nothing yet, and says so; unread stamps are null, not zero", () => {
    const p = buildTripPassportProjection(inputs({ trip: { ...inputs().trip, status: "active" }, stamps: null, unread: ["user_stamps"] }));
    assert.equal(p.completed, false);
    assert.match(p.reading, /completion is not yet recorded/);
    assert.equal(p.stamps, null);
    assert.deepEqual(p.countries, ["France"]);
  });
});

describe("readPostTripInputs — kernel-era tables only under the gate; a failed optional read is named", () => {
  function fixture() {
    const t = base();
    t.trips[0]!.destination_country = "France";
    t.trip_plan_items = [{ id: "p1", trip_id: TRIP_ID, title: "Louvre", status: "done", day_date: "2026-09-13", source_type: "place", source_id: PLACE_A, removed_at: null }];
    t.trip_outcomes = [{ id: "o1", trip_id: TRIP_ID, plan_id: "p1", stage_id: null, outcome_type: "completed", occurred_at: "2026-09-13T12:00:00.000Z", created_at: "2026-09-13T12:00:00.000Z", evidence_json: { source: "test" } }];
    t.trip_meeting_checkpoints = [{ id: "cp1", trip_id: TRIP_ID, label: "Fountain", status: "met", place_id: null, meet_at: "2026-09-13T13:30:00.000Z" }];
    t.trip_meeting_checkpoint_participants = [{ checkpoint_id: "cp1", user_id: OWNER_ID, arrival_state: "arrived" }, { checkpoint_id: "cp1", user_id: MEMBER_ID, arrival_state: "no_show" }];
    t.memories = [{ id: "m1", owner_id: OWNER_ID, trip_id: TRIP_ID, title: "Louvre", place_id: PLACE_A, starts_at: "2026-09-13T09:00:00.000Z", state: "published" }, { id: "m9", owner_id: MEMBER_ID, trip_id: TRIP_ID, title: "Not mine", place_id: PLACE_A, starts_at: null, state: "published" }];
    t.memory_items = [{ id: "i1", memory_id: "m1" }, { id: "i2", memory_id: "m1" }, { id: "i9", memory_id: "m9" }];
    t.user_stamps = [{ id: "s1", user_id: OWNER_ID, stamp_definition_id: "d1", source_type: "trips", source_id: TRIP_ID, earned_at: "2026-09-15T20:00:00.000Z", city: "Paris", country: "France", is_revoked: false }];
    t.stamp_definitions = [{ id: "d1", slug: "first_trip_completed", name: "First Trip" }];
    return t;
  }
  it("reads outcomes, checkpoints with who arrived, the viewer's memories and the viewer's stamps under the gate", async () => {
    const r = await readPostTripInputs(makeClient(fixture()) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const i = r.inputs;
    assert.equal(i.trip.destinationCountry, "France");
    assert.deepEqual(i.outcomes!.map((o) => [o.id, o.planId, o.outcomeType]), [["o1", "p1", "completed"]]);
    assert.deepEqual(i.checkpoints!.map((c) => [c.id, c.status, c.arrivedUserIds]), [["cp1", "met", [OWNER_ID]]]);
    assert.deepEqual(i.memories!.map((m) => [m.id, m.mediaCount]), [["m1", 2]], "another member's memory is not the viewer's, nor its media");
    assert.deepEqual(i.stamps!.map((s) => [s.slug, s.name]), [["first_trip_completed", "First Trip"]]);
    assert.deepEqual(i.unread, []);
    const memory = buildTripMemoryProjection(i);
    assert.deepEqual(memory.candidates.map((c) => [c.id, c.realized?.memoryId ?? null]), [["plan:p1", "m1"], ["checkpoint:cp1", null], ["people", null], ["stamp:s1", null]]);
    assert.deepEqual(memory.unrecordedDonePlanIds, []);
    assert.deepEqual(memory.media, { memories: 1, items: 2 });
  });
  it("with the gate off the kernel-era tables are not read and are named; a failing memories read is named and marks nothing realized", async () => {
    const off = fixture(); off.feature_flags = [];
    const r = await readPostTripInputs(makeClient(off, ["memories"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok);
    assert.equal(r.inputs.outcomes, null); assert.equal(r.inputs.checkpoints, null); assert.equal(r.inputs.memories, null);
    assert.deepEqual(r.inputs.unread, ["memories", "trip_outcomes", "trip_meeting_checkpoints"]);
    const memory = buildTripMemoryProjection(r.inputs);
    assert.deepEqual(memory.candidates.map((c) => [c.id, c.evidence.source, c.realized]), [["plan:p1", "plan_status", null], ["people", "crew", null], ["stamp:s1", "stamp", null]]);
    assert.deepEqual(memory.unrecordedDonePlanIds, []);
  });
  it("a trip that cannot be read, or does not exist, is a refusal by name", async () => {
    assert.deepEqual((await readPostTripInputs(makeClient(fixture(), ["trips"]) as any, TRIP_ID, OWNER_ID)).ok, false);
    const r = await readPostTripInputs(makeClient({ ...fixture(), trips: [] }) as any, TRIP_ID, OWNER_ID);
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, "TRIP_NOT_FOUND");
  });
});
