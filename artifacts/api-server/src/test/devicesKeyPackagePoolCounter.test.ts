/**
 * devicesKeyPackagePoolCounter — `totalPool` must be a number the database
 * agreed to.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * POST /me/devices/:deviceId/key-packages stored the uploaded KeyPackages (that
 * write IS checked) and then advanced the device's pool counter with
 *
 *     await sc.from("devices").update({ key_package_count: newCount }).eq("id", deviceId);
 *
 * — no `.select()`, no `{ error }`. supabase-js RESOLVES on a database error, so
 * a counter that never moved was indistinguishable from one that did, and the
 * route answered HTTP 201 `{ totalPool: <the number it hoped for> }`.
 *
 * devices.key_package_count is not decoration. GET
 * /users/:userId/key-packages/consume picks the target's device with
 * `.gt("key_package_count", 0)`, so a device whose counter stayed at 0 is
 * INVISIBLE to every peer trying to open an E2EE thread with that user — while
 * its key_packages rows sit in the table, uploaded and unusable. The peer is
 * told "No KeyPackages available for this user"; the owner was told their pool
 * is full. Neither answer points at the counter, and nothing reconciles it.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * `db_error` is HTTP 500 and so is an express crash, so both failure cases
 *    assert the JSON body carries `error: 'db_error'`, and a `req.log` shim is
 *    installed (the handler logs through `req.log` on this path).
 *  * "Not 201" would be satisfied by a handler that stopped working; the
 *    positive control asserts 201, the returned totalPool, AND the stored
 *    counter.
 *  * The failure is keyed on the devices UPDATE. The same handler READS `devices`
 *    immediately before, so failing that table wholesale would trip the
 *    ownership check instead and prove nothing about the counter write.
 *  * Each failure case also pins the consequence directly: the KeyPackages are
 *    stored while the counter is still 0, which is precisely the state
 *    `.gt("key_package_count", 0)` filters the device out of.
 *
 * Run: node --import tsx/esm --test src/test/devicesKeyPackagePoolCounter.test.ts
 */
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
const BATCH = Array.from({ length: 10 }, (_, i) => `kp-bytes-${i}`);

let server: http.Server;
let base: string;

interface State {
  device: { id: string; user_id: string; key_package_count: number } | null;
  keyPackages: any[];
  failCounterUpdate: { message: string } | null;
  /** Make the UPDATE match nothing, as if the device row vanished mid-request. */
  counterUpdateMatchesNothing: boolean;
  counterUpdatesAttempted: number;
}

let state: State;

function makeClient() {
  function table(t: string) {
    const self: any = {
      _filters: [] as Array<[string, string, any]>,
      _update: null as any,
      _insert: null as any,
      _single: false,
      select() { return self; },
      insert(d: any) { self._insert = d; return self; },
      update(d: any) { self._update = d; return self; },
      eq(c: string, v: any) { self._filters.push(["eq", c, v]); return self; },
      gt(c: string, v: any) { self._filters.push(["gt", c, v]); return self; },
      order() { return self; },
      limit() { return self; },
      maybeSingle() { self._single = true; return self; },
      single() { self._single = true; return self; },
      then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
        return Promise.resolve(self._resolve()).then(resolve, reject);
      },
      _resolve(): any {
        if (t === "key_packages") {
          if (self._insert) {
            for (const r of (self._insert as any[])) state.keyPackages.push(r);
            return { data: null, error: null };
          }
          return { data: [], error: null };
        }
        if (t === "devices") {
          if (self._update !== null) {
            state.counterUpdatesAttempted += 1;
            // Scoped to the WRITE — the ownership READ above still answers.
            if (state.failCounterUpdate) return { data: null, error: state.failCounterUpdate };
            if (state.counterUpdateMatchesNothing) return { data: [], error: null };
            const d = state.device;
            const hit = d && self._filters.every(([op, c, v]: any) =>
              op === "eq" ? (d as any)[c] === v : true);
            if (!hit) return { data: [], error: null };
            Object.assign(d as any, self._update);
            return { data: [{ id: (d as any).id }], error: null };
          }
          const d = state.device;
          const hit = d && self._filters.every(([op, c, v]: any) =>
            op === "eq" ? (d as any)[c] === v : (d as any)[c] > v);
          if (self._single) return { data: hit ? d : null, error: null };
          return { data: hit ? [d] : [], error: null };
        }
        return self._single ? { data: null, error: null } : { data: [], count: 0, error: null };
      },
    };
    return self;
  }
  return {
    from: (t: string) => table(t),
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

function upload(): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ keyPackages: BATCH });
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
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = {
    device: { id: DEVICE_ID, user_id: USER_ID, key_package_count: 0 },
    keyPackages: [],
    failCounterUpdate: null,
    counterUpdateMatchesNothing: false,
    counterUpdatesAttempted: 0,
  };
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

describe("POST /me/devices/:id/key-packages — totalPool must be a stored number", () => {
  it("refuses with db_error when the pool counter UPDATE fails, instead of answering 201 totalPool", async () => {
    state.failCounterUpdate = { message: "canceling statement due to statement timeout" };
    const r = await upload();

    assert.equal(state.counterUpdatesAttempted, 1, "fixture check: the handler must have attempted the counter UPDATE");
    assert.equal(r.status, 500, `expected the db_error status, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body?.error, "db_error",
      `the body must carry the handler's own error code — an express crash also answers 500 ` +
      `but with no 'error' field. Got ${JSON.stringify(r.body)}`,
    );
    assert.notEqual(r.body?.totalPool, BATCH.length, "the route must not report a pool size the database never stored");

    // The consequence, stated directly: KeyPackages exist, the counter does not,
    // and consume selects devices with `.gt("key_package_count", 0)`.
    assert.equal(state.keyPackages.length, BATCH.length, "the KeyPackages themselves were stored");
    assert.equal(
      state.device!.key_package_count, 0,
      "the counter is still 0 — this device is filtered out of every consume lookup",
    );
  });

  it("refuses with db_error when the counter UPDATE matches no row", async () => {
    state.counterUpdateMatchesNothing = true;
    const r = await upload();

    assert.equal(state.counterUpdatesAttempted, 1, "fixture check: the handler must have attempted the counter UPDATE");
    assert.equal(r.status, 500, `expected the db_error status, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    assert.notEqual(r.body?.totalPool, BATCH.length, "a zero-row update stored no counter and must not report one");
  });

  it("positive control: a healthy upload answers 201 and the stored counter really advances", async () => {
    const r = await upload();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body?.uploaded, BATCH.length);
    assert.equal(r.body?.totalPool, BATCH.length);
    assert.equal(
      state.device!.key_package_count, BATCH.length,
      "the fix must not turn a working upload into a refusal — the counter must actually advance",
    );
    assert.equal(state.keyPackages.length, BATCH.length);
  });
});
