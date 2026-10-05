/**
 * Telegraph §13.1 — CREATE_DECISION, SET_COORDINATION_STATUS and SHARE_LOCATION
 * issued by the command bus through the SAME writer as their route doors
 * (census T166, T169, T170; T168's precedent).
 *
 * Each case reads the STORE back. The equivalence cases post the same payload
 * through both doors and compare the rows written, field for field, so a bus
 * that drifted from the route on any rule — envelope, msg_type, subtype, the
 * events it emits — fails here. The refusal cases prove the bus holds the
 * route's gates: a blocked sender, an E2EE thread and a non-member write
 * nothing, and an invalid payload is refused by the route's own validator
 * before the guard can spend the sender's burst allowance.
 *
 * Run: node --import tsx/esm --test src/test/telegraphEnvelopeCommands.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import { isIssuable, LEGACY_PATH_COMMANDS, UNIMPLEMENTED_COMMANDS } from "../domain/telegraph/commands/telegraphCommands.js";
import { ENVELOPE_COMMAND_KINDS, planEnvelopeCommand } from "../services/telegraph/threadEnvelopeWrites.js";
import { makeFakeClient, startRouter, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const DM = "00000000-0000-4000-8000-00000000000d";
const DM_E2EE = "00000000-0000-4000-8000-00000000000e";
const GROUP = "00000000-0000-4000-8000-00000000000a";

const member = (thread: string, user: string) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
});
const thread = (id: string, type: string, e2ee = false) => ({
  id, thread_type: type, trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: e2ee,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
});

function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [A, B, C].map((id) => ({ id, handle: id.slice(0, 1), name: id.slice(0, 1), preferred_language: "en" })),
    reports: [], user_message_settings: [], user_friendships: [], user_follows: [], circle_memberships: [],
    trust_profiles: [], trust_restrictions: [], message_requests: [], message_translations: [],
    message_threads: [thread(DM, "direct"), thread(DM_E2EE, "direct", true), thread(GROUP, "trip")],
    message_thread_members: [member(DM, A), member(DM, B), member(DM_E2EE, A), member(DM_E2EE, B), member(GROUP, A), member(GROUP, B)],
    messages: [],
    telegraph_events: [],
    ...over,
  };
}

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(commandRouter); // first, exactly as routes/index.ts mounts it
  all.use(telegraphKindsRouter);
  all.use(telegraphCoordinationRouter);
  harness = await startRouter(all);
});
after(async () => { _setTestClient(null, false); await harness.close(); });

function use(seed: Record<string, any[]>): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(seed);
  _setTestClient(c, true);
  return c;
}
async function post(path: string, asUser: string, body: unknown) {
  const res = await fetch(`${harness.base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const messagesIn = (c: FakeClient, threadId: string) => (c._store.messages ?? []).filter((m: any) => m.thread_id === threadId);
/** The parts of a written row a door decides. Ids and clocks differ by construction. */
const shape = (m: any) => ({ sender_id: m.sender_id, msg_type: m.msg_type, subtype: m.subtype, body: JSON.parse(m.body) });

const DECISION = { question: "Which bar?", options: [{ id: "a", label: "Ola" }, { id: "b", label: "Lux" }], resolutionRule: "MAJORITY" };
const STATUS = { state: "ON_MY_WAY", approximateLabel: "near the station" };
const share = () => ({ label: "Pier 2", precision: "area", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

describe("the vocabulary: issued here, not sent away, not unimplemented", () => {
  for (const type of Object.keys(ENVELOPE_COMMAND_KINDS)) {
    it(`${type} is issuable and is no longer a legacy path`, () => {
      assert.equal(isIssuable(type), true);
      assert.equal(LEGACY_PATH_COMMANDS[type], undefined);
      assert.equal(UNIMPLEMENTED_COMMANDS.includes(type), false);
    });
  }
});

describe("two doors, one writer: the bus writes exactly the row the route writes", () => {
  it("CREATE_DECISION ≡ POST /threads/:id/coordination kind DECISION", async () => {
    const c = use(store());
    const viaRoute = await post(`/threads/${GROUP}/coordination`, A, { kind: "DECISION", payload: DECISION });
    assert.equal(viaRoute.status, 201, JSON.stringify(viaRoute.body));
    const viaBus = await post(`/telegraph/commands`, A, { type: "CREATE_DECISION", conversationId: GROUP, params: DECISION });
    assert.equal(viaBus.status, 200, JSON.stringify(viaBus.body));
    assert.equal(viaBus.body.ok, true);
    assert.equal(viaBus.body.data.kind, "DECISION");
    const rows = messagesIn(c, GROUP);
    assert.equal(rows.length, 2);
    assert.deepEqual(shape(rows[1]), shape(rows[0]));
    assert.equal(viaBus.body.data.messageId, rows[1].id);
  });

  it("SET_COORDINATION_STATUS ≡ POST /threads/:id/coordination kind COORDINATION", async () => {
    const c = use(store());
    await post(`/threads/${GROUP}/coordination`, A, { kind: "COORDINATION", payload: STATUS });
    const viaBus = await post(`/telegraph/commands`, A, { type: "SET_COORDINATION_STATUS", conversationId: GROUP, params: STATUS });
    assert.equal(viaBus.status, 200, JSON.stringify(viaBus.body));
    const rows = messagesIn(c, GROUP);
    assert.equal(rows.length, 2);
    assert.deepEqual(shape(rows[1]), shape(rows[0]));
    assert.equal(rows[1].subtype, "on_my_way");
  });

  it("SHARE_LOCATION ≡ POST /threads/:id/typed-messages LOCATION with an expiry, and both emit location.started", async () => {
    const c = use(store());
    const started: TelegraphEvent[] = [];
    const unsub = subscribe(B, (e) => { if (e.type === "location.started") started.push(e); });
    try {
    const payload = share();
    const viaRoute = await post(`/threads/${GROUP}/typed-messages`, A, { kind: "LOCATION", payload });
    assert.equal(viaRoute.status, 201, JSON.stringify(viaRoute.body));
    const viaBus = await post(`/telegraph/commands`, A, { type: "SHARE_LOCATION", conversationId: GROUP, params: payload });
    assert.equal(viaBus.status, 200, JSON.stringify(viaBus.body));
    const rows = messagesIn(c, GROUP);
    assert.equal(rows.length, 2);
    assert.deepEqual(shape(rows[1]), shape(rows[0]));
    // §13.2 location.started, once per share (two shares), from the one writer.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(new Set(started.map((e) => String((e.payload as { shareId?: string }).shareId))).size, 2, JSON.stringify(started));
    } finally {
      unsub();
    }
  });
});

describe("the bus holds the route doors' gates", () => {
  it("a sender the other party BLOCKED writes nothing, and is told what a non-member is told", async () => {
    const c = use(store({ blocks: [{ blocker_id: B, blocked_id: A }] }));
    for (const [type, params] of [["CREATE_DECISION", DECISION], ["SET_COORDINATION_STATUS", STATUS], ["SHARE_LOCATION", share()]] as const) {
      const r = await post(`/telegraph/commands`, A, { type, conversationId: DM, params });
      assert.equal(r.status, 403, `${type}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(messagesIn(c, DM).length, 0);
  });

  it("an end-to-end encrypted thread gets no server-readable row", async () => {
    const c = use(store());
    for (const [type, params] of [["CREATE_DECISION", DECISION], ["SET_COORDINATION_STATUS", STATUS], ["SHARE_LOCATION", share()]] as const) {
      const r = await post(`/telegraph/commands`, A, { type, conversationId: DM_E2EE, params });
      assert.notEqual(r.status, 200, `${type} wrote into an E2EE thread`);
    }
    assert.equal(messagesIn(c, DM_E2EE).length, 0);
  });

  it("a non-member writes nothing", async () => {
    const c = use(store());
    const r = await post(`/telegraph/commands`, C, { type: "CREATE_DECISION", conversationId: DM, params: DECISION });
    assert.equal(r.status, 403);
    assert.equal(messagesIn(c, DM).length, 0);
  });

  it("an invalid payload is refused by the route's own validator — 400, nothing written", async () => {
    const c = use(store());
    const bad = await post(`/telegraph/commands`, A, { type: "CREATE_DECISION", conversationId: GROUP, params: { question: "One option?", options: [{ id: "a", label: "only" }] } });
    assert.equal(bad.status, 400);
    const badState = await post(`/telegraph/commands`, A, { type: "SET_COORDINATION_STATUS", conversationId: GROUP, params: { state: "TELEPORTING" } });
    assert.equal(badState.status, 400);
    assert.equal(messagesIn(c, GROUP).length, 0);
  });

  it("SHARE_LOCATION without an expiry is a pin, not a share — refused, nothing written", async () => {
    const c = use(store());
    const r = await post(`/telegraph/commands`, A, { type: "SHARE_LOCATION", conversationId: GROUP, params: { label: "Pier 2", precision: "area" } });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /pin, not a share/);
    assert.equal(messagesIn(c, GROUP).length, 0);
  });

  it("SHARE_LOCATION with an expiry already past, or past §15.1's ceiling, is refused", async () => {
    const c = use(store());
    const past = await post(`/telegraph/commands`, A, { type: "SHARE_LOCATION", conversationId: GROUP, params: { ...share(), expiresAt: new Date(Date.now() - 60_000).toISOString() } });
    assert.equal(past.status, 400);
    assert.match(String(past.body.message), /already past/, "refused for the wrong reason");
    const far = await post(`/telegraph/commands`, A, { type: "SHARE_LOCATION", conversationId: GROUP, params: { ...share(), expiresAt: new Date(Date.now() + 400 * 3_600_000).toISOString() } });
    assert.equal(far.status, 400);
    assert.match(String(far.body.message), /at most \d+ hours/, "refused for the wrong reason");
    assert.equal(messagesIn(c, GROUP).length, 0);
  });
});

describe("planEnvelopeCommand — pure", () => {
  it("writes the kind the route doors write", () => {
    const now = Date.now();
    const d = planEnvelopeCommand("CREATE_DECISION", DECISION, now);
    const s = planEnvelopeCommand("SET_COORDINATION_STATUS", STATUS, now);
    const l = planEnvelopeCommand("SHARE_LOCATION", share(), now);
    assert.equal(d.ok && d.msgType, "decision");
    assert.equal(s.ok && s.msgType, "coordination");
    assert.equal(l.ok && l.msgType, "location");
    assert.ok(l.ok && l.locationShare);
  });
});
