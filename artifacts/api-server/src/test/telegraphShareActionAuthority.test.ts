/**
 * census-telegraph T445 (lane TELEGRAPH batch 4) — a shared source's ACTIONS are per viewer.
 *
 * T445: "A source object shared in Telegraph cannot grant broader access than its authorized share
 * projection." Its last remainder: "the projection's action set is per family, not per viewer". Now an
 * offered action survives only if the viewer holds, in THIS conversation, the §14.1 capability that
 * governs it (the kernel's own table, ACTION_GOVERNING_CAPABILITY) — at both doors that resolve shares:
 *
 *   POST /threads/:id/share-projections        (routes/telegraphShare.ts)
 *   resolveSharedCards / applySharedCardTruth  (every reader that puts a legacy card's truth on the
 *                                               wire — the messages page, group chat, saved messages)
 *
 * Pinned, over one active hidden gem (the PLACE family: ADD_TO_TRIP, CREATE_PLAN, MEET_HERE, SHARE_PLACE,
 * DO_THIS_NOW):
 *   - a group member with every right is offered all five (the control: nothing is narrowed for nothing);
 *   - in a trip's thread, a member who is not accepted crew may not create a plan: ADD_TO_TRIP and
 *     CREATE_PLAN are withheld, the three things they may do INTO the thread stay;
 *   - in an archived thread nothing is offered, and the card is still served (it opens its deep link);
 *   - a blocked 1:1 member is offered nothing, and nothing on the wire says why (§11.1);
 *   - an unreadable capability input offers nothing (fail closed), never the family's set;
 *   - the same narrowing reaches a card read through the readers' one call;
 *   - the capability set is read once per conversation per call, and only when a live card offers an action.
 *
 * MUTANTS (tgprod/mutants-b4.txt): SA1 the share route does not narrow; SA2 the readers do not narrow;
 * SA3 no capabilities → the family's set (fail open); SA4 the governing capability is ignored;
 * SA5 a lookup that throws keeps the set; SA6 no per-conversation memo.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphShareActionAuthority.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import telegraphShareRouter from "../routes/telegraphShare.js";
import { applySharedCardTruth } from "../services/telegraph/sharedCardTruth.js";
import { ACTION_GOVERNING_CAPABILITY } from "../services/telegraph/contextKernelPolicy.js";
import { TELEGRAPH_ACTIONS, type TelegraphAction } from "../services/telegraph/vocabulary.js";
import { actionsTheViewerMayTake, narrowShareActions, viewerCapabilityLookup } from "../services/telegraph/shareActionAuthority.js";
import { CONVERSATION_CAPABILITY_NAMES, type ConversationCapabilities } from "../domain/telegraph/contracts/conversationCapabilities.js";
import { call, makeFakeClient, startRouter, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const GROUP = "10000000-0000-4000-8000-0000000000a1";
const TRIP_THREAD = "10000000-0000-4000-8000-0000000000a2";
const ARCHIVED = "10000000-0000-4000-8000-0000000000a3";
const DM = "10000000-0000-4000-8000-0000000000a4";
const TRIP = "20000000-0000-4000-8000-0000000000b1";
const GEM = "55550000-0000-4000-8000-000000000002";

const PLACE_FAMILY: TelegraphAction[] = ["ADD_TO_TRIP", "CREATE_PLAN", "MEET_HERE", "SHARE_PLACE", "DO_THIS_NOW"];
const INTO_THE_THREAD: TelegraphAction[] = ["MEET_HERE", "SHARE_PLACE", "DO_THIS_NOW"];

const thread = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, thread_type: type, status: "active", is_e2ee: false, trip_id: null, circle_owner_id: null, title: null,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null, ...extra,
});
const member = (t: string, u: string) => ({ thread_id: t, user_id: u, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null });

function seed(opts: { blocked?: boolean } = {}): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "disable_messaging", enabled: false }],
    message_threads: [thread(GROUP, "group"), thread(TRIP_THREAD, "trip", { trip_id: TRIP }), thread(ARCHIVED, "group", { status: "archived" }), thread(DM, "direct")],
    message_thread_members: [GROUP, TRIP_THREAD, ARCHIVED, DM].flatMap((t) => [member(t, ALICE), member(t, BOB)]),
    trips: [{ id: TRIP, owner_id: BOB }],
    trip_members: [], // Alice is in the trip's THREAD, not its accepted crew
    trust_restrictions: [],
    blocks: opts.blocked ? [{ blocker_id: BOB, blocked_id: ALICE, created_at: "2026-01-01T00:00:00.000Z" }] : [],
    profiles: [ALICE, BOB].map((id, i) => ({ id, handle: `u${i}`, name: `U${i}`, account_status: "active" })),
    hidden_gems: [{ id: GEM, name: "Rooftop", city: "Hue", neighborhood: "Old town", category: "bar", status: "active", sensitivity_level: "public", merged_into: null, updated_at: "2026-05-02T00:00:00.000Z" }],
    places: [],
    messages: [],
  };
}

let harness: RouterHarness;
before(async () => { harness = await startRouter(telegraphShareRouter as unknown as express.Router); });
after(async () => { _setTestClient(null, false); await harness.close(); });

function use(opts: { blocked?: boolean; errors?: string[] } = {}): FakeClient {
  const errors: Record<string, { code: string; message: string }> = {};
  for (const t of opts.errors ?? []) errors[t] = { code: "57014", message: `canceling statement due to statement timeout (${t})` };
  const c = makeFakeClient(seed(opts), { errors });
  _setTestClient(c, true);
  return c;
}
const project = async (threadId: string) => {
  const r = await call(harness.base, "POST", `/threads/${threadId}/share-projections`, ALICE, { refs: [{ objectType: "HIDDEN_GEM", objectId: GEM, messageId: "m1" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

describe("T445 — POST /threads/:id/share-projections offers only what THIS viewer may do here", () => {
  it("control: a group member with every right is offered the family's whole set", async () => {
    use();
    const body = await project(GROUP);
    assert.equal(body.projections[0].available, true);
    assert.deepEqual(body.projections[0].actions, PLACE_FAMILY);
  });

  it("a trip thread member who is not accepted crew: plan-making withheld, what they may do INTO the thread kept", async () => {
    use();
    const p = (await project(TRIP_THREAD)).projections[0];
    assert.equal(p.available, true, "the card is still served");
    assert.deepEqual(p.actions, INTO_THE_THREAD);
  });

  it("an archived thread: nothing is offered, and the card still opens its deep link", async () => {
    use();
    const p = (await project(ARCHIVED)).projections[0];
    assert.equal(p.available, true);
    assert.ok(p.projection && p.deepLink, "the projection and its deep link are served");
    assert.deepEqual(p.actions, []);
  });

  it("a blocked 1:1 member is offered nothing, and nothing on the wire says why (§11.1)", async () => {
    use({ blocked: true });
    const body = await project(DM);
    assert.equal(body.projections[0].available, true, "the gem itself is served: the narrowing, not the loader, withheld the actions");
    assert.deepEqual(body.projections[0].actions, []);
    assert.doesNotMatch(JSON.stringify(body), /BLOCK|block/i);
  });

  it("an unreadable capability input offers nothing (fail closed), never the family's set", async () => {
    use({ errors: ["message_threads"] });
    const p = (await project(GROUP)).projections[0];
    assert.equal(p.available, true, "the gem itself is served");
    assert.deepEqual(p.actions, []);
  });
});

describe("T445 — the readers' one call (applySharedCardTruth) narrows the same way", () => {
  const card = (id: string, threadId: string) => ({
    // A server-authored hidden-gem card (POST /hidden-gems/:id/share): a §5 HIDDEN_GEM reference.
    id, thread_id: threadId, sender_id: BOB, msg_type: "card", subtype: "hidden_gem", deleted_at: null,
    body: JSON.stringify({ type: "hidden_gem", gemId: GEM }),
  });

  it("group: the whole set; trip thread, not crew: plan-making withheld; archived: none", async () => {
    const c = use();
    const at = async (t: string) => (await applySharedCardTruth(c as never, ALICE, [card(`c-${t}`, t)], { threadId: t })).truth.get(`c-${t}`) as any;
    const g = await at(GROUP);
    assert.equal(g.state, "live", JSON.stringify(g));
    assert.deepEqual(g.actions, PLACE_FAMILY);
    assert.deepEqual((await at(TRIP_THREAD)).actions, INTO_THE_THREAD);
    assert.deepEqual((await at(ARCHIVED)).actions, []);
  });

  it("the capability set is read once per conversation per call, however many cards it carries", async () => {
    const c = use();
    const rows = [card("c1", TRIP_THREAD), card("c2", TRIP_THREAD), card("c3", TRIP_THREAD)];
    const before = c._observed.selects.filter((s) => s.table === "trip_members").length;
    const { truth } = await applySharedCardTruth(c as never, ALICE, rows, { threadId: TRIP_THREAD });
    for (const id of ["c1", "c2", "c3"]) assert.deepEqual((truth.get(id) as any).actions, INTO_THE_THREAD, id);
    const reads = c._observed.selects.filter((s) => s.table === "trip_members").length - before;
    assert.ok(reads <= 1, `the capability set was resolved ${reads} times for one conversation`);
  });
});

describe("T445 — the rule, directly", () => {
  const caps = (over: Partial<ConversationCapabilities>): ConversationCapabilities => {
    const all = {} as ConversationCapabilities;
    for (const n of CONVERSATION_CAPABILITY_NAMES) all[n] = true;
    return { ...all, ...over };
  };

  it("every §8.1 action has a governing capability (no action escapes the rule)", () => {
    for (const a of TELEGRAPH_ACTIONS) assert.ok(ACTION_GOVERNING_CAPABILITY[a], a);
  });

  it("each action survives exactly when its governing capability is held; no capabilities → none", () => {
    assert.deepEqual(actionsTheViewerMayTake(PLACE_FAMILY, caps({})), PLACE_FAMILY);
    assert.deepEqual(actionsTheViewerMayTake(PLACE_FAMILY, caps({ canCreatePlan: false })), INTO_THE_THREAD);
    assert.deepEqual(actionsTheViewerMayTake(PLACE_FAMILY, caps({ canSendMessage: false })), ["ADD_TO_TRIP", "CREATE_PLAN"]);
    assert.deepEqual(actionsTheViewerMayTake(PLACE_FAMILY, null), []);
  });

  it("a lookup that throws empties every live share's actions; an unavailable share is untouched; nothing offered → no lookup", async () => {
    const live = () => ({ objectType: "HIDDEN_GEM", objectId: GEM, messageId: null, available: true, status: "active", projection: {} as never, actions: [...PLACE_FAMILY], deepLink: "/" }) as any;
    const gone = { objectType: "POST", objectId: GEM, messageId: null, available: false, status: "deleted", reason: "deleted", projection: null, actions: [], deepLink: "/" } as any;
    const shares = [live(), gone, live()];
    await narrowShareActions(async () => { throw new Error("boom"); }, GROUP, shares);
    assert.deepEqual(shares.map((s) => s.actions), [[], [], []]);
    let asked = 0;
    await narrowShareActions(async () => { asked++; return caps({}); }, GROUP, [gone, { ...live(), actions: [] }]);
    assert.equal(asked, 0, "the capability set was read with nothing to narrow");
  });

  it("viewerCapabilityLookup resolves once per conversation and never rejects", async () => {
    const c = use({ errors: ["message_threads"] });
    const look = viewerCapabilityLookup(c as never, ALICE);
    const [a, b] = await Promise.all([look(GROUP), look(GROUP)]);
    assert.equal(a, b, "the same answer object: one resolve");
    assert.ok(a === null || Object.values(a).every((v) => v === false), "an unreadable thread grants nothing");
  });
});
