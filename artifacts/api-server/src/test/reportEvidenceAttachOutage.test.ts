/**
 * POST /reports — the context evidence row was written into a rejection handler
 * that never runs.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *     void sc.from("report_evidence").insert({...}).then(undefined, () => {});
 *
 * `.then(undefined, cb)` installs a REJECTION handler, and supabase-js does not
 * reject: a failed write RESOLVES as `{ error }` (a network failure resolves
 * too, because postgrest-js catches fetch errors itself). So the handler never
 * ran for the failure that actually happens, and the resolved `{ error }` was
 * discarded by the empty first `.then` slot. The evidence row could fail to
 * write with no log line, no response field and no exception — in a file whose
 * own header promises "Evidence preservation".
 *
 * `context_type`/`context_id` is the pointer from a harassment report to the
 * thread, message or trip it is ABOUT. Without it a moderator opens a report
 * that says only "harassment" and cannot see what was reported, and nobody —
 * reporter, moderator, operator — knows the pointer was ever meant to exist.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - The report itself must STILL be filed (201, reportId) when the evidence
 *     write fails. The documented direction is that evidence attachment never
 *     blocks a report, so a fix that refused would be wrong — asserting 201 is
 *     what prevents that fix from passing.
 *   - The only distinguishing signal is therefore `evidenceAttached`, asserted
 *     explicitly in BOTH cases (true / false); an undefined field fails both.
 *   - A report with NO context_type must omit the field entirely, so
 *     `evidenceAttached: false` cannot be produced by an unrelated path.
 *   - The evidence write is failed by `table:op`; `reports:insert` in the same
 *     handler must keep working or the route never reaches the code under test.
 *   - Exact statuses and codes; `req.log` IS shimmed.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/reportEvidenceAttachOutage.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const REPORTER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TARGET_POST = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONTEXT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const REPORT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

function makeClient(o: { failWrites?: string[] }) {
  const failWrites = new Set(o.failWrites ?? []);
  const builder = (table: string): any => {
    let op = "select";
    const settle = () => {
      if (op !== "select") {
        if (failWrites.has(`${table}:${op}`)) return { data: null, error: DB_ERROR };
        if (table === "reports") return { data: { id: REPORT_ID, status: "open", severity: "normal" }, error: null };
        return { data: null, error: null };
      }
      if (table === "profiles") return { data: { id: REPORTER, account_status: "active" }, error: null };
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
    auth: { getUser: async () => ({ data: { user: { id: REPORTER } }, error: null }) },
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
  const { default: reportsRouter } = await import("../routes/reports.js");
  app.use(reportsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });

function post(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/reports`,
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

const WITH_CONTEXT = {
  target_type: "post",
  target_id: TARGET_POST,
  reason_code: "spam",
  context_type: "thread",
  context_id: CONTEXT_ID,
};

describe("POST /reports — context evidence attachment", () => {
  it("evidence writable: 201 with evidenceAttached true", async () => {
    install({});
    const r = await post(WITH_CONTEXT);
    assert.equal(r.status, 201);
    assert.equal(r.body.reportId, REPORT_ID);
    assert.equal(r.body.evidenceAttached, true);
  });

  it("report_evidence insert FAILS: the report still files, and the miss is reported", async () => {
    install({ failWrites: ["report_evidence:insert"] });
    const r = await post(WITH_CONTEXT);
    // Direction deliberately unchanged: the report row is committed and a failed
    // evidence attach must not throw it away. `evidenceAttached` is the only
    // thing that distinguishes this from the case above.
    assert.equal(r.status, 201);
    assert.equal(r.body.reportId, REPORT_ID);
    assert.equal(r.body.evidenceAttached, false);
  });

  it("no context_type: the field is absent, not false", async () => {
    install({ failWrites: ["report_evidence:insert"] });
    const r = await post({ target_type: "post", target_id: TARGET_POST, reason_code: "spam" });
    assert.equal(r.status, 201);
    assert.equal(r.body.evidenceAttached, undefined);
  });

  it("reports insert FAILS: refuses — evidenceAttached is not standing in for the report write", async () => {
    install({ failWrites: ["reports:insert"] });
    const r = await post(WITH_CONTEXT);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });
});
