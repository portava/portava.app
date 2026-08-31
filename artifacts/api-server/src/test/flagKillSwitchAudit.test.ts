/**
 * Tests for FLAG-1 / FLAG-2 — PUT /admin/notification-defaults must route the
 * push kill switch through the audited RPC and check its result.
 *
 * FLAG-1: the handler used a raw feature_flags.update(), bypassing
 *   toggle_feature_flag_with_audit — so flipping push_notifications_enabled left
 *   no feature_flag_audit_log row and the dashboard's last-change went stale.
 * FLAG-2: that raw update discarded { error } and matched zero rows silently, so
 *   toggling the kill switch OFF during a storm could return ok:true while
 *   nothing changed.
 *
 * The fix routes through the RPC and checks the result + rowcount. This test
 * asserts (A) a successful toggle records an audit row, and (B) an RPC failure
 * (flag row absent) yields an error response, not ok:true. Mutation-proven.
 *
 * Run: node --import tsx/esm --test src/test/flagKillSwitchAudit.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import notificationsRouter from "../routes/notifications.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const ADMIN_ID = "adadadad-0000-0000-0000-000000000001";

// A minimal admin-capable client. `flagKnown` controls whether the audited RPC
// finds the flag (success) or returns "Flag not found" (failure path). Records
// audit rows the RPC would have written so FLAG-1 can be asserted.
function makeAdminClient(flagKnown: boolean, auditRows: any[]) {
  function builder(rows: any[]) {
    const eqs: Array<[string, any]> = [];
    const b: any = {
      select() { return b; },
      update() { return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      maybeSingle() { const m = rows.filter((r) => eqs.every(([c, v]) => r[c] === v)); return Promise.resolve({ data: m[0] ?? null, error: null }); },
      then(res: any, rej: any) { const m = rows.filter((r) => eqs.every(([c, v]) => r[c] === v)); return Promise.resolve({ data: m, error: null }).then(res, rej); },
    };
    return b;
  }
  const adminProfile = { id: ADMIN_ID, role: "admin", account_status: "active", display_name: "Admin", username: "admin", handle: "admin" };
  return {
    auth: { getUser: async (_t: string) => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
    from(table: string) {
      if (table === "profiles") return builder([adminProfile]);
      return builder([]);
    },
    async rpc(name: string, args: any) {
      if (name !== "toggle_feature_flag_with_audit") return { data: [], error: null };
      if (!flagKnown) return { data: null, error: { message: "Flag not found", code: "P0002" } };
      auditRows.push({ flag: args.p_flag, new_enabled: args.p_new_enabled, changed_by_user_id: args.p_changed_by_id });
      return { data: [{ flag: args.p_flag, enabled: args.p_new_enabled, updated_at: new Date().toISOString(), changed_at: new Date().toISOString(), old_enabled: !args.p_new_enabled }], error: null };
    },
  };
}

function startServer(): Promise<{ server: Server; url: string }> {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/", notificationsRouter);
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("FLAG-1/FLAG-2 — push kill switch goes through the audited RPC and is checked", () => {
  let server: Server;
  let url: string;
  let auditRows: any[];

  beforeEach(async () => { ({ server, url } = await startServer()); auditRows = []; });
  afterEach(async () => {
    _setTestClient(null, false);
    _setTestServiceClient(null);
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function put(body: unknown) {
    const res = await fetch(`${url}/admin/notification-defaults`, {
      method: "PUT",
      headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("a successful toggle records a feature_flag_audit_log row (FLAG-1)", async () => {
    const client = makeAdminClient(true, auditRows);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await put({ pushNotificationsEnabled: false });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.equal(r.body.ok, true);
    assert.equal(auditRows.length, 1, "the audited RPC must have written one audit row");
    assert.equal(auditRows[0].flag, "push_notifications_enabled");
    assert.equal(auditRows[0].changed_by_user_id, ADMIN_ID, "audit row attributes the change to the admin");
  });

  it("an RPC failure (flag row absent) returns an error, not ok:true (FLAG-2)", async () => {
    const client = makeAdminClient(false, auditRows);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await put({ pushNotificationsEnabled: false });
    assert.notEqual(r.body.ok, true, "a failed kill-switch write must not report ok:true");
    assert.notEqual(r.status, 200, `a failed write must not be 200, got ${r.status}`);
  });
});
