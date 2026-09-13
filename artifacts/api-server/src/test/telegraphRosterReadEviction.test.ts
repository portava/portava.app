/**
 * Census T344 / T363 — an unreadable ROSTER must not be read as an EMPTY roster.
 *
 * THE DEFECT THIS PINS, and why it is worse than every instance §14, §15 and
 * §16 of `census-telegraph.md` found before it.
 *
 * `lib/chatSync.ts` reconciles a group thread's membership against the domain
 * roster that owns it — `trip_members` for a trip chat, `circle_memberships`
 * for a circle chat. Both of those reads dropped their error:
 *
 *     const { data: acceptedRows } = await sc.from('trip_members')…
 *     const accepted = (acceptedRows ?? []) as Array<…>;
 *     const acceptedIds = new Set(accepted.map((r) => r.user_id));
 *
 * supabase-js RESOLVES on a database error, so an unreadable `trip_members`
 * arrived as `data: null`, `?? []` turned it into "this trip has NO accepted
 * members", and step 5 — which sets `left_at = now()` for every thread member
 * not in the accepted set — then EVICTED THE ENTIRE CREW from their own chat.
 * Not a plausible empty read: a destructive WRITE driven by a read that never
 * happened.
 *
 * AND THE TRIP CASE DOES NOT HEAL. Step 4 only clears `left_at` when the
 * member's trip ROLE CHANGED (`existing.role !== role`), under a comment that
 * says so deliberately: "A member whose role is unchanged but who has left_at
 * set chose to leave the chat themselves — do NOT force-rejoin them on every
 * sync." So after a transient `trip_members` blip, every subsequent HEALTHY
 * sync reads an evicted crew and leaves it evicted, and each member is answered
 * 403 "Not a member of this thread" on a conversation they never left. The
 * circle branch restores (`ex.left_at !== null || ex.role !== role`) and so
 * recovers on the next sync; the trip branch does not.
 *
 * `lib/chatSync.ts` is a LIVE path, not a legacy twin: `routes/groupChat.ts:183`
 * and `:245` (opening a trip or circle chat), `routes/trips.ts:410,1372,2206,
 * 2215,2293` (create, invite-accept, member changes) and `routes/friends.ts:889,
 * 1025` (circle invite accepted, circle member removed) all call it.
 *
 * `services/groupChatSync.ts` is the second implementation, reached from
 * `routes/messaging.ts:3248` and `:3324`. Its roster read was dropped too; it
 * escaped the eviction only by accident, because `if (acceptedIds.size === 0)
 * return threadId;` sits between the read and the removal loop and cannot tell
 * "this trip has no members" from "the table is down". Its `activeMembers` read
 * is dropped in the other direction: unreadable means REMOVE NOBODY, so a
 * member the trip removed keeps thread access with nothing said.
 *
 * WHAT IS ASSERTED. Both files, both discriminators (trip and circle), with a
 * CONTROL beside every failure case proving the healthy path still reconciles —
 * because a fix that simply stopped removing anybody would pass a
 * "nobody was evicted" assertion and break the feature.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphRosterReadEviction.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";

import {
  syncTripChatMembers as syncTripV1,
  syncCircleChatMembers as syncCircleV1,
} from "../lib/chatSync.js";
import {
  syncTripChatMembers as syncTripV2,
  syncCircleChatMembers as syncCircleV2,
} from "../services/groupChatSync.js";

const TRIP = "60000000-0000-4000-a000-000000000001";
const THREAD = "60000000-0000-4000-a000-0000000000ff";
const OWNER = "60000000-0000-4000-a000-000000000002";
const CREW_A = "60000000-0000-4000-a000-000000000003";
const CREW_B = "60000000-0000-4000-a000-000000000004";
/** Accepted by the domain roster but never reconciled into the thread. */
const DEPARTED = "60000000-0000-4000-a000-000000000005";

const ROSTER_DOWN = { message: "permission denied for relation trip_members", code: "42501" };
const CIRCLE_ROSTER_DOWN = {
  message: "permission denied for relation circle_memberships",
  code: "42501",
};

/** A trip whose thread already exists and whose crew is already reconciled. */
function tripRows(over: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    trips: [{ id: TRIP, title: "Da Nang", destination_city: "Da Nang" }],
    message_threads: [{ id: THREAD, thread_type: "trip", trip_id: TRIP, title: "Da Nang" }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner" },
      { trip_id: TRIP, user_id: CREW_A, role: "member" },
      { trip_id: TRIP, user_id: CREW_B, role: "member" },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: null },
      { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: null },
      { thread_id: THREAD, user_id: CREW_B, role: "member", left_at: null },
    ],
    ...over,
  };
}

function circleRows(over: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    profiles: [{ id: OWNER, name: "Mai", handle: "mai" }],
    message_threads: [{ id: THREAD, thread_type: "circle", circle_owner_id: OWNER }],
    circle_memberships: [
      { user_id: OWNER, other_id: CREW_A },
      { user_id: OWNER, other_id: CREW_B },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: null },
      { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: null },
      { thread_id: THREAD, user_id: CREW_B, role: "member", left_at: null },
    ],
    ...over,
  };
}

/** Every `left_at` an update payload actually set to a timestamp. */
function evictions(updated: Record<string, any[]>): any[] {
  return (updated["message_thread_members"] ?? []).filter(
    (p) => p && typeof p.left_at === "string",
  );
}

// ── lib/chatSync.ts — the live path, and the one that does not heal ──────────

describe("lib/chatSync trip sync — an unreadable trip_members is not an empty crew", () => {
  it("CONTROL: a healthy sync evicts the member the trip really removed, and nobody else", async () => {
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: tripRows({
        message_thread_members: [
          { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: null },
          { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: null },
          { thread_id: THREAD, user_id: CREW_B, role: "member", left_at: null },
          { thread_id: THREAD, user_id: DEPARTED, role: "member", left_at: null },
        ],
      }),
      updated,
    });
    assert.equal(await syncTripV1(TRIP, sc), THREAD);
    assert.equal(
      evictions(updated).length,
      1,
      "exactly the one member the trip roster no longer lists",
    );
  });

  it("an unreadable trip_members evicts NOBODY and refuses the sync", async () => {
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: tripRows(),
      failOn: (c: FakeReadContext) => (c.table === "trip_members" ? ROSTER_DOWN : null),
      updated,
    });

    const result = await syncTripV1(TRIP, sc);

    assert.deepEqual(
      evictions(updated),
      [],
      "an unreadable roster must never write left_at — the crew did not leave, the table did",
    );
    assert.equal(
      result,
      null,
      "and the caller must be told the sync did not happen, not handed a thread id " +
        "that implies a reconciled roster",
    );
  });

  it("an unreadable THREAD roster refuses rather than re-inserting the whole crew", async () => {
    // Step 3's read, not step 2's. Dropped, it fails in both directions at
    // once: the thread looks empty, so step 4 INSERTS a second membership row
    // for every accepted member, and step 5 removes nobody. Added because a
    // mutation that deleted this refusal left the suite green — the guard was
    // real and nothing proved it.
    const inserted: Record<string, any[]> = {};
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: tripRows(),
      failOn: (c: FakeReadContext) =>
        c.table === "message_thread_members" ? { message: "roster unavailable", code: "57P01" } : null,
      inserted,
      updated,
    });

    assert.equal(await syncTripV1(TRIP, sc), null);
    assert.deepEqual(
      inserted["message_thread_members"] ?? [],
      [],
      "an unreadable thread roster read as 'nobody is in this thread' and the " +
        "upsert loop re-added every accepted member",
    );
    assert.deepEqual(evictions(updated), []);
  });

  it("CONTROL — why the eviction is permanent: an unchanged role never clears left_at", async () => {
    // Not a proof of the fix. It pins the property that makes the defect above
    // unrecoverable, so nobody later "simplifies" the failure case away on the
    // belief that the next healthy sync would have put the crew back.
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: tripRows({
        message_thread_members: [
          { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: "2026-01-01T00:00:00.000Z" },
          { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: "2026-01-01T00:00:00.000Z" },
          { thread_id: THREAD, user_id: CREW_B, role: "member", left_at: "2026-01-01T00:00:00.000Z" },
        ],
      }),
      updated,
    });
    assert.equal(await syncTripV1(TRIP, sc), THREAD);
    assert.equal(
      (updated["message_thread_members"] ?? []).filter((p) => p && p.left_at === null).length,
      0,
      "a healthy sync does NOT restore an evicted crew whose roles are unchanged",
    );
  });
});

describe("lib/chatSync circle sync — an unreadable circle_memberships is not an empty circle", () => {
  it("CONTROL: a healthy sync evicts the member the circle really removed, and nobody else", async () => {
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: circleRows({
        message_thread_members: [
          { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: null },
          { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: null },
          { thread_id: THREAD, user_id: CREW_B, role: "member", left_at: null },
          { thread_id: THREAD, user_id: DEPARTED, role: "member", left_at: null },
        ],
      }),
      updated,
    });
    assert.equal(await syncCircleV1(OWNER, sc), THREAD);
    assert.equal(evictions(updated).length, 1);
  });

  it("an unreadable circle_memberships evicts NOBODY and refuses the sync", async () => {
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: circleRows(),
      failOn: (c: FakeReadContext) =>
        c.table === "circle_memberships" ? CIRCLE_ROSTER_DOWN : null,
      updated,
    });

    const result = await syncCircleV1(OWNER, sc);

    assert.deepEqual(
      evictions(updated),
      [],
      "every member but the owner would otherwise be evicted from the circle chat",
    );
    assert.equal(result, null);
  });

  it("an unreadable THREAD roster refuses rather than re-inserting the whole circle", async () => {
    // The circle mirror of the trip case above, pinned separately for the same
    // reason §15.4 pinned the circle branches separately: the two branches are
    // the same code against a different discriminator and were fixed one at a
    // time, so a test that covers only one leaves the other defended by nothing.
    const inserted: Record<string, any[]> = {};
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: circleRows(),
      failOn: (c: FakeReadContext) =>
        c.table === "message_thread_members" ? { message: "roster unavailable", code: "57P01" } : null,
      inserted,
      updated,
    });
    assert.equal(await syncCircleV1(OWNER, sc), null);
    assert.deepEqual(inserted["message_thread_members"] ?? [], []);
    assert.deepEqual(evictions(updated), []);
  });
});

// ── services/groupChatSync.ts — the second implementation ────────────────────

describe("services/groupChatSync — the same two reads, the same rule", () => {
  it("CONTROL: a healthy sync evicts the member the trip really removed", async () => {
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: tripRows({
        message_thread_members: [
          { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: null },
          { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: null },
          { thread_id: THREAD, user_id: CREW_B, role: "member", left_at: null },
          { thread_id: THREAD, user_id: DEPARTED, role: "member", left_at: null },
        ],
      }),
      updated,
    });
    assert.equal(await syncTripV2(sc, TRIP), THREAD);
    assert.equal(evictions(updated).length, 1);
  });

  it("an unreadable trip_members REFUSES rather than returning a thread it did not reconcile", async () => {
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: tripRows(),
      failOn: (c: FakeReadContext) => (c.table === "trip_members" ? ROSTER_DOWN : null),
      updated,
    });
    await assert.rejects(
      () => syncTripV2(sc, TRIP),
      /trip_members/,
      "the early `acceptedIds.size === 0` return read an outage as an empty trip and " +
        "handed the caller a thread id that claims a reconciled roster",
    );
    assert.deepEqual(evictions(updated), []);
  });

  it("an unreadable circle_memberships REFUSES rather than silently reconciling to the owner alone", async () => {
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: circleRows(),
      failOn: (c: FakeReadContext) =>
        c.table === "circle_memberships" ? CIRCLE_ROSTER_DOWN : null,
      updated,
    });
    await assert.rejects(() => syncCircleV2(sc, OWNER), /circle_memberships/);
    assert.deepEqual(evictions(updated), []);
  });

  it("an unreadable thread roster REFUSES rather than quietly removing nobody", async () => {
    // `message_thread_members` is read TWICE on this path — once for the
    // member.joined newcomer diff, once for the removal set — so the error is
    // injected from the SECOND read onward. Failing the whole table would abort
    // above the removal loop and the case would pass for the wrong reason.
    let reads = 0;
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: tripRows({
        message_thread_members: [
          { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: null },
          { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: null },
          { thread_id: THREAD, user_id: CREW_B, role: "member", left_at: null },
          { thread_id: THREAD, user_id: DEPARTED, role: "member", left_at: null },
        ],
      }),
      failOn: (c: FakeReadContext) => {
        if (c.table !== "message_thread_members") return null;
        reads += 1;
        return reads >= 2 ? { message: "roster unavailable", code: "57P01" } : null;
      },
      updated,
    });
    await assert.rejects(
      () => syncTripV2(sc, TRIP),
      /message_thread_members/,
      "an unreadable roster removed nobody and said nothing — a member the trip " +
        "removed keeps thread access",
    );
    assert.deepEqual(evictions(updated), []);
  });

  it("and the circle branch's removal read is bound too", async () => {
    let reads = 0;
    const updated: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: circleRows({
        message_thread_members: [
          { thread_id: THREAD, user_id: OWNER, role: "owner", left_at: null },
          { thread_id: THREAD, user_id: CREW_A, role: "member", left_at: null },
          { thread_id: THREAD, user_id: DEPARTED, role: "member", left_at: null },
        ],
      }),
      failOn: (c: FakeReadContext) => {
        if (c.table !== "message_thread_members") return null;
        reads += 1;
        return reads >= 2 ? { message: "roster unavailable", code: "57P01" } : null;
      },
      updated,
    });
    await assert.rejects(() => syncCircleV2(sc, OWNER), /message_thread_members/);
    assert.deepEqual(evictions(updated), []);
  });
});
