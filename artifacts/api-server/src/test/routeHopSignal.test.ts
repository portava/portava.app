/**
 * Map spec §10 — the SECOND signal family (`accepted_plan`, lib/routeHopSignal),
 * and the acceptance transition it rests on.
 *
 * The prior audit refused to wire this family and named four blockers. These
 * tests are organized around those four, because a family wired without each one
 * genuinely closed is worse than no second family at all — MIN_SIGNAL_FAMILIES
 * would then be a rubber stamp:
 *
 *   1. NOTHING WAS EVER ACCEPTED  → POST /api/route-plans/:id/accept is the only
 *      writer of status='active'; a generated plan and an accepted one are
 *      distinguishable in the data; only the owner may accept; re-accepting does
 *      not re-stamp; and a NON-accepted plan contributes nothing.
 *   2. NO LAWFUL BASIS            → the `route_plan_itinerary` purpose exists and
 *      claims the tables, with a bounded retention.
 *   3. NO CONSENT FOR PUBLICATION → no consent, no hop; a consent-read FAILURE
 *      empties the cohort rather than filling it.
 *   4. COORDINATES, NOT ZONES     → THE LOAD-BEARING ONE. A sentinel coordinate
 *      is walked for through the entire path and must not survive; the
 *      derivation's input type cannot carry a point; an unresolvable stop is
 *      dropped rather than approximated.
 *
 * Plus the thing that actually decides whether §10 is satisfied at all: the
 * INDEPENDENCE CASE is present, complete, and names a residual limitation.
 *
 * Pure and offline except the two fake-client cases and the HTTP block.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import routePlanRouter from "../routes/routePlan.js";
import {
  ACCEPTED_PLAN_FAMILY,
  ACCEPTED_PLAN_INDEPENDENCE,
  ACCEPTED_PLAN_STATUS,
  ROUTE_FLOW_CONSENT_TABLE,
  deriveAcceptedPlanHops,
  readAcceptedPlanHops,
  resolveStopZones,
  type AcceptedPlanRow,
  type HopGroupKeyFn,
  type RouteLegRow,
  type StopZone,
} from "../lib/routeHopSignal.js";
import { LOCATION_PURPOSES, unboundedPrecisePurposes } from "../lib/locationPurposes.js";
import { deriveZoneTransitions, SIGNAL_MAX_AGE_MINUTES } from "../lib/crowdFlowProducer.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const ACCEPTED = new Date(NOW - 15 * 60_000).toISOString();

/**
 * Deliberately distinctive so a substring scan cannot miss them. The COORDINATE
 * sentinels are the point of this file: they must never appear in any output.
 */
const ACTOR = (n: number) => `ACTORSENTINEL${n}xyz`;
const TRIP = (n: number) => `TRIPSENTINEL${n}xyz`;
const PLAN = (n: number) => `PLANSENTINEL${n}xyz`;
const STOP = (n: number) => `STOPSENTINEL${n}xyz`;
/** Unique, searchable decimal expansions. If one shows up in output, it leaked. */
const LAT = (n: number) => 16.0500000001 + n / 1e6;
const LNG = (n: number) => 108.2200000001 + n / 1e6;

/** Zones by parity, so a two-stop plan always yields a real A→B hop. */
const zoneForPoint = (p: { lat: number; lng: number }): string | null => {
  const n = Math.round((p.lat - 16.0500000001) * 1e6);
  if (n < 0) return null;
  return n % 2 === 0 ? "zone-A" : "zone-B";
};

/** A group-key function that is stable, secret-free, and NOT the real HMAC. */
const fakeGroupKey: HopGroupKeyFn = (edge, identity) =>
  `GK:${edge.fromZoneId}>${edge.toZoneId}:${identity.kind === "crew" ? identity.crewId : identity.actorId}`;

function planRow(n: number, over: Partial<AcceptedPlanRow> = {}): AcceptedPlanRow {
  return { planId: PLAN(n), actorId: ACTOR(n), tripId: null, acceptedAt: ACCEPTED, ...over };
}
function stopZone(id: string, zoneId: string, updatedAt: string | null = null): StopZone {
  return { stopId: id, zoneId, updatedAt };
}
function leg(planId: string, from: string, to: string): RouteLegRow {
  return { planId, fromStopId: from, toStopId: to };
}

const derive = (
  input: Parameters<typeof deriveAcceptedPlanHops>[0],
  over: Partial<Parameters<typeof deriveAcceptedPlanHops>[1]> = {},
) =>
  deriveAcceptedPlanHops(input, {
    now: NOW,
    maxAgeMinutes: SIGNAL_MAX_AGE_MINUTES,
    groupKeyFor: fakeGroupKey,
    ...over,
  });

/** Every string that appears anywhere in a JSON-serializable value. */
function allStrings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, acc);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      acc.push(k);
      allStrings(x, acc);
    }
  }
  return acc;
}

// ═════════════════════════════════════════════════════════════════════════════
// BLOCKER 4 (the load-bearing one): ZONE GRANULARITY, NEVER A COORDINATE
// ═════════════════════════════════════════════════════════════════════════════

describe("§10 zone granularity — no coordinate reaches the flow", () => {
  it("resolveStopZones returns a shape with NO coordinate field at all", () => {
    const { stopZones } = resolveStopZones(
      [{ stopId: STOP(0), structuredLocation: { label: "Bar", lat: LAT(0), lng: LNG(0) }, updatedAt: null }],
      zoneForPoint,
    );
    assert.equal(stopZones.length, 1);
    // A closed, coordinate-free key set. This is the quarantine boundary: if a
    // lat/lng field is ever added here, the whole downstream argument collapses.
    assert.deepEqual(Object.keys(stopZones[0]).sort(), ["stopId", "updatedAt", "zoneId"]);
    assert.equal(stopZones[0].zoneId, "zone-A");
  });

  it("the sentinel coordinate does not survive the FULL path into ZoneTransitions", () => {
    // A publishable cohort: 20 accepted plans, 5 trips, each plan one A→B leg.
    const plans: AcceptedPlanRow[] = [];
    const rawStops: { stopId: string; structuredLocation: unknown; updatedAt: null }[] = [];
    const legs: RouteLegRow[] = [];
    for (let i = 0; i < 20; i++) {
      plans.push(planRow(i, { tripId: TRIP(i % 5) }));
      // Even index -> zone-A, odd -> zone-B, so a-to-b legs are real transitions.
      rawStops.push({ stopId: `${STOP(i)}-from`, structuredLocation: { label: "L", lat: LAT(0), lng: LNG(0) }, updatedAt: null });
      rawStops.push({ stopId: `${STOP(i)}-to`, structuredLocation: { label: "L", lat: LAT(1), lng: LNG(1) }, updatedAt: null });
      legs.push(leg(PLAN(i), `${STOP(i)}-from`, `${STOP(i)}-to`));
    }
    const { stopZones, unresolvedStopIds } = resolveStopZones(rawStops, zoneForPoint);
    const { signals, skipped } = derive({ plans, stopZones, legs, unresolvedStopIds });
    assert.equal(signals.length, 20, JSON.stringify(skipped));

    const { transitions, rejected } = deriveZoneTransitions(signals, {
      now: NOW,
      zoneCentroids: new Map([
        ["zone-A", { lat: 16.05, lng: 108.22 }],
        ["zone-B", { lat: 16.07, lng: 108.24 }],
      ]),
    });
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].distinctActors, 20);

    // THE COORDINATE PROOF, and it applies to EVERY stage including the
    // intermediate signals. The raw stop points were 16.0500000001 /
    // 16.0500010001 and 108.2200000001 / 108.2200010001. The zone CENTROIDS
    // (16.05, 108.22) are legitimately present in the transition; the STOP
    // points must appear nowhere at all.
    for (const bundle of [signals, skipped, transitions, rejected]) {
      const blob = JSON.stringify(bundle);
      for (const raw of [LAT(0), LAT(1), LNG(0), LNG(1)]) {
        assert.ok(!blob.includes(String(raw)), `stop coordinate ${raw} leaked into ${blob.slice(0, 300)}`);
      }
    }

    // THE IDENTIFIER PROOF, and it applies to the OUTPUT only — deliberately.
    // A MovementSignal is the counting INPUT: it carries actorId and groupKey by
    // design, they enter a Set inside deriveZoneTransitions and are never read
    // out again. What must be identifier-free is everything the producer
    // RETURNS. (This is the same split lib/crowdFlowProducer's own test makes.)
    for (const bundle of [transitions, rejected]) {
      for (const s of allStrings(JSON.parse(JSON.stringify(bundle)))) {
        assert.ok(!s.includes("SENTINEL"), `identifier fragment survived: ${s}`);
      }
    }
    // The published transition carries zone ids and centroids, nothing sharper.
    assert.equal(transitions[0].fromZoneId, "zone-A");
    assert.equal(transitions[0].toZoneId, "zone-B");
  });

  it("a stop that resolves to NO zone is dropped, never approximated to its point", () => {
    const { stopZones, unresolvedStopIds } = resolveStopZones(
      [
        { stopId: "s-ok", structuredLocation: { lat: LAT(0), lng: LNG(0) }, updatedAt: null },
        // Negative offset -> the resolver returns null.
        { stopId: "s-bad", structuredLocation: { lat: 15.0, lng: LNG(0) }, updatedAt: null },
      ],
      zoneForPoint,
    );
    assert.deepEqual(stopZones.map((z) => z.stopId), ["s-ok"]);
    assert.deepEqual(unresolvedStopIds, ["s-bad"]);

    const { signals, skipped } = derive({
      plans: [planRow(0)],
      stopZones,
      legs: [leg(PLAN(0), "s-ok", "s-bad")],
      unresolvedStopIds,
    });
    assert.deepEqual(signals, []);
    assert.deepEqual(skipped, [{ planId: PLAN(0), reason: "unresolved_zone" }]);
  });

  it("with NO zone resolver nothing resolves — fail-closed, not fall-back-to-point", () => {
    const { stopZones, unresolvedStopIds } = resolveStopZones(
      [{ stopId: "s", structuredLocation: { lat: LAT(0), lng: LNG(0) }, updatedAt: null }],
      undefined,
    );
    assert.deepEqual(stopZones, []);
    assert.deepEqual(unresolvedStopIds, ["s"]);
  });

  it("a malformed or out-of-range point is unresolvable, and a throwing resolver is contained", () => {
    const { stopZones, unresolvedStopIds } = resolveStopZones(
      [
        { stopId: "a", structuredLocation: null, updatedAt: null },
        { stopId: "b", structuredLocation: { lat: "16.05", lng: 108.2 }, updatedAt: null },
        { stopId: "c", structuredLocation: { lat: 91, lng: 108.2 }, updatedAt: null },
        { stopId: "d", structuredLocation: { lat: 16.05, lng: 181 }, updatedAt: null },
      ],
      zoneForPoint,
    );
    assert.deepEqual(stopZones, []);
    assert.deepEqual(unresolvedStopIds, ["a", "b", "c", "d"]);

    const thrower = () => { throw new Error("boom"); };
    const r = resolveStopZones(
      [{ stopId: "e", structuredLocation: { lat: LAT(0), lng: LNG(0) }, updatedAt: null }],
      thrower,
    );
    assert.deepEqual(r.stopZones, []);
    assert.deepEqual(r.unresolvedStopIds, ["e"]);
  });

  it("the derivation's INPUT cannot carry a point — the hop is built from zone ids only", () => {
    // Not a type assertion: a StopZone constructed by hand, with no resolver in
    // sight, produces a hop. Nothing downstream of resolveStopZones can consult
    // a coordinate because no coordinate is reachable from there.
    const { signals } = derive({
      plans: [planRow(0)],
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B")],
      legs: [leg(PLAN(0), "s1", "s2")],
    });
    assert.equal(signals.length, 1);
    assert.deepEqual(Object.keys(signals[0]).sort(), [
      "actorId", "family", "fromZoneId", "groupKey", "observedAt", "toZoneId",
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCKER 1: ONLY AN ACCEPTED PLAN CONTRIBUTES
// ═════════════════════════════════════════════════════════════════════════════

describe("§10 accepted_plan — only a traveller's declaration contributes", () => {
  it("the family reads ONLY status='active' — a draft is not a declaration", () => {
    assert.equal(ACCEPTED_PLAN_STATUS, "active");
    assert.equal(ACCEPTED_PLAN_FAMILY, "accepted_plan");
  });

  it("one accepted plan contributes ONE person, however many legs it has", () => {
    const { signals } = derive({
      plans: [planRow(0)],
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B"), stopZone("s3", "zone-C")],
      legs: [leg(PLAN(0), "s1", "s2"), leg(PLAN(0), "s2", "s3")],
    });
    assert.equal(signals.length, 2);
    assert.equal(new Set(signals.map((s) => s.actorId)).size, 1);
    // Two edges, and the producer buckets each separately, so a 3-stop itinerary
    // cannot be read back out of the aggregate.
    assert.deepEqual(signals.map((s) => `${s.fromZoneId}>${s.toZoneId}`), ["zone-A>zone-B", "zone-B>zone-C"]);
  });

  it("an acceptance older than the freshness window contributes nothing", () => {
    const stale = new Date(NOW - (SIGNAL_MAX_AGE_MINUTES + 5) * 60_000).toISOString();
    const { signals, skipped } = derive({
      plans: [planRow(0, { acceptedAt: stale })],
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B")],
      legs: [leg(PLAN(0), "s1", "s2")],
    });
    assert.deepEqual(signals, []);
    // The PLAN is refused once, and each of its legs is then reported as
    // belonging to a plan that is not readable. Both halves are stated; nothing
    // is dropped silently.
    assert.deepEqual(skipped, [
      { planId: PLAN(0), reason: "stale_acceptance" },
      { planId: PLAN(0), reason: "unknown_plan" },
    ]);
  });

  it("a future acceptance is refused — an untrusted clock buys nothing", () => {
    const { signals, skipped } = derive({
      plans: [planRow(0, { acceptedAt: new Date(NOW + 60_000).toISOString() })],
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B")],
      legs: [leg(PLAN(0), "s1", "s2")],
    });
    assert.deepEqual(signals, []);
    assert.deepEqual(skipped, [
      { planId: PLAN(0), reason: "future_acceptance" },
      { planId: PLAN(0), reason: "unknown_plan" },
    ]);
  });

  it("a stale plan is refused ONCE, not once per leg", () => {
    const stale = new Date(NOW - (SIGNAL_MAX_AGE_MINUTES + 5) * 60_000).toISOString();
    const { skipped } = derive({
      plans: [planRow(0, { acceptedAt: stale })],
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B"), stopZone("s3", "zone-C")],
      legs: [leg(PLAN(0), "s1", "s2"), leg(PLAN(0), "s2", "s3")],
    });
    assert.equal(skipped.filter((s) => s.reason === "stale_acceptance").length, 1);
    // The legs are still reported, as belonging to a plan that is not readable.
    assert.equal(skipped.filter((s) => s.reason === "unknown_plan").length, 2);
  });

  it("a leg whose stop MOVED after acceptance is dropped — legs are not recomputed on reorder", () => {
    const after = new Date(NOW - 5 * 60_000).toISOString(); // later than ACCEPTED
    const { signals, skipped } = derive({
      plans: [planRow(0)],
      stopZones: [stopZone("s1", "zone-A", after), stopZone("s2", "zone-B")],
      legs: [leg(PLAN(0), "s1", "s2")],
    });
    assert.deepEqual(signals, []);
    assert.deepEqual(skipped, [{ planId: PLAN(0), reason: "stop_modified_after_acceptance" }]);
  });

  it("a leg pointing at a stop row that is not there is named differently from an unplaced one", () => {
    const { skipped } = derive({
      plans: [planRow(0)],
      stopZones: [stopZone("s1", "zone-A")],
      legs: [leg(PLAN(0), "s1", "s-absent")],
      unresolvedStopIds: [],
    });
    assert.deepEqual(skipped, [{ planId: PLAN(0), reason: "missing_stop" }]);
  });

  it("malformed input is reported, never silently dropped", () => {
    const { signals, skipped } = derive({
      plans: [planRow(0, { actorId: "" }), planRow(1, { acceptedAt: "not-a-date" })],
      stopZones: [],
      legs: [],
    });
    assert.deepEqual(signals, []);
    assert.deepEqual(skipped.map((s) => s.reason), ["invalid_input", "invalid_input"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE GROUP TOKEN — one trip is one party
// ═════════════════════════════════════════════════════════════════════════════

describe("§10 accepted_plan — the party token follows lib/intelGroupKey's ruling", () => {
  it("five friends on ONE trip who each accept their own plan collapse to ONE party", () => {
    const plans = Array.from({ length: 5 }, (_, i) => planRow(i, { tripId: TRIP(0) }));
    const { signals } = derive({
      plans,
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B")],
      legs: plans.map((p) => leg(p.planId, "s1", "s2")),
    });
    assert.equal(signals.length, 5);
    assert.equal(new Set(signals.map((s) => s.actorId)).size, 5, "five distinct people");
    assert.equal(new Set(signals.map((s) => s.groupKey)).size, 1, "but ONE party");

    // ...and the privacy gate sees exactly that: one group holding every grouped
    // actor reads maxGroupShare 1.0, the "one large party is not a crowd" ceiling.
    const { transitions } = deriveZoneTransitions(signals, {
      now: NOW,
      zoneCentroids: new Map([
        ["zone-A", { lat: 16.05, lng: 108.22 }],
        ["zone-B", { lat: 16.07, lng: 108.24 }],
      ]),
    });
    assert.equal(transitions[0].distinctActors, 5);
    assert.equal(transitions[0].distinctGroups, 1);
    assert.equal(transitions[0].maxGroupShare, 1);
  });

  it("a plan with no trip is a party of one — per the ruling that solo counts as a group", () => {
    const plans = [planRow(0), planRow(1)];
    const { signals } = derive({
      plans,
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B")],
      legs: plans.map((p) => leg(p.planId, "s1", "s2")),
    });
    assert.equal(new Set(signals.map((s) => s.groupKey)).size, 2);
  });

  it("the same party on TWO edges gets two unlinkable tokens", () => {
    const { signals } = derive({
      plans: [planRow(0, { tripId: TRIP(0) })],
      stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B"), stopZone("s3", "zone-C")],
      legs: [leg(PLAN(0), "s1", "s2"), leg(PLAN(0), "s2", "s3")],
    });
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0].groupKey, signals[1].groupKey);
  });

  it("NO group token means NO hop — a body with zero group credit is refused", () => {
    const { signals, skipped } = derive(
      {
        plans: [planRow(0)],
        stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B")],
        legs: [leg(PLAN(0), "s1", "s2")],
      },
      { groupKeyFor: () => null },
    );
    assert.deepEqual(signals, []);
    assert.deepEqual(skipped, [{ planId: PLAN(0), reason: "no_group_key" }]);

    // A throwing derivation is contained the same way.
    const t = derive(
      {
        plans: [planRow(0)],
        stopZones: [stopZone("s1", "zone-A"), stopZone("s2", "zone-B")],
        legs: [leg(PLAN(0), "s1", "s2")],
      },
      { groupKeyFor: () => { throw new Error("no secret"); } },
    );
    assert.deepEqual(t.skipped, [{ planId: PLAN(0), reason: "no_group_key" }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCKER 3: CONSENT
// ═════════════════════════════════════════════════════════════════════════════

/** Minimal supabase-shaped fake over route_plans / route_stops / route_legs / consent. */
function fakeClient(opts: {
  plans?: any[];
  stops?: any[];
  legs?: any[];
  consented?: string[];
  consentError?: boolean;
  planError?: boolean;
  legError?: boolean;
}) {
  const chain = (rows: any[], error: any = null) => {
    const self: any = {
      select: () => self, eq: () => self, in: () => self, is: () => self,
      gte: () => self, not: () => self, limit: () => self,
      then: (res: any) => res({ data: error ? null : rows, error }),
    };
    return self;
  };
  return {
    from(table: string) {
      if (table === "route_plans") return chain(opts.plans ?? [], opts.planError ? { message: "boom" } : null);
      if (table === "route_stops") return chain(opts.stops ?? []);
      if (table === "route_legs") return chain(opts.legs ?? [], opts.legError ? { message: "boom" } : null);
      if (table === ROUTE_FLOW_CONSENT_TABLE) {
        return chain(
          (opts.consented ?? []).map((id) => ({ user_id: id })),
          opts.consentError ? { message: "boom" } : null,
        );
      }
      assert.fail(`unexpected table read: ${table}`);
    },
  };
}

const READ_OPTS = {
  now: NOW,
  maxAgeMinutes: SIGNAL_MAX_AGE_MINUTES,
  resolveZoneForPoint: zoneForPoint,
  groupKeyFor: fakeGroupKey,
};

function dbFixture() {
  return {
    plans: [
      { id: PLAN(0), trip_id: null, accepted_by_user_id: ACTOR(0), accepted_at: ACCEPTED, status: "active" },
      { id: PLAN(1), trip_id: null, accepted_by_user_id: ACTOR(1), accepted_at: ACCEPTED, status: "active" },
    ],
    stops: [
      { id: `${STOP(0)}-a`, route_plan_id: PLAN(0), structured_location: { label: "X", lat: LAT(0), lng: LNG(0) }, updated_at: null },
      { id: `${STOP(0)}-b`, route_plan_id: PLAN(0), structured_location: { label: "Y", lat: LAT(1), lng: LNG(1) }, updated_at: null },
      { id: `${STOP(1)}-a`, route_plan_id: PLAN(1), structured_location: { label: "X", lat: LAT(0), lng: LNG(0) }, updated_at: null },
      { id: `${STOP(1)}-b`, route_plan_id: PLAN(1), structured_location: { label: "Y", lat: LAT(1), lng: LNG(1) }, updated_at: null },
    ],
    legs: [
      { route_plan_id: PLAN(0), from_stop_id: `${STOP(0)}-a`, to_stop_id: `${STOP(0)}-b` },
      { route_plan_id: PLAN(1), from_stop_id: `${STOP(1)}-a`, to_stop_id: `${STOP(1)}-b` },
    ],
  };
}

describe("readAcceptedPlanHops — consent, and the refusals before it", () => {
  it("drops every accepter without a live consent row", async () => {
    const r = await readAcceptedPlanHops(
      fakeClient({ ...dbFixture(), consented: [ACTOR(0)] }) as any,
      READ_OPTS,
    );
    assert.equal(r.refusal, null);
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].actorId, ACTOR(0));
  });

  it("a consent-read FAILURE empties the cohort — a failure can never inflate one", async () => {
    const r = await readAcceptedPlanHops(
      fakeClient({ ...dbFixture(), consentError: true }) as any,
      READ_OPTS,
    );
    assert.deepEqual(r.signals, []);
    // THIS ASSERTION CHANGED, and the reason is worth writing down.
    //
    // It used to require `refusal === null`, on the reading that the consent
    // read is a filter rather than a read: an empty consented set is not a
    // refusal to look. But the set is only empty here BECAUSE THE READ FAILED,
    // and `refusal`'s own contract — "Populated when nothing was read. Never a
    // silent empty" — is precisely about that case. Every sibling failure in
    // this suite (`no_service_client`, plan/leg `read_failed`) is already a
    // named refusal; this one was the exception, and it made an unreadable
    // route_flow_contribution_consent table indistinguishable from a population
    // that has not consented to route-flow contribution at all.
    //
    // The SUPPRESSION is unchanged — still no signals, still fail-closed. Only
    // its visibility to the caller is new.
    assert.equal(
      r.refusal,
      "consent_read_failed",
      "an unreadable consent table is not an unconsenting population",
    );
  });

  it("no consent at all yields no hops", async () => {
    const r = await readAcceptedPlanHops(fakeClient({ ...dbFixture(), consented: [] }) as any, READ_OPTS);
    assert.deepEqual(r.signals, []);
  });

  it("a failed consent read and a genuinely unconsenting population are DIFFERENT answers", async () => {
    // The distinction itself, asserted directly. Both return no signals; a
    // caller that renders or reports the layer must still be able to tell "no
    // one has opted in" from "we could not find out", because only the first is
    // a fact about people. Comparing the two is what makes this a test of the
    // distinction rather than of one arbitrary label.
    const unconsenting = await readAcceptedPlanHops(
      fakeClient({ ...dbFixture(), consented: [] }) as any,
      READ_OPTS,
    );
    const unreadable = await readAcceptedPlanHops(
      fakeClient({ ...dbFixture(), consentError: true }) as any,
      READ_OPTS,
    );
    assert.deepEqual(unconsenting.signals, []);
    assert.deepEqual(unreadable.signals, []);
    assert.equal(unconsenting.refusal, null, "nobody opted in — we looked, and that is the answer");
    assert.notEqual(
      unreadable.refusal,
      unconsenting.refusal,
      "the two must not serialize to the same fact",
    );
  });

  it("REFUSES BEFORE READING with no zone resolver — no coordinate could be coarsened", async () => {
    const forbidden = { from() { assert.fail("must not query without a zone resolver"); } };
    const r = await readAcceptedPlanHops(forbidden as any, { ...READ_OPTS, resolveZoneForPoint: undefined });
    assert.equal(r.refusal, "no_zone_resolver");
    assert.deepEqual(r.signals, []);
  });

  it("REFUSES BEFORE READING with no group-key secret — bodies with no party credit are worse than none", async () => {
    const forbidden = { from() { assert.fail("must not query without a group-key secret"); } };
    const r = await readAcceptedPlanHops(forbidden as any, {
      ...READ_OPTS,
      groupKeyFor: () => { throw new Error("INTEL_GROUP_KEY_SECRET required"); },
    });
    assert.equal(r.refusal, "no_group_key_secret");

    const r2 = await readAcceptedPlanHops(forbidden as any, { ...READ_OPTS, groupKeyFor: () => null });
    assert.equal(r2.refusal, "no_group_key_secret");
  });

  it("no service client is a named refusal, not an empty result", async () => {
    const r = await readAcceptedPlanHops(null as any, READ_OPTS);
    assert.equal(r.refusal, "no_service_client");
  });

  it("a failed plan or leg read refuses rather than reporting a thin cohort", async () => {
    const a = await readAcceptedPlanHops(fakeClient({ ...dbFixture(), planError: true }) as any, READ_OPTS);
    assert.equal(a.refusal, "read_failed");
    const b = await readAcceptedPlanHops(
      fakeClient({ ...dbFixture(), consented: [ACTOR(0), ACTOR(1)], legError: true }) as any,
      READ_OPTS,
    );
    assert.equal(b.refusal, "read_failed");
  });

  it("the read path never lets a stop coordinate out either", async () => {
    const r = await readAcceptedPlanHops(
      fakeClient({ ...dbFixture(), consented: [ACTOR(0), ACTOR(1)] }) as any,
      READ_OPTS,
    );
    assert.equal(r.signals.length, 2);
    const blob = JSON.stringify(r);
    for (const raw of [LAT(0), LAT(1), LNG(0), LNG(1)]) {
      assert.ok(!blob.includes(String(raw)), `coordinate ${raw} survived the read path`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCKER 2: THE LAWFUL BASIS
// ═════════════════════════════════════════════════════════════════════════════

describe("§10 accepted_plan — the tables it reads carry a declared purpose", () => {
  it("route_plans / route_stops / route_legs are claimed by `route_plan_itinerary`", () => {
    const p = LOCATION_PURPOSES.find((x) => x.id === "route_plan_itinerary");
    assert.ok(p, "the purpose the audit said was missing must exist");
    for (const t of ["route_plans", "route_stops", "route_legs"]) {
      assert.ok(p!.tables.includes(t), `${t} must be claimed`);
    }
  });

  it("it is PRECISE, so its retention must be bounded — and it is", () => {
    const p = LOCATION_PURPOSES.find((x) => x.id === "route_plan_itinerary")!;
    assert.equal(p.precision, "precise", "structured_location holds {label,lat,lng}");
    assert.equal(p.retentionBound, "content_lifetime");
    assert.equal(p.requiresSeparateControl, true, "publication into a public aggregate needs its own control");
    // The registry-wide invariant still holds with the new entry in place.
    assert.deepEqual(unboundedPrecisePurposes().map((x) => x.id), []);
  });

  it("the entry names the consent scope and flags its wording for policy review", () => {
    const p = LOCATION_PURPOSES.find((x) => x.id === "route_plan_itinerary")!;
    assert.match(p.retentionNote, /route_flow_contribution_consent/);
    assert.match(
      p.retentionNote,
      /WORDING PROVISIONAL/,
      "the registry must not present provisional wording as a settled legal conclusion",
    );
    // The privacy gate, not this purpose, is what makes anything public.
    assert.match(p.visibility, /privacy gate/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE INDEPENDENCE CASE — the thing that decides whether §10 is really satisfied
// ═════════════════════════════════════════════════════════════════════════════

describe("§10 accepted_plan — the independence argument is written down, not asserted", () => {
  it("the case is stated in all six terms, each substantial enough to review", () => {
    const c = ACCEPTED_PLAN_INDEPENDENCE;
    assert.equal(c.family, ACCEPTED_PLAN_FAMILY);
    assert.ok(c.sourceTable.length > 0);
    assert.ok(c.derivationPath.length >= 4, "the path from row to hop must be traceable step by step");
    for (const field of ["actorPopulation", "correlationRisk", "failureMode", "separatenessArgument"] as const) {
      assert.ok(c[field].trim().length > 80, `${field} is too thin to review`);
    }
    for (const e of c.evidence) {
      assert.ok(e.trim().length > 20, `evidence '${e}' is too thin to review`);
    }
  });

  it("the residual limitation is NON-EMPTY — a family with no stated limitation was not examined", () => {
    assert.ok(
      ACCEPTED_PLAN_INDEPENDENCE.residualCorrelation.trim().length > 80,
      "if this can be emptied, the register has become a rubber stamp",
    );
    // The two specific honesty claims the audit's bar demands.
    assert.match(ACCEPTED_PLAN_INDEPENDENCE.residualCorrelation, /overlap/i);
    assert.match(ACCEPTED_PLAN_INDEPENDENCE.correlationRisk, /intent|self-report/i);
  });

  it("it answers the audit's bar on all four counts: table, writer, consent record, population", () => {
    const c = ACCEPTED_PLAN_INDEPENDENCE;
    assert.ok(!c.sourceTable.includes("intel_observations"), "a different TABLE");
    assert.match(c.separatenessArgument, /routePlan\.ts/, "a different WRITER");
    assert.match(c.separatenessArgument, /route_flow_contribution_consent/, "a different CONSENT record");
    assert.match(c.actorPopulation, /accept/i, "a different, capture-distinct POPULATION");
    // The property MIN_SIGNAL_FAMILIES actually defends.
    assert.match(c.failureMode, /Neither outage, bug, flag flip or spam campaign/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE ACCEPTANCE TRANSITION, over HTTP
// ═════════════════════════════════════════════════════════════════════════════

const HTTP_PLAN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OWNER = "user-001";

/** A store-backed fake that DOES apply updates to route_plans, unlike the older one. */
function makeAcceptClient(store: { route_plans: any[] }) {
  function chain(table: string): any {
    const conds: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const obj: any = {
      select: () => obj,
      eq: (c: string, v: unknown) => { conds[c] = v; return obj; },
      update: (p: any) => { patch = p; return obj; },
      maybeSingle: async () => {
        if (table !== "route_plans") return { data: null, error: null };
        const match = store.route_plans.find(
          (p) => Object.entries(conds).every(([k, v]) => p[k === "id" ? "id" : k] === v),
        );
        if (!patch) return { data: match ?? null, error: null };
        if (!match) return { data: null, error: null }; // compare-and-set missed
        Object.assign(match, patch);
        return { data: { ...match }, error: null };
      },
    };
    return obj;
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: OWNER, email: "t@example.com" } }, error: null }) },
    from: (t: string) => chain(t),
  };
}

function startServer(store: { route_plans: any[] }): Promise<{ port: number; close: () => Promise<void> }> {
  _setTestClient(makeAcceptClient(store) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", routePlanRouter);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res()))) });
    });
    srv.on("error", reject);
  });
}

function req(port: number, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { Authorization: "Bearer t" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: text }); }
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const draftPlan = (over: Record<string, unknown> = {}) => ({
  id: HTTP_PLAN, owner_user_id: OWNER, trip_id: null, title: "T", route_style: "custom",
  status: "draft", accepted_at: null, accepted_by_user_id: null, is_approximated: true, ...over,
});

test("POST /accept — a generated plan becomes an ACCEPTED one, with evidence", async () => {
  const store = { route_plans: [draftPlan()] };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${HTTP_PLAN}/accept`);
    assert.equal(status, 200);
    assert.equal(body.status, "active");
    assert.equal(body.alreadyAccepted, false);
    assert.ok(body.acceptedAt, "the acceptance instant is stamped");
    assert.equal(body.acceptedByUserId, OWNER);
    // The stored row now satisfies the CHECK constraint's shape: an accepted
    // state that carries the act which produced it.
    const row = store.route_plans[0];
    assert.equal(row.status, "active");
    assert.ok(row.accepted_at && row.accepted_by_user_id);
  } finally { await srv.close(); }
});

test("POST /accept — re-accepting does NOT re-stamp, so freshness cannot be reset on demand", async () => {
  const earlier = "2026-08-31T10:00:00.000Z";
  const store = { route_plans: [draftPlan({ status: "active", accepted_at: earlier, accepted_by_user_id: OWNER })] };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${HTTP_PLAN}/accept`);
    assert.equal(status, 200);
    assert.equal(body.alreadyAccepted, true);
    assert.equal(body.acceptedAt, earlier, "a client must not be able to refresh a stale hop's window");
    assert.equal(store.route_plans[0].accepted_at, earlier);
  } finally { await srv.close(); }
});

test("POST /accept — only the OWNER may declare; a stranger is refused", async () => {
  const store = { route_plans: [draftPlan({ owner_user_id: "someone-else" })] };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${HTTP_PLAN}/accept`);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
    assert.equal(store.route_plans[0].status, "draft", "nothing was written");
  } finally { await srv.close(); }
});

test("POST /accept — a cancelled plan cannot be accepted", async () => {
  const store = { route_plans: [draftPlan({ status: "cancelled" })] };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${HTTP_PLAN}/accept`);
    assert.equal(status, 409);
    assert.equal(body.error, "invalid_state_transition");
  } finally { await srv.close(); }
});

test("POST /accept — a missing plan is 404 and a malformed id is 400", async () => {
  const srv = await startServer({ route_plans: [] });
  try {
    const missing = await req(srv.port, "POST", `/api/route-plans/${HTTP_PLAN}/accept`);
    assert.equal(missing.status, 404);
    const bad = await req(srv.port, "POST", "/api/route-plans/not-a-uuid/accept");
    assert.equal(bad.status, 400);
  } finally { await srv.close(); }
});
