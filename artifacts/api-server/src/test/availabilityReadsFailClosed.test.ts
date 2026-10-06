/**
 * routes/availability.ts — a failed read is never an absence.
 *
 * `GET /me/quick-availability` destructured only `{ data }`. supabase-js
 * RESOLVES a failure as `{ data: null, error }`, so an unreadable
 * `quick_availability_status` answered `{ status: null }` — "you have set no
 * status" — which is this repository's master defect class. Measured in the
 * same file, the same shape held on six more reads, and in the background
 * nudge sender it turned a failed read into a WRITE:
 *
 *   GET /me/availability            quick-status sub-read → `quickStatus: null`
 *   GET /trips/:id/availability     members + 5 member reads → nobody / nobody free
 *   GET /me/availability-nudges     profile + trip enrichment → nameless nudges
 *   GET|PATCH /circles/:id/availability  membership gate → 403 "Not a circle member"
 *   GET /circles/:id/availability   members + 3 member reads → nobody / nobody free
 *   sendAvailabilityNudges          existing days unreadable → nudged everyone,
 *                                   including people who had already answered
 *
 * Each now refuses with a retryable 503 (`degraded_unavailable`) or, for the
 * sender, sends nothing. Every case reads back the response or the recorded
 * writes, and each has a healthy control beside it.
 *
 * Run: node --import tsx/esm --test src/test/availabilityReadsFailClosed.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import availabilityRouter, { sendAvailabilityNudges } from "../routes/availability.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

const ALICE = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b2";
const TRIP = "00000000-0000-4000-8000-000000000001";
const SOON = new Date(Date.now() + 3_600_000).toISOString();
const DOWN = { message: "connection reset", code: "57P01" };

function rows(): Record<string, Record<string, any>[]> {
  return {
    user_availability: [{ user_id: ALICE, weekly_days: {}, open_to_meet: true, strict_mode: false }],
    quick_availability_status: [{ user_id: ALICE, status: "free_tonight", expires_at: SOON }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" },
    ],
    trip_availability: [],
    trips: [{ id: TRIP, start_date: null, end_date: null, title: "Cebu", destination_city: "Cebu" }],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", avatar_url: null },
      { id: BOB, handle: "bob", name: "Bob", avatar_url: null },
    ],
    circle_memberships: [{ user_id: ALICE, other_id: BOB }],
    availability_nudges: [{ id: "n1", sender_id: BOB, trip_id: TRIP, nudge_date: "2026-10-06", created_at: SOON, recipient_id: ALICE }],
    profile_privacy_settings: [],
    user_privacy_settings: [],
    feature_flags: [],
  };
}

type FailOn = Parameters<typeof makeFailClosedClient>[0]["failOn"];
const onTable = (t: string): FailOn => (ctx) => (ctx.table === t ? DOWN : null);

let base = "";
let server: ReturnType<typeof createServer>;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", availabilityRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function get(path: string, failOn?: FailOn, asUser = ALICE) {
  _setTestClient(makeFailClosedClient({ rows: rows(), failOn, users: { tok: asUser } }), true);
  const r = await fetch(`${base}${path}`, { headers: { authorization: "Bearer tok" } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

describe("GET /me/quick-availability — the defect named in the brief", () => {
  it("CONTROL: a set status is returned", async () => {
    const r = await get("/me/quick-availability");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "free_tonight");
  });

  it("a failed read is a retryable 503 — never `status: null`", async () => {
    const r = await get("/me/quick-availability", onTable("quick_availability_status"));
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal("status" in (r.body ?? {}), false);
  });
});

describe("the same shape elsewhere in the file", () => {
  it("GET /me/availability: an unreadable quick status refuses rather than answering quickStatus: null", async () => {
    assert.equal((await get("/me/availability")).body.quickStatus.status, "free_tonight");
    const r = await get("/me/availability", onTable("quick_availability_status"));
    assert.equal(r.status, 503);
  });

  it("GET /trips/:id/availability: an unreadable member list refuses rather than answering 'nobody'", async () => {
    const ok = await get(`/trips/${TRIP}/availability`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.members.length, 2);
    const r = await get(`/trips/${TRIP}/availability`, (ctx) =>
      ctx.table === "trip_members" && ctx.filters.some((f) => f.op === "in") ? DOWN : null);
    assert.equal(r.status, 503);
  });

  for (const table of ["trip_availability", "user_availability", "quick_availability_status", "profiles", "trips"]) {
    it(`GET /trips/:id/availability: an unreadable ${table} refuses rather than answering 'nobody is free'`, async () => {
      const r = await get(`/trips/${TRIP}/availability`, onTable(table));
      assert.equal(r.status, 503, `${table}: ${JSON.stringify(r.body)}`);
    });
  }

  it("GET /circles/:id/availability: an unreadable membership gate is a 503, not 'Not a circle member'", async () => {
    const r = await get(`/circles/${ALICE}/availability`, onTable("circle_memberships"), BOB);
    assert.equal(r.status, 503);
  });

  it("GET /circles/:id/availability: an unreadable member list or member read refuses", async () => {
    const ok = await get(`/circles/${ALICE}/availability`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.members.length, 2);
    for (const table of ["user_availability", "quick_availability_status", "profiles"]) {
      const r = await get(`/circles/${ALICE}/availability`, onTable(table));
      assert.equal(r.status, 503, table);
    }
    const listDown = await get(`/circles/${ALICE}/availability`, (ctx) =>
      ctx.table === "circle_memberships" && ctx.eq("other_id") === undefined ? DOWN : null);
    assert.equal(listDown.status, 503);
  });

  it("PATCH /circles/:id/availability: an unreadable membership gate is a 503, not a 403", async () => {
    _setTestClient(makeFailClosedClient({ rows: rows(), failOn: onTable("circle_memberships"), users: { tok: BOB } }), true);
    const r = await fetch(`${base}/circles/${ALICE}/availability`, {
      method: "PATCH",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ status: "free_now" }),
    });
    assert.equal(r.status, 503);
  });

  it("GET /me/availability-nudges: unreadable sender profiles refuse rather than serving nameless nudges", async () => {
    const ok = await get("/me/availability-nudges");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.nudges[0].senderHandle, "bob");
    for (const table of ["profiles", "trips"]) {
      const r = await get("/me/availability-nudges", onTable(table));
      assert.equal(r.status, 503, table);
    }
  });
});

describe("sendAvailabilityNudges — a failed read must not become a write", () => {
  const log = { warn() {}, info() {}, error() {} };

  it("CONTROL: a recipient with no answer for the date is nudged", async () => {
    const spec = { rows: rows(), inserted: {} as Record<string, any[]> };
    _setTestClient(makeFailClosedClient(spec), true);
    await sendAvailabilityNudges(TRIP, ALICE, ["2026-10-07"], log);
    assert.equal((spec.inserted.availability_nudges ?? []).length > 0, true);
  });

  it("an unreadable trip_availability nudges NOBODY — not everybody", async () => {
    const spec = { rows: rows(), inserted: {} as Record<string, any[]>, failOn: onTable("trip_availability") };
    _setTestClient(makeFailClosedClient(spec), true);
    await sendAvailabilityNudges(TRIP, ALICE, ["2026-10-07"], log);
    assert.equal((spec.inserted.availability_nudges ?? []).length, 0);
  });

  it("an unreadable recipient list nudges nobody", async () => {
    const spec = { rows: rows(), inserted: {} as Record<string, any[]>, failOn: onTable("trip_members") };
    _setTestClient(makeFailClosedClient(spec), true);
    await sendAvailabilityNudges(TRIP, ALICE, ["2026-10-07"], log);
    assert.equal((spec.inserted.availability_nudges ?? []).length, 0);
  });
});
