/**
 * adminInviteSlotReconcile.test.ts
 *
 * Contract tests for POST /admin/trips/reconcile-invite-slots.
 *
 * Verifies:
 *   1. Non-admin users receive 403.
 *   2. When there are no stranded slots the response is { fixed: 0, slots: [] }.
 *   3. RPC results are shaped into the camelCase response format.
 *   4. minAgeMinutes from the request body is forwarded to the RPC.
 *   5. minAgeMinutes defaults to 5 when omitted.
 *   6. minAgeMinutes is floored to 1 minimum regardless of what the caller sends.
 *   7. A DB error from the RPC returns 500 db_error.
 *
 * Run: node --import tsx/esm --test src/test/adminInviteSlotReconcile.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Fixed test IDs ─────────────────────────────────────────────────────────────

const ADMIN_ID = "aa000000-0000-0000-0000-000000000001";
const LINK_ID  = "bb000000-0000-0000-0000-000000000002";
const USER_ID  = "cc000000-0000-0000-0000-000000000003";
const TRIP_ID  = "dd000000-0000-0000-0000-000000000004";
const CLAIMED_AT = "2026-01-01T00:00:00Z";

// ── Test server ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

// ── HTTP helper ────────────────────────────────────────────────────────────────

function post(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer fake-admin-token",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake-client factory ────────────────────────────────────────────────────────

interface FakeClientOpts {
  isAdmin?: boolean;
  rpcRows?: any[];
  rpcError?: { message: string };
  capturedRpcArgs?: { fn: string; args: Record<string, any> }[];
}

function makeClient(opts: FakeClientOpts = {}): any {
  const {
    isAdmin      = true,
    rpcRows      = [],
    rpcError,
    capturedRpcArgs = [],
  } = opts;

  function builder(rows: unknown[]) {
    const b: any = {
      select:      () => b,
      eq:          () => b,
      maybeSingle: () => Promise.resolve({
        data: rows[0] ?? null,
        error: null,
      }),
      then: (resolve: any) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return b;
  }

  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: ADMIN_ID } },
        error: null,
      }),
    },
    from: (table: string) => {
      if (table === "profiles") {
        return builder([{ id: ADMIN_ID, role: isAdmin ? "admin" : "user" }]);
      }
      return builder([]);
    },
    rpc: async (fn: string, args: Record<string, any>) => {
      capturedRpcArgs.push({ fn, args });
      if (rpcError) {
        return { data: null, error: rpcError };
      }
      return { data: rpcRows, error: null };
    },
  };
}

function setClients(opts: FakeClientOpts) {
  const c = makeClient(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /admin/trips/reconcile-invite-slots", () => {

  it("returns 403 for non-admin users", async () => {
    setClients({ isAdmin: false });
    const r = await post("/admin/trips/reconcile-invite-slots");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("returns { fixed: 0, slots: [] } when there are no stranded slots", async () => {
    setClients({ rpcRows: [] });
    const r = await post("/admin/trips/reconcile-invite-slots");
    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 0);
    assert.deepEqual(r.body.slots, []);
    assert.equal(r.body.minAgeMinutes, 5);
  });

  it("shapes RPC rows into camelCase response slots", async () => {
    const rpcRows = [
      {
        link_id:    LINK_ID,
        user_id:    USER_ID,
        trip_id:    TRIP_ID,
        claimed_at: CLAIMED_AT,
      },
    ];
    setClients({ rpcRows });
    const r = await post("/admin/trips/reconcile-invite-slots");
    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 1);
    assert.equal(r.body.slots.length, 1);
    const slot = r.body.slots[0];
    assert.equal(slot.linkId,    LINK_ID,    "linkId must match");
    assert.equal(slot.userId,    USER_ID,    "userId must match");
    assert.equal(slot.tripId,    TRIP_ID,    "tripId must match");
    assert.equal(slot.claimedAt, CLAIMED_AT, "claimedAt must match");
  });

  it("forwards minAgeMinutes from request body to the RPC", async () => {
    const captured: { fn: string; args: Record<string, any> }[] = [];
    setClients({ rpcRows: [], capturedRpcArgs: captured });
    const r = await post("/admin/trips/reconcile-invite-slots", { minAgeMinutes: 30 });
    assert.equal(r.status, 200);
    assert.equal(r.body.minAgeMinutes, 30);
    const rpcCall = captured.find((c) => c.fn === "reconcile_invite_link_slots");
    assert.ok(rpcCall, "reconcile_invite_link_slots should have been called");
    assert.equal(rpcCall!.args.min_age_minutes, 30);
  });

  it("defaults minAgeMinutes to 5 when not provided", async () => {
    const captured: { fn: string; args: Record<string, any> }[] = [];
    setClients({ rpcRows: [], capturedRpcArgs: captured });
    const r = await post("/admin/trips/reconcile-invite-slots");
    assert.equal(r.status, 200);
    assert.equal(r.body.minAgeMinutes, 5);
    const rpcCall = captured.find((c) => c.fn === "reconcile_invite_link_slots");
    assert.ok(rpcCall);
    assert.equal(rpcCall!.args.min_age_minutes, 5);
  });

  it("clamps minAgeMinutes to a minimum of 1", async () => {
    const captured: { fn: string; args: Record<string, any> }[] = [];
    setClients({ rpcRows: [], capturedRpcArgs: captured });
    const r = await post("/admin/trips/reconcile-invite-slots", { minAgeMinutes: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.body.minAgeMinutes, 1);
    const rpcCall = captured.find((c) => c.fn === "reconcile_invite_link_slots");
    assert.ok(rpcCall);
    assert.equal(rpcCall!.args.min_age_minutes, 1);
  });

  it("returns 500 db_error when the RPC returns an error", async () => {
    setClients({ rpcError: { message: "connection timeout" } });
    const r = await post("/admin/trips/reconcile-invite-slots");
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });

  it("reports correct fixed count when multiple slots are returned", async () => {
    const rpcRows = [
      { link_id: LINK_ID, user_id: USER_ID,   trip_id: TRIP_ID, claimed_at: CLAIMED_AT },
      { link_id: LINK_ID, user_id: "ee000000-0000-0000-0000-000000000005", trip_id: TRIP_ID, claimed_at: CLAIMED_AT },
    ];
    setClients({ rpcRows });
    const r = await post("/admin/trips/reconcile-invite-slots");
    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 2);
    assert.equal(r.body.slots.length, 2);
  });
});
