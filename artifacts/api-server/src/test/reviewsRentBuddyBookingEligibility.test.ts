/**
 * census-trust (wave 5, 2026-10-17) — both parties to a completed Rent-a-Buddy
 * booking may review it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/reviewsRentBuddyBookingEligibility.test.ts
 *
 * THE DEFECT. POST /api/reviews checked eligibility for a `rent_buddy_booking`
 * with `.or(traveler_id.eq.U, buddy_user_id.eq.U)`. rent_buddy_bookings has no
 * `buddy_user_id` (no SQL in the repository declares it): its buddy column is
 * `buddy_id`, and it references rent_buddy_profiles(id), not a user. PostgREST
 * failed the read with 42703, the result read as "no booking", and the route
 * answered 403 review_not_eligible to the TRAVELLER and the BUDDY alike. Found
 * by test/schemaColumnProductionScan.test.ts (class A; an `.or()` column).
 *
 * THE FIX. Two reads: the completed booking (traveler_id, buddy_id), then — for
 * a caller who is not the traveller — the buddy profile's user_id. Proven on
 * schemaStrictSupabase, whose tables are the live schema's:
 *   1. the traveller and the buddy (through their profile) are both eligible (201);
 *   2. a stranger, a booking that is not completed, and a buddy whose PROFILE id
 *      happens to be passed as their user id are refused (403);
 *   3. no statement names a column the live schema lacks.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import reviewsRouter from "../routes/reviews.js";

const TRAVELER = "10000000-0000-4000-a000-000000000001";
const BUDDY_USER = "20000000-0000-4000-a000-000000000002";
const STRANGER = "30000000-0000-4000-a000-000000000003";
const BUDDY_PROFILE = "40000000-0000-4000-a000-000000000004";
const BOOKING = "50000000-0000-4000-a000-000000000005";
const PENDING_BOOKING = "60000000-0000-4000-a000-000000000006";
const TOKENS: Record<string, string> = { "tok-traveler": TRAVELER, "tok-buddy": BUDDY_USER, "tok-stranger": STRANGER, "tok-profile-id": BUDDY_PROFILE };

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } };

function world(): Seed {
  return {
    profiles: [TRAVELER, BUDDY_USER, STRANGER, BUDDY_PROFILE].map((id) => ({ id, role: "user", handle: id.slice(0, 2) })),
    user_account_states: [],
    feature_flags: [],
    rent_buddy_profiles: [{ id: BUDDY_PROFILE, user_id: BUDDY_USER, status: "active", buddy_level: "new" }],
    rent_buddy_bookings: [
      { id: BOOKING, status: "completed", traveler_id: TRAVELER, buddy_id: BUDDY_PROFILE },
      { id: PENDING_BOOKING, status: "confirmed", traveler_id: TRAVELER, buddy_id: BUDDY_PROFILE },
    ],
    reviews: [],
  };
}

const auth = {
  getUser: async (token: string) => (TOKENS[token]
    ? { data: { user: { id: TOKENS[token] } }, error: null }
    : { data: { user: null }, error: { message: "invalid" } }),
};

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", reviewsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

function install(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const client = { from: (t: string) => strict.from(t), rpc: strict.rpc, auth };
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  return strict;
}

async function review(token: string, entityId: string): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ entityType: "rent_buddy_booking", entityId, rating: 5, body: "Great day out" }),
  });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
}

describe("schema-strict: POST /api/reviews for a rent_buddy_booking", () => {
  it("the traveller of a completed booking may review it (201)", async () => {
    const strict = install(world());
    const r = await review("tok-traveler", BOOKING);
    assert.equal(r.status, 201, r.raw);
    assert.deepEqual(strict.writes.filter((w) => w.table === "reviews").map((w) => w.rows[0]!.reviewer_id), [TRAVELER]);
  });

  it("the buddy — the user who owns the booking's buddy profile — may review it (201)", async () => {
    const strict = install(world());
    const r = await review("tok-buddy", BOOKING);
    assert.equal(r.status, 201, r.raw);
    assert.deepEqual(strict.writes.filter((w) => w.table === "reviews").map((w) => w.rows[0]!.reviewer_id), [BUDDY_USER]);
  });

  it("a stranger is refused, and nothing is written", async () => {
    const strict = install(world());
    const r = await review("tok-stranger", BOOKING);
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body.error, "review_not_eligible");
    assert.deepEqual(strict.writes, []);
  });

  it("a booking that is not completed is refused for both parties", async () => {
    install(world());
    for (const t of ["tok-traveler", "tok-buddy"]) {
      const r = await review(t, PENDING_BOOKING);
      assert.equal(r.status, 403, `${t}: ${r.raw}`);
    }
  });

  it("buddy_id is a PROFILE id: a user whose id equals it is not the buddy", async () => {
    install(world());
    const r = await review("tok-profile-id", BOOKING);
    assert.equal(r.status, 403, r.raw);
  });

  it("names no column the live schema lacks (the 42703 that refused everyone)", async () => {
    const strict = install(world());
    await review("tok-buddy", BOOKING);
    assert.deepEqual(strict.deadColumnErrors, []);
  });
});
