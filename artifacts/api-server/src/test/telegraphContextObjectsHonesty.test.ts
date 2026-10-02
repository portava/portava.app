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

import { telegraphGetConversationContext } from "../compass/TelegraphConversationTools.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000c";
const TRIP_ID = "11111111-0000-4000-8000-000000000001";

function fixture() {
  return {
    feature_flags: [] as any[],
    message_threads: [
      { id: THREAD, thread_type: "trip", status: "active", trip_id: TRIP_ID, circle_owner_id: null, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", left_at: null, last_read_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, role: "member", left_at: null, last_read_at: null },
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
    ],
  } as Record<string, any[]>;
}

/**
 * `messagesError` is the ONLY injected failure. Everything the gate reads
 * succeeds, so a refusal coming back from this client can only be the
 * recent-objects read — which is what makes assertion 5 meaningful.
 */
function makeClient(opts: { messagesError?: boolean } = {}) {
  const db = fixture();

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const injected = () =>
      table === "messages" && opts.messagesError
        ? { code: "57014", message: "canceling statement due to statement timeout" }
        : null;

    const target: any = {
      select() { return proxy; },
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
