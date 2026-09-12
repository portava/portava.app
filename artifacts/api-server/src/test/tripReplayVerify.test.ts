/**
 * Trips spec §22.2 / §21.1 — `trip_event_replay_mismatch_total` is recorded
 * where a replay is verified (lib/tripReplayVerify.ts), and reachable at
 * POST /trips/:id/replay/verify. census-trips TR400.
 *
 * Run: node --import tsx/esm --test src/test/tripReplayVerify.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { verifyTripReplay } from "../lib/tripReplayVerify.js";
import { readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
type Row = Record<string, any>;

function withRpc(c: any, rpc: (fn: string, args: Row) => Promise<{ data: any; error: any }>) {
  c.rpc = rpc; return c;
}
let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
async function post(body: unknown, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/replay/verify`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); });

const equalResult = { ok: true, equal: true, head_version: 12, snapshot_version: 9, differing_keys: [], unfolded: {} };
const mismatch = { ok: false, equal: false, head_version: 12, snapshot_version: 9, differing_keys: ["plans", "version"], unfolded: {} };

describe("verifyTripReplay — the SQL verdict, typed, and the mismatch counted", () => {
  it("an equal replay: ok, no metric", async () => {
    const calls: Row[] = [];
    const c = withRpc(makeClient(base()), async (fn, args) => { calls.push({ fn, args }); return { data: equalResult, error: null }; });
    const v = await verifyTripReplay(c, TRIP_ID, 9);
    assert.deepEqual(calls, [{ fn: "trip_snapshot_verify_replay", args: { p_trip_id: TRIP_ID, p_at_version: 9 } }]);
    assert.equal(v.ok, true); assert.equal(v.equal, true); assert.equal(v.headVersion, 12); assert.deepEqual(v.differingKeys, []); assert.equal(v.reason, null);
    assert.deepEqual(readTripMetric("trip_event_replay_mismatch_total"), []);
  });
  it("a mismatch: not ok, the differing keys named, and trip_event_replay_mismatch_total incremented for the trip", async () => {
    const c = withRpc(makeClient(base()), async () => ({ data: mismatch, error: null }));
    const v = await verifyTripReplay(c, TRIP_ID, 9);
    assert.equal(v.ok, false); assert.equal(v.equal, false); assert.deepEqual(v.differingKeys, ["plans", "version"]); assert.match(v.detail!, /disagree on plans, version/);
    await verifyTripReplay(c, TRIP_ID, 9);
    assert.deepEqual(readTripMetric("trip_event_replay_mismatch_total").map((s) => [s.labels.trip, s.count]), [[TRIP_ID, 2]]);
  });
  it("the kernel's own refusals pass through by name; an rpc error is TRIP_REPLAY_UNAVAILABLE — neither is counted as a mismatch", async () => {
    const noEvents = await verifyTripReplay(withRpc(makeClient(base()), async () => ({ data: { ok: false, reason: "TRIP_SNAPSHOT_NO_EVENTS" }, error: null })), TRIP_ID, 9);
    assert.equal(noEvents.reason, "TRIP_SNAPSHOT_NO_EVENTS"); assert.equal(noEvents.equal, null);
    const notFound = await verifyTripReplay(withRpc(makeClient(base()), async () => ({ data: { ok: false, reason: "TRIP_SNAPSHOT_NOT_FOUND", at_version: 9 }, error: null })), TRIP_ID, 9);
    assert.equal(notFound.reason, "TRIP_SNAPSHOT_NOT_FOUND");
    const down = await verifyTripReplay(withRpc(makeClient(base()), async () => ({ data: null, error: { message: "connection terminated" } })), TRIP_ID, 9);
    assert.equal(down.reason, "TRIP_REPLAY_UNAVAILABLE"); assert.match(down.detail!, /connection terminated/);
    assert.deepEqual(readTripMetric("trip_event_replay_mismatch_total"), []);
  });
});

describe("POST /trips/:id/replay/verify", () => {
  function install(tables: Record<string, Row[]>, rpc: (fn: string, args: Row) => Promise<{ data: any; error: any }>) {
    const c = withRpc(makeClient(tables), rpc);
    _setTestClient(c as any, true); _setTestServiceClient(c as any);
  }
  it("a member gets the verdict; a mismatch is 200 with equal=false and counted; unavailable is 503", async () => {
    install(base(), async () => ({ data: mismatch, error: null }));
    const r = await post({ atVersion: 9 });
    assert.equal(r.status, 200); assert.equal(r.body.equal, false); assert.deepEqual(r.body.differingKeys, ["plans", "version"]);
    assert.equal(readTripMetric("trip_event_replay_mismatch_total")[0].count, 1);
    install(base(), async () => ({ data: null, error: { message: "down" } }));
    assert.equal((await post({ atVersion: 9 })).status, 503);
  });
  it("refuses a bad version, a stranger, and a deployment without the flag", async () => {
    install(base(), async () => ({ data: equalResult, error: null }));
    assert.equal((await post({ atVersion: -1 })).status, 400);
    assert.equal((await post({ atVersion: "x" })).status, 400);
    assert.equal((await post({ atVersion: 9 }, "other-token")).status, 403);
    const off = base(); off.feature_flags = [];
    install(off, async () => ({ data: equalResult, error: null }));
    const r = await post({ atVersion: 9 });
    assert.equal(r.status, 404, JSON.stringify(r.body)); assert.equal(r.body.error, "feature_disabled");
  });
});
