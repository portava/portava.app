/**
 * §10.4 meeting checkpoints and §11.3 regroup on the wire (2794; census-trips
 * TR177, TR198, TR262).
 *
 *   regroup with nobody placeable and no explicit point is 409
 *   TRIP_MEETING_NO_CANDIDATE with the alternatives and the unplaced; with an
 *   explicit point it issues CREATE_MEETING_CHECKPOINT through the kernel with
 *   the §14.3 computation attached as the explanation; arrival and close are
 *   kernel commands with their refusals mapped; the list carries everyone's
 *   arrival state; the gate and the kernel flag refuse by name; the map's
 *   meetup layer carries an open checkpoint and the offline bundle carries it.
 *
 * Run: node --import tsx/esm --test src/test/tripMeetingCheckpointsRoute.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetTripMetrics } from "../lib/tripMetrics.js";
import { _resetTripDecisionLedger } from "../services/trips/TripDecisionLedger.js";
import { verifyOfflineBundle } from "../services/trips/TripOfflineBundle.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CP_ID     = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
const SECRET = "offline-bundle-test-secret-0001";
const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
type Row = Record<string, any>;
const NEAR = { lat: 48.8600, lng: 2.3600 };

function fixture(): Record<string, Row[]> {
  const t = base();
  t.feature_flags = [...(t.feature_flags ?? []), { flag: "trip_kernel_enabled", enabled: true }];
  t.trip_stages = [{ id: "st1", trip_id: TRIP_ID, sequence: 1, starts_at: T("00:00", "12"), ends_at: T("23:59", "15") }];
  t.trip_saved_places = [{ id: "s1", trip_id: TRIP_ID, user_id: OWNER_ID, place_id: null, place_name: "Café Mid", place_type: "cafe", lat: NEAR.lat, lng: NEAR.lng }];
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
  return { data: { ok: true, duplicate: false, version: 10, event_id: "ev-1", sequence: 1, result: { id: CP_ID, label: args.p_command.payload.label, participant_ids: [OWNER_ID, MEMBER_ID], purpose: args.p_command.payload.purpose }, contract_version: 2 }, error: null };
};
function install(tables: Record<string, Row[]>, rpc?: (fn: string, args: Row) => Promise<{ data: any; error: any }>) {
  const c: any = makeClient(tables); if (rpc) c.rpc = rpc;
  _setTestClient(c, true); _setTestServiceClient(c); return c;
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); _resetTripDecisionLedger(); process.env.TRIP_OFFLINE_BUNDLE_SECRET = SECRET; });

describe("§11.3 POST /regroup (TR198)", () => {
  it("nobody placeable and no explicit point: 409 TRIP_MEETING_NO_CANDIDATE with the unplaced and the alternatives; nothing reaches the kernel", async () => {
    const calls: Row[] = []; install(fixture(), kernel(calls));
    const r = await call("POST", "regroup", {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TRIP_MEETING_NO_CANDIDATE");
    assert.deepEqual(r.body.meetingPoint.unplaced.map((u: any) => u.userId).sort(), [MEMBER_ID, OWNER_ID].sort());
    assert.equal(calls.length, 0);
  });
  it("an explicit point the crew agreed on: CREATE_MEETING_CHECKPOINT through the kernel with the §14.3 computation as the explanation, and the switch reading", async () => {
    const calls: Row[] = []; install(fixture(), kernel(calls));
    const r = await call("POST", "regroup", { point: { lat: NEAR.lat, lng: NEAR.lng, label: "Fountain" }, meetAt: "2026-09-13T13:30:00.000Z", purpose: "regroup", idempotencyKey: "regroup-1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.type, "CREATE_MEETING_CHECKPOINT"); assert.equal(c.actor_user_id, OWNER_ID); assert.equal(c.idempotency_key, "regroup-1");
    assert.equal(c.payload.label, "Fountain"); assert.equal(c.payload.lat, NEAR.lat); assert.equal(c.payload.meet_at, "2026-09-13T13:30:00.000Z");
    assert.equal(c.payload.explanation.chosenBy, "explicit_point");
    assert.deepEqual(c.payload.explanation.constraintsApplied.length, 6, "the §14.3 computation rides along");
    assert.ok(Array.isArray(c.payload.explanation.unplaced) && c.payload.explanation.unplaced.length === 2);
    assert.equal(r.body.checkpoint.id, CP_ID);
    assert.match(r.body.prioritySwitch, /SAFETY_EVENT/);
    assert.match(r.body.prioritySwitch, /returns to NORMAL/);
  });
  it("a kernel refusal is mapped: a subgroup the caller is not in is 403", async () => {
    const calls: Row[] = []; install(fixture(), kernel(calls, { reason: "TRIP_SUBGROUP_NOT_MEMBER" }));
    const r = await call("POST", "regroup", { point: { lat: NEAR.lat, lng: NEAR.lng, label: "Fountain" }, subgroupId: "dddddddd-dddd-4ddd-8ddd-dddddddddd01" });
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_SUBGROUP_NOT_MEMBER");
  });
  it("without the kernel flag the write is refused by name (503); a stranger is 403; the gate off is 404", async () => {
    const t = fixture(); t.feature_flags = t.feature_flags!.filter((f) => f.flag !== "trip_kernel_enabled");
    install(t, kernel([]));
    let r = await call("POST", "regroup", { point: { lat: NEAR.lat, lng: NEAR.lng, label: "F" } });
    assert.equal(r.status, 503); assert.equal(r.body.reason, "TRIP_KERNEL_UNAVAILABLE");
    install(fixture(), kernel([]));
    r = await call("POST", "regroup", {}, "other-token");
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
    const off = fixture(); off.feature_flags = [];
    install(off, kernel([]));
    r = await call("GET", "meeting-checkpoints");
    assert.equal(r.status, 404); assert.equal(r.body.error, "feature_disabled");
  });
});

describe("§10.4 the checkpoint's arrival state and close (TR177)", () => {
  const withCheckpoint = () => {
    const t = fixture();
    t.trip_meeting_checkpoints = [{ id: CP_ID, trip_id: TRIP_ID, subgroup_id: null, created_by: OWNER_ID, label: "Fountain", lat: NEAR.lat, lng: NEAR.lng, place_id: null, meet_at: T("13:30"), purpose: "regroup", status: "open", explanation: { chosenBy: "recommended" }, created_at: T("12:00"), closed_at: null }];
    t.trip_meeting_checkpoint_participants = [
      { checkpoint_id: CP_ID, user_id: OWNER_ID, arrival_state: "arrived", arrived_at: T("13:20") },
      { checkpoint_id: CP_ID, user_id: MEMBER_ID, arrival_state: "en_route", arrived_at: null },
    ];
    return t;
  };
  it("GET lists the open checkpoints with everyone's state and the counts", async () => {
    install(withCheckpoint(), kernel([]));
    const r = await call("GET", "meeting-checkpoints", undefined, "member-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.checkpoints.length, 1);
    const cp = r.body.checkpoints[0];
    assert.equal(cp.id, CP_ID); assert.equal(cp.pendingCount, 1); assert.equal(cp.arrivedCount, 1);
    assert.deepEqual(cp.participants.map((p: any) => p.arrivalState), ["arrived", "en_route"]);
  });
  it("POST arrival issues SET_MEETING_ARRIVAL as the caller; a bad state is 400; a non-participant's refusal is 403; close issues CLOSE_MEETING_CHECKPOINT", async () => {
    const calls: Row[] = []; install(withCheckpoint(), kernel(calls));
    let r = await call("POST", `meeting-checkpoints/${CP_ID}/arrival`, { arrivalState: "arrived" }, "member-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(calls[0]!.type, "SET_MEETING_ARRIVAL"); assert.equal(calls[0]!.actor_user_id, MEMBER_ID); assert.deepEqual(calls[0]!.payload, { checkpoint_id: CP_ID, arrival_state: "arrived" });
    r = await call("POST", `meeting-checkpoints/${CP_ID}/arrival`, { arrivalState: "teleported" }, "member-token");
    assert.equal(r.status, 400); assert.equal(calls.length, 1);
    install(withCheckpoint(), kernel(calls, { reason: "TRIP_MEETING_NOT_PARTICIPANT" }));
    r = await call("POST", `meeting-checkpoints/${CP_ID}/arrival`, { arrivalState: "arrived" });
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_MEETING_NOT_PARTICIPANT");
    install(withCheckpoint(), kernel(calls, { reason: "TRIP_MEETING_INVALID_TRANSITION", detail: "the checkpoint is met" }));
    r = await call("POST", `meeting-checkpoints/${CP_ID}/close`, { outcome: "cancelled" });
    assert.equal(r.status, 409); assert.equal(r.body.reason, "TRIP_MEETING_INVALID_TRANSITION");
    const ok: Row[] = []; install(withCheckpoint(), kernel(ok));
    r = await call("POST", `meeting-checkpoints/${CP_ID}/close`, {});
    assert.equal(r.status, 200); assert.equal(ok[0]!.type, "CLOSE_MEETING_CHECKPOINT"); assert.deepEqual(ok[0]!.payload, { checkpoint_id: CP_ID, outcome: "met" });
  });
  it("the map's meetup layer carries the open checkpoint as a meeting_checkpoint (TR262) and the offline bundle carries it with my arrival state (§18.1)", async () => {
    install(withCheckpoint(), kernel([]));
    const map = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/map-projection`, { headers: { Authorization: "Bearer member-token" } });
    assert.equal(map.status, 200);
    const mp: any = await map.json();
    assert.equal(mp.meetupPoints.status, "ok");
    const point = mp.meetupPoints.items.find((p: any) => p.kind === "meeting_checkpoint");
    assert.ok(point, JSON.stringify(mp.meetupPoints));
    assert.equal(point.id, CP_ID); assert.equal(point.label, "Fountain"); assert.equal(point.meta.purpose, "regroup");
    const b = await call("GET", "offline-bundle", undefined, "member-token");
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(verifyOfflineBundle(b.body.bundle, b.body.signature, SECRET), true);
    assert.deepEqual(b.body.bundle.contents.meetingPoints.map((m: any) => [m.id, m.label, m.myArrivalState]), [[CP_ID, "Fountain", "en_route"]]);
    assert.match(b.body.bundle.notCarried.meetingPoints, /carried: the open meeting checkpoints/);
  });
});
