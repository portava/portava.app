/**
 * Telegraph §30A.19 — the Context Kernel (census-telegraph T439) and the §30A.1
 * relationship term it hands the §14.1 capability policy (T381).
 *
 * §30A.19: "Formalize a Context Kernel above the transport layer. Inputs are
 * Relationship, Time, Proximity, Intent, and Shared Objects. These feed Policy +
 * Capabilities, which determine what the Telegraph surface may reveal and what
 * actions it may offer."
 *
 * WHAT IS REAL HERE: the contract (domain/telegraph/contracts/telegraphContextKernel.ts),
 * the reads (server/telegraph/telegraphContextKernel.ts and
 * telegraphContextRelationship.ts), the route (server/telegraph/telegraphContextRoute.ts),
 * the capability policy and route, GET /coordination, the call gateway's
 * messaging floor, the relationship resolver, canMessage, the Nearby loader,
 * the signal contract and the observation budget. What is replaced is PostgREST
 * (src/test/telegraphCertificationHarness.ts: `.or()` really parsed, failures
 * RESOLVED as `{ data: null, error }`, writes visible to later reads).
 *
 *   A  the contract, pure
 *   K  GET /threads/:id/context — flag, gate, each input's read / degraded /
 *      not-consulted / withheld path, no coordinate on the wire
 *   P  the policy's relationship term: changes canCall only with the flag ON,
 *      and then agrees with the call door's messaging floor
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphContextKernel.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

import { _setTestClient } from "../lib/http.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { makeCallGateway } from "../lib/calls/callGatewayAdapter.js";
import contextRouter from "../server/telegraph/telegraphContextRoute.js";
import capabilityRouter from "../server/telegraph/capabilityRoute.js";
import coordinationRouter from "../routes/telegraphCoordination.js";
import { resolveConversationCapabilities, kernelCallTerm } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";
import {
  CONTEXT_INPUTS,
  CONTEXT_KERNEL_FLAG,
  composeConversationContext,
  contextForWire,
  degradedInput,
  notConsultedInput,
  readInput,
  withheldInput,
  type KernelInputs,
} from "../domain/telegraph/contracts/telegraphContextKernel.js";
import { call, makeFakeClient, startRouter, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const asSc = (c: unknown) => c as SupabaseClient;

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // A's DM partner
const C = "cccccccc-0000-4000-8000-000000000003"; // blocked A
const D = "dddddddd-0000-4000-8000-000000000004"; // group member
const E = "eeeeeeee-0000-4000-8000-000000000005"; // B's DM partner; A is not in that DM
const R = "abababab-0000-4000-8000-000000000006"; // a viewer whose Nearby rate limit is spent

const DM_AB = "00000000-0000-4000-8000-0000000000a1";
const DM_AC = "00000000-0000-4000-8000-0000000000a2";
const GROUP = "00000000-0000-4000-8000-0000000000a3";
const DM_BE = "00000000-0000-4000-8000-0000000000a4";
const TRIP_PAIR = "00000000-0000-4000-8000-0000000000a5"; // a trip thread of exactly A and B — pairwise in size, not a direct conversation
const DM_RB = "00000000-0000-4000-8000-0000000000a6";
const MISSING = "00000000-0000-4000-8000-0000000000a9";

const PLAN_PAST = "70000000-0000-4000-8000-000000000001";
const PLAN_NEXT = "70000000-0000-4000-8000-000000000002";
const PLAN_LATER = "70000000-0000-4000-8000-000000000003";
const TRIP1 = "11111111-0000-4000-8000-000000000001";
const TRIP2 = "11111111-0000-4000-8000-000000000002";

const LAT = 41.157944;
const LNG = -8.629105;
const HOUR = 3_600_000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const member = (thread_id: string, user_id: string, extra: Record<string, unknown> = {}) =>
  ({ thread_id, user_id, role: "member", left_at: null, visible_from_at: null, last_read_at: null, ...extra });

interface WorldFlags { kernel?: boolean | null; relationship?: boolean; nearby?: boolean; historyBound?: boolean }

function world(flags: WorldFlags = {}, over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  const ff: any[] = [];
  if (flags.kernel !== null) ff.push({ flag: CONTEXT_KERNEL_FLAG, enabled: flags.kernel ?? true });
  ff.push({ flag: "telegraph_relationship_context_enabled", enabled: flags.relationship ?? true });
  if (flags.nearby) ff.push({ flag: "nearby_reachable_enabled", enabled: true });
  if (flags.historyBound) ff.push({ flag: "telegraph_history_bound_enabled", enabled: true });
  const thread = (id: string, thread_type: string, extra: Record<string, unknown> = {}) =>
    ({ id, thread_type, status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false, ...extra });
  return {
    feature_flags: ff,
    message_threads: [
      thread(DM_AB, "direct"), thread(DM_AC, "direct"), thread(GROUP, "group"), thread(DM_BE, "direct"),
      thread(TRIP_PAIR, "trip", { trip_id: TRIP2 }), thread(DM_RB, "direct"),
    ],
    message_thread_members: [
      member(DM_AB, A), member(DM_AB, B),
      member(DM_AC, A), member(DM_AC, C),
      member(GROUP, A), member(GROUP, B), member(GROUP, D),
      member(DM_BE, B), member(DM_BE, E),
      member(TRIP_PAIR, A), member(TRIP_PAIR, B),
      member(DM_RB, R), member(DM_RB, B),
    ],
    blocks: [{ blocker_id: C, blocked_id: A }],
    user_message_settings: [], user_friendships: [], user_follows: [], trip_members: [], circle_memberships: [],
    trust_restrictions: [], trust_profiles: [], user_restrictions: [], user_mutes: [], user_privacy_settings: [],
    profile_privacy_settings: [],
    message_requests: [], event_attendees: [], events: [], rent_buddy_profiles: [], rent_buddy_bookings: [],
    meetups: [], meetup_invites: [], trips: [], messages: [], trip_crew_location_sessions: [],
    telegraph_chat_suggestions: [],
    location_preferences: [], user_location_state: [], user_availability: [], quick_availability_status: [],
    availability_windows: [], nearby_proximity_observations: [],
    profiles: [A, B, C, D, E, R].map((id) => ({ id, handle: id.slice(0, 4), is_private: false, account_status: "active" })),
    ...over,
  };
}

/** The Nearby world of src/test/nearbyReachableRoute.test.ts: B is A's circle member, both sharing, both fresh. */
function nearbyRows(viewer = A): Partial<Record<string, any[]>> {
  const fresh = iso(-60_000);
  return {
    circle_memberships: [{ user_id: viewer, other_id: B }],
    location_preferences: [
      { user_id: viewer, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
      { user_id: B, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
    ],
    user_privacy_settings: [{ user_id: B, allow_location_sharing: true }],
    profile_privacy_settings: [{ user_id: B, allow_profile_discovery: true }],
    user_location_state: [
      { user_id: viewer, lat: LAT, lng: LNG, last_known_at: fresh },
      { user_id: B, lat: LAT + 0.01, lng: LNG + 0.01, last_known_at: fresh },
    ],
    user_availability: [{ user_id: B, open_to_meet: true }],
    quick_availability_status: [{ user_id: B, status: "free_now", expires_at: iso(2 * HOUR) }],
  };
}

let harness: RouterHarness;
before(async () => {
  const r = express.Router();
  r.use(contextRouter);
  r.use(capabilityRouter);
  r.use(coordinationRouter);
  harness = await startRouter(r);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(rows: Record<string, any[]>, opts: FakeDbOptions = {}) {
  const c = makeFakeClient(rows, opts);
  _setTestClient(c, true);
  return c;
}
const ctx = (thread: string, as = A) => call(harness.base, "GET", `/threads/${thread}/context`, as);
const strip = (body: any) => ({ ...body, conversationId: "<id>", generatedAt: "<t>" });

// ── A: the contract ──────────────────────────────────────────────────────────

const relValue = { state: "ACTIVE" as const, origins: ["MUTUAL_FOLLOW" as const], expiredOrigins: [], messagingFloor: "allowed" as const };
const readings = (): KernelInputs => ({
  relationship: readInput(relValue),
  time: readInput({ coordination: null, historyVisibleFrom: null }),
  proximity: readInput({ bucket: "nearby" as const, precision: "bucket" as const, freshness: "live" }),
  intent: readInput({ detected: ["food"] }),
  sharedObjects: readInput({ now: 0, upcoming: 1, unresolved: 0, past: 0, railMode: "COMPACT_UPCOMING" }),
});

describe("A — the contract, pure", () => {
  it("A1 names §30A.19's five inputs in the spec's order", () => {
    assert.deepEqual([...CONTEXT_INPUTS], ["relationship", "time", "proximity", "intent", "sharedObjects"]);
  });

  it("A2 a non-member gets every input withheld, conversation type 'unknown', and nothing degraded", () => {
    const c = composeConversationContext({ conversationId: DM_AB, conversationType: "direct", gate: { kind: "not_member", reason: "TELEGRAPH_AUTH_NOT_MEMBER" }, readings: readings() });
    for (const n of CONTEXT_INPUTS) assert.deepEqual(c.inputs[n], withheldInput("TELEGRAPH_AUTH_NOT_MEMBER"), n);
    assert.equal(c.conversationType, "unknown", "a non-member is not told the conversation's type");
    assert.equal(c.degraded, false);
  });

  it("A3 an unreadable gate degrades every input; nothing is served from a failed read", () => {
    const c = composeConversationContext({ conversationId: DM_AB, conversationType: "direct", gate: { kind: "unreadable", reason: "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE" }, readings: readings() });
    for (const n of CONTEXT_INPUTS) assert.equal(c.inputs[n].status, "degraded", n);
    assert.equal(c.degraded, true);
    assert.deepEqual(c.degradedReasons, ["TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE"]);
  });

  it("A4 a block either way is the MINIMAL context — and on the wire it is a non-member's answer, byte for byte", () => {
    const blocked = composeConversationContext({ conversationId: DM_AB, conversationType: "direct", gate: { kind: "member", pairwise: true, pairBlock: "blocked" }, readings: readings() });
    for (const n of CONTEXT_INPUTS) assert.equal(blocked.inputs[n].status, "withheld", n);
    const stranger = composeConversationContext({ conversationId: DM_AB, conversationType: "direct", gate: { kind: "not_member", reason: "TELEGRAPH_AUTH_NOT_MEMBER" } });
    assert.deepEqual(contextForWire(blocked), contextForWire(stranger), "the wire told a blocked member something a stranger is not told");
    assert.ok(!JSON.stringify(contextForWire(blocked)).includes("BLOCKED"));
  });

  it("A5 a block state that could not be read withholds all five, as unreadable", () => {
    const c = composeConversationContext({ conversationId: DM_AB, conversationType: "direct", gate: { kind: "member", pairwise: true, pairBlock: "unreadable" }, readings: readings() });
    for (const n of CONTEXT_INPUTS) assert.deepEqual(c.inputs[n], withheldInput("TELEGRAPH_DEGRADED_BLOCKS_UNREADABLE"), n);
    assert.equal(c.degraded, true);
  });

  it("A6 a pairwise reading in a conversation that is not pairwise is never served", () => {
    const c = composeConversationContext({ conversationId: GROUP, conversationType: "group", gate: { kind: "member", pairwise: false, pairBlock: "not_applicable" }, readings: readings() });
    assert.deepEqual(c.inputs.relationship, notConsultedInput("KERNEL_PAIRWISE_ONLY"));
    assert.deepEqual(c.inputs.proximity, notConsultedInput("KERNEL_PAIRWISE_ONLY"));
    assert.equal(c.inputs.time.status, "read");
  });

  it("A7 a reading nobody supplied is degraded — never 'read', never 'nothing there'", () => {
    const { intent: _drop, ...rest } = readings();
    const c = composeConversationContext({ conversationId: DM_AB, conversationType: "direct", gate: { kind: "member", pairwise: true, pairBlock: "clear" }, readings: rest });
    assert.deepEqual(c.inputs.intent, degradedInput("KERNEL_SOURCE_UNREADABLE"));
    assert.equal(c.degraded, true);
  });

  it("A8 a relationship the resolver saw as BLOCKED (a race past the gate) withholds all five", () => {
    const r = readings();
    const c = composeConversationContext({
      conversationId: DM_AB, conversationType: "direct", gate: { kind: "member", pairwise: true, pairBlock: "clear" },
      readings: { ...r, relationship: readInput({ ...relValue, state: "BLOCKED" as const, origins: [], messagingFloor: "denied" as const }) },
    });
    for (const n of CONTEXT_INPUTS) assert.equal(c.inputs[n].status, "withheld", n);
    assert.equal(c.conversationType, "unknown");
  });

  it("A9 the wire copies named fields only: the policy's messagingFloor and anything a reader added stay behind", () => {
    const r = readings();
    const smuggled = { ...r, proximity: readInput({ bucket: "nearby" as const, precision: "bucket" as const, freshness: "live", lat: LAT, lng: LNG } as any) };
    const wire = contextForWire(composeConversationContext({ conversationId: DM_AB, conversationType: "direct", gate: { kind: "member", pairwise: true, pairBlock: "clear" }, readings: smuggled }));
    const s = JSON.stringify(wire);
    assert.ok(!s.includes("messagingFloor"), "the policy's term reached the wire");
    assert.ok(!s.includes(String(LAT)) && !/"(lat|lng)"/.test(s), `a coordinate reached the wire: ${s}`);
    assert.deepEqual(wire.inputs.proximity.value, { bucket: "nearby", precision: "bucket", freshness: "live" });
  });

  it("A10 kernelCallTerm: only a read term refuses, and only where the call door would", () => {
    assert.deepEqual(kernelCallTerm(readInput(relValue)), { refusal: null, degraded: false });
    assert.deepEqual(kernelCallTerm(readInput({ ...relValue, messagingFloor: "requires_request" as const })), { refusal: "TELEGRAPH_POLICY_RECIPIENT_PRIVACY", degraded: false });
    assert.deepEqual(kernelCallTerm(readInput({ ...relValue, messagingFloor: "denied" as const })), { refusal: "TELEGRAPH_POLICY_RECIPIENT_PRIVACY", degraded: false });
    assert.deepEqual(kernelCallTerm(readInput({ ...relValue, state: "BLOCKED" as const, messagingFloor: "denied" as const })), { refusal: "TELEGRAPH_AUTH_BLOCKED", degraded: false });
    assert.deepEqual(kernelCallTerm(degradedInput("KERNEL_SOURCE_UNREADABLE")), { refusal: "TELEGRAPH_DEGRADED_RELATIONSHIP_UNREADABLE", degraded: true });
    assert.deepEqual(kernelCallTerm(notConsultedInput("KERNEL_SOURCE_OFF")), { refusal: null, degraded: false });
  });
});

// ── K: the route ─────────────────────────────────────────────────────────────

describe("K — GET /threads/:threadId/context, the flag and the gate", () => {
  it("K1 flag OFF: feature_disabled, and NOTHING but the flag is read", async () => {
    const c = use(world({ kernel: false }));
    const r = await ctx(DM_AB);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "feature_disabled");
    const tables = new Set(c._observed.selects.map((s) => s.table));
    tables.delete("profiles"); // requireUser's account-state gate
    assert.deepEqual([...tables], ["feature_flags"], `the OFF kernel read ${[...tables].join(", ")}`);
  });

  it("K1b no flag row at all (3826 unapplied): feature_disabled", async () => {
    use(world({ kernel: null }));
    assert.equal((await ctx(DM_AB)).body.error, "feature_disabled");
  });

  it("K2 an unreadable flag is 503, never either answer", async () => {
    use(world(), { errors: { feature_flags: { message: "connection reset" } } });
    const r = await ctx(DM_AB);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("K3 a non-member gets 200, every input withheld, type 'unknown' — the same body as a conversation that does not exist", async () => {
    use(world());
    const notMine = await ctx(DM_BE);
    assert.equal(notMine.status, 200, JSON.stringify(notMine.body));
    for (const n of CONTEXT_INPUTS) {
      assert.deepEqual(notMine.body.inputs[n], { status: "withheld", reason: "TELEGRAPH_AUTH_NOT_MEMBER", value: null }, n);
    }
    assert.equal(notMine.body.conversationType, "unknown");
    const missing = await ctx(MISSING);
    assert.deepEqual(strip(missing.body), strip(notMine.body), "the endpoint is a thread-existence oracle");
  });

  it("K4 a block either way is the minimal context, redacted — a stranger's body — and no input is read", async () => {
    const c = use(world());
    const blocked = await ctx(DM_AC);
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    const stranger = await ctx(DM_BE);
    assert.deepEqual(strip(blocked.body), strip(stranger.body), "a blocked member is told something a stranger is not");
    assert.ok(!JSON.stringify(blocked.body).includes("BLOCKED"));
    for (const t of ["meetups", "telegraph_chat_suggestions", "trip_members", "event_attendees", "location_preferences"]) {
      assert.ok(!c._observed.selects.some((s) => s.table === t), `an input (${t}) was read across a block`);
    }
  });

  it("K5 the block read failing — returned OR thrown — withholds all five as unreadable", async () => {
    use(world(), { errors: { blocks: { message: "statement timeout" } } });
    const returned = await ctx(DM_AB);
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    for (const n of CONTEXT_INPUTS) assert.deepEqual(returned.body.inputs[n], { status: "withheld", reason: "TELEGRAPH_DEGRADED_BLOCKS_UNREADABLE", value: null }, n);
    assert.equal(returned.body.degraded, true);

    use(world(), { onRead: (table) => { if (table === "blocks") throw new Error("client torn down"); } });
    const thrown = await ctx(DM_AB);
    assert.equal(thrown.status, 200, `a THROWN block read escaped as ${thrown.status}`);
    assert.deepEqual(strip(thrown.body), strip(returned.body));
  });

  it("K6 an unreadable roster is not 'no other members': every input degraded", async () => {
    use(world(), { errors: { message_thread_members: { message: "down", afterOps: 1 } } });
    const r = await ctx(DM_AB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const n of CONTEXT_INPUTS) assert.equal(r.body.inputs[n].status, "degraded", n);
    assert.deepEqual(r.body.degradedReasons, ["TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE"]);
  });

  it("K7 a member who LEFT gets the non-member shape", async () => {
    const rows = world();
    rows.message_thread_members = rows.message_thread_members!.map((m) => (m.thread_id === DM_AB && m.user_id === A ? { ...m, left_at: iso(-HOUR) } : m));
    use(rows);
    const r = await ctx(DM_AB);
    for (const n of CONTEXT_INPUTS) assert.equal(r.body.inputs[n].status, "withheld", n);
    assert.equal(r.body.conversationType, "unknown");
  });

  it("K8 malformed id 400, no token 401", async () => {
    use(world());
    assert.equal((await ctx("not-a-uuid")).status, 400);
    const res = await fetch(`${harness.base}/threads/${DM_AB}/context`);
    assert.equal(res.status, 401);
  });
});

describe("K — each input: read, degraded, not consulted, withheld", () => {
  it("K10 relationship: §30A.1's state and origins for a direct conversation; the policy's floor never on the wire", async () => {
    use(world({}, { user_follows: [{ follower_id: A, following_id: B }, { follower_id: B, following_id: A }] }));
    const r = await ctx(DM_AB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.inputs.relationship, { status: "read", reason: null, value: { state: "ACTIVE", origins: ["MUTUAL_FOLLOW"], expiredOrigins: [] } });
    assert.ok(!JSON.stringify(r.body).includes("messagingFloor"));
    assert.equal(r.body.conversationType, "direct");
  });

  it("K11 relationship: its own flag OFF is not_consulted, and none of its tables is read", async () => {
    const c = use(world({ relationship: false }));
    const r = await ctx(DM_AB);
    assert.deepEqual(r.body.inputs.relationship, { status: "not_consulted", reason: "KERNEL_SOURCE_OFF", value: null });
    for (const t of ["message_requests", "user_message_settings", "user_friendships", "user_follows"]) { // the relationship's own reads; the rail reads event_attendees itself
      assert.ok(!c._observed.selects.some((s) => s.table === t), `${t} was read with the relationship off`);
    }
  });

  it("K12 relationship: a failed read is degraded, never a floor; an unreadable flag too", async () => {
    use(world(), { errors: { event_attendees: { message: "connection reset" } } });
    let r = await ctx(DM_AB);
    assert.deepEqual(r.body.inputs.relationship, { status: "degraded", reason: "KERNEL_SOURCE_UNREADABLE", value: null });
    assert.equal(r.body.degraded, true);
    // The kernel's own flag (the first feature_flags read) answers; every later flag read fails.
    use(world(), { errors: { feature_flags: { message: "connection reset", afterOps: 1 } } });
    r = await ctx(DM_AB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inputs.relationship.status, "degraded", "an unreadable relationship flag was read as off");
  });

  it("K13 a group conversation: relationship and proximity not consulted; time, intent, shared objects read", async () => {
    const c = use(world({ nearby: true }));
    const r = await ctx(GROUP);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.inputs.relationship, { status: "not_consulted", reason: "KERNEL_PAIRWISE_ONLY", value: null });
    assert.deepEqual(r.body.inputs.proximity, { status: "not_consulted", reason: "KERNEL_PAIRWISE_ONLY", value: null });
    for (const n of ["time", "intent", "sharedObjects"]) assert.equal(r.body.inputs[n].status, "read", n);
    assert.ok(!c._observed.selects.some((s) => s.table === "location_preferences"), "Nearby was polled for a group");
    // Two people, but not a DIRECT conversation (a trip thread of A and B): still not pairwise.
    const pair = await ctx(TRIP_PAIR);
    assert.equal(pair.status, 200, JSON.stringify(pair.body));
    assert.deepEqual(pair.body.inputs.relationship, { status: "not_consulted", reason: "KERNEL_PAIRWISE_ONLY", value: null });
    assert.deepEqual(pair.body.inputs.proximity, { status: "not_consulted", reason: "KERNEL_PAIRWISE_ONLY", value: null });
  });

  it("K14 time: the plan the coordination route chooses, §9's derived state, and the viewer's own §14.3 window", async () => {
    const meetups = [
      { id: PLAN_PAST, title: "Brunch", chat_thread_id: DM_AB, starts_at: iso(-30 * HOUR), ends_at: iso(-28 * HOUR), status: "active" },
      { id: PLAN_LATER, title: "Hike", chat_thread_id: DM_AB, starts_at: iso(48 * HOUR), ends_at: iso(52 * HOUR), status: "active" },
      { id: PLAN_NEXT, title: "Dinner", chat_thread_id: DM_AB, starts_at: iso(30 * 60_000), ends_at: iso(3 * HOUR), status: "active" },
    ];
    const bound = iso(-5 * HOUR);
    const rows = world({ historyBound: true }, { meetups });
    rows.message_thread_members = rows.message_thread_members!.map((m) => (m.thread_id === DM_AB && m.user_id === A ? { ...m, visible_from_at: bound } : m));
    use(rows);
    const r = await ctx(DM_AB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = r.body.inputs.time;
    assert.equal(t.status, "read");
    assert.equal(t.value.coordination.planId, PLAN_NEXT);
    assert.equal(t.value.coordination.state, "ASSEMBLING", "30 minutes out is inside the 45-minute leave-by");
    assert.equal(t.value.coordination.coordinating, true);
    assert.equal(Date.parse(t.value.historyVisibleFrom), Date.parse(bound));
    assert.ok(!JSON.stringify(t).includes("Dinner"), "the kernel restates the plan's id and timeline, not its content");

    const coord = await call(harness.base, "GET", `/threads/${DM_AB}/coordination`, A);
    assert.equal(coord.status, 200, JSON.stringify(coord.body));
    assert.equal(coord.body.coordination.plan.objectId, t.value.coordination.planId, "the kernel and GET /coordination chose different plans");
    assert.equal(coord.body.coordination.state, t.value.coordination.state);
    assert.equal(coord.body.coordination.plan.leaveByAt, t.value.coordination.leaveByAt);
  });

  it("K15 time: with every plan over, the latest is the plan — as GET /coordination has it; the §14.3 bound OFF is null and never named", async () => {
    const meetups = [
      { id: PLAN_PAST, title: "Brunch", chat_thread_id: DM_AB, starts_at: iso(-30 * HOUR), ends_at: iso(-28 * HOUR), status: "active" },
      { id: PLAN_NEXT, title: "Dinner", chat_thread_id: DM_AB, starts_at: iso(-10 * HOUR), ends_at: iso(-8 * HOUR), status: "active" },
    ];
    const c = use(world({}, { meetups }));
    const r = await ctx(DM_AB);
    assert.equal(r.body.inputs.time.value.coordination.planId, PLAN_NEXT);
    assert.equal(r.body.inputs.time.value.coordination.state, "COMPLETE");
    assert.equal(r.body.inputs.time.value.historyVisibleFrom, null);
    assert.ok(!c._observed.selects.some((s) => s.table === "message_thread_members" && s.sel.includes("visible_from_at")),
      "with the §14.3 flag off the window column was named");
    const coord = await call(harness.base, "GET", `/threads/${DM_AB}/coordination`, A);
    assert.equal(coord.body.coordination.plan.objectId, PLAN_NEXT);
  });

  it("K16 time: an unreadable plan read is degraded; the other inputs still answer", async () => {
    use(world(), { errors: { meetups: { message: "down" } } });
    const r = await ctx(GROUP);
    assert.deepEqual(r.body.inputs.time, { status: "degraded", reason: "KERNEL_SOURCE_UNREADABLE", value: null });
    assert.equal(r.body.inputs.intent.status, "read");
  });

  it("K17 an input whose read THROWS is that input's unknown — not a 500 for the whole answer", async () => {
    use(world(), { onRead: (t) => { if (t === "telegraph_chat_suggestions") throw new Error("socket hang up"); } });
    const r = await ctx(GROUP);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.inputs.intent, { status: "degraded", reason: "KERNEL_SOURCE_UNREADABLE", value: null });
    assert.equal(r.body.inputs.time.status, "read");
  });

  it("K18 intent: the viewer's own live suggestions in this conversation, newest first, each once, vocabulary only", async () => {
    const s = (over: Record<string, unknown>) => ({ id: crypto.randomUUID(), thread_id: GROUP, user_id: A, status: "shown", expires_at: iso(HOUR), ...over });
    use(world({}, {
      telegraph_chat_suggestions: [
        s({ intent_type: "food", created_at: iso(-3 * 60_000) }),
        s({ intent_type: "nightlife", created_at: iso(-1 * 60_000) }),
        s({ intent_type: "food", created_at: iso(-2 * 60_000) }),
        s({ intent_type: "beach", created_at: iso(-4 * 60_000), expires_at: iso(-60_000) }),
        s({ intent_type: "transport", created_at: iso(-5 * 60_000), status: "dismissed" }),
        s({ intent_type: "attraction", created_at: iso(-6 * 60_000), user_id: B }),
        s({ intent_type: "time_poll", created_at: iso(-7 * 60_000), thread_id: DM_AB }),
        s({ intent_type: "drop table", created_at: iso(-8 * 60_000) }),
      ],
    }));
    const r = await ctx(GROUP);
    assert.deepEqual(r.body.inputs.intent, { status: "read", reason: null, value: { detected: ["nightlife", "food"] } });
  });

  it("K19 shared objects: §3's rail counted; a rail with a failed resolver is degraded, not smaller", async () => {
    const rows = world({}, {
      trip_members: [{ trip_id: TRIP1, user_id: A, status: "accepted", role: "member" }, { trip_id: TRIP1, user_id: B, status: "accepted", role: "member" }],
      trips: [{ id: TRIP1, owner_id: A, title: "Porto", start_date: iso(10 * 24 * HOUR).slice(0, 10), end_date: iso(14 * 24 * HOUR).slice(0, 10), status: "planning" }],
    });
    use(rows);
    const r = await ctx(DM_AB);
    assert.deepEqual(r.body.inputs.sharedObjects, { status: "read", reason: null, value: { now: 0, upcoming: 1, unresolved: 0, past: 0, railMode: "COMPACT_UPCOMING" } });
    use(rows, { errors: { meetup_invites: { message: "down" } } });
    assert.deepEqual((await ctx(DM_AB)).body.inputs.sharedObjects, { status: "degraded", reason: "KERNEL_SOURCE_UNREADABLE", value: null });
  });
});

describe("K — proximity is Nearby's answer, narrowed to one person", () => {
  it("K20 Nearby OFF: not consulted, and Nearby is not polled", async () => {
    const c = use(world({}, nearbyRows()));
    const r = await ctx(DM_AB);
    assert.deepEqual(r.body.inputs.proximity, { status: "not_consulted", reason: "KERNEL_SOURCE_OFF", value: null });
    assert.ok(!c._observed.selects.some((s) => s.table === "user_location_state"));
  });

  it("K21 Nearby ON: a bucket and nothing finer — no coordinate anywhere in the answer — and the observation is RECORDED", async () => {
    const c = use(world({ nearby: true }, nearbyRows()));
    const r = await ctx(DM_AB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.inputs.proximity, { status: "read", reason: null, value: { bucket: "same_area", precision: "bucket", freshness: "live" } });
    const s = JSON.stringify(r.body);
    for (const n of [LAT, LNG, LAT + 0.01, LNG + 0.01]) assert.ok(!s.includes(String(n)), `a coordinate reached the wire: ${n}`);
    assert.ok(!/"(lat|lng|latitude|longitude|distanceKm|etaMinutes)"/.test(s), s);
    const recorded = (c._store.nearby_proximity_observations ?? []).filter((o: any) => o.viewer_id === A && o.subject_id === B);
    assert.equal(recorded.length, 1, "a bucket was served without the observation budget recording it");
    assert.equal(recorded[0].bucket, "same_area");
  });

  it("K22 the observation budget decides: inside the interval the RECORDED bucket is served, not the fresh one", async () => {
    use(world({ nearby: true }, {
      ...nearbyRows(),
      nearby_proximity_observations: [{ viewer_id: A, subject_id: B, bucket: "far", travel: "out_of_range", freshness: "live", observed_at: iso(-60_000) }],
    }));
    const r = await ctx(DM_AB);
    assert.equal(r.body.inputs.proximity.value?.bucket, "far", "the kernel served proximity past Nearby's budget");
  });

  it("K23 the budget unreadable is degraded — never a bucket served unrecorded", async () => {
    use(world({ nearby: true }, nearbyRows()), { errors: { nearby_proximity_observations: { message: 'relation "nearby_proximity_observations" does not exist', code: "42P01" } } });
    assert.deepEqual((await ctx(DM_AB)).body.inputs.proximity, { status: "degraded", reason: "KERNEL_SOURCE_UNREADABLE", value: null });
  });

  it("K24 invisible mode withholds proximity — the VIEWER's own, and the other person's — with one undifferentiated reason", async () => {
    const mine = nearbyRows();
    mine.location_preferences = mine.location_preferences!.map((p) => (p.user_id === A ? { ...p, sharing_paused: true } : p));
    use(world({ nearby: true }, mine));
    assert.deepEqual((await ctx(DM_AB)).body.inputs.proximity, { status: "withheld", reason: "KERNEL_NOT_SHOWN", value: null });
    const theirs = nearbyRows();
    theirs.location_preferences = theirs.location_preferences!.map((p) => (p.user_id === B ? { ...p, location_mode: "off" } : p));
    use(world({ nearby: true }, theirs));
    assert.deepEqual((await ctx(DM_AB)).body.inputs.proximity, { status: "withheld", reason: "KERNEL_NOT_SHOWN", value: null });
  });

  it("K25 a person who is not one of the viewer's graph candidates is never located, whatever their consent", async () => {
    const rows = nearbyRows();
    rows.circle_memberships = []; // B shares, is fresh and consents — but is not in A's circle or crew
    use(world({ nearby: true }, rows));
    assert.deepEqual((await ctx(DM_AB)).body.inputs.proximity, { status: "withheld", reason: "KERNEL_NOT_SHOWN", value: null });
  });

  it("K26 the kernel spends Nearby's own rate limit: a viewer who has spent it gets no bucket", async () => {
    for (let i = 0; i < 20; i++) checkRateLimit("nearby_reachable", R, 20, 60_000);
    use(world({ nearby: true }, nearbyRows(R)));
    assert.deepEqual((await ctx(DM_RB, R)).body.inputs.proximity, { status: "withheld", reason: "KERNEL_RATE_LIMITED", value: null });
  });
});

// ── P: the policy's relationship term ────────────────────────────────────────

/** B accepts direct messages from friends only, and takes requests: A (no relationship) is `requires_request`. */
const friendsOnly = { user_message_settings: [{ user_id: B, message_privacy: "friends", allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false }] };

describe("P — the relationship term changes a capability only with the kernel ON, and then agrees with the call door", () => {
  it("P1 kernel OFF: canCall is granted where the call door refuses — today's divergence, left exactly as it is", async () => {
    const c = use(world({ kernel: false }, friendsOnly));
    const r = await resolveConversationCapabilities(asSc(c), { viewerId: A, conversationId: DM_AB });
    assert.equal(r.capabilities.canCall, true);
    assert.equal(await makeCallGateway(asSc(c)).canMessage(A, B, DM_AB), false, "fixture: the door's messaging floor must refuse");
    for (const t of ["event_attendees", "message_requests", "rent_buddy_profiles", "meetup_invites"]) {
      assert.ok(!c._observed.selects.some((s) => s.table === t), `the OFF policy read ${t}`);
    }
  });

  it("P2 kernel ON (and the relationship ON): canCall refused with the recipient-privacy reason — the door's answer", async () => {
    const c = use(world({}, friendsOnly));
    const r = await resolveConversationCapabilities(asSc(c), { viewerId: A, conversationId: DM_AB });
    assert.equal(r.capabilities.canCall, false);
    assert.equal(r.reasons.canCall, "TELEGRAPH_POLICY_RECIPIENT_PRIVACY");
    assert.equal(r.capabilities.canSendMessage, true, "the term is an input to canCall only; it replaces no other input");
    assert.equal(r.degraded, false);
  });

  it("P3 kernel OFF and ON give byte-identical answers wherever the term grants", async () => {
    const off = await resolveConversationCapabilities(asSc(use(world({ kernel: false }))), { viewerId: A, conversationId: DM_AB });
    const on = await resolveConversationCapabilities(asSc(use(world())), { viewerId: A, conversationId: DM_AB });
    assert.deepEqual(on, off);
    assert.equal(on.capabilities.canCall, true);
  });

  it("P4 the relationship's own flag OFF: the term is not consulted and canCall is unchanged", async () => {
    const c = use(world({ relationship: false }, friendsOnly));
    const r = await resolveConversationCapabilities(asSc(c), { viewerId: A, conversationId: DM_AB });
    assert.equal(r.capabilities.canCall, true);
    assert.ok(!c._observed.selects.some((s) => s.table === "event_attendees"));
  });

  it("P5 a term that cannot be read: canCall false AND degraded — never a grant, never a confident refusal", async () => {
    const c = use(world(), { errors: { rent_buddy_profiles: { message: "down" } } });
    const r = await resolveConversationCapabilities(asSc(c), { viewerId: A, conversationId: DM_AB });
    assert.equal(r.capabilities.canCall, false);
    assert.equal(r.reasons.canCall, "TELEGRAPH_DEGRADED_RELATIONSHIP_UNREADABLE");
    assert.equal(r.degraded, true);
    assert.ok(r.degradedReasons.includes("TELEGRAPH_DEGRADED_RELATIONSHIP_UNREADABLE"));
  });

  it("P5b a term whose read THROWS is the same unknown: false + degraded, never a 500 out of the policy", async () => {
    const c = use(world(), { onRead: (t) => { if (t === "event_attendees") throw new Error("socket hang up"); } });
    const r = await resolveConversationCapabilities(asSc(c), { viewerId: A, conversationId: DM_AB });
    assert.equal(r.capabilities.canCall, false);
    assert.equal(r.reasons.canCall, "TELEGRAPH_DEGRADED_RELATIONSHIP_UNREADABLE");
    assert.equal(r.degraded, true);
  });

  it("P6 not a direct conversation — a group, or a two-person trip thread — the term is never read (group calls have no messaging floor)", async () => {
    for (const thread of [GROUP, TRIP_PAIR]) {
      const c = use(world({}, friendsOnly));
      const r = await resolveConversationCapabilities(asSc(c), { viewerId: A, conversationId: thread });
      assert.equal(r.capabilities.canCall, true, thread);
      assert.ok(!c._observed.selects.some((s) => s.table === "event_attendees"), `the term was read for ${thread}`);
    }
  });

  it("P7 across a block the term is not read — the block input already refuses", async () => {
    const c = use(world({}, friendsOnly));
    const r = await resolveConversationCapabilities(asSc(c), { viewerId: A, conversationId: DM_AC });
    assert.equal(r.reasons.canCall, "TELEGRAPH_AUTH_BLOCKED");
    assert.ok(!c._observed.selects.some((s) => s.table === "event_attendees"));
  });

  it("P8 GET /threads/:id/capabilities serves the kernel's term (the route consumes it through the policy)", async () => {
    use(world({}, friendsOnly));
    const on = await call(harness.base, "GET", `/threads/${DM_AB}/capabilities`, A);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.capabilities.canCall, false);
    assert.equal(on.body.reasons.canCall, "TELEGRAPH_POLICY_RECIPIENT_PRIVACY");
    use(world({ kernel: false }, friendsOnly));
    const off = await call(harness.base, "GET", `/threads/${DM_AB}/capabilities`, A);
    assert.equal(off.body.capabilities.canCall, true);
  });

  it("P9 AGREEMENT: across every message-privacy setting and relationship, the ON projection's canCall IS the call door's messaging floor", async () => {
    const settings = ["everyone", "friends", "followers", "following", "trip_members", "no_one"];
    const relationships: Array<[string, Partial<Record<string, any[]>>]> = [
      ["none", {}],
      ["friends", { user_friendships: [{ user_a: A, user_b: B }] }],
      ["A follows B", { user_follows: [{ follower_id: A, following_id: B }] }],
      ["B follows A", { user_follows: [{ follower_id: B, following_id: A }] }],
      ["shared trip", { trip_members: [{ trip_id: TRIP1, user_id: A, role: "member", status: "accepted" }, { trip_id: TRIP1, user_id: B, role: "member", status: "accepted" }] }],
      ["shared circle", { circle_memberships: [{ user_id: B, other_id: A }] }],
    ];
    let refused = 0;
    let granted = 0;
    for (const privacy of settings) {
      for (const [label, rel] of relationships) {
        const rows = world({}, { ...rel, user_message_settings: [{ user_id: B, message_privacy: privacy, allow_message_requests: true, allow_trip_member_messages: privacy === "trip_members", allow_circle_member_messages: true }] });
        const door = await makeCallGateway(asSc(makeFakeClient(rows))).canMessage(A, B, DM_AB);
        const r = await resolveConversationCapabilities(asSc(use(rows)), { viewerId: A, conversationId: DM_AB });
        assert.equal(r.capabilities.canCall, door, `${privacy} × ${label}: projection ${r.capabilities.canCall}, door ${door}`);
        if (door) granted++; else refused++;
      }
    }
    assert.ok(granted > 0 && refused > 0, `the matrix must exercise both answers (granted ${granted}, refused ${refused})`);
  });
});
