/**
 * POST /friend-requests/:requestId/decline — the anti-retaliation cooldown was
 * written into a rejection handler that never runs.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *     await sc.from("user_interaction_cooldowns").upsert({...})
 *       .then(undefined, () => {});
 *
 * `.then(undefined, cb)` installs a REJECTION handler, and this client does not
 * reject: supabase-js resolves a failed write as `{ error }` (even a network
 * failure resolves, because postgrest-js catches fetch errors itself). So the
 * handler never ran for the failure that actually happens, and the resolved
 * `{ error }` went nowhere because the first `.then` slot was `undefined`. The
 * one row that stops a declined requester from re-sending for 24 hours could
 * fail to write and leave NO trace: not in the response, not in the log, not as
 * an exception. routes/blocks.ts had already found and fixed this exact shape on
 * its own cooldown write; this one was missed.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - The DECLINE itself must still succeed (200, `status: "declined"`) when the
 *     cooldown write fails. The direction is deliberately unchanged — a failed
 *     cooldown must not undo a decline that has already committed — so a fix
 *     that simply refused would be wrong, and asserting 200 here is what stops
 *     that.
 *   - The distinguishing assertion is therefore `cooldownApplied`, on the exact
 *     same 200 that used to be emitted either way. Both cases assert it
 *     explicitly (true / false), so an undefined field fails both.
 *   - The cooldown write is failed by `table:op` — `friend_requests` is updated
 *     in the same handler, and failing by table alone would fail the decline
 *     update instead and never reach the write under test.
 *   - `profiles` is never failed wholesale (requireUser's account_status read).
 *   - `req.log` IS shimmed: the new failure path logs before responding.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/friendDeclineCooldownWrite.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const REQUESTER = "aaaaaaaa-3333-3333-3333-333333333333";
const RECIPIENT = "bbbbbbbb-4444-4444-4444-444444444444";
const REQUEST_ID = "cccccccc-5555-5555-5555-555555555555";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

/**
 * The builder is a Proxy that answers ANY unknown chain method with itself.
 * That is deliberate: the real chains reached from this route include
 * `.is()`, `.or()`, `.gt()` and more via services/trust/TrustRestrictionService,
 * and a hand-listed method set made the permission engine throw a TypeError
 * that the route caught and reported as a 500 — a false RED that looks exactly
 * like a route refusing. Only the terminals are modelled explicitly.
 */
function makeClient(o: { failCooldownWrite?: boolean }) {
  const builder = (table: string): any => {
    let op = "select";
    const settle = () => {
      if (table === "user_interaction_cooldowns" && op !== "select") {
        return o.failCooldownWrite ? { data: null, error: DB_ERROR } : { data: null, error: null };
      }
      if (table === "friend_requests" && op === "select") {
        return {
          data: { id: REQUEST_ID, requester_id: REQUESTER, recipient_id: RECIPIENT, status: "pending" },
          error: null,
        };
      }
      if (table === "profiles") return { data: { id: RECIPIENT, account_status: "active" }, error: null };
      return { data: op === "select" ? null : null, error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(settle()).then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(settle());
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
          return (..._a: any[]) => { op = String(prop); return b; };
        }
        return (..._a: any[]) => b;
      },
    });
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: RECIPIENT } }, error: null }) },
    from: (table: string) => builder(table),
  } as any;
}

function install(o: { failCooldownWrite?: boolean }) {
  const c = makeClient(o);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  const { default: friendsRouter } = await import("../routes/friends.js");
  app.use(friendsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });

function post(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = "{}";
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("POST /friend-requests/:id/decline — anti-retaliation cooldown", () => {
  it("cooldown writable: 200 declined with cooldownApplied true", async () => {
    install({});
    const r = await post(`/friend-requests/${REQUEST_ID}/decline`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "declined");
    assert.equal(r.body.cooldownApplied, true);
  });

  it("cooldown write FAILS: the decline still stands, and the failure is reported", async () => {
    install({ failCooldownWrite: true });
    const r = await post(`/friend-requests/${REQUEST_ID}/decline`);
    // Direction unchanged on purpose: the decline is committed and must not be
    // undone by a failed cooldown. So the ONLY thing that can distinguish these
    // two cases is the field below, which is why it is asserted in both.
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "declined");
    assert.equal(r.body.cooldownApplied, false);
  });
});
