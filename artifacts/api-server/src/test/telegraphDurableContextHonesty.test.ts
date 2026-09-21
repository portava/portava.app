/**
 * §17.8 item 2 and T344's own "context" half, closed: an unreadable table is
 * not a closed thread, not an empty conversation, and — worst of the three —
 * not a name a thread then keeps forever.
 *
 * ── WHY THIS FILE IS SEPARATE FROM telegraphNotFoundHonesty.test.ts ──────────
 * §18 closed twelve sites whose outage became a confident `not_found`. §18.4
 * then wrote down, precisely, what it had NOT closed and why the rows could not
 * move:
 *
 *   "§17.8 item 2's three sites are also still open: the group-chat reader that
 *    reports an unreadable `message_threads` as `title: 'Trip Chat'`,
 *    `status: 'active'` — so a closed thread reads as active — and both sync
 *    implementations, which write a DURABLE generic title onto a newly created
 *    thread when `trips` is unreadable. A durable wrong title is the worst of
 *    the three consequences in this class, because unlike a 404 it does not go
 *    away when the outage does."
 *
 * This file is those sites. Three things it found that §17.8's enumeration did
 * not, all in the same two functions and all the same defect, are pinned here
 * too rather than left for a later grep:
 *
 *   1. There are TWO group-chat readers, not one. `GET /circles/:id/chat` has
 *      the identical `?? 'Trusted Circle'` / `?? 'active'` shape.
 *   2. Both sync implementations have a CIRCLE branch whose durable title comes
 *      from an unread `profiles` read, exactly as the trip branch's comes from
 *      an unread `trips` read. Four durable sites, not two.
 *   3. `fetchMessagesForThread` dropped the error on the `messages` read itself
 *      and returned `[]`, so an unreadable `messages` rendered a trip or circle
 *      chat as A CONVERSATION WITH NO MESSAGES. That is T344's "plausible empty
 *      **context**" and T363's "plausible empty **state**" in the plainest form
 *      the tree contains, and no section of the census had named it.
 *
 * ── THE POSTURE IS §18.2's, COPIED ──────────────────────────────────────────
 * Routes bind the error, log it, and answer `degraded_unavailable` — this
 * codebase's own code for "the check was NOT PERFORMED", and the only code
 * marked retryable in `lib/http.ts` RETRYABLE_CODES. The two sync functions are
 * not routes and already have a "could not sync" answer each (`null` in
 * `lib/chatSync.ts`, a thrown Error in `services/groupChatSync.ts`); they use
 * the one they already have rather than gaining a third posture.
 *
 * ── EVERY CASE IS PAIRED ────────────────────────────────────────────────────
 * A file that only asserted "an outage is not a 200" would pass against a route
 * that had been deleted or that refuses everything. So each outage case has a
 * CONTROL on the healthy tree asserting the REAL value arrives — the trip's own
 * title, the thread's real `status`, the messages that exist, the title the
 * created row is actually given.
 *
 * And the refusal in `services/groupChatSync.ts` is placed at the DURABILITY,
 * not at the read: that read runs on every call but is load-bearing only on the
 * call that creates the thread. Two cases assert that an unreadable `trips` /
 * `profiles` still syncs successfully when the thread already exists, because a
 * refusal that fired there would turn a cosmetic outage into a failed sync for
 * every healthy group chat in the system.
 *
 * Run: node --import tsx/esm --test src/test/telegraphDurableContextHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import groupChatRouter from "../routes/groupChat.js";
import {
  syncTripChatMembers as libSyncTrip,
  syncCircleChatMembers as libSyncCircle,
} from "../lib/chatSync.js";
import {
  syncTripChatMembers as svcSyncTrip,
  syncCircleChatMembers as svcSyncCircle,
} from "../services/groupChatSync.js";
import {
  makeFakeClient,
  startRouter,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const TRIP = "33333333-0000-4000-8000-000000000003";
const TRIP_THREAD = "00000000-0000-4000-8000-00000000000e";
const CIRCLE_THREAD = "00000000-0000-4000-8000-00000000000f";
const MSG = "11111111-0000-4000-8000-000000000001";
/** A trip and a circle that have no thread yet — the CREATE path. */
const NEW_TRIP = "44444444-0000-4000-8000-000000000004";
const NEW_CIRCLE_OWNER = "cccccccc-0000-4000-8000-000000000003";

const down = (t: string) => ({ message: `permission denied for relation ${t}`, code: "42501" });

async function get(base: string, path: string, asUser: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "Ana", account_status: null },
      { id: B, handle: "b", name: "Ben", account_status: null },
      { id: NEW_CIRCLE_OWNER, handle: "cass", name: "Cass", account_status: null },
    ],
    profile_privacy_settings: [],
    trips: [
      { id: TRIP, title: "Lisbon", destination_city: "Lisbon", created_by: A },
      { id: NEW_TRIP, title: "Osaka", destination_city: "Osaka", created_by: A },
    ],
    trip_members: [
      { trip_id: TRIP, user_id: A, status: "accepted", role: "owner" },
      { trip_id: NEW_TRIP, user_id: A, status: "accepted", role: "owner" },
    ],
    circle_memberships: [
      { user_id: B, other_id: A },
      { user_id: NEW_CIRCLE_OWNER, other_id: A },
    ],
    message_threads: [
      { id: TRIP_THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null,
        title: "Lisbon · Lisbon", status: "closed", is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
        last_message_at: "2026-01-02T00:00:00.000Z" },
      { id: CIRCLE_THREAD, thread_type: "circle", trip_id: null, circle_owner_id: B,
        title: "Ben's Trusted Circle", status: "closed", is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
        last_message_at: "2026-01-02T00:00:00.000Z" },
    ],
    message_thread_members: [
      { thread_id: TRIP_THREAD, user_id: A, role: "owner", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: CIRCLE_THREAD, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: CIRCLE_THREAD, user_id: B, role: "owner", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      { id: MSG, thread_id: TRIP_THREAD, sender_id: A, body: "we land at nine",
        created_at: "2026-01-02T00:00:00.000Z", deleted_at: null, edited_at: null,
        original_language: "en", msg_type: "text", subtype: null },
      { id: MSG.replace(/1$/, "2"), thread_id: CIRCLE_THREAD, sender_id: B, body: "bring the charger",
        created_at: "2026-01-02T00:00:00.000Z", deleted_at: null, edited_at: null,
        original_language: "en", msg_type: "text", subtype: null },
    ],
    message_translations: [],
    ...over,
  };
}

function use(state: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  _resetRateLimit();
  const c = makeFakeClient(state, opts);
  _setTestClient(c, true);
  return c;
}

/**
 * How many operations on `table` happen BEFORE the select naming `sel`.
 *
 * `afterOps: N` injects from operation N+1 onward and counts EVERY settled
 * operation on the table, writes included, while `_observed.selects` records
 * only selects. So this asserts the two agree for this table on this path —
 * i.e. that no write to it intervened — rather than assuming it. If a write is
 * ever added, the case fails loudly instead of silently moving to another read.
 */
function priorOpsOf(c: FakeClient, table: string, sel: string): number {
  const writes =
    c._observed.inserts.filter((w) => w.table === table).length +
    c._observed.updates.filter((w) => w.table === table).length +
    c._observed.upserts.filter((w) => w.table === table).length +
    c._observed.deletes.filter((w) => w.table === table).length;
  assert.equal(
    writes, 0,
    `this path now writes ${table}, so a select index is no longer an operation index — ` +
      "re-measure before trusting afterOps here",
  );
  const idx = c._observed.selects.findIndex((s) => s.table === table && s.sel === sel);
  assert.ok(
    idx >= 0,
    `no ${table} read selecting "${sel}" was observed — the call site moved or its select changed. ` +
      `Observed on ${table}: ${JSON.stringify(c._observed.selects.filter((s) => s.table === table).map((s) => s.sel))}`,
  );
  return c._observed.selects.filter((s, i) => s.table === table && i < idx).length;
}

const THREAD_SEL_TRIP = "id, thread_type, trip_id, title, status, last_message_at, created_at";
const THREAD_SEL_CIRCLE = "id, thread_type, circle_owner_id, title, status, last_message_at, created_at";

let harness: RouterHarness;
before(async () => { harness = await startRouter(groupChatRouter); });
after(async () => { await harness.close(); });
beforeEach(() => { resetFakeIds(); _resetRateLimit(); });

describe("§17.8 item 2 — an unreadable `message_threads` is not an ACTIVE thread", () => {
  it("CONTROL — GET /trips/:id/chat reports the thread's REAL title and status", async () => {
    use(store());
    const r = await get(harness.base, `/trips/${TRIP}/chat`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.thread?.title, "Lisbon · Lisbon");
    assert.equal(r.body?.thread?.status, "closed");
  });

  it("GET /trips/:id/chat refuses retryably rather than answering `Trip Chat` / `active`", async () => {
    const probe = use(store());
    await get(harness.base, `/trips/${TRIP}/chat`, A);
    const before = priorOpsOf(probe, "message_threads", THREAD_SEL_TRIP);

    use(store(), { errors: { message_threads: { ...down("message_threads"), afterOps: before } } });
    const r = await get(harness.base, `/trips/${TRIP}/chat`, A);

    assert.notEqual(
      r.body?.thread?.status, "active",
      `a CLOSED thread was reported ACTIVE from a read that never happened: ${JSON.stringify(r.body)}`,
    );
    assert.notEqual(r.body?.thread?.title, "Trip Chat", JSON.stringify(r.body));
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });

  it("CONTROL — GET /circles/:id/chat reports the thread's REAL title and status", async () => {
    use(store());
    const r = await get(harness.base, `/circles/${B}/chat`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.thread?.title, "Ben's Trusted Circle");
    assert.equal(r.body?.thread?.status, "closed");
  });

  it("GET /circles/:id/chat refuses retryably rather than answering `Trusted Circle` / `active`", async () => {
    const probe = use(store());
    await get(harness.base, `/circles/${B}/chat`, A);
    const before = priorOpsOf(probe, "message_threads", THREAD_SEL_CIRCLE);

    use(store(), { errors: { message_threads: { ...down("message_threads"), afterOps: before } } });
    const r = await get(harness.base, `/circles/${B}/chat`, A);

    assert.notEqual(
      r.body?.thread?.status, "active",
      `a CLOSED thread was reported ACTIVE from a read that never happened: ${JSON.stringify(r.body)}`,
    );
    assert.notEqual(r.body?.thread?.title, "Trusted Circle", JSON.stringify(r.body));
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });
});

describe("T344 'plausible empty CONTEXT' — an unreadable `messages` is not an empty chat", () => {
  it("CONTROL — the trip chat returns the messages that exist", async () => {
    use(store());
    const r = await get(harness.base, `/trips/${TRIP}/chat`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.messages?.length, 1, JSON.stringify(r.body));
  });

  it("the trip chat refuses retryably rather than rendering a conversation with no messages", async () => {
    use(store(), { errors: { messages: down("messages") } });
    const r = await get(harness.base, `/trips/${TRIP}/chat`, A);
    assert.notDeepEqual(
      r.body?.messages, [],
      `a thread full of history rendered as empty from a read that never happened: ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });

  it("CONTROL — the circle chat returns the messages that exist", async () => {
    use(store());
    const r = await get(harness.base, `/circles/${B}/chat`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.messages?.length, 1, JSON.stringify(r.body));
  });

  it("the circle chat refuses retryably rather than rendering a conversation with no messages", async () => {
    use(store(), { errors: { messages: down("messages") } });
    const r = await get(harness.base, `/circles/${B}/chat`, A);
    assert.notDeepEqual(r.body?.messages, [], JSON.stringify(r.body));
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });
});

describe("§18.4's worst consequence — a DURABLE title from a read that never happened", () => {
  it("CONTROL — lib/chatSync creates the trip thread with the TRIP's own title", async () => {
    const c = use(store());
    const id = await libSyncTrip(NEW_TRIP, c as any);
    assert.ok(id, "the healthy path must still create the thread");
    const row = c._store.message_threads.find((t) => t.trip_id === NEW_TRIP);
    assert.equal(row?.title, "Osaka · Osaka", JSON.stringify(row));
  });

  it("lib/chatSync refuses rather than stamping `Trip Chat` on a new thread when `trips` is unreadable", async () => {
    const c = use(store(), { errors: { trips: down("trips") } });
    const id = await libSyncTrip(NEW_TRIP, c as any);
    const row = c._store.message_threads.find((t) => t.trip_id === NEW_TRIP);
    assert.equal(
      row, undefined,
      `a thread was CREATED with a durable guessed title from a read that never happened: ${JSON.stringify(row)}`,
    );
    assert.equal(id, null, "an unreconcilable sync must answer with the null this function already uses");
  });

  it("CONTROL — lib/chatSync creates the circle thread with the OWNER's own name", async () => {
    const c = use(store());
    const id = await libSyncCircle(NEW_CIRCLE_OWNER, c as any);
    assert.ok(id, "the healthy path must still create the thread");
    const row = c._store.message_threads.find((t) => t.circle_owner_id === NEW_CIRCLE_OWNER);
    assert.equal(row?.title, "Cass's Trusted Circle", JSON.stringify(row));
  });

  it("lib/chatSync refuses rather than stamping `Trusted Circle` when `profiles` is unreadable", async () => {
    const c = use(store(), { errors: { profiles: down("profiles") } });
    const id = await libSyncCircle(NEW_CIRCLE_OWNER, c as any);
    const row = c._store.message_threads.find((t) => t.circle_owner_id === NEW_CIRCLE_OWNER);
    assert.equal(row, undefined, `a thread was CREATED with a durable guessed title: ${JSON.stringify(row)}`);
    assert.equal(id, null);
  });

  it("CONTROL — services/groupChatSync creates the trip thread with the TRIP's own title", async () => {
    const c = use(store());
    const id = await svcSyncTrip(c as any, NEW_TRIP);
    assert.ok(id);
    const row = c._store.message_threads.find((t) => t.trip_id === NEW_TRIP);
    assert.equal(row?.title, "Osaka", JSON.stringify(row));
  });

  it("services/groupChatSync refuses rather than stamping `Trip Chat` when `trips` is unreadable", async () => {
    const c = use(store(), { errors: { trips: down("trips") } });
    await assert.rejects(
      () => svcSyncTrip(c as any, NEW_TRIP),
      /trip read failed/,
      "an unreadable `trips` on the CREATE path must refuse, not name the thread by guess",
    );
    const row = c._store.message_threads.find((t) => t.trip_id === NEW_TRIP);
    assert.equal(row, undefined, `a thread was CREATED with a durable guessed title: ${JSON.stringify(row)}`);
  });

  it("CONTROL — services/groupChatSync creates the circle thread from the OWNER's own name", async () => {
    const c = use(store());
    const id = await svcSyncCircle(c as any, NEW_CIRCLE_OWNER);
    assert.ok(id);
    const row = c._store.message_threads.find((t) => t.circle_owner_id === NEW_CIRCLE_OWNER);
    assert.match(String(row?.title), /Cass/, JSON.stringify(row));
  });

  it("services/groupChatSync refuses rather than guessing the circle's name when `profiles` is unreadable", async () => {
    const c = use(store(), { errors: { profiles: down("profiles") } });
    await assert.rejects(
      () => svcSyncCircle(c as any, NEW_CIRCLE_OWNER),
      /owner profile read failed/,
    );
    const row = c._store.message_threads.find((t) => t.circle_owner_id === NEW_CIRCLE_OWNER);
    assert.equal(row, undefined, `a thread was CREATED with a durable guessed title: ${JSON.stringify(row)}`);
  });
});

describe("the refusal is placed at the DURABILITY, not at the read", () => {
  it("an unreadable `trips` does NOT fail a sync for a trip whose thread already exists", async () => {
    const c = use(store(), { errors: { trips: down("trips") } });
    const id = await svcSyncTrip(c as any, TRIP);
    assert.equal(
      id, TRIP_THREAD,
      "the title read is load-bearing only when the thread is created; refusing here would turn a " +
        "cosmetic outage into a failed sync for every healthy trip chat in the system",
    );
  });

  it("an unreadable `profiles` does NOT fail a sync for a circle whose thread already exists", async () => {
    const c = use(store(), { errors: { profiles: down("profiles") } });
    const id = await svcSyncCircle(c as any, B);
    assert.equal(id, CIRCLE_THREAD);
  });
});
