/**
 * GET /threads/:threadId/capabilities is not a thread-existence oracle
 * (census-telegraph §97).
 *
 * THE DEFECT
 * ----------
 * The route's header promised that "every capability false is the same answer
 * for 'this thread does not exist', 'you were removed' and 'you were blocked'".
 * It was not. The policy read `message_threads` FIRST: a missing thread came
 * back as `conversationType: "unknown"` with `inputsRead: []`, but a thread that
 * exists came back to a NON-member with its real type ("direct", "group",
 * "trip") and `inputsRead: ["conversationType", "membership"]`. Any signed-in
 * user could therefore probe a thread id and learn whether it exists and what
 * kind of conversation it is. A failed membership read leaked the same way:
 * degraded with the real type for a thread that exists, a clean "not a member"
 * for one that does not.
 *
 * WHAT IS PROVED HERE
 * -------------------
 * The same thread id is asked for in two databases — one where the thread
 * exists and the viewer is not in it, one where it does not exist at all — and
 * the two HTTP responses must be identical: status, content type and every byte
 * of the body. The not-existent answer itself is pinned to the body this route
 * has always sent, so the fix moved the non-member onto it rather than inventing
 * a new one. Members and former members (who have a membership row) are
 * answered by the policy exactly as before.
 *
 * Red on main: the byte comparisons and the "thread is never read" check fail.
 *
 * Run (HTTP — outside a sandbox that forbids listen(2)):
 *   node --import tsx/esm --test src/test/telegraphCapabilityExistenceOracle.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import capabilityRouter from "../server/telegraph/capabilityRoute.js";
import { CONVERSATION_CAPABILITY_NAMES, CAPABILITY_INPUTS } from "../domain/telegraph/contracts/conversationCapabilities.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const CARL = "cccccccc-0000-4000-8000-0000000000c3";
const THREAD = "00000000-0000-4000-8000-0000000000f1";
const TRIP = "11111111-0000-4000-8000-0000000000f2";

interface World {
  /** Whether THREAD exists, and of what type. */
  thread: null | "direct" | "group" | "trip";
  /** Alice's own row in THREAD: none, active, or one she has left. */
  alice: "none" | "member" | "left";
  membershipError?: boolean;
  threadError?: boolean;
}

function tables(w: World): Record<string, any[]> {
  const members: any[] = [];
  if (w.thread) {
    members.push({ thread_id: THREAD, user_id: BOB, role: "member", left_at: null, visible_from_at: null });
    if (w.thread !== "direct") members.push({ thread_id: THREAD, user_id: CARL, role: "member", left_at: null, visible_from_at: null });
    if (w.alice !== "none") {
      members.push({ thread_id: THREAD, user_id: ALICE, role: "member", left_at: w.alice === "left" ? "2026-10-01T00:00:00.000Z" : null, visible_from_at: null });
    }
  }
  return {
    feature_flags: [],
    message_threads: w.thread
      ? [{ id: THREAD, thread_type: w.thread, status: "active", trip_id: w.thread === "trip" ? TRIP : null, circle_owner_id: null, is_e2ee: false }]
      : [],
    message_thread_members: members,
    blocks: [],
    trust_restrictions: [],
    user_privacy_settings: [],
    profile_privacy_settings: [],
    trips: w.thread === "trip" ? [{ id: TRIP, owner_id: BOB }] : [],
    trip_members: w.thread === "trip" ? [{ trip_id: TRIP, user_id: BOB, role: "owner", status: "accepted" }] : [],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
  };
}

function makeClient(w: World) {
  const db = tables(w);
  const reads: string[] = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const filteredCols: string[] = [];
    reads.push(table);
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const injected = () => {
      if (table === "message_threads" && w.threadError) return { message: "thread read blew up" };
      if (table === "message_thread_members" && w.membershipError && filteredCols.includes("user_id") && filteredCols.includes("thread_id")) {
        return { message: "membership read blew up" };
      }
      return null;
    };
    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { filteredCols.push(col); filters.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { filters.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      or() { return proxy; }, order() { return proxy; }, limit() { return proxy; },
      maybeSingle() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _reads: reads,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

/** The body this route has always sent for a thread that does not exist. */
function nonexistentBody(threadId: string) {
  return {
    conversationId: threadId,
    conversationType: "unknown",
    capabilities: Object.fromEntries(CONVERSATION_CAPABILITY_NAMES.map((n) => [n, false])),
    reasons: Object.fromEntries(CONVERSATION_CAPABILITY_NAMES.map((n) => [n, "TELEGRAPH_AUTH_NOT_MEMBER"])),
    inputsRead: [],
    degraded: false,
    degradedReasons: [],
    conversation: { memberCount: null, isE2ee: null, transportClass: null, degraded: false },
  };
}

describe("GET /threads/:threadId/capabilities — a non-member learns nothing about the thread (census-telegraph §97)", () => {
  let server: Server;
  let base = "";

  before(async () => {
    const app = express();
    app.use("/api", capabilityRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  });

  after(async () => {
    _setTestClient(null, false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function ask(w: World, asUser = ALICE) {
    const client = makeClient(w);
    _setTestClient(client, true);
    const res = await fetch(`${base}/threads/${THREAD}/capabilities`, { headers: { authorization: `Bearer ${asUser}` } });
    return { status: res.status, type: res.headers.get("content-type"), text: await res.text(), reads: client._reads as string[] };
  }

  it("CONTROL: a thread that does not exist gets the answer this route has always given it", async () => {
    const gone = await ask({ thread: null, alice: "none" });
    assert.equal(gone.status, 200);
    assert.deepEqual(JSON.parse(gone.text), nonexistentBody(THREAD));
  });

  for (const type of ["direct", "group", "trip"] as const) {
    it(`a non-member of an existing ${type} thread gets byte-for-byte the non-existent thread's answer`, async () => {
      const exists = await ask({ thread: type, alice: "none" });
      const gone = await ask({ thread: null, alice: "none" });
      assert.equal(exists.status, gone.status, "same status");
      assert.equal(exists.type, gone.type, "same content type");
      assert.equal(exists.text, gone.text, `the body must not depend on whether the thread exists (got ${exists.text})`);
      assert.deepEqual(JSON.parse(exists.text), nonexistentBody(THREAD));
    });
  }

  it("for a non-member the thread itself is never read — the answer cannot depend on it, in content or in timing", async () => {
    const exists = await ask({ thread: "group", alice: "none" });
    const gone = await ask({ thread: null, alice: "none" });
    assert.ok(!exists.reads.includes("message_threads"), `message_threads was read for a non-member: ${exists.reads.join(", ")}`);
    assert.deepEqual(exists.reads, gone.reads, "the same reads, in the same order, whether or not the thread exists");
    assert.equal(exists.reads.filter((t) => t === "message_thread_members").length, 1, "the viewer's own row, read once");
  });

  it("a membership read that FAILS answers the same degraded bytes whether or not the thread exists, never its type", async () => {
    const exists = await ask({ thread: "trip", alice: "none", membershipError: true });
    const gone = await ask({ thread: null, alice: "none", membershipError: true });
    assert.equal(exists.status, gone.status);
    assert.equal(exists.text, gone.text, `degraded answers differ: ${exists.text} vs ${gone.text}`);
    const body = JSON.parse(exists.text);
    assert.equal(body.conversationType, "unknown");
    assert.equal(body.degraded, true, "an unreadable membership is degraded, never a confident 'not a member'");
    assert.deepEqual(body.degradedReasons, ["TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE"]);
    assert.equal(Object.values(body.capabilities).some(Boolean), false);
    assert.equal(body.conversation.degraded, true);
  });

  it("…and a MEMBER whose row cannot be read is told 'try again', not 'you are not a member'", async () => {
    const member = await ask({ thread: "direct", alice: "member", membershipError: true });
    const body = JSON.parse(member.text);
    assert.equal(body.degraded, true);
    assert.notEqual(body.reasons.canSendMessage, "TELEGRAPH_AUTH_NOT_MEMBER");
  });

  it("CONTROL: a thread read that fails tells a non-member nothing either", async () => {
    const exists = await ask({ thread: "group", alice: "none", threadError: true });
    const gone = await ask({ thread: null, alice: "none", threadError: true });
    assert.equal(exists.text, gone.text);
  });

  it("members are answered by the policy, unchanged: the real type, all eight inputs read, the facts", async () => {
    const member = await ask({ thread: "group", alice: "member" });
    assert.equal(member.status, 200);
    const body = JSON.parse(member.text);
    assert.equal(body.conversationType, "group");
    assert.deepEqual([...body.inputsRead].sort(), [...CAPABILITY_INPUTS].sort());
    assert.equal(body.capabilities.canSendMessage, true);
    assert.equal(body.capabilities.canSeeGroupReadReceipts, true);
    assert.equal(body.conversation.memberCount, 3);
    assert.equal(body.conversation.isE2ee, false);
    assert.equal(body.degraded, false);
  });

  it("a FORMER member (a row with left_at) is answered by the policy as before: the type, and why they cannot act", async () => {
    const left = await ask({ thread: "direct", alice: "left" });
    const body = JSON.parse(left.text);
    assert.equal(body.conversationType, "direct");
    assert.equal(body.reasons.canSendMessage, "TELEGRAPH_AUTH_LEFT_THREAD");
    assert.deepEqual(body.conversation, { memberCount: null, isE2ee: null, transportClass: null, degraded: false });
  });
});
