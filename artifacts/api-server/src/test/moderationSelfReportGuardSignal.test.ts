/**
 * POST /api/moderation/report — when the self-report guard cannot RUN, say so.
 *
 * The guard is `if (subjectUserId && subjectUserId === user.id)`. A null owner
 * passes it. `resolveContentOwner` returns null for four different reasons, one
 * of which is "the lookup could not run" (supabase-js RESOLVES on a database
 * error), so an unreadable `posts` silently let someone report their own
 * content — and the one log this route emitted said "the content row is missing
 * OR the owner lookup failed", because it genuinely could not tell.
 *
 * ── WHAT IS DELIBERATELY *NOT* CHANGED, AND IS ASSERTED HERE ────────────────
 * The report is STILL FILED. This is the abuse-reporting intake path, and its
 * fail-OPEN posture is a recorded owner decision: a self-report is a nuisance a
 * moderator dismisses in one click, while a report refused because a lookup
 * blinked is gone, and the person who needed to file it never learns it did not
 * land. The deliverable is therefore the operator SIGNAL, and the assertions
 * below are on the signal — that the two causes are told apart, and that the
 * skipped guard is stated as skipped.
 *
 * A test that only asserted "a log was written" would pass on any log, so each
 * case asserts WHICH message appeared and WHICH did not.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/moderationSelfReportGuardSignal.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import moderationRouter from "../routes/moderation.js";

const ALICE = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB = "bbbbbbbb-0000-0000-0000-000000000002";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

type Row = Record<string, any>;

let logs: Array<{ level: string; msg: string }> = [];
let inserted: Row[] = [];

/**
 * `profiles` carries BOTH the reporter's account status (read by requireUser
 * with `.select("account_status")`) and, for a `user` subject, the owner. Only
 * the subject-owner read is failed, keyed on the exact projection — failing the
 * whole table would make requireUser refuse with a 503 upstream and the route
 * under test would never run.
 */
function makeClient(rows: Record<string, Row[]>, errors: Record<string, any>) {
  function chain(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let insertRow: Row | null = null;
    let projection = "";

    const errFor = () => {
      if (insertRow) return null;
      const e = errors[table];
      if (!e) return null;
      const col = table === "posts" ? "author_id" : table === "profiles" ? "__never__" : "user_id";
      return projection.trim() === col ? e : null;
    };

    async function resolve(single: boolean) {
      if (insertRow) {
        const saved = { id: "report-1", ...insertRow };
        inserted.push(saved);
        return { data: single ? saved : [saved], error: null };
      }
      const e = errFor();
      if (e) return { data: null, error: e };
      const m = (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: single ? (m[0] ?? null) : m, error: null };
    }

    const q: any = {
      select(cols?: string) { projection = cols ?? ""; return q; },
      insert(d: Row) { insertRow = Array.isArray(d) ? d[0] : d; return q; },
      update() { return q; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return q; },
      in() { return q; },
      order() { return q; },
      limit() { return q; },
      single() { return resolve(true); },
      maybeSingle() { return resolve(true); },
      then(res: any, rej: any) { return resolve(false).then(res, rej); },
    };
    return q;
  }

  return {
    from: (t: string) => chain(t),
    auth: { getUser: async () => ({ data: { user: { id: ALICE } }, error: null }) },
  } as any;
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const cap = (level: string) => (_o: unknown, msg?: string) => { logs.push({ level, msg: String(msg ?? _o) }); };
    req.log = { error: cap("error"), warn: cap("warn"), info: cap("info"), debug: cap("debug") };
    next();
  });
  app.use("/api", moderationRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.close(); });

let requests = 0;
async function report(
  rows: Record<string, Row[]>,
  errors: Record<string, any>,
  body: Record<string, unknown>,
) {
  logs = [];
  inserted = [];
  _resetRateLimit();
  _setTestClient(makeClient(rows, errors), true);
  requests++;
  const res = await fetch(`${baseUrl}/api/moderation/report`, {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any, logs: [...logs], inserted: [...inserted] };
}

const aliceProfile = () => [{ id: ALICE, account_status: "active" }];
const POST_A = "cccccccc-0000-0000-0000-00000000000a";
const POST_B = "cccccccc-0000-0000-0000-00000000000b";
const POST_C = "cccccccc-0000-0000-0000-00000000000c";
const POST_D = "cccccccc-0000-0000-0000-00000000000d";

const said = (ls: Array<{ level: string; msg: string }>, needle: string) =>
  ls.find((l) => l.msg.includes(needle));

describe("subject-owner lookup FAILED", () => {
  it("still files the report — the documented fail-open posture is preserved", async () => {
    const r = await report({ profiles: aliceProfile() }, { posts: DB_ERROR },
      { subjectType: "post", subjectId: POST_A, category: "spam" });
    assert.equal(r.status, 201, `expected the report to be filed; got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.inserted.length, 1, "the report row must be written");
    assert.equal(r.inserted[0].subject_user_id, null, "unattributed, for a moderator to attribute by hand");
  });

  it("states that the SELF-REPORT GUARD did not run", async () => {
    const r = await report({ profiles: aliceProfile() }, { posts: DB_ERROR },
      { subjectType: "post", subjectId: POST_A, category: "spam" });
    const hit = said(r.logs, "self-report guard DID NOT RUN");
    assert.ok(hit, `expected the skipped-guard signal; got ${JSON.stringify(r.logs)}`);
    assert.equal(hit!.level, "error");
  });

  it("distinguishes the outage from 'the content row is missing'", async () => {
    const r = await report({ profiles: aliceProfile() }, { posts: DB_ERROR },
      { subjectType: "post", subjectId: POST_A, category: "spam" });
    assert.ok(said(r.logs, "COULD NOT RUN"), `got ${JSON.stringify(r.logs)}`);
    assert.equal(said(r.logs, "the content row is missing"), undefined,
      "an unreadable table must not be reported as a missing content row");
  });
});

describe("PAIRED readable cases", () => {
  it("owner is SOMEONE ELSE → filed, attributed, and no failure signal at all", async () => {
    const r = await report(
      { profiles: aliceProfile(), posts: [{ id: POST_B, author_id: BOB }] }, {},
      { subjectType: "post", subjectId: POST_B, category: "spam" });
    assert.equal(r.status, 201);
    assert.equal(r.inserted[0].subject_user_id, BOB);
    assert.equal(said(r.logs, "DID NOT RUN"), undefined);
    assert.equal(said(r.logs, "COULD NOT RUN"), undefined);
  });

  it("owner IS the reporter → 400, the guard runs and refuses", async () => {
    // Proves the guard is live, so "it did not run" above is a real distinction
    // and not a description of a guard that never fires.
    const r = await report(
      { profiles: aliceProfile(), posts: [{ id: POST_C, author_id: ALICE }] }, {},
      { subjectType: "post", subjectId: POST_C, category: "spam" });
    assert.equal(r.status, 400, `expected the self-report to be refused; got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(r.inserted.length, 0, "a self-report must not be filed");
  });

  it("content row genuinely ABSENT → filed unattributed, and says the row is missing", async () => {
    // The case the outage used to be indistinguishable from.
    const r = await report({ profiles: aliceProfile(), posts: [] }, {},
      { subjectType: "post", subjectId: POST_D, category: "spam" });
    assert.equal(r.status, 201);
    assert.equal(r.inserted[0].subject_user_id, null);
    assert.ok(said(r.logs, "the content row is missing"), `got ${JSON.stringify(r.logs)}`);
    assert.equal(said(r.logs, "COULD NOT RUN"), undefined);
    assert.equal(said(r.logs, "DID NOT RUN"), undefined);
  });
});

describe("vacuity", () => {
  it("every case above actually issued a report request", () => {
    assert.ok(requests >= 6, `expected >= 6 requests, got ${requests}`);
  });
});
