/**
 * The impact state's degradation, disclosed on every route that consumes it.
 *
 * `loadImpactState` (domain/trips/services/TripImpactState.ts) already records
 * every table it could NOT read in `unread` — the standard census-trips §54.1
 * states as *"a named unread, never a failed completion"*. Two of the five
 * consumers carried that list to the caller (`/proposals/preview`, `/replan`)
 * and three dropped it (`/simulate`, `/meeting-point`, `/rescue`), so a client
 * could not tell an answer computed over the whole trip from one computed over
 * a trip whose attendance, commitments or transport could not be read.
 *
 * This matters on every current deployment rather than only in theory:
 * `trip_plan_participants` (2771), `trip_commitments` (2761) and
 * `trip_transport_segments` (2782) are in portava-ci or in no database at all,
 * so those reads FAIL in production today and the silent fallback is "the whole
 * crew is going" / "there is no next commitment".
 *
 * `computeMeetingPoint` additionally read `trip_saved_places` and
 * `trip_plan_items` with the error destructured away, which is the §29.6
 * fail-closed defect: a failed candidate read was served as "no candidates".
 *
 * These tests drive the REAL routes over HTTP, not the pure engines.
 *
 * Run: node --import tsx/esm --test src/test/tripImpactUnreadDisclosure.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetTripMetrics } from "../domain/trips/services/tripMetrics.js";
import { _resetOpportunityPortfolios } from "../domain/trips/projections/TripOpportunityProjection.js";
import { _resetTripDecisionLedger } from "../domain/trips/services/TripDecisionLedger.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NEAR = { lat: 48.86, lng: 2.36 };
type Row = Record<string, any>;

function fixture(): Record<string, Row[]> {
  const t = base();
  t.trip_stages = [{ id: "st1", trip_id: TRIP_ID, sequence: 1, starts_at: T("00:00", "12"), ends_at: T("23:59", "15") }];
  t.trip_plan_items = [{ id: "walk", trip_id: TRIP_ID, title: "Walking tour", category: "activity", status: "confirmed", starts_at: T("15:00"), ends_at: T("17:00"), day_date: "2026-09-13", plan_scope: "ALL_CREW", lat: NEAR.lat, lng: NEAR.lng, location_is_private: false, removed_at: null }];
  t.trip_saved_places = [{ id: "s1", trip_id: TRIP_ID, user_id: OWNER_ID, place_id: null, place_name: "Café Mid", place_type: "cafe", lat: NEAR.lat, lng: NEAR.lng }];
  t.trip_reservations = [];
  return t;
}

let server: Server; let port: number;
async function start(): Promise<void> {
  await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
}
after(() => { server?.close(); });

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/trips/${TRIP_ID}/${path}`, {
    method: "POST", headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function install(errorOn: string[] = []) {
  const c = makeClient(fixture(), errorOn);
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  return c;
}

beforeEach(async () => { if (!server) await start(); _resetTripMetrics(); _resetOpportunityPortfolios(); _resetTripDecisionLedger(); });

describe("§54.1 a named unread, never a silent completion — every impact-state route", () => {
  it("POST /simulate names the attendance relation it could not read", async () => {
    install(["trip_plan_participants"]);
    const r = await post("simulate", { change: { kind: "move_plan", targetId: "walk", startsAt: T("12:30"), endsAt: T("13:30") } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.unread), "the simulate response must carry the unread list its siblings carry");
    assert.ok(r.body.unread.includes("trip_plan_participants"),
      `attendance was unreadable and the simulation was computed over the whole crew instead; unread=${JSON.stringify(r.body.unread)}`);
  });

  it("POST /simulate over a trip that read cleanly names nothing", async () => {
    install();
    const r = await post("simulate", { change: { kind: "move_plan", targetId: "walk", startsAt: T("12:30"), endsAt: T("13:30") } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.unread, [], "a clean read must not invent an unread table");
  });

  it("POST /meeting-point names the attendance relation it could not read", async () => {
    install(["trip_plan_participants"]);
    const r = await post("meeting-point", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.unread), "the meeting-point response must carry an unread list");
    assert.ok(r.body.unread.includes("trip_plan_participants"),
      `attendance was unreadable and the meeting point was computed for the whole crew instead; unread=${JSON.stringify(r.body.unread)}`);
  });

  it("POST /meeting-point names a candidate source it could not read, instead of serving 'no candidates'", async () => {
    install(["trip_saved_places"]);
    const r = await post("meeting-point", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body.unread ?? []).includes("trip_saved_places"),
      `a failed saved-places read was served as an empty candidate set; unread=${JSON.stringify(r.body.unread)}`);
  });

  it("POST /rescue names the relation it could not read, instead of serving a plan that looks complete", async () => {
    install(["trip_plan_participants"]);
    const r = await post("rescue", { problem: "missed_transport" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.unread), "the rescue response must carry an unread list");
    assert.ok(r.body.unread.includes("trip_plan_participants"),
      `the rescue plan was built over a degraded state and reported as complete; unread=${JSON.stringify(r.body.unread)}`);
  });

  it("BOUNDARY — a table the operational gate PROBES is a refusal, not an unread", async () => {
    // trip_commitments / trip_risks / trip_stages are in the capability
    // definition, so an unreadable one is `TRIP_PROJECTION_UNAVAILABLE` (503)
    // before any impact state is built. That is the fail-closed half of the
    // same rule and this test pins the boundary between the two.
    install(["trip_commitments"]);
    const r = await post("meeting-point", {});
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TRIP_PROJECTION_UNAVAILABLE");
  });

  it("CONTROL — the two routes that already disclosed still do", async () => {
    install(["trip_plan_participants"]);
    const preview = await post("proposals/preview", { change: { kind: "cancel_plan", targetId: "walk" } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.unread.includes("trip_plan_participants"));
    const replan = await post("replan", {});
    assert.equal(replan.status, 200, JSON.stringify(replan.body));
    assert.ok(replan.body.unread.includes("trip_plan_participants"));
  });
});
