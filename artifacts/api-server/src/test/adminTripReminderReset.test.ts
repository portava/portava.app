/**
 * POST /admin/trips/:tripId/reset-reminder — auth-gate tests
 *
 * Verifies that requireAdmin blocks the reset-reminder endpoint for:
 *   - a non-admin (role=member) caller → 403
 *   - an unauthenticated caller (no Authorization header) → 401
 *
 * Run:
 *   node --import tsx/esm --test src/test/adminTripReminderReset.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake.jwt.token";
const USER_ID    = "aaaaaaaa-1111-1111-1111-000000000001";
const TRIP_ID    = "cccccccc-2222-2222-2222-000000000002";

// ── Server ────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

// ── Fake client builder ───────────────────────────────────────────────────────

function makeFakeClient(role: "admin" | "member") {
  const profileRow = { id: USER_ID, role, account_status: "active", handle: "testuser", display_name: null, username: null };

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") {
          return { data: { user: null }, error: { message: "invalid token" } };
        }
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
    from: (_table: string) => {
      const b: any = {
        select:      () => b,
        eq:          () => b,
        neq:         () => b,
        is:          () => b,
        in:          () => b,
        update:      () => b,
        insert:      () => b,
        upsert:      () => b,
        delete:      () => b,
        order:       () => b,
        limit:       () => b,
        maybeSingle: () => ({ data: profileRow, error: null }),
        single:      () => ({ data: profileRow, error: null }),
        then:        (resolve: any) => Promise.resolve({ data: [profileRow], error: null }).then(resolve),
        get count() { return 1; },
      };
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return client;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Makes a POST request to `path`. Pass `token` to include an Authorization
 * header; omit it entirely to send an unauthenticated request.
 */
function req(
  path: string,
  token?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) {
      headers["authorization"] = `Bearer ${token}`;
    }
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method:   "POST",
        headers,
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
    r.end();
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", adminRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /admin/trips/:tripId/reset-reminder — auth gate", () => {
  it("returns 403 when caller is not admin (role=member)", async () => {
    const fc = makeFakeClient("member");
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    const r = await req(`/admin/trips/${TRIP_ID}/reset-reminder`, FAKE_TOKEN);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "forbidden", "error code should be 'forbidden'");
  });

  it("returns 401 when caller sends no Authorization header", async () => {
    const fc = makeFakeClient("admin");
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    // No token argument → no Authorization header sent
    const r = await req(`/admin/trips/${TRIP_ID}/reset-reminder`);
    assert.equal(r.status, 401, `expected 401, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "unauthenticated", "error code should be 'unauthenticated'");
  });
});
