/**
 * Telegraph §30A.12 — large-group controls (census T417): slow mode, host-only
 * posting, media/link restrictions, member moderation, bounded acknowledgement.
 *
 * ENFORCEMENT IS SERVER-SIDE AND IS TESTED AT THE DOORS: the text and media
 * doors of routes/messaging.ts (inline gate) and the shared guard
 * (lib/telegraphThreadWrite.ts gate 5b, which share / typed kinds / voice /
 * coordination / the command bus run). The control routes
 * (routes/telegraphGroups.ts) only let a host set what that gate reads.
 *
 * MUTANTS (each applied alone, each red, each reverted):
 *   G1 decideGroupSend ignores postingPolicy ..................................... red
 *   G2 decideGroupSend lets a host's controls bind the host ...................... red
 *   G3 the mute applies to responses too ......................................... red (a muted member may still acknowledge)
 *   G4 slow mode never refuses ................................................... red
 *   G5 the inline text door does not call refuseByGroupControls .................. red
 *   G6 the shared guard skips gate 5b ............................................ red
 *   G7 controls read with the flag OFF ........................................... red (nothing read while off)
 *   G8 controlGate drops the host check (needHost ignored) ....................... red
 *   G9 bounded acknowledgement hands every member the outstanding list ........... red
 *   G10 the media restriction ignored ............................................ red
 *   G11 the link restriction ignored ............................................. red
 *   G12 an unreadable controls/mute row treated as "no control" .................. red
 *
 * Run: node --import tsx/esm --test src/test/telegraphGroupControls.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { guardTelegraphThreadWrite } from "../lib/telegraphThreadWrite.js";
import telegraphGroupsRouter from "../routes/telegraphGroups.js";
import messagingRouter from "../routes/messaging.js";
import telegraphShareRouter from "../routes/telegraphShare.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import { decideGroupSend, carriesLink, NO_CONTROLS } from "../domain/telegraph/policies/groupControlsPolicy.js";
import { call, makeFakeClient, startRouter, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // host
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const X = "eeeeeeee-0000-4000-8000-000000000005"; // outsider

const G = "00000000-0000-4000-8000-0000000000a1"; // group, A admin
const TRIP_T = "00000000-0000-4000-8000-0000000000a2"; // trip owned by A
const CIRCLE_T = "00000000-0000-4000-8000-0000000000a3"; // circle owned by A
const DM = "00000000-0000-4000-8000-0000000000a4";
const BIG = "00000000-0000-4000-8000-0000000000a5"; // 60-member group, A admin
const TRIP_ID = "99990000-0000-4000-8000-000000000001";
const PLACE_OK = "77770000-0000-4000-8000-000000000001";

const crowd = Array.from({ length: 60 }, (_, i) => `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

const member = (thread: string, user: string, over: Record<string, unknown> = {}) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, ...over,
});
const thread = (id: string, type: string, over: Record<string, unknown> = {}) => ({
  id, thread_type: type, trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: false,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null, ...over,
});
const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: "1", payload });

type Controls = Partial<{ slow_mode_seconds: number; posting_policy: string; media_policy: string; link_policy: string }>;

function seed(opts: { flag?: boolean | null; controls?: Record<string, Controls>; mutes?: any[]; over?: Partial<Record<string, any[]>> } = {}) {
  const ctl = Object.entries(opts.controls ?? {}).map(([thread_id, c]) => ({
    thread_id, slow_mode_seconds: 0, posting_policy: "everyone", media_policy: "everyone", link_policy: "everyone", ...c,
  }));
  return {
    feature_flags: opts.flag === null ? [] : [{ flag: "telegraph_group_controls_enabled", enabled: opts.flag !== false }],
    blocks: [],
    profiles: [A, B, C, X, ...crowd].map((id, i) => ({ id, handle: `u${i}`, name: `U${i}`, preferred_language: "en", avatar_url: null, show_name_publicly: true })),
    trust_profiles: [], trust_restrictions: [], user_account_states: [], user_message_settings: [], message_requests: [],
    trips: [{ id: TRIP_ID, owner_id: A, title: "T", destination_city: "Hue" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: A, role: "owner", status: "accepted", permissions: null },
      { trip_id: TRIP_ID, user_id: B, role: "member", status: "accepted", permissions: null },
    ],
    message_threads: [
      thread(G, "group", { created_by: A }), thread(TRIP_T, "trip", { trip_id: TRIP_ID }),
      thread(CIRCLE_T, "circle", { circle_owner_id: A }), thread(DM, "direct"), thread(BIG, "group", { created_by: A }),
    ],
    message_thread_members: [
      member(G, A, { role: "admin" }), member(G, B), member(G, C),
      member(TRIP_T, A), member(TRIP_T, B),
      member(CIRCLE_T, A), member(CIRCLE_T, B),
      member(DM, A), member(DM, B),
      member(BIG, A, { role: "admin" }), ...crowd.map((u) => member(BIG, u)),
    ],
    messages: [],
    message_translations: [],
    places: [{ id: PLACE_OK, name: "Rooftop", city: "Hue", neighborhood: "Old town", primary_category: "bar", status: "active", updated_at: "2026-05-01T00:00:00.000Z" }],
    telegraph_thread_controls: ctl,
    telegraph_thread_member_mutes: opts.mutes ?? [],
    ...(opts.over ?? {}),
  };
}

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(telegraphGroupsRouter);
  all.use(telegraphShareRouter);
  all.use(telegraphCoordinationRouter);
  all.use(messagingRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(opts: Parameters<typeof seed>[0] = {}, extra: FakeDbOptions = {}): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(seed(opts), { ...extra, columnDefaults: { message_threads: { status: "active", is_e2ee: false } } });
  _setTestClient(c, true);
  return c;
}

const say = (threadId: string, as: string, body: string) => call(harness.base, "POST", `/threads/${threadId}/messages`, as, { body });
const media = (threadId: string, as: string) =>
  call(harness.base, "POST", `/threads/${threadId}/media`, as, { mediaUrl: `post-media/${as}/p${++mediaSeq}.webp`, mediaType: "image" });
let mediaSeq = 0;
const sent = (c: FakeClient, threadId: string) => c._store.messages.filter((m) => m.thread_id === threadId).length;

// ── The decision, pure ────────────────────────────────────────────────────────

describe("§30A.12 decideGroupSend — the one decision", () => {
  const base = { controls: NO_CONTROLS, isHost: false, mutedUntil: null, lastPostAt: null } as const;
  const NOW = Date.parse("2026-06-01T12:00:00.000Z");
  it("hosts_only refuses a member's post and admits a response, a safety send and the host", () => {
    const f = { ...base, controls: { ...NO_CONTROLS, postingPolicy: "hosts_only" as const } };
    assert.equal(decideGroupSend(f, { contribution: "post" }, NOW).allowed, false);
    assert.equal(decideGroupSend(f, { contribution: "response" }, NOW).allowed, true);
    assert.equal(decideGroupSend(f, { safety: true }, NOW).allowed, true);
    assert.equal(decideGroupSend({ ...f, isHost: true }, { contribution: "post" }, NOW).allowed, true);
  });
  it("a mute stops posts, not responses; an expired mute is not in force; an unparseable end is", () => {
    assert.equal(decideGroupSend({ ...base, mutedUntil: "indefinite" }, {}, NOW).allowed, false);
    assert.equal(decideGroupSend({ ...base, mutedUntil: "indefinite" }, { contribution: "response" }, NOW).allowed, true);
    assert.equal(decideGroupSend({ ...base, mutedUntil: "2026-06-01T11:00:00.000Z" }, {}, NOW).allowed, true);
    assert.equal(decideGroupSend({ ...base, mutedUntil: "2026-06-01T13:00:00.000Z" }, {}, NOW).allowed, false);
    assert.equal(decideGroupSend({ ...base, mutedUntil: "garbage" }, {}, NOW).allowed, false);
  });
  it("slow mode refuses a second post inside the window with a retry hint, not a response", () => {
    const f = { ...base, controls: { ...NO_CONTROLS, slowModeSeconds: 60 }, lastPostAt: "2026-06-01T11:59:30.000Z" };
    const v = decideGroupSend(f, {}, NOW);
    assert.equal(v.allowed, false);
    assert.equal((v as any).refusal, "slow_mode");
    assert.equal((v as any).retryAfterMs, 30_000);
    assert.equal(decideGroupSend(f, { contribution: "response" }, NOW).allowed, true);
    assert.equal(decideGroupSend({ ...f, lastPostAt: "2026-06-01T11:58:00.000Z" }, {}, NOW).allowed, true);
  });
  it("links: http(s) and www. hosts count; prose with dots does not", () => {
    assert.equal(carriesLink("see https://x.example/p"), true);
    assert.equal(carriesLink("go to www.scam-site.com now"), true);
    assert.equal(carriesLink("meet at 5.30, e.g. by the gate"), false);
  });
});

// ── The doors ─────────────────────────────────────────────────────────────────

describe("§30A.12 enforced at the text and media doors (inline gate)", () => {
  it("host-only posting: a member's text is refused, the host's is not", async () => {
    const c = use({ controls: { [G]: { posting_policy: "hosts_only" } } });
    const r = await say(G, B, "hello all");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TELEGRAPH_POLICY_GROUP_CONTROL");
    assert.equal(sent(c, G), 0);
    const h = await say(G, A, "hello all");
    assert.equal(h.status, 201, JSON.stringify(h.body));
    assert.equal(sent(c, G), 1);
  });

  it("a host's mute stops that member only, and an expired mute is lifted", async () => {
    const c = use({ mutes: [{ thread_id: G, user_id: B, muted_by: A, muted_until: null }, { thread_id: G, user_id: C, muted_by: A, muted_until: "2020-01-01T00:00:00.000Z" }] });
    assert.equal((await say(G, B, "x")).status, 403);
    assert.equal((await say(G, C, "x")).status, 201);
    assert.equal(sent(c, G), 1);
  });

  it("media restriction refuses a member's upload; their text still goes", async () => {
    const c = use({ controls: { [G]: { media_policy: "hosts_only" } } });
    const m = await media(G, B);
    assert.equal(m.status, 403, JSON.stringify(m.body));
    assert.equal((await media(G, A)).status, 201, "the host may upload");
    assert.equal((await say(G, B, "words are fine")).status, 201);
    assert.equal(sent(c, G), 2);
  });

  it("link restriction refuses a member's link and admits plain text", async () => {
    const c = use({ controls: { [G]: { link_policy: "hosts_only" } } });
    assert.equal((await say(G, B, "deal at https://cheap.example/x")).status, 403);
    assert.equal((await say(G, B, "www.scam-site.com")).status, 403);
    assert.equal((await say(G, B, "see you at 5")).status, 201);
    assert.equal((await say(G, A, "official: https://portava.app/x")).status, 201);
    assert.equal(sent(c, G), 2);
  });

  it("slow mode: one post per window for a member (429 + Retry-After); the host is not limited", async () => {
    const c = use({ controls: { [G]: { slow_mode_seconds: 60 } } });
    assert.equal((await say(G, B, "one")).status, 201);
    const second = await say(G, B, "two");
    assert.equal(second.status, 429, JSON.stringify(second.body));
    assert.equal((await say(G, A, "one")).status, 201);
    assert.equal((await say(G, A, "two")).status, 201);
    assert.equal(sent(c, G), 3);
  });

  it("controls on a TRIP thread bind its members; the trip owner is its host", async () => {
    const c = use({ controls: { [TRIP_T]: { posting_policy: "hosts_only" } } });
    assert.equal((await say(TRIP_T, B, "x")).status, 403);
    assert.equal((await say(TRIP_T, A, "x")).status, 201);
    assert.equal(sent(c, TRIP_T), 1);
  });

  it("a DIRECT thread has no controls: a stray row binds nothing and is not read", async () => {
    const c = use({ controls: { [DM]: { posting_policy: "hosts_only" } } });
    assert.equal((await say(DM, B, "hi")).status, 201);
    assert.equal(c._observed.selects.filter((s) => s.table === "telegraph_thread_controls").length, 0);
  });
});

describe("§30A.12 enforced at the shared guard (share, typed kinds, voice, coordination, commands)", () => {
  it("a member's share is refused under host-only posting", async () => {
    const c = use({ controls: { [G]: { posting_policy: "hosts_only" } } });
    const r = await call(harness.base, "POST", `/threads/${G}/share`, B, { objectType: "PLACE", objectId: PLACE_OK });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(sent(c, G), 0);
  });
  it("a share caption with a link is refused under the link restriction", async () => {
    use({ controls: { [G]: { link_policy: "hosts_only" } } });
    const r = await call(harness.base, "POST", `/threads/${G}/share`, B, { objectType: "PLACE", objectId: PLACE_OK, caption: "book at https://x.example" });
    assert.equal(r.status, 403);
  });
  it("the guard admits a RESPONSE and a SAFETY send from a muted member under host-only", async () => {
    const c = use({ controls: { [G]: { posting_policy: "hosts_only" } }, mutes: [{ thread_id: G, user_id: B, muted_by: A, muted_until: null }] });
    assert.equal((await guardTelegraphThreadWrite(c as any, G, B, { groupSend: { contribution: "response" } })).ok, true);
    assert.equal((await guardTelegraphThreadWrite(c as any, G, B, { sendBucket: "safety" })).ok, true);
    const post = await guardTelegraphThreadWrite(c as any, G, B);
    assert.equal(post.ok, false);
    assert.equal((post as any).reason, "TELEGRAPH_POLICY_GROUP_CONTROL");
  });
  it("a muted member can still ACKNOWLEDGE an announcement through the coordination door", async () => {
    const ANN = "11111111-0000-4000-8000-0000000000aa";
    const c = use({
      controls: { [G]: { posting_policy: "hosts_only" } },
      mutes: [{ thread_id: G, user_id: B, muted_by: A, muted_until: null }],
      over: { messages: [{ id: ANN, thread_id: G, sender_id: A, created_at: "2026-05-01T00:00:00.000Z", deleted_at: null, msg_type: "announcement", subtype: null, body: env("ANNOUNCEMENT", { title: "Bus at 8", body: "lobby", requiresAcknowledgement: true }) }] },
    });
    const r = await call(harness.base, "POST", `/threads/${G}/coordination`, B, { kind: "ACKNOWLEDGEMENT", payload: { announcementMessageId: ANN } });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    assert.equal(sent(c, G), 2);
  });
});

describe("the flag (3661, seeded OFF) — restrictive when ON, so read three-valued", () => {
  it("OFF: controls and mutes are not read and bind nothing", async () => {
    const c = use({ flag: false, controls: { [G]: { posting_policy: "hosts_only" } }, mutes: [{ thread_id: G, user_id: B, muted_by: A, muted_until: null }] });
    assert.equal((await say(G, B, "x")).status, 201);
    assert.equal(c._observed.selects.filter((s) => s.table === "telegraph_thread_controls" || s.table === "telegraph_thread_member_mutes").length, 0);
  });
  it("absent row: OFF", async () => {
    const c = use({ flag: null, controls: { [G]: { posting_policy: "hosts_only" } } });
    assert.equal((await say(G, B, "x")).status, 201);
    assert.equal(sent(c, G), 1);
  });
  it("an unreadable controls row refuses a group send as retryable, never a pass", async () => {
    const c = use({ controls: { [G]: { posting_policy: "everyone" } } }, { errors: { telegraph_thread_controls: { message: "connection reset" } } });
    const r = await say(G, B, "x");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(sent(c, G), 0);
  });
  it("the control routes answer feature_disabled while OFF", async () => {
    use({ flag: false });
    const r = await call(harness.base, "PUT", `/threads/${G}/controls`, A, { postingPolicy: "hosts_only" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });
});

describe("§30A.12 control routes — only a host sets them", () => {
  it("a member cannot set controls; the host can, and the gate then reads them", async () => {
    const c = use();
    assert.equal((await call(harness.base, "PUT", `/threads/${G}/controls`, B, { postingPolicy: "hosts_only" })).status, 403);
    assert.equal(c._store.telegraph_thread_controls.length, 0);
    const ok = await call(harness.base, "PUT", `/threads/${G}/controls`, A, { postingPolicy: "hosts_only", slowModeSeconds: 30 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(c._store.telegraph_thread_controls[0].posting_policy, "hosts_only");
    assert.equal((await say(G, B, "x")).status, 403);
  });
  it("a circle's owner is its host; a non-member learns nothing; a DM has no controls", async () => {
    use();
    assert.equal((await call(harness.base, "PUT", `/threads/${CIRCLE_T}/controls`, A, { mediaPolicy: "hosts_only" })).status, 200);
    assert.equal((await call(harness.base, "PUT", `/threads/${CIRCLE_T}/controls`, B, { mediaPolicy: "hosts_only" })).status, 403);
    assert.equal((await call(harness.base, "GET", `/threads/${G}/controls`, X)).status, 404);
    assert.equal((await call(harness.base, "PUT", `/threads/${DM}/controls`, A, { postingPolicy: "hosts_only" })).status, 409);
  });
  it("mute: host only, never a host, timed or until lifted; lifting deletes the row", async () => {
    const c = use();
    assert.equal((await call(harness.base, "POST", `/threads/${G}/moderation/${C}/mute`, B, {})).status, 403);
    assert.equal((await call(harness.base, "POST", `/threads/${G}/moderation/${A}/mute`, A, {})).status, 400);
    const m = await call(harness.base, "POST", `/threads/${G}/moderation/${B}/mute`, A, { minutes: 60 });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(c._store.telegraph_thread_member_mutes.length, 1);
    assert.equal((await say(G, B, "x")).status, 403);
    assert.equal((await call(harness.base, "DELETE", `/threads/${G}/moderation/${B}/mute`, A)).status, 200);
    assert.equal(c._store.telegraph_thread_member_mutes.length, 0);
    assert.equal((await say(G, B, "x")).status, 201);
  });
  it("a member's own GET shows their own mute and not anyone else's", async () => {
    use({ mutes: [{ thread_id: G, user_id: B, muted_by: A, muted_until: null }] });
    const b = await call(harness.base, "GET", `/threads/${G}/controls`, B);
    assert.equal(b.body.mutedUntil, "indefinite");
    const cc = await call(harness.base, "GET", `/threads/${G}/controls`, C);
    assert.equal(cc.body.mutedUntil, null);
    assert.ok(!JSON.stringify(cc.body).includes(B));
  });
  it("remove: a group's host removes a member, who then cannot send or read; a trip's roster is not the chat's to change", async () => {
    const c = use();
    const r = await call(harness.base, "POST", `/threads/${G}/moderation/${B}/remove`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(c._store.message_thread_members.find((m) => m.thread_id === G && m.user_id === B).left_at);
    assert.equal((await say(G, B, "x")).status, 403);
    assert.equal((await call(harness.base, "GET", `/threads/${G}/messages`, B)).status, 403);
    assert.equal((await call(harness.base, "POST", `/threads/${TRIP_T}/moderation/${B}/remove`, A)).status, 409);
    assert.equal((await call(harness.base, "POST", `/threads/${G}/moderation/${C}/remove`, C)).status, 403, "a member is not a host");
  });
});

describe("§30A.12 bounded acknowledgement in a LARGE_GROUP", () => {
  const ANN = "11111111-0000-4000-8000-0000000000bb";
  const acks = crowd.slice(0, 30).map((u, i) => ({
    id: `22222222-0000-4000-8000-${String(i).padStart(12, "0")}`, thread_id: BIG, sender_id: u,
    created_at: `2026-05-01T00:${String(10 + i).padStart(2, "0")}:00.000Z`, deleted_at: null, msg_type: "acknowledgement", subtype: null,
    body: env("ACKNOWLEDGEMENT", { announcementMessageId: ANN, note: null }),
  }));
  const msgs = [{ id: ANN, thread_id: BIG, sender_id: A, created_at: "2026-05-01T00:00:00.000Z", deleted_at: null, msg_type: "announcement", subtype: null,
    body: env("ANNOUNCEMENT", { title: "Bus at 8", body: "lobby", requiresAcknowledgement: true }) }, ...acks];

  it("a member gets counts and a bounded sample, never the outstanding names", async () => {
    use({ over: { messages: msgs } });
    const r = await call(harness.base, "GET", `/threads/${BIG}/announcements`, crowd[59]!);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = r.body.announcements[0];
    assert.equal(a.acknowledgedCount, 30);
    assert.equal(a.acknowledgedBy.length, 20);
    assert.equal(a.outstanding, null);
    assert.equal(a.outstandingCount, 30);
    assert.equal(a.rosterBounded, true);
  });
  it("the host gets a bounded sample of who is outstanding", async () => {
    use({ over: { messages: msgs } });
    const a = (await call(harness.base, "GET", `/threads/${BIG}/announcements`, A)).body.announcements[0];
    assert.equal(a.outstanding.length, 20);
    assert.equal(a.outstandingCount, 30);
  });
  it("flag OFF: the roster is exactly what it was", async () => {
    use({ flag: false, over: { messages: msgs } });
    const a = (await call(harness.base, "GET", `/threads/${BIG}/announcements`, crowd[59]!)).body.announcements[0];
    assert.equal(a.acknowledgedBy.length, 30);
    assert.equal(a.outstanding.length, 30);
    assert.equal(a.rosterBounded, undefined);
  });
});
