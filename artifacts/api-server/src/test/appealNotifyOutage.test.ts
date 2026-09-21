/**
 * PATCH /appeals/:id — the appellant's only notice was written into two dead
 * handlers.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *     await sc.from("notifications").insert({...}).then(() => {}).catch(() => {});
 *
 * Two of them: one for `approved`, one for `denied`. supabase-js RESOLVES on a
 * database error rather than throwing, so:
 *   - `.catch(() => {})` is DEAD CODE for the failure that actually happens
 *     (postgrest-js catches fetch errors itself, so even a network failure
 *     resolves), and
 *   - `.then(() => {})` threw away the `{ error }` that WAS delivered.
 * The result: the one message telling a person their appeal was approved — or
 * denied, or approved-but-your-content-still-has-to-be-restored-by-hand — could
 * fail to write with no log line, no response field, and no exception, while
 * the moderator's response reported the appeal resolved. Both sites are in
 * scripts/SILENT_SUPABASE_WRITES_BASELINE.json as `routes/appeals.ts: 2`.
 *
 * NOTHING HERE TOUCHES RESTORE SEMANTICS. What "approved" restores, and whether
 * a deferred restoration should hold the appeal, is a separate open decision
 * (APPEAL_RESTORE_SEMANTICS) and this change does not enter it. Only the
 * observability of the notification write changes.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - The state transition must STILL commit when the notification fails: the
 *     appeals row is already updated and a notification failure must not undo
 *     it. So both cases are a 200 carrying `state: "denied"`, and `notified` is
 *     the ONLY thing that can distinguish them — asserted explicitly in both
 *     (true / false), so an undefined field fails both.
 *   - The `denied` path is used because it reaches the notification write
 *     WITHOUT going through resolveAppeal, so nothing about reversal or
 *     restoration is exercised or asserted here.
 *   - Writes are failed by `table:op`; `appeals:update` must keep working or the
 *     handler never reaches the code under test.
 *   - Exact statuses; `req.log` IS shimmed (the new failure path logs).
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/appealNotifyOutage.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const ADMIN = "aaaaaaaa-eeee-eeee-eeee-eeeeeeeeeeee";
const APPELLANT = "bbbbbbbb-ffff-ffff-ffff-ffffffffffff";
const APPEAL_ID = "cccccccc-1234-1234-1234-123456789abc";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

function makeClient(o: { failWrites?: string[] }) {
  const failWrites = new Set(o.failWrites ?? []);
  const builder = (table: string): any => {
    let op = "select";
    const settle = () => {
      if (op !== "select") {
        if (failWrites.has(`${table}:${op}`)) return { data: null, error: DB_ERROR };
        if (table === "appeals") {
          return {
            data: { id: APPEAL_ID, state: "denied", resolution_note: null, updated_at: "2026-09-08T00:00:00Z" },
            error: null,
          };
        }
        return { data: null, error: null };
      }
      if (table === "profiles") {
        // requireAdmin and requireUser both read this table.
        return { data: { id: ADMIN, account_status: "active", role: "admin", display_name: "Mod", username: "mod", handle: "mod" }, error: null };
      }
      if (table === "appeals") {
        return {
          data: {
            id: APPEAL_ID,
            appellant_id: APPELLANT,
            target_type: "post",
            target_id: "dddddddd-1234-1234-1234-123456789abc",
            state: "under_review",
            resolution_note: null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
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
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
    from: (table: string) => builder(table),
  } as any;
}

function install(o: { failWrites?: string[] }) {
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
  const { default: appealsRouter } = await import("../routes/appeals.js");
  app.use(appealsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });

function patch(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/appeals/${APPEAL_ID}`,
      {
        method: "PATCH",
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

describe("PATCH /appeals/:id (denied) — notifying the appellant", () => {
  it("notification writable: 200 denied with notified true", async () => {
    install({});
    const r = await patch({ state: "denied" });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "denied");
    assert.equal(r.body.notified, true);
  });

  it("notifications insert FAILS: the denial still commits, and the miss is reported", async () => {
    install({ failWrites: ["notifications:insert"] });
    const r = await patch({ state: "denied" });
    // Direction deliberately unchanged: the appeals row is updated and a failed
    // notification must not undo it. `notified` is the only distinguishing
    // signal, which is exactly what did not exist before.
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "denied");
    assert.equal(r.body.notified, false);
  });

  it("appeals update FAILS: refuses — `notified` is not standing in for the state write", async () => {
    install({ failWrites: ["appeals:update"] });
    const r = await patch({ state: "denied" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });
});
