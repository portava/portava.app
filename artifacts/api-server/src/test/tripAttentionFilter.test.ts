/**
 * Trips spec §17.2 — "Commercial recommendations and entertainment discovery
 * are suppressed when a severe operational or safety state requires the
 * user's attention." census-trips TR319: the switch APPLIED to a list.
 *
 *   1. classification is by whole token, fail-closed: a pharmacy, a station
 *      and a "safety_tip" are safety/logistics; a bar, a beach and a
 *      "gastropub" are not; an unclassifiable candidate is not;
 *   2. nothing is withheld unless the switch was consulted AND suppresses;
 *   3. readTripAttention through the REAL health projection: an open regroup
 *      flips it to SAFETY_EVENT and the reading suppresses; a calm trip does
 *      not; the gate closed or a non-member is "not consulted", never "on".
 *
 * Run: node --import tsx/esm --test src/test/tripAttentionFilter.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SAFETY_LOGISTICS_TERMS, classifyForAttention, applyAttentionSuppression, attentionFrom, attentionNotConsulted,
  attentionOnTheWire, readTripAttention,
} from "../domain/trips/policies/TripAttentionFilter.js";
import { prioritySwitch } from "../domain/trips/services/TripHealth.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = new Date("2026-09-13T12:00:00.000Z");

const SUPPRESSING = prioritySwitch({ health: "DISRUPTED", reasons: [{ code: "SAFETY_NEEDS_HELP", level: "DISRUPTED", detail: "x", subjectIds: [] } as any] });
const CALM = prioritySwitch({ health: "HEALTHY", reasons: [] });

describe("classification is by whole token, fail-closed", () => {
  it("names a safety or logistics need → safety_logistics; anything else → commercial_entertainment", () => {
    assert.equal(classifyForAttention(["pharmacy"]), "safety_logistics");
    assert.equal(classifyForAttention(["Train Station"]), "safety_logistics");
    assert.equal(classifyForAttention(["safety_tip"]), "safety_logistics");
    assert.equal(classifyForAttention(["language_tip"]), "safety_logistics");
    assert.equal(classifyForAttention([null, undefined, "hotel"]), "safety_logistics");
    assert.equal(classifyForAttention(["bar"]), "commercial_entertainment");
    assert.equal(classifyForAttention(["beach", "nightlife"]), "commercial_entertainment");
    assert.equal(classifyForAttention(["gastropub"]), "commercial_entertainment", "\"gas\" must not match inside a word");
    assert.equal(classifyForAttention([]), "commercial_entertainment", "unclassifiable is withheld under suppression");
    assert.equal(classifyForAttention([null]), "commercial_entertainment");
    assert.ok(SAFETY_LOGISTICS_TERMS.includes("embassy"));
  });
});

describe("nothing is withheld unless the switch was consulted and suppresses", () => {
  const items = [{ id: "p", category: "pharmacy" }, { id: "b", category: "bar" }, { id: "u", category: null }];
  const termsOf = (i: { id: string; category: string | null }) => [i.category];
  it("null reading, not consulted, or NORMAL: everything kept, reason null", () => {
    for (const reading of [null, attentionNotConsulted(TRIP_ID, "gate closed"), attentionFrom(TRIP_ID, CALM)]) {
      const r = applyAttentionSuppression(items, reading, termsOf);
      assert.equal(r.kept.length, 3); assert.equal(r.withheld, 0); assert.equal(r.reason, null);
    }
  });
  it("suppressing: only safety/logistics kept, the rest counted, reason TRIP_DISRUPTION_SUPPRESSED", () => {
    const r = applyAttentionSuppression(items, attentionFrom(TRIP_ID, SUPPRESSING), termsOf);
    assert.deepEqual(r.kept.map((i) => i.id), ["p"]);
    assert.equal(r.withheld, 2); assert.equal(r.reason, "TRIP_DISRUPTION_SUPPRESSED");
    assert.match(r.detail!, /2 commercial or entertainment candidates withheld/);
    const wire = attentionOnTheWire(attentionFrom(TRIP_ID, SUPPRESSING), r.withheld);
    assert.equal(wire.suppressed, true); assert.equal(wire.mode, "SAFETY_EVENT"); assert.equal(wire.withheld, 2);
    assert.equal(wire.consulted, true); assert.equal(wire.tripId, TRIP_ID);
  });
});

describe("readTripAttention through the real health projection", () => {
  it("an open regroup with someone still expected → SAFETY_EVENT, suppressed; everyone arrived → NORMAL, not suppressed", async () => {
    const tables = base();
    tables.trip_meeting_checkpoints = [{ id: "cp1", trip_id: TRIP_ID, label: "Fountain", purpose: "regroup", status: "open" }];
    tables.trip_meeting_checkpoint_participants = [
      { checkpoint_id: "cp1", user_id: OWNER_ID, arrival_state: "arrived" },
      { checkpoint_id: "cp1", user_id: MEMBER_ID, arrival_state: "en_route" },
    ];
    let r = await readTripAttention(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.equal(r.consulted, true); assert.equal(r.mode, "SAFETY_EVENT"); assert.equal(r.suppressed, true);
    assert.equal(r.reason, "TRIP_DISRUPTION_SUPPRESSED"); assert.match(r.detail!, /§17\.2/);
    tables.trip_meeting_checkpoint_participants[1]!.arrival_state = "arrived";
    r = await readTripAttention(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.equal(r.consulted, true); assert.equal(r.mode, "NORMAL"); assert.equal(r.suppressed, false); assert.equal(r.reason, null);
  });
  it("gate closed → not consulted, not suppressed, and the reason names the flag", async () => {
    const tables = base();
    tables.feature_flags = [{ flag: "trip_operational_projections_enabled", enabled: false }];
    const r = await readTripAttention(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.equal(r.consulted, false); assert.equal(r.suppressed, false); assert.equal(r.attention, null);
    assert.match(r.info!, /not readable/);
  });
  it("a non-member → not consulted; an unreadable input → not consulted, never suppressed by default", async () => {
    let r = await readTripAttention(makeClient(base()) as any, TRIP_ID, OTHER_ID, { now: NOW });
    assert.equal(r.consulted, false); assert.match(r.info!, /not a member/);
    r = await readTripAttention(makeClient(base(), ["trip_disruptions"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.equal(r.consulted, false); assert.equal(r.suppressed, false); assert.match(r.info!, /could not be read/);
    r = await readTripAttention(makeClient(base(), ["trip_members"]) as any, TRIP_ID, MEMBER_ID, { now: NOW });
    assert.equal(r.consulted, false); assert.match(r.info!, /membership could not be checked/);
  });
});
