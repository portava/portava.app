/**
 * DELETE /circles/:circleOwnerId/members/:memberId — "removed" was asserted, not
 * observed.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *     await sc.from("circle_memberships").delete().eq(...).eq(...);
 *     res.status(200).json({ status: "removed", memberId });
 *
 * The delete was awaited into nothing. supabase-js RESOLVES a failed DELETE as
 * `{ error }` rather than throwing, so the row could survive untouched and the
 * owner was told the member had been removed. A surviving circle_memberships
 * row is what lib/privacyResolver.ts, routes/events.ts, routes/groupChat.ts,
 * routes/meetups.ts and compass all read to grant circle-visibility access to
 * posts, events, meetups and group chat — so this is a REVOCATION that did not
 * happen, reported as done, on the one action whose entire purpose is to cut
 * somebody off. The unfriend handler twenty lines below already checked its own
 * delete: the file disagreed with itself.
 *
 * Second defect in the same handler: the membership existence read bound only
 * `data`, so an unreadable circle_memberships was reported as "Membership not
 * found" — the owner told that the person they are trying to eject is not in
 * their circle.
 *
 * ── WHAT MAKES THESE ASSERTIONS MEAN SOMETHING ──────────────────────────────
 *   - Statuses asserted EXACTLY with their error codes. `!== 200` would pass on
 *     a crash-500; `>= 500` would admit one.
 *   - The failure case asserts `body.status !== "removed"` explicitly, because
 *     the defect's signature is the WORD "removed", not the status code.
 *   - `req.log` IS shimmed, so a 500 cannot be a crash in the new log call.
 *   - Reads and writes are failed SEPARATELY (`circle_memberships` read vs
 *     `circle_memberships:delete`). This handler touches the same table twice,
 *     and failing it wholesale would fail the existence read and never reach the
 *     delete under test — the exact false green this file exists to avoid.
 *   - `profiles` is never failed: requireUser reads `profiles.account_status` on
 *     every authenticated request and refuses with its own 503, which would make
 *     the 503 assertion pass without the guard existing.
 *   - Both failure cases are PAIRED with the writable case, which must still be
 *     a plain 200 "removed"; and the genuinely-absent membership must still be a
 *     404, so the new 503 cannot have swallowed the real not-found.
 *
 * Runtime: node:test. The verdict is the exit code.
 * Run: node --import tsx/esm --test src/test/circleMemberRemovalHonesty.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const OWNER = "aaaaaaaa-1111-1111-1111-111111111111";
const MEMBER = "bbbbbbbb-2222-2222-2222-222222222222";

const DB_ERROR = { code: "XX000", message: "internal error: relation unavailable" };

interface Opts {
  membershipPresent: boolean;
  failMembershipRead?: boolean;
  failMembershipDelete?: boolean;
}

function makeClient(o: Opts) {
  const builder = (table: string): any => {
    let op = "select";
    const b: any = {
      select: () => b,
      insert: () => { op = "insert"; return b; },
      update: () => { op = "update"; return b; },
      upsert: () => { op = "upsert"; return b; },
      delete: () => { op = "delete"; return b; },
      eq: () => b, in: () => b, or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
      then: (resolve: (v: any) => any, reject?: any) => Promise.resolve(settle()).then(resolve, reject),
    };
    function settle() {
      if (table === "profiles") return { data: { id: OWNER, account_status: "active" }, error: null };
      if (table === "circle_memberships") {
        if (op === "delete") {
          return o.failMembershipDelete ? { data: null, error: DB_ERROR } : { data: [{ other_id: MEMBER }], error: null };
        }
        if (o.failMembershipRead) return { data: null, error: DB_ERROR };
        return { data: o.membershipPresent ? { other_id: MEMBER } : null, error: null };
      }
      return { data: op === "select" ? null : { id: "x" }, error: null };
    }
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: OWNER } }, error: null }) },
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

function del(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: "DELETE", headers: { authorization: "Bearer t" } },
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
    req.end();
  });
}

const PATH = `/circles/${OWNER}/members/${MEMBER}`;

describe("DELETE /circles/:circleOwnerId/members/:memberId", () => {
  it("writable: 200 removed (the answer the failed delete used to forge)", async () => {
    install({ membershipPresent: true });
    const r = await del(PATH);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "removed");
    assert.equal(r.body.memberId, MEMBER);
  });

  it("delete FAILS: refuses — the member still has circle access and is not reported removed", async () => {
    install({ membershipPresent: true, failMembershipDelete: true });
    const r = await del(PATH);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.notEqual(r.body.status, "removed");
  });

  it("membership read FAILS: 503, not 'Membership not found'", async () => {
    install({ membershipPresent: true, failMembershipRead: true });
    const r = await del(PATH);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    assert.notEqual(r.body.status, "removed");
  });

  it("genuinely absent membership still says not_found (the 503 did not swallow 404)", async () => {
    install({ membershipPresent: false });
    const r = await del(PATH);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });
});
