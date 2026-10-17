/**
 * §18.3 T244 `getConversationContext()` — an unreadable object list must not
 * be reported as an empty conversation.
 *
 * THE DEFECT THIS FILE PINS
 * =========================
 * `telegraphGetConversationContext` read the conversation's recent structured
 * objects and then did this:
 *
 *     const { data: recent, error } = await recentQ;
 *     if (error) log.warn(...);
 *     ...
 *     recentObjectKinds: ((recent as any[]) ?? []).filter(...).map(...)
 *
 * supabase-js RESOLVES a rejected query with `{ data: null, error }` rather
 * than throwing, so the `?? []` turned every refusal — RLS denial, timeout,
 * dropped connection — into the empty array. The tool then handed Compass
 * `recentObjectKinds: []`, which reads as "the participants have put nothing
 * into this conversation", and the model repeats that to the participant as
 * fact. It is a confident false statement about a conversation, produced by a
 * failure nobody was told about.
 *
 * Every OTHER tool in that module already refuses by name on an unreadable
 * read — `plans_unavailable`, `places_unavailable`, `participants_unavailable`,
 * `membership_unavailable` — each with `degraded: true`, which is the module's
 * own word for "we could not check" as opposed to "you may not". This one read
 * was the exception.
 *
 * WHAT IS ASSERTED
 * ================
 *   1. `recentObjectKinds` is NULL, not `[]`, when the read failed. The shape
 *      matters more than the flag: an empty array is iterable and sums to
 *      "nothing", and a caller that forgets to check a boolean still gets the
 *      right answer from a null.
 *   2. The failure is NAMED (`recentObjectsUnreadable: true`) rather than
 *      inferred from the null.
 *   3. The note carries the instruction, so the model repeats "I could not
 *      check" rather than inventing a reason.
 *   4. The HAPPY PATH still returns a real list, so the fix cannot have been
 *      "make it always unreadable".
 *   5. The rest of the context — type, participant count, capabilities — still
 *      comes back, because those reads succeeded. Refusing the whole tool over
 *      one failed non-essential read would trade a false answer for no answer.
 *
 * MUTATION REQUIREMENT: restoring `?? []` on the recent-objects read must fail
 * "an unreadable object list is null, never an empty conversation"; dropping
 * the `recentObjectsUnreadable` flag must fail "the failure is named, not
 * inferred".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { telegraphGetConversationContext, TELEGRAPH_COMPASS_TOOL_DEFINITIONS } from "../compass/TelegraphConversationTools.js";
import { projectCatchUp } from "../services/telegraph/catchUp.js";
import * as catchUpModule from "../services/telegraph/catchUp.js";
import { CATCH_UP_SCAN_LIMIT } from "../routes/telegraphCoordination.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000c";
const TRIP_ID = "11111111-0000-4000-8000-000000000001";
const FOREIGN = "00000000-0000-4000-8000-00000000000f";

/** census-telegraph T267: Alice's read marker and §14.3 window, the bound's flag, and extra thread messages. Defaults keep every case above unchanged. */
interface CatchUpOpts { aliceLastReadAt?: string | null; aliceVisibleFrom?: string | null; historyBound?: boolean; extraMessages?: any[] }

function fixture(o: CatchUpOpts = {}) {
  return {
    feature_flags: (o.historyBound === undefined ? [] : [{ flag: "telegraph_history_bound_enabled", enabled: o.historyBound }]) as any[],
    message_threads: [
      { id: THREAD, thread_type: "trip", status: "active", trip_id: TRIP_ID, circle_owner_id: null, is_e2ee: false },
      { id: FOREIGN, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", left_at: null, last_read_at: o.aliceLastReadAt ?? null, visible_from_at: o.aliceVisibleFrom ?? null },
      { thread_id: THREAD, user_id: BOB, role: "member", left_at: null, last_read_at: null },
      { thread_id: FOREIGN, user_id: BOB, role: "member", left_at: null, last_read_at: null },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice",
        show_telegraph_dm: true, show_telegraph_trip: true, show_telegraph_circle: true },
      { id: BOB, handle: "bob", name: "Bob" },
    ],
    trips: [{ id: TRIP_ID, owner_id: ALICE, destination_city: "Hanoi", destination_country: "Vietnam" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: BOB, role: "member", status: "accepted" },
    ],
    blocks: [],
    trust_restrictions: [],
    user_privacy_settings: [],
    profile_privacy_settings: [],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
    meetups: [],
    availability_windows: [],
    messages: [
      { id: "m1", thread_id: THREAD, sender_id: BOB, body: "{}", subtype: "discovery_card",
        msg_type: "text", media_url: null, deleted_at: null, created_at: "2026-05-03T00:00:00.000Z" },
      { id: "m2", thread_id: THREAD, sender_id: BOB, body: "plain prose", subtype: null,
        msg_type: "text", media_url: null, deleted_at: null, created_at: "2026-05-04T00:00:00.000Z" },
      ...(o.extraMessages ?? []),
    ],
  } as Record<string, any[]>;
}

/**
 * `messagesError` is the ONLY injected failure. Everything the gate reads
 * succeeds, so a refusal coming back from this client can only be the
 * recent-objects read — which is what makes assertion 5 meaningful.
 */
function makeClient(opts: { messagesError?: boolean } & CatchUpOpts = {}) {
  const db = fixture(opts);

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;

    let _columns: string | null = null;
    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      const limited = _limit !== null ? rows.slice(0, _limit) : rows;
      // census-telegraph T267: the membership row is PROJECTED to the columns asked for, so a gate
      // that stops selecting `last_read_at` reads none (other tables keep the whole row, as before).
      if (table !== "message_thread_members" || !_columns || /[()*]/.test(_columns)) return limited;
      const cols = _columns.split(",").map((c) => c.trim());
      return limited.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    };
    const injected = () =>
      table === "messages" && opts.messagesError
        ? { code: "57014", message: "canceling statement due to statement timeout" }
        : null;

    const target: any = {
      select(cols?: string) { _columns = typeof cols === "string" ? cols : null; return proxy; },
      eq(col: string, val: any) { preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      not(col: string, op: string, val: any) { if (op === "is" && val === null) preds.push((r) => r[col] != null); return proxy; },
      in(col: string, vals: any[]) { preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      gte(col: string, val: any) { preds.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
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
        // The shape that started all of this: a REJECTION that RESOLVES.
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

const ARGS = { conversationId: THREAD };

describe("§18.3 T244 — an unreadable object list is never an empty conversation", () => {
  it("an unreadable object list is null, never an empty conversation", async () => {
    const out: any = await telegraphGetConversationContext(makeClient({ messagesError: true }), ALICE, ARGS);
    assert.equal(out.authorized, true);
    assert.equal(
      out.recentObjectKinds,
      null,
      "a failed read must not be handed to the model as an empty list of shared objects",
    );
    assert.notDeepEqual(out.recentObjectKinds, []);
  });

  it("the failure is named, not inferred", async () => {
    const out: any = await telegraphGetConversationContext(makeClient({ messagesError: true }), ALICE, ARGS);
    assert.equal(out.recentObjectsUnreadable, true);
  });

  it("the note tells the model to say it could not check, rather than to invent a reason", async () => {
    const out: any = await telegraphGetConversationContext(makeClient({ messagesError: true }), ALICE, ARGS);
    assert.match(String(out.note), /could not be read/i);
    assert.match(String(out.note), /not empty/i);
  });

  it("the rest of the context still comes back — one failed read is not a refusal of all five", async () => {
    const out: any = await telegraphGetConversationContext(makeClient({ messagesError: true }), ALICE, ARGS);
    assert.equal(out.conversationId, THREAD);
    assert.equal(out.conversationType, "trip");
    assert.equal(out.participantCount, 2);
    assert.ok(out.capabilities, "the capability set is read by the gate and was readable");
  });

  it("the happy path still returns the real list — the fix is not 'always unreadable'", async () => {
    const out: any = await telegraphGetConversationContext(makeClient(), ALICE, ARGS);
    assert.equal(out.recentObjectsUnreadable, false);
    assert.deepEqual(out.recentObjectKinds, ["discovery_card"]);
    // The plain-prose message carries no subtype and must not become a "kind".
    assert.equal(out.recentObjectKinds.length, 1);
    assert.doesNotMatch(String(out.note), /could not be read/i);
  });

  it("still returns no message prose in either branch — §18.3's boundary is unchanged", async () => {
    for (const client of [makeClient(), makeClient({ messagesError: true })]) {
      const out: any = await telegraphGetConversationContext(client, ALICE, ARGS);
      assert.doesNotMatch(JSON.stringify(out), /plain prose/);
    }
  });
});

/* ─────────── census-telegraph T267: the catch-up reaches Compass ──────────── */
//
// §20's Compass row: "Authorized thread context, meeting/recommendation tools,
// catch-up." The catch-up's server half is GET /threads/:id/catch-up
// (routes/telegraphCoordination.ts) over `projectCatchUp`; until now nothing in
// Compass reached it, and §18.3's tool set is closed at eight names, so it rides
// inside getConversationContext — the SAME projection, for the calling
// participant, under the gate every tool shares (membership, privacy verdict,
// capabilities) and the caller's own §14.3 window. Never prose: counts and
// typed items only, with `inferredFromProse: false` carried through. (The
// prose assertion above — "no message prose in either branch" — now covers it.)
describe("T267 — getConversationContext carries the caller's catch-up", () => {
  const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: "1", payload });
  const row = (id: string, sender: string, created_at: string, extra: Record<string, unknown> = {}) => ({
    id, thread_id: THREAD, sender_id: sender, created_at, deleted_at: null,
    msg_type: "text", subtype: null, media_url: null, body: "just talking", ...extra,
  });
  const decision = (id: string, at: string, question: string) => row(id, BOB, at, {
    msg_type: "decision", body: env("DECISION", { question, options: [{ id: "a", label: "Sky36" }, { id: "b", label: "Polite" }], resolutionRule: "PLURALITY", deadlineAt: null }),
  });
  const MARK = "2026-05-05T00:00:00.000Z";
  const EXTRA = [
    row("before-mark", BOB, "2026-05-04T12:00:00.000Z"),
    row("after-1", BOB, "2026-05-06T00:00:00.000Z"),
    row("after-2", BOB, "2026-05-06T01:00:00.000Z"),
    row("mine", ALICE, "2026-05-06T02:00:00.000Z"),
    decision("decision", "2026-05-06T03:00:00.000Z", "Which bar?"),
  ];
  const ctx = async (o: Parameters<typeof makeClient>[0]) => (await telegraphGetConversationContext(makeClient(o), ALICE, ARGS)) as any;

  it("is the SAME projection the thread's catch-up serves — for the caller, from their marker, never their own messages", async () => {
    const out = await ctx({ aliceLastReadAt: MARK, extraMessages: EXTRA });
    assert.equal(out.authorized, true);
    assert.ok(out.catchUp, "getConversationContext carries no catch-up");
    assert.equal(out.catchUpUnreadable, false);
    assert.equal(out.catchUp.sinceBasis, "read_marker");
    assert.equal(out.catchUp.since, MARK);
    assert.equal(out.catchUp.missedCount, 3, "Alice's own message, or one from before her marker, was counted as missed");
    assert.deepEqual(out.catchUp.decisionsOpened.map((d: any) => d.messageId), ["decision"]);
    assert.equal(out.catchUp.inferredFromProse, false);
    // One projection, not a second opinion: the pure function over the rows this caller may see.
    const rows = (fixture({ extraMessages: EXTRA }).messages as any[]).filter((m) => m.thread_id === THREAD);
    const expected = projectCatchUp({ threadId: THREAD, viewerId: ALICE, rows, lastReadAt: MARK, windowFrom: null, nowMs: Date.parse(out.catchUp.generatedAt) });
    const { generatedAt: _g, scanned, truncated, ...served } = out.catchUp;
    const { generatedAt: _e, ...wanted } = expected;
    assert.deepEqual(served, wanted);
    assert.equal(scanned, rows.length);
    assert.equal(truncated, false);
  });

  it("a caller who never read the thread is told so (conversation_start), not handed a null", async () => {
    const out = await ctx({ extraMessages: EXTRA });
    assert.equal(out.catchUp.sinceBasis, "conversation_start");
    assert.equal(out.catchUp.since, null);
  });

  it("§14.3: the caller's own join bounds it — an older marker does not widen it, and nothing asked before the join awaits them", async () => {
    const out = await ctx({
      historyBound: true, aliceVisibleFrom: "2026-05-06T00:30:00.000Z", aliceLastReadAt: "2026-05-01T00:00:00.000Z",
      extraMessages: [...EXTRA, decision("early-decision", "2026-05-04T06:00:00.000Z", "Before you came?")],
    });
    assert.equal(out.catchUp.sinceBasis, "history_window");
    assert.equal(out.catchUp.since, "2026-05-06T00:30:00.000Z");
    assert.equal(out.catchUp.missedCount, 2, "rows from before the caller's join reached the catch-up");
    const awaiting = out.catchUp.needsYou.map((i: any) => i.messageId);
    assert.ok(awaiting.includes("decision"), "the control: a question asked after the join awaits her");
    assert.equal(awaiting.includes("early-decision"), false, "a question from before the caller's join reached what awaits her");
    assert.equal(JSON.stringify(out.catchUp).includes("Before you came?"), false);
  });

  it("an unreadable conversation is NOT 'nothing happened': the catch-up is null, flagged, and the model is told not to say so", async () => {
    const out = await ctx({ aliceLastReadAt: MARK, extraMessages: EXTRA, messagesError: true });
    assert.equal(out.authorized, true);
    assert.equal(out.catchUp, null);
    assert.equal(out.catchUpUnreadable, true);
    assert.match(out.catchUpNote, /could not/i);
  });

  it("the same scan bound as the thread's own catch-up route", () => {
    assert.equal((catchUpModule as Record<string, unknown>).VIEWER_CATCH_UP_SCAN_LIMIT, CATCH_UP_SCAN_LIMIT);
  });

  it("is gated like every tool: a non-participant gets a refusal and no catch-up", async () => {
    const out: any = await telegraphGetConversationContext(makeClient({ extraMessages: EXTRA }), ALICE, { conversationId: FOREIGN });
    assert.equal(out.authorized, false);
    assert.equal(out.catchUp, undefined);
  });

  it("the model is told the tool carries a catch-up", () => {
    const def = TELEGRAPH_COMPASS_TOOL_DEFINITIONS.find((d) => d.function.name === "telegraph_get_conversation_context")!;
    assert.match(def.function.description, /catch-up/i);
  });
});
