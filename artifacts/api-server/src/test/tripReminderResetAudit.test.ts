/**
 * POST /admin/trips/:tripId/reset-reminder — audit trail tests
 *
 * Verifies that a successful reminder reset writes a moderation_actions row
 * with action_type 'trip_reminder_reset', the admin's user ID as performed_by,
 * and the trip owner's user ID as target_user_id.
 *
 * Run: node --import tsx/esm --test src/test/tripReminderResetAudit.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import adminRouter from "../routes/admin.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake.jwt.token";
const ADMIN_ID   = "aaaaaaaa-1111-1111-1111-000000000001";
const OWNER_ID   = "bbbbbbbb-2222-2222-2222-000000000002";
const TRIP_ID    = "cccccccc-3333-3333-3333-000000000003";

// ── HTTP helpers ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${FAKE_TOKEN}`,
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

// ── Fake Supabase client ───────────────────────────────────────────────────────

function makeFakeClient(opts: {
  tripExists?: boolean;
  captureInserts?: Record<string, any[]>;
  updateError?: boolean;
}) {
  const {
    tripExists = true,
    captureInserts = {},
    updateError = false,
  } = opts;

  const adminProfile = { id: ADMIN_ID, role: "admin", account_status: "active", handle: "testadmin" };
  const tripRow      = { id: TRIP_ID, owner_id: OWNER_ID };

  function builder(table: string, rows: any[]) {
    let _rows = rows.map((r) => ({ ...r }));
    const b: any = {
      select:      (_cols?: string) => builder(table, _rows),
      insert:      (data: any) => {
        const row = Array.isArray(data) ? data[0] : data;
        if (!captureInserts[table]) captureInserts[table] = [];
        captureInserts[table].push(row);
        _rows = [row];
        return b;
      },
      update:      (_patch: any) => {
        return {
          eq: () => ({
            then: (resolve: any) =>
              Promise.resolve({ data: null, error: updateError ? { message: "db error" } : null }).then(resolve),
          }),
        };
      },
      eq:          (col: string, val: any) => builder(table, _rows.filter((r) => r[col] === val)),
      neq:         (col: string, val: any) => builder(table, _rows.filter((r) => r[col] !== val)),
      is:          (col: string, val: any) => builder(table, val === null ? _rows.filter((r) => r[col] == null) : _rows.filter((r) => r[col] === val)),
      in:          (col: string, vals: any[]) => builder(table, _rows.filter((r) => vals.includes(r[col]))),
      or:          () => builder(table, _rows),
      not:         () => builder(table, _rows),
      order:       () => builder(table, _rows),
      limit:       (n: number) => builder(table, _rows.slice(0, n)),
      range:       () => builder(table, _rows),
      maybeSingle: () => ({ data: _rows[0] ?? null, error: null }),
      single:      () => ({ data: _rows[0] ?? null, error: _rows.length ? null : { message: "no rows" } }),
      then:        (resolve: any) => Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
      get count()  { return _rows.length; },
    };
    return b;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id: ADMIN_ID } }, error: null };
      },
    },
    storage: {
      from: () => ({ remove: async () => ({ error: null }) }),
    },
    from: (table: string) => {
      if (table === "profiles")           return builder(table, [adminProfile]);
      if (table === "trips")              return builder(table, tripExists ? [tripRow] : []);
      if (table === "moderation_actions") return builder(table, []);
      // Passthrough stub for any other table the route may touch.
      const stub: any = {
        select: () => stub, insert: () => stub, update: () => stub,
        upsert: () => stub, delete: () => stub, eq: () => stub,
        neq: () => stub, is: () => stub, in: () => stub, or: () => stub,
        not: () => stub, order: () => stub, limit: () => stub, range: () => stub,
        maybeSingle: () => ({ data: null, error: null }),
        single: () => ({ data: null, error: { message: "no rows" } }),
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        get count() { return 0; },
      };
      return stub;
    },
    rpc: async () => ({ data: null, error: null }),
  };

  return client;
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("POST /admin/trips/:tripId/reset-reminder — audit trail", () => {
  before((_, done) => {
    const app = express();
    app.use(express.json());
    app.use(adminRouter);
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  after(() => server.close());

  it("writes a moderation_actions row with action_type 'trip_reminder_reset' on success", async () => {
    const captureInserts: Record<string, any[]> = {};
    const client = makeFakeClient({ tripExists: true, captureInserts });
    _setTestClient(client, true);

    const res = await req("POST", `/admin/trips/${TRIP_ID}/reset-reminder`);

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.reset, true, "response body should have reset: true");

    const modRows = captureInserts["moderation_actions"] ?? [];
    assert.equal(modRows.length, 1, "exactly one moderation_actions row must be inserted");

    const row = modRows[0];
    assert.equal(row.action_type,    "trip_reminder_reset", "action_type must be 'trip_reminder_reset'");
    assert.equal(row.performed_by,   ADMIN_ID,              "performed_by must be the admin's user ID");
    assert.equal(row.target_user_id, OWNER_ID,              "target_user_id must be the trip owner's user ID");
    assert.ok(
      typeof row.reason === "string" && row.reason.includes(TRIP_ID),
      `reason should reference the trip ID, got: ${row.reason}`,
    );
  });

  it("returns 404 and writes no audit row when the trip does not exist", async () => {
    const captureInserts: Record<string, any[]> = {};
    const client = makeFakeClient({ tripExists: false, captureInserts });
    _setTestClient(client, true);

    const res = await req("POST", `/admin/trips/${TRIP_ID}/reset-reminder`);

    assert.equal(res.status, 404);
    const modRows = captureInserts["moderation_actions"] ?? [];
    assert.equal(modRows.length, 0, "no audit row should be written when trip is not found");
  });

  it("returns 400 for a non-UUID tripId and writes no audit row", async () => {
    const captureInserts: Record<string, any[]> = {};
    const client = makeFakeClient({ captureInserts });
    _setTestClient(client, true);

    const res = await req("POST", "/admin/trips/not-a-uuid/reset-reminder");

    assert.equal(res.status, 400);
    const modRows = captureInserts["moderation_actions"] ?? [];
    assert.equal(modRows.length, 0, "no audit row should be written for an invalid tripId");
  });
});
