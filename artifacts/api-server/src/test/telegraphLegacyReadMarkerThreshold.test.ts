/**
 * §7.2 / census T70 — the LEGACY read marker stops being whatever the client asserts.
 *
 * ── THE ROW, AND THE ONE HALF THAT WAS LEFT ─────────────────────────────────
 * T70: *"Seen = crossed the approved visibility threshold in an active
 * foreground conversation."* census §21.4 built the checkable half on a NEW
 * path — `POST /threads/:id/seen` takes a MESSAGE, not a clock reading, and
 * stamps that message's own `created_at` — and §21.5 then recorded, exactly,
 * why the row could not move:
 *
 *   > "It stays W because the legacy path in `routes/messaging.ts` still stamps
 *   > `now()` on any authenticated call and this lane does not own that file —
 *   > while both paths exist, seen is still whatever the client asserts on the
 *   > one that is wired into the app."
 *
 * The legacy path is the one the app calls: `markThreadRead` →
 * `POST /api/threads/:threadId/read` (`travel-buddy-standalone/src/services/messaging.ts`).
 * This file is that half.
 *
 * ── WHY `now()` IS NOT A THRESHOLD ──────────────────────────────────────────
 * `last_read_at = now()` is a claim about a moment, not about a message. It
 * asserts the caller has seen EVERYTHING up to the instant the request landed,
 * including messages that were never sent and messages the caller's §14.3
 * window forbids them from loading. It also asserted it for any authenticated
 * caller at all: the handler performed NO membership check and answered
 * `{ ok: true }` after updating zero rows, so a stranger got a success and the
 * thread got a `read.updated` broadcast naming them.
 *
 * The threshold has to be a MESSAGE, because that is the only thing whose
 * existence the server can check. The marker is therefore clamped to the newest
 * non-deleted message inside the caller's own window, and it never moves
 * backwards — the same two rules `routes/telegraphLifecycle.ts` follows, so the
 * two paths can no longer disagree about what "seen" means.
 *
 * ── WHAT THIS FILE DOES NOT CLAIM ───────────────────────────────────────────
 * "Active foreground conversation" is T71 and this census scores it `?`: the
 * server cannot observe foreground and no protocol change here would let it.
 * Nothing below asserts it.
 *
 * Run: node --import tsx/esm --test src/test/telegraphLegacyReadMarkerThreshold.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import messagingRouter from "../routes/messaging.js";
import {
  makeFakeClient,
  startRouter,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003"; // never a member of anything
const DM = "00000000-0000-4000-8000-00000000000d";
const EMPTY = "00000000-0000-4000-8000-00000000000e"; // a thread with no messages

const OLD = "2026-01-01T00:00:00.000Z";
const NEWEST = "2026-01-02T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const down = (t: string) => ({ message: `permission denied for relation ${t}`, code: "42501" });

async function post(base: string, path: string, asUser: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

function member(threadId: string, userId: string, over: Record<string, unknown> = {}) {
  return {
    thread_id: threadId, user_id: userId, role: "member", joined_at: OLD,
    left_at: null, last_read_at: null, muted_at: null, archived_at: null,
    visible_from_at: null, ...over,
  };
}

function msg(id: string, threadId: string, senderId: string, createdAt: string, over: Record<string, unknown> = {}) {
  return {
    id, thread_id: threadId, sender_id: senderId, body: "hello there friend",
    created_at: createdAt, deleted_at: null, edited_at: null,
    original_language: "en", language_detection_source: "provider",
    msg_type: "text", subtype: null, media_url: null, media_type: null,
    media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
    ...over,
  };
}

function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "A", account_status: null },
      { id: B, handle: "b", name: "B", account_status: null },
      { id: C, handle: "c", name: "C", account_status: null },
    ],
    message_threads: [
      { id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: OLD, updated_at: OLD, last_message_at: NEWEST },
      { id: EMPTY, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: OLD, updated_at: OLD, last_message_at: null },
    ],
    message_thread_members: [
      member(DM, A), member(DM, B), member(EMPTY, A),
    ],
    messages: [
      msg("11111111-0000-4000-8000-000000000001", DM, B, OLD),
      msg("11111111-0000-4000-8000-000000000002", DM, B, NEWEST),
    ],
    ...over,
  };
}

function use(state: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  _resetRateLimit();
  const c = makeFakeClient(state, opts);
  _setTestClient(c, true);
  return c;
}

let harness: RouterHarness;
before(async () => { harness = await startRouter(messagingRouter); });
after(async () => { await harness.close(); });
beforeEach(() => { resetFakeIds(); _resetRateLimit(); });

/** The marker actually written to the store, as opposed to the one reported. */
function markerFor(c: FakeClient, threadId: string, userId: string): string | null {
  const row = c._store.message_thread_members.find(
    (r: any) => r.thread_id === threadId && r.user_id === userId,
  );
  assert.ok(row, "the membership row vanished");
  return (row as any).last_read_at ?? null;
}

describe("§7.2 / T70 — the legacy read marker is a MESSAGE threshold, not a clock reading", () => {
  it("stamps the newest visible message's own created_at, never now()", async () => {
    const c = use(store());
    const r = await post(harness.base, `/threads/${DM}/read`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(
      r.body?.lastReadAt, NEWEST,
      `the marker must be the newest message's created_at — a clock reading asserts the caller ` +
        `saw messages that were never sent: ${JSON.stringify(r.body)}`,
    );
    assert.equal(markerFor(c, DM, A), NEWEST, "the stored marker must match the reported one");
  });

  it("the marker can never run AHEAD of the newest message in the thread", async () => {
    const c = use(store());
    await post(harness.base, `/threads/${DM}/read`, A);
    const stored = markerFor(c, DM, A);
    assert.ok(stored !== null, "nothing was stored");
    const newest = Math.max(
      ...c._store.messages
        .filter((m: any) => m.thread_id === DM && m.deleted_at === null)
        .map((m: any) => Date.parse(m.created_at)),
    );
    assert.ok(
      Date.parse(stored as string) <= newest,
      `the marker ran past the newest message: ${stored} > ${new Date(newest).toISOString()}`,
    );
  });

  it("a deleted message cannot be the threshold", async () => {
    const c = use(store({
      messages: [
        msg("11111111-0000-4000-8000-000000000001", DM, B, OLD),
        msg("11111111-0000-4000-8000-000000000002", DM, B, NEWEST, { deleted_at: NEWEST }),
      ],
    }));
    const r = await post(harness.base, `/threads/${DM}/read`, A);
    assert.equal(r.body?.lastReadAt, OLD, JSON.stringify(r.body));
    assert.equal(markerFor(c, DM, A), OLD);
  });

  it("the marker NEVER moves backwards", async () => {
    const c = use(store({
      message_thread_members: [member(DM, A, { last_read_at: FUTURE }), member(DM, B)],
    }));
    const r = await post(harness.base, `/threads/${DM}/read`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.advanced, false, JSON.stringify(r.body));
    assert.equal(markerFor(c, DM, A), FUTURE, "an existing marker ahead of the thread was rewound");
  });

  it("a thread with nothing visible leaves the marker alone and SAYS so", async () => {
    const c = use(store());
    const r = await post(harness.base, `/threads/${EMPTY}/read`, A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.advanced, false, JSON.stringify(r.body));
    assert.equal(markerFor(c, EMPTY, A), null, "a marker was invented for a thread with no messages");
  });

  it("the realtime receipt carries the threshold, not the wall clock", async () => {
    // Subscribed as B, the OTHER member: `publishToThread` excludes the caller,
    // so a subscription on A would receive nothing and this case would assert
    // nothing at all. That is the shape §21.6 caught twice as "a test that
    // could not fail", so the event is REQUIRED here rather than checked if
    // present.
    const seen: TelegraphEvent[] = [];
    const off = subscribe(B, (e) => { seen.push(e); });
    try {
      use(store());
      await post(harness.base, `/threads/${DM}/read`, A);
      await new Promise((r) => setTimeout(r, 50)); // the publish is fire-and-forget
      const receipts = seen.filter((e) => e.type === "read.updated");
      assert.equal(receipts.length, 1, `expected exactly one read.updated: ${JSON.stringify(seen)}`);
      assert.equal(
        (receipts[0] as any).payload?.lastReadAt, NEWEST,
        `the broadcast told the other member the caller had read up to a clock reading`,
      );
    } finally { off(); }
  });
});

describe("§7.2 / T70 — the legacy path is membership-gated, and honest when it cannot tell", () => {
  it("a caller who is not a member is REFUSED, not told ok", async () => {
    const seen: TelegraphEvent[] = [];
    const off = subscribe(A, (e) => { seen.push(e); });
    use(store());
    const r = await post(harness.base, `/threads/${DM}/read`, C);
    await new Promise((x) => setTimeout(x, 50));
    off();
    assert.equal(r.status, 403, `a stranger was given a success for a thread they are not in: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "forbidden", JSON.stringify(r.body));
    assert.equal(
      seen.length, 0,
      `a stranger's call broadcast a read receipt into somebody else's thread: ${JSON.stringify(seen)}`,
    );
  });

  it("a member who LEFT is refused with the words this file already uses", async () => {
    use(store({ message_thread_members: [member(DM, A, { left_at: NEWEST }), member(DM, B)] }));
    const r = await post(harness.base, `/threads/${DM}/read`, A);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, "forbidden", JSON.stringify(r.body));
  });

  it("an unreadable `message_thread_members` refuses RETRYABLY rather than reporting success", async () => {
    use(store(), { errors: { message_thread_members: down("message_thread_members") } });
    const r = await post(harness.base, `/threads/${DM}/read`, A);
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });

  it("an unreadable `messages` is not 'there is nothing to mark read'", async () => {
    const c = use(store(), { errors: { messages: down("messages") } });
    const r = await post(harness.base, `/threads/${DM}/read`, A);
    assert.equal(
      r.body?.error, "degraded_unavailable",
      `an unreadable messages table was reported as an empty conversation: ${JSON.stringify(r.body)}`,
    );
    assert.equal(markerFor(c, DM, A), null, "a marker was written from a read that never happened");
  });
});
