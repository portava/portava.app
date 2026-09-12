/**
 * §11.3 "I am bored" — GET /trips/:tripId/bored (census-trips TR197): the
 * window containing now and the §13 candidates compiled for it, in one
 * answer, changing nothing.
 *
 * Run: node --import tsx/esm --test src/test/tripBoredRoute.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetTripMetrics } from "../lib/tripMetrics.js";
import { _resetOpportunityPortfolios } from "../services/trips/TripOpportunityProjection.js";
import { _resetTripDecisionLedger } from "../services/trips/TripDecisionLedger.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
type Row = Record<string, any>;
const NEAR = { lat: 48.8600, lng: 2.3600 };

function fixture(): Record<string, Row[]> {
  const t = base();
  t.trip_stages = [{ id: "st1", trip_id: TRIP_ID, sequence: 1, starts_at: "2026-09-12T00:00:00.000Z", ends_at: "2026-09-15T23:59:00.000Z" }];
  t.trip_saved_places = [{ id: "s1", trip_id: TRIP_ID, user_id: OWNER_ID, place_id: null, place_name: "Café Mid", place_type: "cafe", lat: NEAR.lat, lng: NEAR.lng }];
  return t;
}
let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });
const AT = "2026-09-13T12:00:00.000Z"; // the health fixture's NOW: between commitment A (10:00) and B (arrive by 16:00)
async function get(token = "owner-token", at: string | null = AT): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/bored${at ? `?at=${encodeURIComponent(at)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function install(tables: Record<string, Row[]>) {
  const c: any = makeClient(tables);
  const calls: Row[] = [];
  c.rpc = async (fn: string, args: Row) => { calls.push({ fn, ...args }); return { data: { ok: true, duplicate: false, version: 9, event_id: "e", sequence: 1, result: {}, contract_version: 2 }, error: null }; };
  _setTestClient(c, true); _setTestServiceClient(c); return { c, calls };
}
beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); _resetOpportunityPortfolios(); _resetTripDecisionLedger(); });

describe("§11.3 GET /bored (TR197)", () => {
  it("answers with the window containing now, its minutes left and the next deadline, the compiled candidates, and says nothing was touched", async () => {
    const { calls } = install(fixture());
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.now, AT);
    assert.ok(r.body.window, JSON.stringify(r.body));
    assert.equal(r.body.window.position, "between", "noon sits between A and B");
    assert.equal(r.body.window.requiredDestination?.commitmentId, "B", "the deadline that ends the window");
    assert.ok(r.body.window.minutesLeft > 0 && r.body.window.minutesLeft <= 240);
    assert.equal(r.body.nextWindow, null);
    assert.ok(r.body.candidates, "candidates were compiled for the window containing now");
    assert.equal(r.body.candidates.windowId, r.body.window.id);
    assert.ok(Array.isArray(r.body.candidates.executable) && Array.isArray(r.body.candidates.uncertain));
    assert.equal(r.body.candidates.suppressed, false);
    assert.match(r.body.readings.candidates, /compiled for the window containing now/);
    assert.match(r.body.readings.touched, /nothing/);
    const later = await get("owner-token", "2026-09-13T23:30:00.000Z");
    assert.equal(later.status, 200);
    assert.equal(later.body.window?.position ?? null, "after_last", "late evening: after the last commitment, still free");
    const writes = calls.filter((c) => c.p_command && !["RECORD_OPPORTUNITY_CHANGE", "OPEN_FREE_WINDOW", "MARK_COMMITMENT_AT_RISK", "CLEAR_COMMITMENT_RISK"].includes(c.p_command.type));
    assert.deepEqual(writes, [], "no command that changes a commitment, plan or reservation was issued");
  });
  it("a stranger is refused; the gate off is feature_disabled", async () => {
    install(fixture());
    let r = await get("other-token");
    assert.equal(r.status, 403); assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
    const off = fixture(); off.feature_flags = [];
    install(off);
    r = await get();
    assert.equal(r.status, 404); assert.equal(r.body.error, "feature_disabled");
  });
});
