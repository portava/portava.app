/**
 * POST /circle-invites, /circle-invites/:id/accept, /circle-invites/:id/decline
 * — three writes into someone's trusted circle that were reported blind.
 *
 * ── THE DEFECTS ─────────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error; it does not throw. So every one of
 * these was a claim assembled out of a statement nobody looked at:
 *
 *   ACCEPT   `await sc.from("circle_invites").update({status:"accepted"})…`
 *            with `.error` never bound, followed by the circle_memberships
 *            upsert whose error WAS bound, WAS logged — and was then fallen
 *            straight past into `res.json({ status: "accepted" })`. That is the
 *            ERROR-INERT shape: the error is observed and the observation
 *            changes nothing the caller is told. The handler's own banner says
 *            it is THE ONLY PLACE that creates a circle_memberships row, so an
 *            "accepted" with no row means the person is not in the circle, sees
 *            none of its posts/events/presence, and every retry now answers
 *            400 `Invite is already accepted` because the status flip DID land.
 *            The two writes are now ordered membership-first and both checked,
 *            so any partial failure is retry-recoverable.
 *
 *   DECLINE  the status update awaited into nothing: a failed write left the
 *            invite PENDING — still acceptable, still an outstanding invitation
 *            into that user's trusted circle — under a 200 `{status:"declined"}`.
 *
 *   REACTIVATE  same shape: 200 `reactivated: true` for an invite still sitting
 *            in its declined state.
 *
 * Also fixed and covered: the `{ data: inv }` reads on accept/decline bound no
 * error, so an unreadable `circle_invites` was reported to the recipient as
 * "Circle invite not found".
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - Statuses are asserted EXACTLY with their error codes, never `!== 200`
 *     (a crash-500 passes that) and never `>= 500` (which admits a crash).
 *   - `req.log` IS shimmed, so a 500 cannot be a crash in the new log call
 *     wearing a refusal's clothes.
 *   - Every failure case is PAIRED with the success case it must be
 *     distinguishable from — before the fix they returned the same 200 body.
 *   - Writes are FAILED BY (table, operation), not by table alone: accept
 *     touches `circle_invites` for the read AND the update, and failing the
 *     table wholesale would fail the read instead and never reach the write
 *     under test. The fake records which operation each builder performed.
 *   - `profiles` is never failed wholesale: requireUser reads
 *     `profiles.account_status` on every authenticated request and refuses with
 *     its own 503, which would make a guard-under-test assertion pass without
 *     the guard existing.
 *   - The accept suite asserts ORDER: when the membership upsert fails, the
 *     invite status flip must NOT have been attempted (recorded in `writes`).
 *     Without that, "membership-first" would be untested and a fix that merely
 *     checked both errors in the old order would still leave the unrecoverable
 *     dead end in place.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/circleInviteWriteHonesty.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const OWNER = "aaaaaaaa-0000-0000-0000-000000000001";
const RECIPIENT = "bbbbbbbb-0000-0000-0000-000000000002";
const INVITE_ID = "cccccccc-0000-0000-0000-000000000003";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

type Row = Record<string, unknown>;
type Op = "select" | "insert" | "update" | "upsert" | "delete";

interface Opts {
  invite?: Row | null;
  /** Fail reads of these tables. */
  failReads?: string[];
  /** Fail writes, keyed `table:op` (e.g. "circle_invites:update"). */
  failWrites?: string[];
  /**
   * Mutated by the fake: every write attempted, in order, as `table:op`.
   * `orderOf()` narrows it to the two tables this route's ORDER claim is about;
   * the detached syncCircleChatMembers also writes and must not be asserted on.
   */
  writes: string[];
}

function makeClient(o: Opts) {
  const failReads = new Set(o.failReads ?? []);
  const failWrites = new Set(o.failWrites ?? []);

  const builder = (table: string): any => {
    let op: Op = "select";
    const b: any = {
      select: () => b,
      insert: () => { op = "insert"; return b; },
      update: () => { op = "update"; return b; },
      upsert: () => { op = "upsert"; return b; },
      delete: () => { op = "delete"; return b; },
      eq: () => b, in: () => b, or: () => b, order: () => b, limit: () => b, neq: () => b,
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
      then: (resolve: (v: any) => any, reject?: any) => Promise.resolve(settle()).then(resolve, reject),
    };

    function settle() {
      if (op === "select") {
        if (failReads.has(table)) return { data: null, error: DB_ERROR };
        if (table === "circle_invites") return { data: o.invite ?? null, error: null };
        if (table === "profiles") return { data: { id: RECIPIENT, account_status: "active" }, error: null };
        return { data: null, error: null };
      }
      o.writes.push(`${table}:${op}`);
      if (failWrites.has(`${table}:${op}`)) return { data: null, error: DB_ERROR };
      return { data: { id: INVITE_ID }, error: null };
    }
    return b;
  };

  return {
    auth: { getUser: async () => ({ data: { user: { id: RECIPIENT } }, error: null }) },
    from: (table: string) => builder(table),
  } as any;
}

function install(o: Opts) {
  const c = makeClient(o);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // REQUIRED: the guards under test log before refusing.
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

function post(path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
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

/** The two writes whose ORDER this route's recoverability argument depends on. */
function orderOf(writes: string[]): string[] {
  return writes.filter((w) => w.startsWith("circle_memberships:") || w.startsWith("circle_invites:"));
}

const PENDING_INVITE: Row = { id: INVITE_ID, owner_id: OWNER, recipient_id: RECIPIENT, status: "pending" };

describe("POST /circle-invites/:id/accept", () => {
  let writes: string[];
  beforeEach(() => { writes = []; });

  it("everything writable: 200 accepted, membership written BEFORE the status flip", async () => {
    install({ invite: PENDING_INVITE, writes });
    const r = await post(`/circle-invites/${INVITE_ID}/accept`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "accepted");
    assert.equal(r.body.ownerId, OWNER);
    assert.deepEqual(orderOf(writes), ["circle_memberships:upsert", "circle_invites:update"]);
  });

  it("circle_memberships upsert fails: refuses, and does NOT flip the invite", async () => {
    install({ invite: PENDING_INVITE, failWrites: ["circle_memberships:upsert"], writes });
    const r = await post(`/circle-invites/${INVITE_ID}/accept`);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.notEqual(r.body.status, "accepted");
    // The ORDER assertion: the invite must still be pending, so the retry is
    // the ordinary path rather than a permanent 400 dead end.
    assert.deepEqual(orderOf(writes), ["circle_memberships:upsert"]);
  });

  it("status flip fails after a written membership: refuses rather than claiming accepted", async () => {
    install({ invite: PENDING_INVITE, failWrites: ["circle_invites:update"], writes });
    const r = await post(`/circle-invites/${INVITE_ID}/accept`);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.notEqual(r.body.status, "accepted");
    assert.deepEqual(orderOf(writes), ["circle_memberships:upsert", "circle_invites:update"]);
  });

  it("unreadable circle_invites: 503, not 'invite not found'", async () => {
    install({ invite: PENDING_INVITE, failReads: ["circle_invites"], writes });
    const r = await post(`/circle-invites/${INVITE_ID}/accept`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    assert.deepEqual(orderOf(writes), []);
  });

  it("genuinely absent invite still says not_found (the 503 did not swallow 404)", async () => {
    install({ invite: null, writes });
    const r = await post(`/circle-invites/${INVITE_ID}/accept`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });
});

describe("POST /circle-invites/:id/decline", () => {
  let writes: string[];
  beforeEach(() => { writes = []; });

  it("writable: 200 declined", async () => {
    install({ invite: PENDING_INVITE, writes });
    const r = await post(`/circle-invites/${INVITE_ID}/decline`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "declined");
    assert.deepEqual(orderOf(writes), ["circle_invites:update"]);
  });

  it("update fails: refuses instead of reporting a decline that left the invite PENDING", async () => {
    install({ invite: PENDING_INVITE, failWrites: ["circle_invites:update"], writes });
    const r = await post(`/circle-invites/${INVITE_ID}/decline`);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.notEqual(r.body.status, "declined");
  });

  it("unreadable circle_invites: 503, not 'invite not found'", async () => {
    install({ invite: PENDING_INVITE, failReads: ["circle_invites"], writes });
    const r = await post(`/circle-invites/${INVITE_ID}/decline`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual(orderOf(writes), []);
  });
});

describe("POST /circle-invites (reactivate a declined invite)", () => {
  let writes: string[];
  beforeEach(() => { writes = []; });

  const DECLINED: Row = { id: INVITE_ID, owner_id: RECIPIENT, recipient_id: OWNER, status: "declined" };

  it("writable: 200 reactivated", async () => {
    install({ invite: DECLINED, writes });
    const r = await post("/circle-invites", { recipientId: OWNER });
    assert.equal(r.status, 200);
    assert.equal(r.body.reactivated, true);
    assert.deepEqual(orderOf(writes), ["circle_invites:update"]);
  });

  it("update fails: refuses instead of claiming a reactivation that never happened", async () => {
    install({ invite: DECLINED, failWrites: ["circle_invites:update"], writes });
    const r = await post("/circle-invites", { recipientId: OWNER });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.notEqual(r.body.reactivated, true);
  });
});
