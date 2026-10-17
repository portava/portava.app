/**
 * census-trust (wave 5, 2026-10-17) — a database without migration 3601 answers
 * "the commission schedule is not available", not a 500.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/rentBuddyFeeScheduleNotDeployed.test.ts
 *
 * THE DEFECT. 3601 adds `rent_buddy_fee_rules.platform_fee_basis_points` and is
 * HELD for production (owner hold D-OWNER1004-14; the 2026-10-17 apply packet
 * excludes it). The fee resolver selects only that column, so on production
 * every read fails 42703. Refusing is right (the rate is unknowable there), but:
 *   - GET /api/rent-a-buddy/me/earnings/summary (no rent_buddy_enabled check)
 *     answered 500 db_error to every user with an active buddy profile;
 *   - PATCH /api/rent-a-buddy/admin/fee-rules answered 500 db_error.
 * Found by test/schemaColumnProductionScan.test.ts (class B, UNGATED).
 *
 * THE FIX. The resolver marks a read that failed for THAT column
 * (`schemaAbsent`), and both routes answer 503 degraded_unavailable with the
 * reason. No rate is invented. Proven on schemaStrictSupabase, whose
 * rent_buddy_fee_rules is the live schema's (no platform_fee_basis_points), so
 * the 42703 here is the real one, not a staged error:
 *   1. the resolver says schemaAbsent, and only for that column;
 *   2. the earnings summary answers 503 with no fee figure;
 *   3. the admin editor answers 503 and writes nothing (no fee row, no audit row);
 *   4. controls: with the column present (3601 run) both answer 200; another
 *      read failure is still a 500.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import {
  resolveFeeSchedule, isFeeScheduleSchemaAbsent, FEE_SCHEDULE_NOT_DEPLOYED, FEE_SCHEDULE_NOT_DEPLOYED_ADMIN,
} from "../lib/rentBuddyFeeSchedule.js";
import marketplaceRouter from "../routes/rentABuddyMarketplace.js";
import { resetCharge } from "./helpers/estimateChargePolicy.js";

const BUDDY = "b0b0b0b0-0000-4000-a000-0000000000b0";
const ADMIN = "a0a0a0a0-0000-4000-a000-0000000000a0";
const PROFILE_ID = "c0c0c0c0-0000-4000-a000-0000000000c0";
const TOKENS: Record<string, string> = { "tok-buddy": BUDDY, "tok-admin": ADMIN };

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } };

/** A production-shaped schedule row: the columns production has (no basis points). */
const PROD_FEE_ROW = { id: "fr-1", buddy_level: "new", platform_fee_percent: 10, traveler_service_fee_usd: 0, traveler_service_fee_pct: 0, updated_at: "2026-10-01T00:00:00Z" };

function world(): Seed {
  return {
    profiles: [{ id: BUDDY, role: "user", handle: "buddy" }, { id: ADMIN, role: "admin", handle: "admin" }],
    user_account_states: [],
    rent_buddy_profiles: [{ id: PROFILE_ID, user_id: BUDDY, status: "active", buddy_level: "new" }],
    rent_buddy_fee_rules: [{ ...PROD_FEE_ROW }],
    rent_buddy_admin_actions: [],
  };
}

/**
 * The fee schedule, the buddy profile and the auth reads go through the
 * schema-strict double. The earnings summary's paged booking/tip reads and the
 * trust read (which the refusal path never uses) are answered empty by a stub,
 * because this double has no `.range()`.
 */
const PAGED = new Set(["rent_buddy_bookings", "rent_buddy_tips", "trust_profiles", "trust_events", "trust_reviews"]);
function stubList(): any {
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve);
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
      return () => b;
    },
  });
  return b;
}

const auth = {
  getUser: async (token: string) => (TOKENS[token]
    ? { data: { user: { id: TOKENS[token] } }, error: null }
    : { data: { user: null }, error: { message: "invalid" } }),
};

function install(seed: Seed, opts: { columnPresent?: boolean } = {}) {
  const strict = makeSchemaStrictClient(seed, opts.columnPresent ? { unchecked: ["rent_buddy_fee_rules"] } : {});
  const client = { from: (t: string) => (PAGED.has(t) ? stubList() : strict.from(t)), auth };
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  return strict;
}

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", marketplaceRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});
afterEach(resetCharge);

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed, raw };
}

const SUMMARY = "/api/rent-a-buddy/me/earnings/summary";
const FEE_RULES = "/api/rent-a-buddy/admin/fee-rules";
const FLAT_UPDATE = { updates: [{ buddyLevel: "new", platformFeeBasisPoints: 1000, travelerServiceFeeUsd: 0, travelerServiceFeePct: 0 }] };

describe("schema-strict: the resolver says WHICH failure a database without 3601 is", () => {
  it("a production-shaped rent_buddy_fee_rules (no platform_fee_basis_points) is read_failed + schemaAbsent", async () => {
    const strict = makeSchemaStrictClient(world());
    const r = await resolveFeeSchedule(strict, "new");
    assert.equal(r.status, "read_failed");
    assert.equal((r as any).schemaAbsent, true);
    assert.deepEqual(strict.deadColumnErrors.map((e) => `${e.table}.${e.column}`), ["rent_buddy_fee_rules.platform_fee_basis_points"],
      "the statement named exactly the column 3601 adds");
  });

  it("any other read failure is read_failed WITHOUT schemaAbsent (it stays a 500)", async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42501", message: "permission denied for table rent_buddy_fee_rules" } }) }) }) }) };
    const r = await resolveFeeSchedule(failing, "new");
    assert.equal(r.status, "read_failed");
    assert.equal((r as any).schemaAbsent, undefined);
    assert.equal(isFeeScheduleSchemaAbsent({ code: "42703", message: "column rent_buddy_fee_rules.traveler_service_fee_pct does not exist" }), false,
      "a different missing column is not 3601's, so the stated reason would be wrong");
    assert.equal(isFeeScheduleSchemaAbsent({ code: "PGRST204", message: "Could not find the 'platform_fee_basis_points' column of 'rent_buddy_fee_rules' in the schema cache" }), true,
      "the write-side (PostgREST schema cache) shape of the same absence");
  });
});

describe("schema-strict: GET /api/rent-a-buddy/me/earnings/summary on a database without 3601", () => {
  it("answers 503 degraded_unavailable with the reason, and publishes no fee or earnings figure", async () => {
    install(world());
    const r = await call("GET", SUMMARY, "tok-buddy");
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.message, FEE_SCHEDULE_NOT_DEPLOYED);
    assert.equal(r.body.retryable, true);
    assert.equal("estimatedPlatformFeeUsd" in r.body, false);
    assert.equal("platformFeeBasisPoints" in r.body, false);
  });

  it("control: with the column present (3601 run) the same request is priced (200)", async () => {
    const seed = world();
    seed.rent_buddy_fee_rules = [{ ...PROD_FEE_ROW, platform_fee_basis_points: 1000 }];
    install(seed, { columnPresent: true });
    const r = await call("GET", SUMMARY, "tok-buddy");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.platformFeeBasisPoints, 1000);
  });
});

describe("schema-strict: PATCH /api/rent-a-buddy/admin/fee-rules on a database without 3601", () => {
  it("answers 503 degraded_unavailable naming the held migration, and writes nothing", async () => {
    const strict = install(world());
    const r = await call("PATCH", FEE_RULES, "tok-admin", FLAT_UPDATE);
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.message, FEE_SCHEDULE_NOT_DEPLOYED_ADMIN);
    assert.deepEqual(strict.writes.map((w) => w.table), [], "no fee row and no audit row");
    assert.deepEqual(strict.deadColumnErrors.map((e) => `${e.table}.${e.column}`), ["rent_buddy_fee_rules.platform_fee_basis_points"]);
  });

  it("control: with the column present the flat rate is saved and audited (200)", async () => {
    const strict = install(world(), { columnPresent: true });
    const r = await call("PATCH", FEE_RULES, "tok-admin", FLAT_UPDATE);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.writes.map((w) => w.table), ["rent_buddy_fee_rules", "rent_buddy_admin_actions"]);
  });
});
