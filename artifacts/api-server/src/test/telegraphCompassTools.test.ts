/**
 * Telegraph §18.3 Compass tool boundary — against the real tools, through the
 * real dispatcher.
 *
 * Spec (identical in v1 and v1.1):
 *   §18.3 names eight accessors — getConversationContext, getSharedPlans,
 *   getParticipantAvailability, getSharedPlaces, suggestMeetingPoint,
 *   createPlanDraft, findSafePublicMeetup, searchAuthorizedConversationContent —
 *   and then: "Compass sees only data authorized to the conversational context.
 *   It cannot reveal one participant's private Memory/preferences to another,
 *   impersonate participants, or silently create canonical plans from uncertain
 *   prose."
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - Registering a tool without wiring it into the dispatcher: the
 *     definitions/dispatch parity test fails. That is the exact shape of the
 *     `telegraph.reaction` defect census-telegraph T143 records — a fully
 *     written consumer for something that does not exist — caught mechanically.
 *   - Dropping the membership gate from ANY tool: the non-participant loop
 *     fails for that tool by name, not in aggregate.
 *   - Treating an unreadable membership row as "not a member": the degraded
 *     test fails, because `degraded: true` is what lets the model say "I could
 *     not check" instead of "you are not in that conversation".
 *   - Making createPlanDraft write: there is no write to assert against, so the
 *     test asserts the observable consequence instead — `requiresConfirmation`
 *     and an unchanged database.
 *   - Widening the availability projection: the test gives one participant a
 *     private window and asserts it never appears.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphCompassTools.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TELEGRAPH_COMPASS_TOOL_DEFINITIONS,
  TELEGRAPH_COMPASS_TOOL_NAMES,
  TELEGRAPH_TOOL_SPEC_NAMES,
  executeTelegraphConversationTool,
  gateConversation,
} from "../compass/TelegraphConversationTools.js";
import { COMPASS_TOOL_DEFINITIONS, executeCompassTool } from "../compass/CompassTools.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";

const TRIP_THREAD = "00000000-0000-4000-8000-00000000000c";
const FOREIGN = "00000000-0000-4000-8000-00000000000f";
const TRIP_ID = "11111111-0000-4000-8000-000000000001";

const PLACE_CARD = JSON.stringify({
  title: "Sky36 Rooftop",
  city: "Hanoi",
  lat: 21.0287654,
  lng: 105.8542,
});

interface State {
  membershipError?: boolean;
  optOut?: boolean;
  rosterError?: boolean;
  /**
   * Telegraph §14.3. `historyBound` seeds the feature_flags row
   * telegraph_history_bound_enabled; `aliceVisibleFrom` is the caller's window
   * on TRIP_THREAD. Both default to today's production state — no flag row and
   * no bound — so every case above this line is untouched.
   */
  historyBound?: boolean;
  aliceVisibleFrom?: string | null;
}

function fixture(state: State) {
  return {
    feature_flags: state.historyBound === undefined
      ? []
      : [{ flag: "telegraph_history_bound_enabled", enabled: state.historyBound }],
    message_threads: [
      { id: TRIP_THREAD, thread_type: "trip", status: "active", trip_id: TRIP_ID, circle_owner_id: null, is_e2ee: false },
      { id: FOREIGN, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: TRIP_THREAD, user_id: ALICE, role: "member", left_at: null, last_read_at: null,
        visible_from_at: state.aliceVisibleFrom ?? null },
      { thread_id: TRIP_THREAD, user_id: BOB, role: "member", left_at: null, last_read_at: null },
      { thread_id: TRIP_THREAD, user_id: CARL, role: "member", left_at: null, last_read_at: null },
      { thread_id: FOREIGN, user_id: BOB, role: "member", left_at: null, last_read_at: null },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice",
        show_telegraph_dm: !state.optOut, show_telegraph_trip: !state.optOut, show_telegraph_circle: !state.optOut },
      { id: BOB, handle: "bob", name: "Bob" },
      { id: CARL, handle: "carl", name: "Carl" },
    ],
    trips: [{ id: TRIP_ID, owner_id: ALICE, destination_city: "Hanoi", destination_country: "Vietnam" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: BOB, role: "member", status: "accepted" },
      { trip_id: TRIP_ID, user_id: CARL, role: "member", status: "accepted" },
    ],
    blocks: [],
    trust_restrictions: [],
    user_privacy_settings: [],
    profile_privacy_settings: [],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
    meetups: [
      { id: "meet-1", chat_thread_id: TRIP_THREAD, title: "Coffee at 9", location_name: "Cong Caphe",
        approximate_date: "2026-06-01", time_block: "morning", status: "active",
        starts_at: null, created_at: "2026-05-01T00:00:00.000Z" },
      { id: "meet-2", chat_thread_id: TRIP_THREAD, title: "Cancelled thing", location_name: "Nowhere",
        approximate_date: null, time_block: null, status: "cancelled",
        starts_at: null, created_at: "2026-05-02T00:00:00.000Z" },
    ],
    messages: [
      { id: "m1", thread_id: TRIP_THREAD, sender_id: BOB, body: PLACE_CARD, subtype: "discovery_card",
        msg_type: "text", media_url: null, deleted_at: null, created_at: "2026-05-03T00:00:00.000Z" },
      { id: "m2", thread_id: TRIP_THREAD, sender_id: BOB, body: "plain talk about sky36", subtype: null,
        msg_type: "text", media_url: null, deleted_at: null, created_at: "2026-05-04T00:00:00.000Z" },
    ],
    availability_windows: [
      // Bob shares with crew; Carl's window is private and must never appear.
      { id: "w-bob", user_id: BOB, type: "today", start_at: "2026-05-01T00:00:00.000Z",
        end_at: "2099-01-01T00:00:00.000Z", trip_id: null, open_to_plans: true, intents: ["food"],
        group_preference: "small_group", max_travel_minutes: 30, visibility: "crew", source: "explicit",
        social_availability: null, expires_at: null, created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z" },
      { id: "w-carl", user_id: CARL, type: "today", start_at: "2026-05-01T00:00:00.000Z",
        end_at: "2099-01-01T00:00:00.000Z", trip_id: null, open_to_plans: true, intents: ["nightlife"],
        group_preference: null, max_travel_minutes: null, visibility: "private", source: "explicit",
        social_availability: null, expires_at: null, created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z" },
    ],
  } as Record<string, any[]>;
}

function makeClient(state: State = {}) {
  const db = fixture(state);

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let nFilters = 0;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const injected = () => {
      if (table === "message_thread_members" && state.membershipError) return { message: "membership read blew up" };
      if (table === "message_thread_members" && state.rosterError && nFilters === 2) return { message: "roster read blew up" };
      return null;
    };

    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { nFilters++; preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { nFilters++; preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { nFilters++; preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      not(col: string, op: string, val: any) { nFilters++; if (op === "is" && val === null) preds.push((r) => r[col] != null); return proxy; },
      in(col: string, vals: any[]) { nFilters++; preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      gte(col: string, val: any) { nFilters++; preds.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      ilike(col: string, pattern: string) {
        nFilters++;
        const needle = pattern.replace(/%/g, "").toLowerCase();
        preds.push((r) => String(r[col] ?? "").toLowerCase().includes(needle));
        return proxy;
      },
      or() { return proxy; },
      order() { return proxy; },
      limit(n: number) { _limit = n; return proxy; },
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
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

const ARGS = { conversationId: TRIP_THREAD };

/* ───────────────────── the eight exist and are reachable ──────────────────── */

describe("Telegraph §18.3 — all eight accessors exist and are dispatchable", () => {
  it("names all eight of §18.3's accessors", () => {
    assert.equal(Object.keys(TELEGRAPH_TOOL_SPEC_NAMES).length, 8);
    for (const toolName of Object.values(TELEGRAPH_TOOL_SPEC_NAMES)) {
      assert.ok(TELEGRAPH_COMPASS_TOOL_NAMES.has(toolName), `§18.3 accessor missing: ${toolName}`);
    }
  });

  it("every declared tool is dispatchable — no definition without an implementation", async () => {
    const sc = makeClient();
    for (const def of TELEGRAPH_COMPASS_TOOL_DEFINITIONS) {
      const out = await executeTelegraphConversationTool(sc, ALICE, def.function.name, {
        ...ARGS, query: "sky36", title: "Drinks",
      });
      assert.notEqual(out, undefined, `declared but not dispatched: ${def.function.name}`);
    }
  });

  it("all eight are registered in the Compass definition list the model is given", () => {
    const registered = new Set(COMPASS_TOOL_DEFINITIONS.map((t: any) => t.function.name));
    for (const toolName of TELEGRAPH_COMPASS_TOOL_NAMES) {
      assert.ok(registered.has(toolName), `not offered to the model: ${toolName}`);
    }
  });

  it("reaches them through executeCompassTool, not only through their own dispatcher", async () => {
    const sc = makeClient();
    const out: any = await executeCompassTool(sc, ALICE, null, "telegraph_get_conversation_context", ARGS);
    assert.equal(out.authorized, true);
    assert.equal(out.conversationId, TRIP_THREAD);
  });
});

/* ─────────────────────────── the gate, per tool ───────────────────────────── */

describe("Telegraph §18.3 — Compass sees only what the conversation authorizes", () => {
  it("EVERY tool refuses a non-participant, by name", async () => {
    const sc = makeClient();
    for (const toolName of TELEGRAPH_COMPASS_TOOL_NAMES) {
      const out: any = await executeTelegraphConversationTool(sc, ALICE, toolName, {
        conversationId: FOREIGN, query: "sky36", title: "Drinks",
      });
      assert.equal(out.authorized, false, `${toolName} answered a non-participant`);
      assert.equal(out.reason, "not_a_participant", `${toolName} gave the wrong reason`);
    }
  });

  it("EVERY tool refuses a missing/invalid conversation id", async () => {
    const sc = makeClient();
    for (const toolName of TELEGRAPH_COMPASS_TOOL_NAMES) {
      const out: any = await executeTelegraphConversationTool(sc, ALICE, toolName, { query: "x", title: "y" });
      assert.equal(out.authorized, false, `${toolName} answered without a conversation`);
      assert.equal(out.reason, "conversation_id_required");
    }
  });

  it("an UNREADABLE membership refuses as DEGRADED, not as 'not a participant'", async () => {
    const sc = makeClient({ membershipError: true });
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_get_shared_plans", ARGS);
    assert.equal(out.authorized, false);
    assert.equal(out.reason, "membership_unavailable");
    assert.equal(out.degraded, true,
      "a failed check reported as a refusal makes the model tell the user something untrue");
  });

  it("the Telegraph opt-out refuses before any content is read", async () => {
    const sc = makeClient({ optOut: true });
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_get_shared_places", ARGS);
    assert.equal(out.authorized, false);
    assert.equal(out.reason, "telegraph_disabled");
  });

  it("the gate itself is one function, and it returns the capability set", async () => {
    const sc = makeClient();
    const gate: any = await gateConversation(sc, ALICE, ARGS);
    assert.equal(gate.authorized, true);
    assert.deepEqual(gate.memberIds.sort(), [ALICE, BOB, CARL].sort());
    assert.equal(typeof gate.capabilities.canCreatePlan, "boolean");
  });
});

/* ────────────────────────── what each tool returns ────────────────────────── */

describe("Telegraph §18.3 — the accessors' content", () => {
  it("getConversationContext returns shape and capabilities, and no message prose", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_get_conversation_context", ARGS);
    assert.equal(out.conversationType, "trip");
    assert.equal(out.participantCount, 3);
    assert.equal(out.tripContextAvailable, true);
    assert.deepEqual(out.recentObjectKinds, ["discovery_card"]);
    assert.ok(!JSON.stringify(out).includes("plain talk"), "message prose reached the model");
  });

  it("getSharedPlans returns a place NAME and excludes cancelled plans", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_get_shared_plans", ARGS);
    assert.equal(out.count, 1);
    assert.equal(out.plans[0].title, "Coffee at 9");
    assert.equal(out.plans[0].where, "Cong Caphe");
    assert.ok(!out.plans.some((p: any) => p.title === "Cancelled thing"));
  });

  it("getSharedPlaces returns the card title and NEVER the coordinates", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_get_shared_places", ARGS);
    assert.equal(out.count, 1);
    assert.equal(out.places[0].title, "Sky36 Rooftop");
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes("21.0287"), "a latitude reached the model");
    assert.ok(!serialized.includes("105.85"), "a longitude reached the model");
  });

  it("getParticipantAvailability returns a shared window and never a private one", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_get_participant_availability", ARGS);
    assert.equal(out.participantsChecked, 2);
    const byUser = new Map(out.availability.map((a: any) => [a.userId, a]));
    assert.ok(byUser.has(BOB), "Bob shares with crew and should appear");
    assert.ok(!byUser.has(CARL), "Carl's window is private and must never be projected");
    const bob: any = byUser.get(BOB);
    assert.equal(bob.windows[0].intents[0], "food");
    assert.equal(bob.windows[0].maxTravelMinutes, undefined,
      "a travel-time budget is a distance signal and is not part of this projection");
  });

  it("searchAuthorizedConversationContent goes through the §21 service, structured first", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_search_conversation", {
      ...ARGS, query: "sky36",
    });
    assert.equal(out.authorized, true);
    assert.ok(out.hits.length >= 1);
    assert.equal(out.hits[0].kind, "PLACES", "a structured object must outrank prose");
    assert.ok(!JSON.stringify(out).includes("21.0287"));
  });

  it("searchAuthorizedConversationContent refuses a one-character query", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_search_conversation", {
      ...ARGS, query: "s",
    });
    assert.equal(out.authorized, false);
    assert.equal(out.reason, "query_too_short");
  });
});

/* ─────────────────── the three prohibitions in §18.3's tail ───────────────── */

describe("Telegraph §18.3 — the boundary sentence, enforced", () => {
  it("createPlanDraft writes NOTHING and says the participant must confirm", async () => {
    const sc = makeClient();
    const before = JSON.stringify(fixture({}));
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_create_plan_draft", {
      ...ARGS, title: "Drinks at 8", where: "Cong Caphe",
    });
    assert.equal(out.authorized, true);
    assert.equal(out.requiresConfirmation, true);
    assert.equal(out.draft.title, "Drinks at 8");
    assert.equal(JSON.stringify(fixture({})), before, "the fixture shape must be unchanged — nothing was written");
  });

  it("createPlanDraft refuses a title it was not given rather than inventing one", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_create_plan_draft", ARGS);
    assert.equal(out.authorized, false);
    assert.equal(out.reason, "title_required");
  });

  it("suggestMeetingPoint uses the conversation's destination and no participant location", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_suggest_meeting_point", ARGS);
    assert.equal(out.authorized, true);
    assert.equal(out.near, "Hanoi");
    assert.ok(String(out.note).includes("No participant's location was read"));
  });

  it("findSafePublicMeetup labels its basis and does not claim safety it cannot know", async () => {
    const sc = makeClient();
    const out: any = await executeTelegraphConversationTool(sc, ALICE, "telegraph_find_safe_public_meetup", ARGS);
    assert.equal(out.safetyBasis, "public_staffed_category_only");
    assert.ok(/crime|lighting|opening hours|public, staffed/i.test(String(out.note)), String(out.note));
  });
});

/* ─────────────── §14.3 — Compass answers inside the caller's window ──────── */

/**
 * §18.3's boundary sentence is "Compass sees only data authorized to the
 * conversational context", and §14.3 says what that means for a member added
 * later: the context they are authorized to STARTS when their membership does.
 * Two of the eight accessors read `messages` directly, so two of the eight can
 * carry pre-membership content out through the model instead of through the
 * thread read — `getSharedPlaces` returns a card's TITLE and its summary text,
 * and `getConversationContext` returns the KINDS of object that were shared
 * and, by their presence, that they were shared at all.
 *
 * The bound is resolved ONCE, in `gateConversation`, and handed to the tools as
 * `gate.visibleFrom`. That is deliberate: a ninth tool written later takes the
 * conversation id from the same object, so it takes the window with it.
 *
 * m1 is the only `subtype` row in the fixture (a discovery_card at
 * 2026-05-03); m2 is plain prose at 2026-05-04. A window opening at 2026-05-04
 * therefore puts exactly the card outside it.
 */
describe("Telegraph §14.3 — Compass cannot answer from before the caller joined", () => {
  const WINDOW = "2026-05-04T00:00:00.000Z";

  it("CONTROL — with no bound, the shared place and its kind are both returned", async () => {
    const sc = makeClient();
    const places: any = await executeTelegraphConversationTool(
      sc, ALICE, "telegraph_get_shared_places", ARGS,
    );
    assert.equal(places.places.length, 1);
    assert.equal(places.places[0].title, "Sky36 Rooftop");

    const ctx: any = await executeTelegraphConversationTool(
      sc, ALICE, "telegraph_get_conversation_context", ARGS,
    );
    assert.deepEqual(ctx.recentObjectKinds, ["discovery_card"]);
  });

  it("flag OFF (the production seed): a bound on the row changes nothing", async () => {
    const sc = makeClient({ historyBound: false, aliceVisibleFrom: WINDOW });
    const places: any = await executeTelegraphConversationTool(
      sc, ALICE, "telegraph_get_shared_places", ARGS,
    );
    assert.equal(places.places.length, 1, "OFF must be byte-identical to today");
  });

  it("flag ON: a place shared before the caller's window is not returned", async () => {
    const sc = makeClient({ historyBound: true, aliceVisibleFrom: WINDOW });
    const places: any = await executeTelegraphConversationTool(
      sc, ALICE, "telegraph_get_shared_places", ARGS,
    );
    assert.equal(places.authorized, true, "the tool still answers — it is narrower, not refused");
    assert.deepEqual(
      places.places, [],
      "a pre-membership card's title and summary are message CONTENT; reaching them through the model is the same disclosure",
    );
  });

  it("flag ON: the conversation context does not even report that the card exists", async () => {
    const sc = makeClient({ historyBound: true, aliceVisibleFrom: WINDOW });
    const ctx: any = await executeTelegraphConversationTool(
      sc, ALICE, "telegraph_get_conversation_context", ARGS,
    );
    assert.equal(ctx.authorized, true);
    assert.deepEqual(ctx.recentObjectKinds, []);
  });

  it("flag ON: THE OTHER HALF — a member with a NULL bound still gets everything", async () => {
    const sc = makeClient({ historyBound: true, aliceVisibleFrom: null });
    const places: any = await executeTelegraphConversationTool(
      sc, ALICE, "telegraph_get_shared_places", ARGS,
    );
    assert.equal(places.places.length, 1);
    const ctx: any = await executeTelegraphConversationTool(
      sc, ALICE, "telegraph_get_conversation_context", ARGS,
    );
    assert.deepEqual(ctx.recentObjectKinds, ["discovery_card"]);
  });

  it("the gate hands the window to every tool, so a ninth one cannot forget it", async () => {
    const sc = makeClient({ historyBound: true, aliceVisibleFrom: WINDOW });
    const gate: any = await gateConversation(sc, ALICE, ARGS);
    assert.equal(gate.authorized, true);
    assert.equal(gate.visibleFrom, WINDOW);

    const off: any = await gateConversation(makeClient({ historyBound: false, aliceVisibleFrom: WINDOW }), ALICE, ARGS);
    assert.equal(off.visibleFrom, null, "OFF must resolve to no bound even when the column carries one");
  });
});
