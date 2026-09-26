/**
 * GET /api/nearby/reachable — the §4 / §30A.2 surface, and the two disclosure
 * channels a route owns: the RESPONSE BODY and the LOG LINE.
 *
 * The log assertion is not a source-code scan. The router is mounted behind a
 * middleware that installs a CAPTURING `req.log`, so what is asserted is the
 * payload the handler actually hands the logger while serving a real request.
 * (Capturing `process.stdout.write` would not work: outside production the
 * logger ships through a pino-pretty transport in a worker thread, so nothing
 * the handler logs passes through this thread's stdout.) A coordinate in a log
 * line is a disclosure with a longer retention than the response that caused
 * it, and this repo logs liberally.
 *
 * Also pinned here: the capability gate (no `nearby_reachable_enabled` row
 * exists on any deployment, so the surface is OFF), the refusal that a failed
 * read produces instead of an empty list, and §4.5's poll quantum.
 *
 * Run: node --import tsx/esm --test src/test/nearbyReachableRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import nearbyReachableRouter, { POLL_QUANTUM_MS, quantiseNow } from "../routes/nearbyReachable.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const CREWMATE = "22222222-2222-4222-8222-222222222222";
const TRIP = "33333333-3333-4333-8333-333333333333";
const LAT = 41.157944;
const LNG = -8.629105;

function world(flagOn: boolean): FakeClientSpec {
  const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const fresh = new Date(Date.now() - 60_000).toISOString();
  return {
    users: { tok: VIEWER },
    rows: {
      feature_flags: flagOn ? [{ flag: "nearby_reachable_enabled", enabled: true }] : [],
      blocks: [],
      circle_memberships: [{ user_id: VIEWER, other_id: CREWMATE }],
      trip_members: [
        { trip_id: TRIP, user_id: VIEWER, status: "accepted" },
        { trip_id: TRIP, user_id: CREWMATE, status: "accepted" },
      ],
      location_preferences: [
        { user_id: VIEWER, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
        { user_id: CREWMATE, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
      ],
      user_privacy_settings: [{ user_id: CREWMATE, allow_location_sharing: true }],
      profile_privacy_settings: [{ user_id: CREWMATE, allow_profile_discovery: true }],
      user_location_state: [
        { user_id: VIEWER, lat: LAT, lng: LNG, last_known_at: fresh },
        { user_id: CREWMATE, lat: LAT + 0.01, lng: LNG + 0.01, last_known_at: fresh },
      ],
      user_availability: [{ user_id: CREWMATE, open_to_meet: true }],
      quick_availability_status: [{ user_id: CREWMATE, status: "free_now", expires_at: soon }],
      availability_windows: [],
      // canMessage's reads. Absent rows are simply "no such relationship";
      // `profiles` supplies the recipient's message settings.
      profiles: [{ id: CREWMATE, message_privacy: "everyone", allow_message_requests: true }],
      friendships: [],
      follows: [],
    },
  };
}

let server: Server;
let port = 0;
let logged: Array<{ level: string; payload: unknown; message: unknown }> = [];

/** The router behind a capturing `req.log`. Everything else is the real thing. */
function makeApp(): express.Express {
  const a = express();
  a.use((req, _res, next) => {
    const record = (level: string) => (payload: unknown, message?: unknown) => {
      logged.push({ level, payload, message });
    };
    (req as any).log = {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
      trace: record("trace"),
      fatal: record("fatal"),
      child: () => (req as any).log,
    };
    next();
  });
  a.use("/api", nearbyReachableRouter);
  return a;
}

async function call(auth = true): Promise<{ status: number; body: any; logs: string }> {
  logged = [];
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = "Bearer tok";
  const res = await fetch(`http://127.0.0.1:${port}/api/nearby/reachable`, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, logs: JSON.stringify(logged) };
}

describe("GET /api/nearby/reachable", () => {
  before(() => new Promise<void>((resolve) => {
    server = createServer(makeApp());
    server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); });
  }));
  after(() => new Promise<void>((resolve) => {
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
    server.close(() => resolve());
  }));

  it("requires authentication", async () => {
    _setTestClient(makeFailClosedClient(world(true)) as any, true);
    const { status } = await call(false);
    assert.equal(status, 401);
  });

  it("with no feature_flags row the surface is OFF and publishes nobody", async () => {
    _setTestClient(makeFailClosedClient(world(false)) as any, true);
    const { status, body } = await call();
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false, people: [], generatedAt: null });
  });

  it("with the flag on it answers a bucketed list and nothing finer", async () => {
    _setTestClient(makeFailClosedClient(world(true)) as any, true);
    const { status, body } = await call();
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.enabled, true);
    assert.equal(body.pollQuantumMs, POLL_QUANTUM_MS);
    // NOT VACUOUS: an empty list trivially contains no coordinate. The
    // crewmate must actually be published for the assertions below to mean
    // anything, and the relationship behind them is resolved by the real
    // `canMessage` against the fake, not by a stub.
    assert.equal(body.people.length, 1, JSON.stringify(body));
    assert.equal(body.people[0].proximity.bucket, "same_area");
    assert.equal(body.people[0].proximity.precision, "bucket");
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes(String(LAT)), false, "the viewer's coordinate reached the response");
    assert.equal(serialised.includes(String(LNG)), false, "the viewer's coordinate reached the response");
    assert.equal(/"(lat|lng|distanceKm|etaMinutes)"/.test(serialised), false, serialised);
    assert.equal(body.viewer.privateMapAvailable, true, "§4.4: the private map survives");
  });

  it("THE LOG LINE CARRIES COUNTS, NOT COORDINATES", async () => {
    _setTestClient(makeFailClosedClient(world(true)) as any, true);
    const { body, logs } = await call();
    assert.equal(body.people.length, 1, "nothing was published, so the log has nothing to leak");
    assert.ok(logs.includes("nearby/reachable served"), `the handler did not log at all: ${logs}`);
    assert.equal(logs.includes(String(LAT)), false, `a coordinate was logged: ${logs}`);
    assert.equal(logs.includes(String(LNG)), false, `a coordinate was logged: ${logs}`);
    assert.equal(/"lat"|"lng"|"coords"|"distanceKm"/.test(logs), false, `a position field was logged: ${logs}`);
    assert.equal(logs.includes(CREWMATE), false, "the log named a specific person on a presence surface");
  });

  it("a failed read is a retryable refusal, NOT an empty list", async () => {
    const spec = world(true);
    _setTestClient(
      makeFailClosedClient({
        ...spec,
        failOn: (ctx) => (ctx.table === "blocks" ? { message: "down", code: "57P01" } : null),
      }) as any,
      true,
    );
    const { status, body } = await call();
    assert.equal(status, 503);
    assert.equal(body.error, "degraded_unavailable");
    assert.equal(body.retryable, true);
    assert.equal("people" in body, false, "a refusal must not look like an answer");
  });

  it("the refusal log names the stage and no position", async () => {
    const spec = world(true);
    _setTestClient(
      makeFailClosedClient({
        ...spec,
        failOn: (ctx) => (ctx.table === "blocks" ? { message: "down", code: "57P01" } : null),
      }) as any,
      true,
    );
    const { logs } = await call();
    assert.ok(logs.includes("nearby/reachable refused"));
    assert.ok(logs.includes("blocks"));
    assert.equal(logs.includes(String(LAT)), false);
  });
});

describe("§4.5 — the poll quantum", () => {
  it("quantiseNow floors to the quantum, so polls inside one are identical", () => {
    const t = Date.parse("2026-09-22T18:00:37.412Z");
    assert.equal(quantiseNow(t), Date.parse("2026-09-22T18:00:00.000Z"));
    assert.equal(quantiseNow(t + 20_000), quantiseNow(t), "two polls 20s apart see the same instant");
    assert.notEqual(quantiseNow(t + POLL_QUANTUM_MS), quantiseNow(t));
  });
});
