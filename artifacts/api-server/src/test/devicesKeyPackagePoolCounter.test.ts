/** HTTP publication contract. Actual transaction/locking/rollback behavior is
 * exercised by keyPackages.postgres.test.ts against PostgreSQL. */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import keyPackagesRouter from "../routes/keyPackages.js";

const TOKEN     = "kp-owner-token";
const USER_ID   = "55555555-5555-4555-8555-555555555555";
const DEVICE_ID = "66666666-6666-4666-8666-666666666666";
const BATCH = Array.from({ length: 10 }, (_, i) => Buffer.from(`kp-bytes-${i}`).toString("base64url"));

let server: http.Server;
let base: string;

interface State { result: { data: unknown; error: { code: string } | null }; calls: Array<{ name: string; args: unknown }> }
let state: State;
function makeClient() {
  return {
    from: (table: string) => { assert.equal(table, 'profiles'); return {
      select: () => ({ eq: (_field: string, owner: string) => { assert.equal(owner, USER_ID); return { maybeSingle: async () => ({ data: { account_status: 'active', user_account_states: [] }, error: null }) }; } }),
    }; },
    rpc: async (name: string, args: unknown) => { state.calls.push({ name, args }); return state.result; },
    auth: { getUser: async (token: string) => token === TOKEN
      ? { data: { user: { id: USER_ID } }, error: null }
      : { data: { user: null }, error: { message: "invalid token" } } },
  };
}

function upload(batch: unknown = BATCH): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ keyPackages: batch });
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path: `/api/me/devices/${DEVICE_ID}/key-packages`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = { _raw: raw }; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", keyPackagesRouter);
  // `() => resolve()` and not `resolve`: Express 5's listen callback is typed
  // `(error?: Error) => void`, and a bare `resolve` from `Promise<void>` cannot
  // accept that argument. Discarding it is also the right behaviour here — the
  // listen error path is not what this suite is testing, and passing `resolve`
  // through would have RESOLVED the promise with an Error as the value.
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = { result: { data: [{ uploaded: BATCH.length, total_pool: BATCH.length }], error: null }, calls: [] };
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

describe("POST /me/devices/:id/key-packages — atomic publication contract", () => {
  it("binds the transaction to the authenticated owner and returns committed counts", async () => {
    const result = await upload(); assert.equal(result.status, 201);
    assert.deepEqual(result.body, { uploaded: 10, totalPool: 10 });
    assert.deepEqual(state.calls, [{ name: "publish_key_packages", args: { p_owner_id: USER_ID, p_device_id: DEVICE_ID, p_packages: BATCH } }]);
  });
  it("does not report an uncommitted pool when the transaction fails", async () => {
    state.result = { data: null, error: { code: "57014" } };
    const result = await upload(); assert.equal(result.status, 500); assert.equal(result.body.error, "db_error"); assert.equal(result.body.totalPool, undefined);
  });
  it("refuses a missing commit receipt and an unowned device", async () => {
    state.result = { data: [], error: null }; assert.equal((await upload()).status, 500);
    state.result = { data: null, error: { code: "42501" } }; assert.equal((await upload()).status, 404);
  });
  it("accepts an idempotent retry without inventing newly uploaded keys", async () => {
    state.result.data = [{ uploaded: 0, total_pool: 1 }];
    assert.deepEqual((await upload()).body, { uploaded: 0, totalPool: 1 });
  });
  it("rejects malformed or unbounded packages before database work", async () => {
    for (const batch of [[null], [42], ["has whitespace"], ["a".repeat(65537)], []]) assert.equal((await upload(batch)).status, 400);
    assert.equal(state.calls.length, 0);
  });
});
