/**
 * Rate-limit tests for POST /reports and POST /users/:id/mute
 *
 * Verifies that:
 *  1. Requests under the limit are accepted (200/201)
 *  2. The request that crosses the limit is rejected (429, error:"rate_limited")
 *  3. The 429 response carries a Retry-After header (seconds, >= 1)
 *  4. A different user ID has its own independent bucket (no cross-user spill)
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest)
 * Run:
 *   node --import tsx/esm --test src/test/rateLimits.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit, REPORT_HOURLY_LIMIT, MUTE_DAILY_LIMIT } from "../lib/rateLimit.js";

// ── Shared UUIDs ──────────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-aa01-4000-a000-000000000001";
const BOB_ID    = "bbbbbbbb-bb01-4000-a000-000000000002";
const TARGET_ID = "cccccccc-cc01-4000-a000-000000000003";

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeClient(actorId: string) {
  const db: Record<string, any[]> = {
    profiles:                   [
      { id: actorId,   handle: "actor",  name: "Actor",  is_private: false },
      { id: TARGET_ID, handle: "target", name: "Target", is_private: false },
    ],
    blocks:                     [],
    user_follows:               [],
    user_friendships:           [],
    friend_requests:            [],
    user_message_settings:      [],
    message_requests:           [],
    user_account_states:        [],
    user_privacy_settings:      [],
    user_mutes:                 [],
    user_restrictions:          [],
    trust_restrictions:         [],
    user_interaction_cooldowns: [],
    moderation_actions:         [],
    trip_members:               [],
    circle_memberships:         [],
    rent_buddy_bookings:        [],
    reports:                    [],
  };

  function from(table: string) {
    let active_filters: Array<(r: any) => boolean> = [];
    let insertPayload: any = null;
    let upsertPayload: any = null;
    let deleteOp = false;
    let _limitN: number | null = null;

    const b: any = {
      select()               { return b; },
      insert(row: any)       { insertPayload = row; return b; },
      upsert(row: any)       { upsertPayload = row; return b; },
      update(patch: any)     { void patch; return b; },
      delete()               { deleteOp = true; return b; },
      eq(col: string, val: any) { active_filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any){ active_filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]){ active_filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) {
        active_filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      or()   { return b; },
      not()  { return b; },
      gte()  { return b; },
      lte()  { return b; },
      gt()   { return b; },
      lt()   { return b; },
      ilike(){ return b; },
      limit(n: number) { _limitN = n; return b; },
      order()  { return b; },
      range()  { return b; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      let source: any[] = db[table] ?? [];
      source = source.filter((r) => active_filters.every((f) => f(r)));
      if (_limitN !== null) source = source.slice(0, _limitN);
      return source;
    }

    async function resolveSingle(maybe: boolean) {
      if (upsertPayload) {
        const row = { id: "upserted-id", ...upsertPayload };
        (db[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (insertPayload) {
        const row = { id: `new-${Date.now()}`, severity: "normal", status: "open", ...insertPayload };
        (db[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (deleteOp) return { data: null, error: null };
      const matched = rows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (insertPayload) {
        const row = { id: `new-${Date.now()}`, severity: "normal", status: "open", ...insertPayload };
        (db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (upsertPayload) {
        const rowsArr = Array.isArray(upsertPayload) ? upsertPayload : [upsertPayload];
        for (const r of rowsArr) (db[table] ??= []).push({ id: `upserted-${Date.now()}`, ...r });
        return { data: rowsArr.map((r: any) => ({ id: "upserted-id", ...r })), error: null };
      }
      if (deleteOp) return { data: [], error: null };
      return { data: rows(), error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        if (token === actorId) return { data: { user: { id: actorId } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function bearer(token: string) { return { Authorization: `Bearer ${token}` }; }

async function startServer(app: Express) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

function makeApp(...routers: any[]): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  for (const r of routers) app.use("/api", r);
  return app;
}

async function req(
  url: string,
  path: string,
  method: "POST" | "DELETE" | "GET",
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = await res.json().catch(() => ({}));
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body: responseBody, headers };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Rate limits — POST /reports", () => {
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    const { default: reportsRouter } = await import("../routes/reports.js");
    const app = makeApp(reportsRouter);
    _setTestClient(makeClient(ALICE_ID), true);
    server = await startServer(app);
  });

  after(async () => { await server.close(); });

  beforeEach(() => { _resetRateLimit(); });

  const validReport = () => ({
    target_type: "user",
    target_id:   TARGET_ID,
    reason_code: "spam",
  });

  it("allows requests under the hourly limit", async () => {
    const r = await req(server.url, "/api/reports", "POST", ALICE_ID, validReport());
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "open");
  });

  it("returns 429 after exceeding REPORT_HOURLY_LIMIT requests", async () => {
    for (let i = 0; i < REPORT_HOURLY_LIMIT; i++) {
      const r = await req(server.url, "/api/reports", "POST", ALICE_ID, validReport());
      assert.equal(r.status, 201, `request ${i + 1} should succeed but got ${r.status}`);
    }
    const over = await req(server.url, "/api/reports", "POST", ALICE_ID, validReport());
    assert.equal(over.status, 429, `expected 429 after ${REPORT_HOURLY_LIMIT} reports, got ${over.status}`);
    assert.equal(over.body.error, "rate_limited");
  });

  it("429 response includes a Retry-After header", async () => {
    for (let i = 0; i < REPORT_HOURLY_LIMIT; i++) {
      await req(server.url, "/api/reports", "POST", ALICE_ID, validReport());
    }
    const over = await req(server.url, "/api/reports", "POST", ALICE_ID, validReport());
    assert.equal(over.status, 429);
    const retryAfter = parseInt(over.headers["retry-after"] ?? "0", 10);
    assert.ok(retryAfter >= 1, `Retry-After should be >= 1 second, got ${retryAfter}`);
  });

  it("different users have independent buckets", async () => {
    _setTestClient(makeClient(ALICE_ID), true);
    for (let i = 0; i < REPORT_HOURLY_LIMIT; i++) {
      await req(server.url, "/api/reports", "POST", ALICE_ID, validReport());
    }
    const aliceOver = await req(server.url, "/api/reports", "POST", ALICE_ID, validReport());
    assert.equal(aliceOver.status, 429, "Alice should be rate-limited");

    _setTestClient(makeClient(BOB_ID), true);
    const bobFirst = await req(server.url, "/api/reports", "POST", BOB_ID, validReport());
    assert.equal(bobFirst.status, 201, `Bob should not be rate-limited (Alice's bucket should not spill): got ${bobFirst.status}`);
  });
});

describe("Rate limits — POST /users/:id/mute", () => {
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    const { default: mutesRouter } = await import("../routes/mutes.js");
    const app = makeApp(mutesRouter);
    _setTestClient(makeClient(ALICE_ID), true);
    server = await startServer(app);
  });

  after(async () => { await server.close(); });

  beforeEach(() => { _resetRateLimit(); });

  it("allows muting under the daily limit", async () => {
    const r = await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", ALICE_ID, {
      mute_types: ["messages"],
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.muted, true);
  });

  it("returns 429 after exceeding MUTE_DAILY_LIMIT requests", async () => {
    for (let i = 0; i < MUTE_DAILY_LIMIT; i++) {
      const r = await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", ALICE_ID, {
        mute_types: ["messages"],
      });
      assert.equal(r.status, 200, `mute ${i + 1} should succeed but got ${r.status}`);
    }
    const over = await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", ALICE_ID, {
      mute_types: ["messages"],
    });
    assert.equal(over.status, 429, `expected 429 after ${MUTE_DAILY_LIMIT} mutes, got ${over.status}`);
    assert.equal(over.body.error, "rate_limited");
  });

  it("429 response includes a Retry-After header", async () => {
    for (let i = 0; i < MUTE_DAILY_LIMIT; i++) {
      await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", ALICE_ID, { mute_types: ["all"] });
    }
    const over = await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", ALICE_ID, { mute_types: ["all"] });
    assert.equal(over.status, 429);
    const retryAfter = parseInt(over.headers["retry-after"] ?? "0", 10);
    assert.ok(retryAfter >= 1, `Retry-After should be >= 1 second, got ${retryAfter}`);
  });

  it("different users have independent mute buckets", async () => {
    _setTestClient(makeClient(ALICE_ID), true);
    for (let i = 0; i < MUTE_DAILY_LIMIT; i++) {
      await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", ALICE_ID, { mute_types: ["all"] });
    }
    const aliceOver = await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", ALICE_ID, { mute_types: ["all"] });
    assert.equal(aliceOver.status, 429, "Alice should be rate-limited");

    _setTestClient(makeClient(BOB_ID), true);
    const bobFirst = await req(server.url, `/api/users/${TARGET_ID}/mute`, "POST", BOB_ID, { mute_types: ["all"] });
    assert.equal(bobFirst.status, 200, `Bob should not be rate-limited: got ${bobFirst.status}`);
  });
});
