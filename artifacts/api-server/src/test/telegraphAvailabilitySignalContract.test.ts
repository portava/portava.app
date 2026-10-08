/**
 * census-telegraph T22 / T23 / T27 — the AvailabilitySignal contract (migration 3652, behind
 * `availability_signal_contract_enabled`, seeded FALSE), and proposed ruling P-T10: a signal with no
 * audience policy is seen by mutual follows and crew only; nothing wider without an explicit choice.
 *
 * WHAT IS EXERCISED: the real contract (services/telegraph/availabilitySignalContract.ts) — its pure
 * rules, its reads over the certification harness's PostgREST fake, the route wrapper Nearby calls,
 * and the real write doors (routes/availabilitySignal.ts) over an express app on 127.0.0.1.
 *
 * Run: node --import tsx/esm --test src/test/telegraphAvailabilitySignalContract.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";

import {
  DEFAULT_AUDIENCE,
  applyAvailabilitySignalContract,
  applyContractToPerson,
  audienceAdmits,
  bucketUnderSignal,
  effectiveSignal,
  withSignalContract,
  type ContractInputs,
} from "../services/telegraph/availabilitySignalContract.js";
import { nearbyRank, type ReachablePersonProjection, type RelationshipTier } from "../services/telegraph/reachablePeople.js";
import type { ProximityBucket } from "../lib/proximityBuckets.js";
import type { ReachableLoadOk } from "../services/telegraph/reachablePeopleQuery.js";
import { _setTestClient } from "../lib/http.js";
import availabilitySignalRouter, { MAX_ETA_GRANT_HOURS } from "../routes/availabilitySignal.js";
import { makeFakeClient, call } from "./telegraphCertificationHarness.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";
const BEN = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

function person(id: string, tier: RelationshipTier, bucket: ProximityBucket = "same_area"): ReachablePersonProjection {
  const travel = bucket === "unknown" ? "unknown" : "walkable";
  const rank = nearbyRank({
    availability: "available_now", relationship: tier, proximity: bucket, overlap: "unknown", sharedContextCount: 0,
    intentOverlap: 2, travel, freshness: "live", safety: "clear",
  });
  return {
    personId: id,
    relationship: { tier, origins: [] },
    availability: { state: "available_now", intents: ["Food", "Drinks"], overlap: "unknown", publishedUntil: iso(NOW + HOUR) },
    proximity: { bucket, precision: "bucket", travel, freshness: "live" },
    sharedContext: { trips: 0, circles: 0, kinds: [] },
    privacy: { availabilityPublished: true, proximityPublished: bucket !== "unknown", preciseShared: false },
    safety: { state: "clear" },
    rank,
  };
}

const signalOf = (rung: any, audience: any = DEFAULT_AUDIENCE, scope: any = null) => ({ audience, rung, scope });
function inputs(over: Partial<ContractInputs> = {}): ContractInputs {
  return { optedIn: new Set([ANA, BEN]), signals: new Map(), mutualEta: new Set(), ...over };
}

describe("P-T10 — the default audience is mutual follows and crew only", () => {
  it("audienceAdmits", () => {
    assert.equal(DEFAULT_AUDIENCE, "mutual_follow_and_crew");
    for (const t of ["mutual_follow", "friend", "shared_context", "crew"] as RelationshipTier[]) assert.equal(audienceAdmits(DEFAULT_AUDIENCE, t), true, t);
    for (const t of ["none", "follow"] as RelationshipTier[]) assert.equal(audienceAdmits(DEFAULT_AUDIENCE, t), false, t);
    assert.equal(audienceAdmits("crew_only", "mutual_follow"), false);
    assert.equal(audienceAdmits("crew_only", "shared_context"), true);
    assert.equal(audienceAdmits("public", "none"), true, "public exists only by an explicit policy");
  });

  it("several windows: the most restrictive of each field wins", () => {
    const s = effectiveSignal([signalOf("ETA_IF_MUTUAL", "public", "neighborhood"), signalOf("NEARBY", "crew_only", "city")]);
    assert.deepEqual(s, { audience: "crew_only", rung: "NEARBY", scope: "city" });
    assert.equal(effectiveSignal([]), null);
  });
});

describe("T23 — the proximity rung and the geography cap", () => {
  it("HIDDEN shows nothing; NEARBY only that the person is near; DISTANCE_BUCKET the bucket", () => {
    assert.equal(bucketUnderSignal("same_area", "HIDDEN", null), "unknown");
    assert.equal(bucketUnderSignal("same_area", "NEARBY", null), "nearby");
    assert.equal(bucketUnderSignal("same_city", "NEARBY", null), "unknown");
    assert.equal(bucketUnderSignal("same_city", "DISTANCE_BUCKET", null), "same_city");
  });
  it("proximity is never finer than the scope the signal speaks for", () => {
    assert.equal(bucketUnderSignal("same_area", "DISTANCE_BUCKET", "city"), "same_city");
    assert.equal(bucketUnderSignal("same_city", "DISTANCE_BUCKET", "region"), "same_region");
    assert.equal(bucketUnderSignal("far", "DISTANCE_BUCKET", "region"), "far");
    assert.equal(bucketUnderSignal("same_area", "NEARBY", "city"), "same_city");
  });
});

describe("T22 / T23 / T27 — one person under the contract", () => {
  it("T22: no Nearby opt-in → not shown, whatever else they publish", () => {
    const p = person(ANA, "crew");
    assert.equal(applyContractToPerson(p, inputs({ optedIn: new Set(), signals: new Map([[ANA, signalOf("DISTANCE_BUCKET")]]) })), null);
  });

  it("a one-way follower is outside the default audience: neither availability nor proximity → not shown", () => {
    const p = person(ANA, "follow");
    assert.equal(applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("DISTANCE_BUCKET")]]) })), null);
  });

  it("a mutual follow sees the availability and the chosen rung; HIDDEN is the default rung and shows no proximity", () => {
    const p = person(ANA, "mutual_follow");
    const hidden = applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("HIDDEN")]]) }))!;
    assert.equal(hidden.availability.state, "available_now");
    assert.equal(hidden.proximity.bucket, "unknown");
    assert.equal(hidden.privacy.proximityPublished, false);
    const shown = applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("DISTANCE_BUCKET")]]) }))!;
    assert.equal(shown.proximity.bucket, "same_area");
  });

  it("T27: the travel band (the only ETA-shaped value) only on ETA_IF_MUTUAL AND a live grant both ways", () => {
    const p = person(ANA, "crew");
    const bucketOnly = applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("DISTANCE_BUCKET")]]), mutualEta: new Set([ANA]) }))!;
    assert.equal(bucketOnly.proximity.travel, "unknown", "DISTANCE_BUCKET never carries an ETA");
    const notMutual = applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("ETA_IF_MUTUAL")]]) }))!;
    assert.equal(notMutual.proximity.travel, "unknown");
    const mutual = applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("ETA_IF_MUTUAL")]]), mutualEta: new Set([ANA]) }))!;
    assert.equal(mutual.proximity.travel, "walkable");
  });

  it("no published signal for this viewer: no proximity rides along, so a proximity-only row is not shown", () => {
    const p = { ...person(ANA, "crew"), privacy: { availabilityPublished: false, proximityPublished: true, preciseShared: false as const } };
    assert.equal(applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("DISTANCE_BUCKET")]]) })), null);
  });

  it("the rank follows what is shown: withheld proximity lowers it by exactly the proximity terms", () => {
    const p = person(ANA, "crew");
    const hidden = applyContractToPerson(p, inputs({ signals: new Map([[ANA, signalOf("HIDDEN")]]) }))!;
    const expected = nearbyRank({
      availability: "available_now", relationship: "crew", proximity: "unknown", overlap: "unknown", sharedContextCount: 0,
      intentOverlap: 2, travel: "unknown", freshness: "stale", safety: "clear",
    });
    assert.equal(hidden.rank, expected);
  });
});

// ── The reads ─────────────────────────────────────────────────────────────────

function world(over: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    nearby_consents: [{ user_id: ANA, opted_in: true }, { user_id: BEN, opted_in: true }],
    availability_windows: [
      { id: "w-ana", user_id: ANA, visibility: "followers", audience_policy_id: null, proximity_visibility: "DISTANCE_BUCKET", geography_scope: null, start_at: iso(NOW - HOUR), end_at: iso(NOW + HOUR), expires_at: null },
      { id: "w-ben", user_id: BEN, visibility: "public", audience_policy_id: "p-ben", proximity_visibility: "ETA_IF_MUTUAL", geography_scope: null, start_at: iso(NOW - HOUR), end_at: iso(NOW + HOUR), expires_at: null },
    ],
    availability_audience_policies: [{ id: "p-ben", owner_id: BEN, audience: "public" }],
    eta_coordination_grants: [
      { grantor_id: VIEWER, grantee_id: BEN, expires_at: iso(NOW + HOUR) },
      { grantor_id: BEN, grantee_id: VIEWER, expires_at: iso(NOW + HOUR) },
    ],
    feature_flags: [{ flag: "availability_signal_contract_enabled", enabled: true }],
    ...over,
  };
}

describe("the contract's reads", () => {
  it("applies each person's own windows, policies and grants", async () => {
    const r = await applyAvailabilitySignalContract(makeFakeClient(world()), VIEWER, [person(ANA, "follow"), person(BEN, "none", "same_city")], NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.people.map((p) => p.personId), [BEN], "ANA's default audience does not admit a one-way follower; BEN chose public");
    assert.equal(r.people[0]!.proximity.travel, "short_ride", "BEN: ETA_IF_MUTUAL with a live grant both ways");
    assert.equal(r.dropped, 1);
  });

  it("a policy that is someone else's is read as the NARROWEST audience, never as the default or public", async () => {
    const w = world({ availability_audience_policies: [{ id: "p-ben", owner_id: ANA, audience: "public" }] });
    const r = await applyAvailabilitySignalContract(makeFakeClient(w), VIEWER, [person(BEN, "mutual_follow")], NOW);
    assert.equal(r.ok && r.people.length, 0, "crew_only does not admit a mutual follow");
  });

  it("an expired grant is not a grant, and a one-way grant is not mutual", async () => {
    const w = world({ eta_coordination_grants: [{ grantor_id: VIEWER, grantee_id: BEN, expires_at: iso(NOW + HOUR) }] });
    const r = await applyAvailabilitySignalContract(makeFakeClient(w), VIEWER, [person(BEN, "crew")], NOW);
    assert.equal(r.ok && r.people[0]!.proximity.travel, "unknown");
  });

  it("a private or expired window is no signal", async () => {
    const w = world();
    w.availability_windows = [
      { ...w.availability_windows[0], visibility: "private" },
      { ...w.availability_windows[1], expires_at: iso(NOW - 1) },
    ];
    const r = await applyAvailabilitySignalContract(makeFakeClient(w), VIEWER, [person(ANA, "crew"), person(BEN, "crew")], NOW);
    assert.equal(r.ok && r.people.length, 0);
  });

  for (const table of ["nearby_consents", "availability_windows", "availability_audience_policies", "eta_coordination_grants"]) {
    it(`an unreadable ${table} refuses the answer (fail closed)`, async () => {
      const c = makeFakeClient(world(), { errors: { [table]: { message: `${table} unreadable` } } });
      const r = await applyAvailabilitySignalContract(c, VIEWER, [person(ANA, "crew"), person(BEN, "crew")], NOW);
      assert.equal(r.ok, false);
    });
  }
});

describe("the door Nearby calls (withSignalContract)", () => {
  const loaded = (): ReachableLoadOk => ({
    ok: true,
    people: [person(ANA, "follow"), person(BEN, "crew")],
    telemetry: { published: 2, refusals: { stale: 1 }, buckets: {}, viewerInvisible: false, degraded: false },
    viewerInvisible: { invisible: false, reasons: [], degraded: false },
    degraded: false,
  });

  it("flag OFF (the seed): the answer is exactly as it was", async () => {
    const before = loaded();
    const r = await withSignalContract(makeFakeClient(world({ feature_flags: [{ flag: "availability_signal_contract_enabled", enabled: false }] })), VIEWER, NOW, before);
    assert.equal(r, before);
  });

  it("flag ON: the contract applies and its drops join the ONE undifferentiated refusal count", async () => {
    const r = await withSignalContract(makeFakeClient(world()), VIEWER, NOW, loaded());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.people.map((p) => p.personId), [BEN]);
    assert.deepEqual(r.telemetry.refusals, { stale: 1, signal_contract: 1 });
    assert.equal(r.telemetry.published, 1);
  });

  it("flag UNREADABLE: the contract applies (it only narrows)", async () => {
    const c = makeFakeClient(world(), { errors: { feature_flags: { message: "flags unreadable" } } });
    const r = await withSignalContract(c, VIEWER, NOW, loaded());
    assert.equal(r.ok && r.people.length, 1);
  });

  it("a contract read that fails refuses through the route's refusal branch", async () => {
    const c = makeFakeClient(world(), { errors: { nearby_consents: { message: "down" } } });
    const r = await withSignalContract(c, VIEWER, NOW, loaded());
    assert.equal(r.ok, false);
  });

  it("the Nearby route calls it on the loader's answer, before the observation budget (source level)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../routes/nearbyReachable.ts", import.meta.url), "utf8");
    assert.match(src, /const result = await withSignalContract\(db, user\.id, nowMs, await loadReachablePeople\(db, \{ viewerId: user\.id, nowMs \}\)\);/);
    assert.ok(src.indexOf("withSignalContract(db") < src.indexOf("applyObservationBudget(db"));
  });
});

// ── The write doors ───────────────────────────────────────────────────────────

describe("the write doors (routes/availabilitySignal.ts)", () => {
  let server: Server;
  let base = "";
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", availabilitySignalRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const use = (s: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]) => {
    const c = makeFakeClient(s, opts);
    _setTestClient(c, true);
    return c;
  };
  const on = () => ({ feature_flags: [{ flag: "availability_signal_contract_enabled", enabled: true }], blocks: [] as any[] });

  it("every door answers 404 while the flag is OFF (the seed) and writes nothing", async () => {
    const c = use({ feature_flags: [{ flag: "availability_signal_contract_enabled", enabled: false }] });
    for (const [m, p, b] of [
      ["PUT", "/me/nearby-consent", { optedIn: true }],
      ["POST", "/me/availability-audience-policies", { audience: "public" }],
      ["PATCH", "/me/availability-windows/44444444-4444-4444-8444-444444444444/signal", { proximityVisibility: "NEARBY" }],
      ["PUT", `/me/eta-grants/${BEN}`, { hours: 2 }],
    ] as const) {
      const r = await call(base, m as any, p, VIEWER, b);
      assert.equal(r.status, 404, `${m} ${p}`);
    }
    assert.equal(c._observed.upserts.length + c._observed.inserts.length + c._observed.updates.length, 0);
  });

  it("T22: the Nearby opt-in is the caller's own row; no row reads as not opted in", async () => {
    const c = use({ ...on(), nearby_consents: [] });
    assert.equal((await call(base, "GET", "/me/nearby-consent", VIEWER)).body.optedIn, false);
    const r = await call(base, "PUT", "/me/nearby-consent", VIEWER, { optedIn: true });
    assert.equal(r.status, 200);
    assert.deepEqual(
      c._observed.upserts.map((u) => ({ user_id: u.rows[0].user_id, opted_in: u.rows[0].opted_in })),
      [{ user_id: VIEWER, opted_in: true }],
    );
    assert.equal((await call(base, "PUT", "/me/nearby-consent", VIEWER, { optedIn: "yes" })).status, 400);
  });

  it("P-T10: creating an audience is an explicit choice from a closed list; listing names the default", async () => {
    use({ ...on(), availability_audience_policies: [] });
    assert.equal((await call(base, "POST", "/me/availability-audience-policies", VIEWER, { audience: "everyone" })).status, 400);
    const r = await call(base, "POST", "/me/availability-audience-policies", VIEWER, { audience: "crew_only" });
    assert.equal(r.status, 201);
    const list = await call(base, "GET", "/me/availability-audience-policies", VIEWER);
    assert.equal(list.body.defaultAudience, "mutual_follow_and_crew");
    assert.deepEqual(list.body.policies.map((p: any) => p.audience), ["crew_only"]);
  });

  it("T23: a window's signal is set only on the caller's window, and only with the caller's own policy", async () => {
    const W = "44444444-4444-4444-8444-444444444444";
    const P_OTHER = "55555555-5555-4555-8555-555555555555";
    const P_MINE = "66666666-6666-4666-8666-666666666666";
    const c = use({
      ...on(),
      availability_windows: [{ id: W, user_id: VIEWER, proximity_visibility: "HIDDEN", geography_scope: null, audience_policy_id: null }],
      availability_audience_policies: [{ id: P_OTHER, owner_id: ANA, audience: "public" }, { id: P_MINE, owner_id: VIEWER, audience: "crew_only" }],
    });
    assert.equal((await call(base, "PATCH", `/me/availability-windows/${W}/signal`, ANA, { proximityVisibility: "NEARBY" })).status, 404, "not ANA's window");
    assert.equal((await call(base, "PATCH", `/me/availability-windows/${W}/signal`, VIEWER, { audiencePolicyId: P_OTHER })).status, 404, "not VIEWER's policy");
    assert.equal((await call(base, "PATCH", `/me/availability-windows/${W}/signal`, VIEWER, { proximityVisibility: "EXACT" })).status, 400);
    assert.equal(c._observed.updates.length, 0);
    const ok = await call(base, "PATCH", `/me/availability-windows/${W}/signal`, VIEWER, { audiencePolicyId: P_MINE, proximityVisibility: "ETA_IF_MUTUAL", geographyScope: "city" });
    assert.equal(ok.status, 200);
    assert.deepEqual(c._observed.updates[0]!.patch.audience_policy_id, P_MINE);
    assert.equal(c._observed.updates[0]!.patch.proximity_visibility, "ETA_IF_MUTUAL");
    assert.equal(c._observed.updates[0]!.patch.geography_scope, "city");
  });

  it(`T27: a grant is from the caller, at most ${MAX_ETA_GRANT_HOURS} hours, never to self, never across a block`, async () => {
    const c = use({ ...on(), eta_coordination_grants: [] });
    assert.equal((await call(base, "PUT", `/me/eta-grants/${VIEWER}`, VIEWER, { hours: 2 })).status, 400);
    assert.equal((await call(base, "PUT", `/me/eta-grants/${BEN}`, VIEWER, { hours: MAX_ETA_GRANT_HOURS + 1 })).status, 400);
    const r = await call(base, "PUT", `/me/eta-grants/${BEN}`, VIEWER, { hours: 3 });
    assert.equal(r.status, 200);
    const row = c._observed.upserts[0]!.rows[0];
    assert.equal(row.grantor_id, VIEWER);
    assert.equal(row.grantee_id, BEN);
    assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 3 * HOUR);

    const blocked = use({ ...on(), blocks: [{ blocker_id: BEN, blocked_id: VIEWER }], eta_coordination_grants: [] });
    assert.equal((await call(base, "PUT", `/me/eta-grants/${BEN}`, VIEWER, { hours: 3 })).status, 404);
    assert.equal(blocked._observed.upserts.length, 0);

    const unreadable = use({ ...on(), eta_coordination_grants: [] }, { errors: { blocks: { message: "down" } } });
    assert.equal((await call(base, "PUT", `/me/eta-grants/${BEN}`, VIEWER, { hours: 3 })).status, 503);
    assert.equal(unreadable._observed.upserts.length, 0);
  });

  it("T27: listing says whether a grant is mutual; withdrawing deletes the caller's own grant", async () => {
    const c = use({
      ...on(),
      eta_coordination_grants: [
        { grantor_id: VIEWER, grantee_id: BEN, expires_at: iso(Date.now() + HOUR) },
        { grantor_id: BEN, grantee_id: VIEWER, expires_at: iso(Date.now() + HOUR) },
        { grantor_id: VIEWER, grantee_id: ANA, expires_at: iso(Date.now() + HOUR) },
      ],
    });
    const list = await call(base, "GET", "/me/eta-grants", VIEWER);
    assert.deepEqual(
      list.body.grants.map((g: any) => [g.userId, g.mutual]).sort(),
      [[ANA, false], [BEN, true]].sort(),
    );
    assert.equal((await call(base, "DELETE", `/me/eta-grants/${BEN}`, VIEWER)).status, 200);
    assert.equal(c._store.eta_coordination_grants.filter((g) => g.grantor_id === VIEWER && g.grantee_id === BEN).length, 0);
    assert.equal(c._store.eta_coordination_grants.filter((g) => g.grantor_id === BEN && g.grantee_id === VIEWER).length, 1, "the other person's grant is theirs");
  });
});
