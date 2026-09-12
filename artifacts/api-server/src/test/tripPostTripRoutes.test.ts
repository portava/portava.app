/**
 * §20 post-trip on the wire (census-trips TR362, TR363, TR385, TR388, TR428):
 * the two projections carry the §19.1 envelope and are for accepted crew;
 * a §20.3 answer is RECORD_OUTCOME through the kernel, refused by name
 * without it, keyed by plan and answer, and only for a plan of this trip.
 *
 * Run: node --import tsx/esm --test src/test/tripPostTripRoutes.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetTripMetrics } from "../lib/tripMetrics.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_TRIP = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PLAN_DONE = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const PLAN_OPEN = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const PLAN_ELSEWHERE = "dddddddd-dddd-4ddd-8ddd-ddddddddddd9";
const PLACE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
type Row = Record<string, any>;

function fixture(): Record<string, Row[]> {
  const t = base();
  t.trips[0]!.destination_country = "France";
  t.trip_plan_items = [
    { id: PLAN_DONE, trip_id: TRIP_ID, title: "Louvre", status: "done", day_date: "2026-09-13", starts_at: "2026-09-13T09:00:00.000Z", ends_at: "2026-09-13T12:00:00.000Z", location_name: "Louvre", source_type: "place", source_id: PLACE_A, removed_at: null },
    { id: PLAN_OPEN, trip_id: TRIP_ID, title: "Hoi An", status: "tentative", day_date: "2026-09-14", starts_at: null, ends_at: null, location_name: "Hoi An", source_type: "manual", source_id: null, removed_at: null },
    { id: PLAN_ELSEWHERE, trip_id: OTHER_TRIP, title: "Elsewhere", status: "tentative", day_date: "2026-09-14", removed_at: null },
  ];
  t.trip_outcomes = []; t.trip_meeting_checkpoints = []; t.memories = []; t.user_stamps = [];
  return t;
}
let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
async function call(method: string, path: string, body?: unknown, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const kernel = (calls: Row[], refuse?: Row) => async (fn: string, args: Row) => {
  if (fn !== "trip_kernel_execute") return { data: null, error: null };
  calls.push(args.p_command);
  if (refuse) return { data: { ok: false, ...refuse, contract_version: 2 }, error: null };
  return { data: { ok: true, duplicate: false, version: 10, event_id: "ev-1", sequence: 1, result: { id: "outcome-1" }, contract_version: 2 }, error: null };
};
function install(tables: Record<string, Row[]>, rpc?: (fn: string, args: Row) => Promise<{ data: any; error: any }>) {
  const c: any = makeClient(tables); if (rpc) c.rpc = rpc;
  _setTestClient(c, true); _setTestServiceClient(c); return c;
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); });

describe("GET /trips/:id/memory-candidates and /passport-projection (TR362, TR363)", () => {
  it("the Memory candidates for the viewer, under the envelope, with the done plan's draft and the crew; a stranger is refused", async () => {
    install(fixture());
    const r = await call("GET", "memory-candidates");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.projectionSchemaVersion, 1); assert.equal(r.body.sourceTripVersion, 9); assert.equal(r.body.freshness, "live");
    assert.equal(r.body.projectionId, "TripMemoryProjection");
    assert.equal(r.body.viewerId, OWNER_ID);
    assert.deepEqual(r.body.candidates.map((c: any) => [c.id, c.kind]), [[`plan:${PLAN_DONE}`, "place_visited"], ["people", "people"]]);
    assert.equal(r.body.candidates[0].memoryDraft.placeId, PLACE_A);
    assert.deepEqual(r.body.unrecordedDonePlanIds, [PLAN_DONE]);
    assert.deepEqual(r.body.unread, []);
    const m = await call("GET", "memory-candidates", undefined, "member-token");
    assert.equal(m.status, 200); assert.deepEqual(m.body.candidates[1].peopleUserIds, [OWNER_ID], "the member's candidates name the owner, not themself");
    assert.equal((await call("GET", "memory-candidates", undefined, "other-token")).status, 403);
    assert.equal((await call("GET", "passport-projection", undefined, "other-token")).status, 403);
  });
  it("the Passport row: countries and cities from the destination, completion from the trip's status, stamps for this trip", async () => {
    const t = fixture(); t.trips[0]!.status = "completed";
    t.user_stamps = [{ id: "s1", user_id: OWNER_ID, stamp_definition_id: "d1", source_type: "trips", source_id: TRIP_ID, earned_at: "2026-09-15T20:00:00.000Z", city: "Paris", country: "France", is_revoked: false }];
    t.stamp_definitions = [{ id: "d1", slug: "first_trip_completed", name: "First Trip" }];
    install(t);
    const r = await call("GET", "passport-projection");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.projectionId, "TripPassportProjection");
    assert.equal(r.body.completed, true);
    assert.deepEqual(r.body.countries, ["France"]); assert.deepEqual(r.body.cities, ["Paris"]);
    assert.deepEqual(r.body.stamps.map((s: any) => s.slug), ["first_trip_completed"]);
    assert.equal(r.body.sourceTripVersion, 9);
  });
  it("with the operational gate off the kernel-era inputs are named unread and the projection still answers from plan status", async () => {
    const t = fixture(); t.feature_flags = [];
    install(t);
    const r = await call("GET", "memory-candidates");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.unread, ["trip_outcomes", "trip_meeting_checkpoints"]);
    assert.deepEqual(r.body.unrecordedDonePlanIds, []);
    assert.equal(r.body.candidates[0].id, `plan:${PLAN_DONE}`);
  });
});

describe("POST /trips/:id/closeout/answers — §20.3 answered as RECORD_OUTCOME (TR385)", () => {
  it("without the kernel the answer is refused by the flag's name and nothing is written", async () => {
    const calls: Row[] = []; install(fixture(), kernel(calls));
    const r = await call("POST", "closeout/answers", { planId: PLAN_OPEN, answer: "completed" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TRIP_KERNEL_UNAVAILABLE"); assert.match(r.body.detail, /trip_kernel_enabled/);
    assert.equal(calls.length, 0);
  });
  it("with the kernel: RECORD_OUTCOME with the answer as the outcome type, the plan, its day as occurred_at, the question as evidence, keyed by plan and answer", async () => {
    const calls: Row[] = []; const t = fixture(); t.feature_flags.push({ flag: "trip_kernel_enabled", enabled: true }); install(t, kernel(calls));
    const r = await call("POST", "closeout/answers", { planId: PLAN_OPEN, answer: "skipped" }, "member-token");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.type, "RECORD_OUTCOME"); assert.equal(c.actor_user_id, MEMBER_ID);
    assert.equal(c.idempotency_key, `closeout:answer:${PLAN_OPEN}:skipped`);
    assert.equal(c.payload.outcome_type, "skipped"); assert.equal(c.payload.plan_id, PLAN_OPEN);
    assert.equal(c.payload.occurred_at, "2026-09-14T23:59:59.000Z");
    assert.equal(c.payload.evidence_json.source, "closeout_answer");
    assert.equal(c.payload.evidence_json.question, "Did you make it to Hoi An?");
    assert.equal(c.payload.evidence_json.answered_by, MEMBER_ID);
    assert.equal(r.body.question, "Did you make it to Hoi An?");
    assert.deepEqual(r.body.kernel, { version: 10, eventId: "ev-1", duplicate: false });
  });
  it("a plan of another trip is not found; a bad answer is refused before the kernel; a kernel refusal is mapped", async () => {
    const calls: Row[] = []; const t = fixture(); t.feature_flags.push({ flag: "trip_kernel_enabled", enabled: true }); install(t, kernel(calls));
    assert.equal((await call("POST", "closeout/answers", { planId: PLAN_ELSEWHERE, answer: "completed" })).status, 404);
    assert.equal((await call("POST", "closeout/answers", { planId: PLAN_OPEN, answer: "maybe" })).status, 400);
    assert.equal((await call("POST", "closeout/answers", { planId: "nope", answer: "completed" })).status, 400);
    assert.equal(calls.length, 0);
    install(t, kernel(calls, { reason: "TRIP_AUTH_NOT_CREW" }));
    const r = await call("POST", "closeout/answers", { planId: PLAN_OPEN, answer: "completed" });
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
  });
});
