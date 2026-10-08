/**
 * census-trips §86 (wave 5 item 5): the retained-record rule on the doors that
 * change a trip's shared life from OUTSIDE the trip routers.
 *
 * The owner's ruling (2026-10-04): "if a trip has ended, restore access to its
 * retained record only." 3974 stamps such a membership
 * `trip_members.permissions.access = 'retained_record_only'`; wave 4 (§85,
 * §85.2) refused every member-level write under /trips/:tripId. The person is
 * still an accepted member, so they stay in the trip's Telegraph thread
 * (services/groupChatSync.ts) and pass every "accepted trip member" check a
 * meetup makes — and until this change could write into both.
 *
 *   L   live location: starting a crew live share is under /trips/:tripId, so
 *       the §85.2 guard refuses it; stopping one is never refused.
 *   TH  the trip's thread: every Telegraph door into `messages` (text, media,
 *       typed, coordination, the plain-message library) refuses a retained
 *       member's write into a `trip` thread with 403 `trip_record_read_only`,
 *       nothing written; a safety send (NEED_HELP) is never refused; another
 *       kind of thread is untouched; an unreadable access row is "try again".
 *   MT  meetups that belong to the trip: create, edit, invite, RSVP, time
 *       options, vote and confirm refuse a retained member; cancelling one's
 *       own meetup is not refused; a retained member is not invitable.
 *
 * Every refusal is asserted on the response AND on the rows written.
 *
 * Run: node --import tsx/esm --test src/test/tripRetainedRecordOutsideDoors.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { postPlainThreadMessage } from "../lib/threadMessage.js";
import { RETAINED_RECORD_ONLY_MESSAGE } from "../lib/tripTrustGate.js";
import { readRetainedAccess } from "../lib/tripRetainedRecordGuard.js";
import tripsRouter from "../routes/trips.js";
import tripCrewLocationRouter from "../routes/tripCrewLocation.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import messagingRouter from "../routes/messaging.js";
import meetupsRouter from "../routes/meetups.js";
import { makeFakeClient, startRouter, call, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ANA = "11111111-0000-4000-8000-000000000001"; // restored to the ended trip's record only
const BEN = "22222222-0000-4000-8000-000000000002"; // a full member
const ORG = "33333333-0000-4000-8000-000000000003"; // the trip's owner
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const TRIP_THREAD = "7e7e7e7e-0000-4000-8000-00000000007e";
const DM = "7d7d7d7d-0000-4000-8000-00000000007d"; // a direct thread Ana and Ben share, Ben has written
const DM_FROM_TRIP = "7c7c7c7c-0000-4000-8000-00000000007c"; // a direct thread that names the trip (started from it), Ben has written
const MEETUP = "eeeeeeee-0000-4000-8000-00000000000e"; // Ana's meetup on the trip
const BEN_MEETUP = "eeeeeeee-0000-4000-8000-00000000000f"; // Ben's meetup on the trip
const OPTION = "0f0f0f0f-0000-4000-8000-00000000000f";

type Rows = Array<Record<string, unknown>>;

const member = (thread: string, user: string) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
});
const thread = (id: string, type: string, tripId: string | null) => ({
  id, thread_type: type, trip_id: tripId, circle_owner_id: null, title: null, status: "active", is_e2ee: false,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
});
const message = (id: string, threadId: string, sender: string) => ({
  id, thread_id: threadId, sender_id: sender, body: "hello", created_at: "2026-05-02T00:00:00.000Z",
  deleted_at: null, unsent_at: null, edited_at: null, msg_type: "text", subtype: null, reply_to_id: null,
});
const meetup = (id: string, creator: string) => ({
  id, creator_id: creator, title: "Dinner", description: null, location_name: "Alfama", trip_id: TRIP, circle_owner_id: null,
  visibility: "trip", status: "active", approximate_date: null, time_block: null, starts_at: null,
  age_limit_enabled: false, min_age: null, max_age: null, created_at: "2026-05-01T00:00:00.000Z",
});

function seed(anaAccess: "retained_record_only" | "membership"): Record<string, Rows> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [ANA, BEN, ORG].map((id, i) => ({ id, handle: `u${i}`, name: `U${i}`, preferred_language: "en", avatar_url: null, show_name_publicly: true, role: "user" })),
    trust_profiles: [],
    trust_restrictions: [],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    message_requests: [],
    trips: [{ id: TRIP, owner_id: ORG, version: 7, status: "completed", title: "Lisbon", start_date: "2026-09-01", end_date: "2026-09-05" }],
    trip_members: [
      { trip_id: TRIP, user_id: ORG, role: "owner", status: "accepted", permissions: {} },
      { trip_id: TRIP, user_id: BEN, role: "member", status: "accepted", permissions: {} },
      { trip_id: TRIP, user_id: ANA, role: "member", status: "accepted", permissions: { access: anaAccess, restored_by_appeal: "appeal-1" } },
    ],
    message_threads: [thread(TRIP_THREAD, "trip", TRIP), thread(DM, "direct", null), thread(DM_FROM_TRIP, "direct", TRIP)],
    message_thread_members: [member(TRIP_THREAD, ORG), member(TRIP_THREAD, BEN), member(TRIP_THREAD, ANA), member(DM, ANA), member(DM, BEN), member(DM_FROM_TRIP, ANA), member(DM_FROM_TRIP, BEN)],
    messages: [message("11110000-0000-4000-8000-000000000001", TRIP_THREAD, BEN), message("11110000-0000-4000-8000-000000000002", DM, BEN), message("11110000-0000-4000-8000-000000000003", DM_FROM_TRIP, BEN)],
    message_translations: [],
    message_reactions: [],
    meetups: [meetup(MEETUP, ANA), meetup(BEN_MEETUP, BEN)],
    meetup_invites: [],
    meetup_time_options: [{ id: OPTION, meetup_id: MEETUP, starts_at: "2026-09-03T19:00:00.000Z", label: null, created_at: "2026-05-01T00:00:00.000Z" }],
    meetup_time_votes: [],
    trip_crew_location_sessions: [],
    trip_crew_location_preferences: [],
    trip_crew_location_events: [],
  };
}

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  // routes/index.ts order where it matters: the trips router (which carries the §85.2 guard) first.
  for (const r of [tripsRouter, telegraphKindsRouter, telegraphCoordinationRouter, messagingRouter, meetupsRouter, tripCrewLocationRouter]) all.use(r);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null as never);
  await harness.close();
});

function use(anaAccess: "retained_record_only" | "membership", opts: FakeDbOptions = {}): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(seed(anaAccess), {
    ...opts,
    columnDefaults: { message_threads: { thread_type: "direct", is_e2ee: false, status: "active" } },
  });
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
  return c;
}
const writes = (c: FakeClient) => c._observed.inserts.length + c._observed.updates.length + c._observed.upserts.length + c._observed.deletes.length;
const fromAna = (c: FakeClient, threadId: string) => (c._store.messages ?? []).filter((m) => m.thread_id === threadId && m.sender_id === ANA).length;
function assertReadOnly(r: { status: number; body: any }, label: string) {
  assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.body?.error, "trip_record_read_only", label);
  assert.equal(r.body?.message, RETAINED_RECORD_ONLY_MESSAGE, label);
  assert.doesNotMatch(String(r.body?.message), /restrict/i, `${label}: a retained record is not a Trust restriction`);
}

describe("L. live location sharing on the ended trip", () => {
  it("L1 starting a crew live share is refused by the §85.2 guard, nothing written", async () => {
    const c = use("retained_record_only");
    const r = await call(harness.base, "POST", `/trips/${TRIP}/crew/live-share/start`, ANA, { durationMinutes: 30 });
    assertReadOnly(r, "live-share start");
    assert.equal(writes(c), 0);
  });
  it("L2 stopping a live share is never refused by it", async () => {
    use("retained_record_only");
    const r = await call(harness.base, "POST", `/trips/${TRIP}/crew/live-share/stop`, ANA, {});
    assert.notEqual(r.body?.error, "trip_record_read_only", JSON.stringify(r.body).slice(0, 200));
  });
});

const SENDS: Array<{ name: string; path: (t: string) => string; body: () => unknown }> = [
  { name: "text", path: (t) => `/threads/${t}/messages`, body: () => ({ body: "Can we go back?" }) },
  { name: "media", path: (t) => `/threads/${t}/media`, body: () => ({ mediaUrl: `post-media/${ANA}/p1.webp`, mediaType: "image" }) },
  { name: "typed", path: (t) => `/threads/${t}/typed-messages`, body: () => ({ kind: "ANNOUNCEMENT", payload: { title: "Leaving at eight" } }) },
  { name: "coordination", path: (t) => `/threads/${t}/coordination`, body: () => ({ kind: "COORDINATION", payload: { state: "ARRIVED" } }) },
];

describe("TH. the trip's Telegraph thread", () => {
  for (const s of SENDS) {
    it(`TH ${s.name}: a retained member's write into the trip thread → 403 trip_record_read_only, nothing written`, async () => {
      const c = use("retained_record_only");
      const r = await call(harness.base, "POST", s.path(TRIP_THREAD), ANA, s.body());
      assertReadOnly(r, s.name);
      assert.equal(fromAna(c, TRIP_THREAD), 0);
    });
    it(`TH ${s.name} CONTROL: the same member restored with access 'membership' is not refused by this rule`, async () => {
      const c = use("membership");
      const r = await call(harness.base, "POST", s.path(TRIP_THREAD), ANA, s.body());
      assert.notEqual(r.body?.error, "trip_record_read_only", JSON.stringify(r.body).slice(0, 300));
      assert.ok(r.status < 300, `${s.name}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.ok(fromAna(c, TRIP_THREAD) >= 1, "the full member's send was written");
    });
  }
  it("TH a direct thread is untouched by the rule — even one that names the trip: the rule is the trip's own thread, not every conversation about it", async () => {
    for (const t of [DM, DM_FROM_TRIP]) {
      const c = use("retained_record_only");
      const r = await call(harness.base, "POST", `/threads/${t}/messages`, ANA, { body: "hi" });
      assert.ok(r.status < 300, `${t}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(fromAna(c, t), 1, t);
      const k = await call(harness.base, "POST", `/threads/${t}/typed-messages`, ANA, { kind: "ANNOUNCEMENT", payload: { title: "Leaving at eight" } });
      assert.notEqual(k.body?.error, "trip_record_read_only", `${t}: ${JSON.stringify(k.body).slice(0, 300)}`);
    }
  });
  it("TH a safety send (NEED_HELP) into the trip thread is never refused by it", async () => {
    const c = use("retained_record_only");
    const r = await call(harness.base, "POST", `/threads/${TRIP_THREAD}/coordination`, ANA, { kind: "COORDINATION", payload: { state: "NEED_HELP" } });
    assert.notEqual(r.body?.error, "trip_record_read_only", JSON.stringify(r.body).slice(0, 300));
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.equal(fromAna(c, TRIP_THREAD), 1);
  });
  it("TH the plain-message library refuses it too (a door with no HTTP of its own)", async () => {
    const c = use("retained_record_only");
    const r = await postPlainThreadMessage(c as never, { threadId: TRIP_THREAD, senderId: ANA, body: "hello" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "trip_record_read_only");
    assert.equal(fromAna(c, TRIP_THREAD), 0);
  });
  it("TH the access row unreadable → 503 'try again', never a pass, nothing written", async () => {
    for (const s of SENDS) {
      const c = use("retained_record_only", { errors: { trip_members: { message: "members down", code: "57P01", ops: ["select"] } } });
      const r = await call(harness.base, "POST", s.path(TRIP_THREAD), ANA, s.body());
      assert.equal(r.status, 503, `${s.name}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
      assert.equal(fromAna(c, TRIP_THREAD), 0, s.name);
    }
  });
});

describe("MT. meetups that belong to the trip", () => {
  const DOORS: Array<[string, "POST" | "PATCH", string, unknown]> = [
    ["create", "POST", "/meetups", { title: "One more dinner", tripId: TRIP, visibility: "trip" }],
    ["edit", "PATCH", `/meetups/${MEETUP}`, { title: "Changed" }],
    ["invite", "POST", `/meetups/${MEETUP}/invites`, { userIds: [BEN] }],
    ["rsvp", "POST", `/meetups/${BEN_MEETUP}/rsvp`, { status: "going" }],
    ["time-options", "POST", `/meetups/${MEETUP}/time-options`, { startsAt: "2026-09-04T19:00:00.000Z" }],
    ["vote", "POST", `/meetups/${MEETUP}/time-options/${OPTION}/vote`, { vote: "yes" }],
    ["confirm-time", "POST", `/meetups/${MEETUP}/confirm-time`, { optionId: OPTION }],
  ];
  for (const [name, m, p, b] of DOORS) {
    it(`MT ${name}: a retained member → 403 trip_record_read_only, nothing written`, async () => {
      const c = use("retained_record_only");
      const r = await call(harness.base, m, p, ANA, b);
      assertReadOnly(r, name);
      assert.equal(writes(c), 0, `${name}: ${JSON.stringify(c._observed).slice(0, 300)}`);
    });
  }
  it("MT CONTROL: with access 'membership' the same member is not refused by this rule at any of them", async () => {
    for (const [name, m, p, b] of DOORS) {
      use("membership");
      const r = await call(harness.base, m, p, ANA, b);
      assert.notEqual(r.body?.error, "trip_record_read_only", `${name}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  });
  it("MT cancelling one's own meetup only reduces, so it is not refused", async () => {
    use("retained_record_only");
    const r = await call(harness.base, "DELETE", `/meetups/${MEETUP}`, ANA);
    assert.notEqual(r.body?.error, "trip_record_read_only", JSON.stringify(r.body).slice(0, 200));
  });
  it("MT a retained member is not invitable to a trip meetup (ineligible, no invite row)", async () => {
    const c = use("retained_record_only");
    const r = await call(harness.base, "POST", `/meetups/${BEN_MEETUP}/invites`, BEN, { userIds: [ANA, ORG] });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.deepEqual(r.body?.ineligible, [ANA], JSON.stringify(r.body).slice(0, 300));
    assert.equal((c._store.meetup_invites ?? []).filter((i) => i.user_id === ANA).length, 0);
    assert.equal((c._store.meetup_invites ?? []).filter((i) => i.user_id === ORG).length, 1, "CONTROL: the owner, a full member, was invited");
  });
  it("MT the access row unreadable → 503 'try again', nothing written", async () => {
    const c = use("retained_record_only", { errors: { trip_members: { message: "members down", code: "57P01", ops: ["select"] } } });
    const r = await call(harness.base, "PATCH", `/meetups/${MEETUP}`, ANA, { title: "Changed" });
    assert.equal(r.status, 503, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    assert.equal(writes(c), 0);
  });
});

describe("the reader, pure", () => {
  it("no client, an error and a throw are 'unread'; no row is 'other'", async () => {
    assert.equal(await readRetainedAccess(null, TRIP, ANA), "unread");
    const failing = makeFakeClient(seed("retained_record_only"), { errors: { trip_members: { message: "down", ops: ["select"] } } });
    assert.equal(await readRetainedAccess(failing as never, TRIP, ANA), "unread");
    assert.equal(await readRetainedAccess({ from: () => { throw new Error("boom"); } }, TRIP, ANA), "unread");
    const c = makeFakeClient(seed("retained_record_only"));
    assert.equal(await readRetainedAccess(c as never, TRIP, ANA), "retained_record_only");
    assert.equal(await readRetainedAccess(c as never, TRIP, BEN), "other");
    assert.equal(await readRetainedAccess(c as never, TRIP, "99999999-0000-4000-8000-000000000009"), "other");
  });
});
