/**
 * Telegraph §14.3 — POST /api/threads/:threadId/add-people (census T212, T213).
 *
 * Spec §14.3: "Adding a third person to a DM creates a new group; it does not
 * expose the old DM history. Explicitly selected Plans/Places may be carried
 * forward as new share objects."
 *
 * Driven through the real router (routes/telegraphGroups.ts → services/
 * telegraph/groupFormation.ts → the real permission engine, block guard, share
 * loaders and send guard) over the certification harness's fake PostgREST, and
 * through routes/messaging.ts for the READ side: the person added can read the
 * new group and cannot read the DM.
 *
 * MUTANTS (each applied alone, each turned this suite red, each reverted):
 *   M1 groupFormation.ts inserts the new thread as thread_type "direct" ............ red (new thread is a group)
 *   M2 copy the DM's messages into the new thread after member insert ............. red (no DM message in the group; C reads nothing old)
 *   M3 skip the resolveInteractionPermissions loop .................................. red (C blocked A; messaging restriction; no_one privacy)
 *   M4 skip the pairwise isBlockedBetween loop ........................................ red (B and C have a block)
 *   M5 carry-forward checks only the actor's visibility .............................. red (plan visible only to A)
 *   M6 readFlagState "unknown" treated as on ........................................ red (unreadable flag refuses)
 *   M7 drop `.strict()` on the carried item ........................................... red (messageId in a selection is refused)
 *
 * Run: node --import tsx/esm --test src/test/telegraphGroupFormation.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import telegraphGroupsRouter from "../routes/telegraphGroups.js";
import messagingRouter from "../routes/messaging.js";
import { CANNOT_ADD_MESSAGE } from "../services/telegraph/groupFormation.js";
import { call, makeFakeClient, startRouter, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // the actor
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // the DM's other party
const C = "cccccccc-0000-4000-8000-000000000003"; // added
const D = "dddddddd-0000-4000-8000-000000000004"; // added
const X = "eeeeeeee-0000-4000-8000-000000000005"; // outsider

const DM = "00000000-0000-4000-8000-0000000000d1";
const DM_LEFT = "00000000-0000-4000-8000-0000000000d2"; // B left
const TRIP_T = "00000000-0000-4000-8000-0000000000d3";
const PLACE_OK = "77770000-0000-4000-8000-000000000001";
const PLAN_PRIVATE = "88880000-0000-4000-8000-000000000001"; // A's meetup, only A
const PLAN_ALL = "88880000-0000-4000-8000-000000000002"; // A's meetup, B C invited
const SECRET = "Our private DM: the door code is 4471";

const member = (thread: string, user: string, over: Record<string, unknown> = {}) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, ...over,
});
const thread = (id: string, type: string, over: Record<string, unknown> = {}) => ({
  id, thread_type: type, trip_id: type === "trip" ? "99990000-0000-4000-8000-000000000001" : null,
  circle_owner_id: null, title: null, status: "active", is_e2ee: false, created_by: A,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null, ...over,
});

function seed(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "telegraph_dm_group_formation_enabled", enabled: true }],
    blocks: [],
    profiles: [A, B, C, D, X].map((id, i) => ({
      id, handle: `u${i}`, name: `U${i}`, preferred_language: "en", avatar_url: null, show_name_publicly: true,
      is_private: false, tag_permission: "everyone",
    })),
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trip_members: [],
    trust_profiles: [],
    trust_restrictions: [],
    user_account_states: [],
    message_requests: [],
    message_threads: [thread(DM, "direct"), thread(DM_LEFT, "direct"), thread(TRIP_T, "trip")],
    message_thread_members: [
      member(DM, A), member(DM, B),
      member(DM_LEFT, A), member(DM_LEFT, B, { left_at: "2026-02-01T00:00:00.000Z" }),
      member(TRIP_T, A), member(TRIP_T, B),
    ],
    messages: [
      { id: "11111111-0000-4000-8000-000000000001", thread_id: DM, sender_id: B, body: SECRET, created_at: "2026-03-01T00:00:00.000Z",
        deleted_at: null, unsent_at: null, edited_at: null, msg_type: "text", subtype: null, reply_to_id: null },
      { id: "11111111-0000-4000-8000-000000000002", thread_id: DM, sender_id: A, body: "and the plan", created_at: "2026-03-01T00:01:00.000Z",
        deleted_at: null, unsent_at: null, edited_at: null, msg_type: "text", subtype: null, reply_to_id: null },
    ],
    message_translations: [],
    places: [{ id: PLACE_OK, name: "Rooftop", city: "Hue", neighborhood: "Old town", primary_category: "bar", status: "active", updated_at: "2026-05-01T00:00:00.000Z" }],
    meetups: [
      { id: PLAN_PRIVATE, creator_id: A, title: "Just me", location_name: "X", starts_at: "2026-07-01T12:00:00.000Z", status: "active", visibility: "invitees", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: PLAN_ALL, creator_id: A, title: "Dinner", location_name: "Y", starts_at: "2026-07-01T12:00:00.000Z", status: "active", visibility: "invitees", updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    meetup_invites: [
      { meetup_id: PLAN_ALL, user_id: B, status: "accepted" },
      { meetup_id: PLAN_ALL, user_id: C, status: "pending" },
    ],
    ...over,
  };
}

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(telegraphGroupsRouter);
  all.use(messagingRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(over: Partial<Record<string, any[]>> = {}, opts: FakeDbOptions = {}): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(seed(over), {
    ...opts,
    columnDefaults: { message_threads: { status: "active", is_e2ee: false }, message_thread_members: { left_at: null } },
  });
  _setTestClient(c, true);
  return c;
}

const addPeople = (threadId: string, body: unknown, as = A) => call(harness.base, "POST", `/threads/${threadId}/add-people`, as, body);
const groups = (c: FakeClient) => c._store.message_threads.filter((t) => t.thread_type === "group");

describe("§14.3 — adding a person to a DM creates a NEW group (T212)", () => {
  it("creates a new `group` thread of the DM's two people plus the added person, the actor its host", async () => {
    const c = use();
    const r = await addPeople(DM, { userIds: [C] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.threadType, "group");
    assert.notEqual(r.body.threadId, DM);
    const g = groups(c);
    assert.equal(g.length, 1);
    assert.equal(g[0].id, r.body.threadId);
    const roster = c._store.message_thread_members.filter((m) => m.thread_id === r.body.threadId);
    assert.deepEqual(roster.map((m) => m.user_id).sort(), [A, B, C].sort());
    assert.equal(roster.find((m) => m.user_id === A)!.role, "admin");
    assert.ok(roster.filter((m) => m.user_id !== A).every((m) => m.role === "member"));
    const joined = new Set(roster.map((m) => m.joined_at));
    assert.equal(joined.size, 1, "every member joins at the formation instant");
  });

  it("NEVER exposes the DM's history: no DM message is in the group, and the added person cannot read the DM", async () => {
    const c = use();
    const r = await addPeople(DM, { userIds: [C] });
    assert.equal(r.status, 201);
    const inGroup = c._store.messages.filter((m) => m.thread_id === r.body.threadId);
    assert.equal(inGroup.length, 0, "the group starts empty");
    assert.ok(!c._store.messages.some((m) => m.thread_id !== DM && String(m.body ?? "").includes("door code")));

    const groupRead = await call(harness.base, "GET", `/threads/${r.body.threadId}/messages`, C);
    assert.equal(groupRead.status, 200, JSON.stringify(groupRead.body));
    assert.ok(!JSON.stringify(groupRead.body).includes("door code"));
    const dmRead = await call(harness.base, "GET", `/threads/${DM}/messages`, C);
    assert.equal(dmRead.status, 403, "the added person is not in the DM");
    assert.ok(!JSON.stringify(dmRead.body).includes("door code"));
  });

  it("leaves the DM untouched — same members, same messages, still direct", async () => {
    const c = use();
    const before = JSON.stringify([
      c._store.message_threads.find((t) => t.id === DM),
      c._store.message_thread_members.filter((m) => m.thread_id === DM),
      c._store.messages.filter((m) => m.thread_id === DM),
    ]);
    const r = await addPeople(DM, { userIds: [C, D] });
    assert.equal(r.status, 201);
    const after = JSON.stringify([
      c._store.message_threads.find((t) => t.id === DM),
      c._store.message_thread_members.filter((m) => m.thread_id === DM),
      c._store.messages.filter((m) => m.thread_id === DM),
    ]);
    assert.equal(after, before);
    assert.equal(c._observed.updates.filter((u) => u.table === "message_thread_members").length, 0);
  });
});

describe("§14.3 — who may be added (blocks, D-24 restriction, the request door)", () => {
  const cases: Array<[string, Partial<Record<string, any[]>>]> = [
    ["the added person blocked the actor", { blocks: [{ blocker_id: C, blocked_id: A }] }],
    ["the actor blocked the added person", { blocks: [{ blocker_id: A, blocked_id: C }] }],
    ["the DM's other party and the added person have a block", { blocks: [{ blocker_id: B, blocked_id: C }] }],
    ["the added person only accepts messages from no one", { user_message_settings: [{ user_id: C, message_privacy: "no_one", allow_message_requests: true }] }],
    ["the actor is under a messaging restriction (D-24: 'start new conversations')", {
      trust_restrictions: [{ id: "33333333-0000-4000-8000-000000000001", user_id: A, restriction_type: "messaging", lifted_at: null, expires_at: null, created_at: "2026-09-01T00:00:00.000Z" }],
    }],
  ];
  for (const [name, over] of cases) {
    it(`refuses, and writes nothing, when ${name}`, async () => {
      const c = use(over);
      const r = await addPeople(DM, { userIds: [C] });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(groups(c).length, 0);
      assert.equal(c._observed.inserts.filter((i) => i.table === "message_thread_members").length, 0);
    });
  }

  it("every block refusal reads the SAME sentence — it does not say which pair", async () => {
    const r1 = await (use({ blocks: [{ blocker_id: C, blocked_id: A }] }), addPeople(DM, { userIds: [C] }));
    const r2 = await (use({ blocks: [{ blocker_id: B, blocked_id: C }] }), addPeople(DM, { userIds: [C] }));
    assert.equal(r1.body.message, CANNOT_ADD_MESSAGE);
    assert.equal(r2.body.message, CANNOT_ADD_MESSAGE);
  });

  it("a block between two ADDED people refuses", async () => {
    const c = use({ blocks: [{ blocker_id: D, blocked_id: C }] });
    const r = await addPeople(DM, { userIds: [C, D] });
    assert.equal(r.status, 403);
    assert.equal(groups(c).length, 0);
  });

  it("an unreadable blocks table refuses (fail closed), never a pass", async () => {
    const c = use({}, { errors: { blocks: { message: "blocks: connection reset" } } });
    const r = await addPeople(DM, { userIds: [C] });
    assert.ok(r.status === 403 || r.status === 503, JSON.stringify(r.body));
    assert.equal(groups(c).length, 0);
  });

  it("a HOSTING restriction does not refuse (D-24: its sentence names group trips, not conversations)", async () => {
    const c = use({
      trust_restrictions: [{ id: "33333333-0000-4000-8000-000000000002", user_id: A, restriction_type: "hosting", lifted_at: null, expires_at: null, created_at: "2026-09-01T00:00:00.000Z" }],
    });
    const r = await addPeople(DM, { userIds: [C] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(groups(c).length, 1);
  });
});

describe("§14.3 — the source must be a live two-party DM the actor is in", () => {
  it("a non-member learns nothing (404)", async () => {
    const c = use();
    const r = await addPeople(DM, { userIds: [C] }, X);
    assert.equal(r.status, 404);
    assert.equal(groups(c).length, 0);
  });
  it("a trip thread is not a DM (its roster is the trip's)", async () => {
    const c = use();
    const r = await addPeople(TRIP_T, { userIds: [C] });
    assert.equal(r.status, 403);
    assert.equal(groups(c).length, 0);
  });
  it("a DM the other party has left is not two-party any more", async () => {
    const c = use();
    const r = await addPeople(DM_LEFT, { userIds: [C] });
    assert.equal(r.status, 403);
    assert.equal(groups(c).length, 0);
  });
  it("re-adding a DM party is not group formation", async () => {
    const r = await (use(), addPeople(DM, { userIds: [B] }));
    assert.equal(r.status, 400);
  });
});

describe("§14.3 — explicitly selected Plans / Places carried forward as NEW share objects (T213)", () => {
  it("a Place everyone can see is carried as a new PORTAVA_OBJECT message naming the canonical place", async () => {
    const c = use();
    const r = await addPeople(DM, { userIds: [C], carryForward: [{ kind: "PLACE", objectId: PLACE_OK }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const msgs = c._store.messages.filter((m) => m.thread_id === r.body.threadId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].msg_type, "portava_object");
    assert.equal(msgs[0].subtype, "place");
    assert.equal(msgs[0].sender_id, A);
    const body = JSON.parse(msgs[0].body);
    assert.deepEqual([body.objectType, body.objectId], ["PLACE", PLACE_OK]);
    assert.ok(!("messageId" in body));
  });

  it("a Plan every member is invited to is carried", async () => {
    const c = use();
    const r = await addPeople(DM, { userIds: [C], carryForward: [{ kind: "PLAN", objectId: PLAN_ALL }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c._store.messages.filter((m) => m.thread_id === r.body.threadId && m.subtype === "plan").length, 1);
  });

  it("a Plan some member cannot see is REFUSED — and no group is left behind", async () => {
    const c = use();
    const r = await addPeople(DM, { userIds: [C], carryForward: [{ kind: "PLAN", objectId: PLAN_PRIVATE }] });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(groups(c).length, 0);
  });

  it("a selection that names a message is refused at the door", async () => {
    const c = use();
    const r = await addPeople(DM, { userIds: [C], carryForward: [{ kind: "PLACE", objectId: PLACE_OK, messageId: "11111111-0000-4000-8000-000000000001" }] });
    assert.equal(r.status, 400);
    assert.equal(groups(c).length, 0);
  });

  it("a kind §14.3 does not name is refused", async () => {
    const r = await (use(), addPeople(DM, { userIds: [C], carryForward: [{ kind: "MEMORY", objectId: PLACE_OK }] }));
    assert.equal(r.status, 400);
  });
});

describe("the flag (3660, seeded OFF) — existing behaviour unchanged when off", () => {
  it("OFF: feature_disabled, nothing written", async () => {
    const c = use({ feature_flags: [{ flag: "telegraph_dm_group_formation_enabled", enabled: false }] });
    const r = await addPeople(DM, { userIds: [C] });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(c._observed.inserts.length, 0);
  });
  it("absent row reads OFF", async () => {
    const c = use({ feature_flags: [] });
    const r = await addPeople(DM, { userIds: [C] });
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(c._observed.inserts.length, 0);
  });
  it("an unreadable flag is a retryable refusal, not ON", async () => {
    const c = use({}, { errors: { feature_flags: { message: "flags: connection reset" } } });
    const r = await addPeople(DM, { userIds: [C] });
    assert.equal(r.status, 503);
    assert.equal(c._observed.inserts.length, 0);
  });
});
