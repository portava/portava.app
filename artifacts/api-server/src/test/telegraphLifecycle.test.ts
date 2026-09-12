/**
 * Telegraph §7 — receipts, and unsend-before-seen.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §7.3 "For direct chats, show Sent/Delivered/Seen. For groups, derive
 *         'Seen by N' … Do not create permanent row-per-message-per-user
 *         receipt explosions."
 *   §7.4 "A sender may unsend only while no eligible recipient has seen the
 *         message. In a group, ONE recipient seeing the message closes the
 *         unseen-unsend window FOR EVERYONE. The server resolves read-vs-unsend
 *         races transactionally."
 *
 * The census scored T75/T76/T77 as N with the note that the only thing
 * resembling unsend is an unconditional DELETE. What is asserted here is the
 * rule §7.4 actually states, against the real route:
 *
 *   - an unseen message unsends;
 *   - a message ONE recipient has seen does not, even in a group where three
 *     others have not — this is the sentence a naive "have all recipients seen
 *     it?" implementation gets exactly backwards;
 *   - a departed member's stale last_read_at does not keep the window shut;
 *   - an unreadable receipt state fails CLOSED, never as "nobody has seen it";
 *   - a non-sender is refused before seen-ness is computed, so the endpoint
 *     cannot probe another person's read state.
 *
 * And the race: a read that lands during the write is COMPENSATED — the message
 * is put back, body intact — which is weaker than §7.4's "transactionally" and
 * is tested as the weaker thing it is.
 *
 * SHOWN RED before commit (32 pass green), each mutation reverted:
 *   • `planUnsend` refusing only when `seen.length === recipientCount` — i.e.
 *     "have they ALL seen it?", §7.4's sentence inverted
 *       -> pass 29 / fail 2 ("ONE of four recipients seeing it refuses the
 *          unsend for all of them", "REFUSES once a recipient has seen it, and
 *          writes nothing")
 *   • `eligibleRecipients` no longer excluding departed members
 *       -> pass 30 / fail 1 ("a DEPARTED member's stale read does not keep the
 *          window shut")
 *   • the `before.ok` fail-closed branch replaced with an empty member list
 *       -> pass 31 / fail 1 ("an unreadable receipt state FAILS CLOSED")
 *   • `detectReadRace` returning [] always (compensation never fires)
 *       -> pass 28 / fail 4 (both race-detector unit tests and both
 *          compensation route tests)
 *
 * THE THIRD MUTATION IS THE ONE WORTH READING. It first stayed GREEN: the
 * fail-closed test injected a failure on the whole `message_thread_members`
 * table, so the MEMBERSHIP GATE refused the request before the receipt read was
 * reached, and the branch under test never ran. The test asserted a status code
 * that a different guard produced. `failMemberReadsAfterGate` exists because of
 * that — it fails the receipt read and only the receipt read — and a second
 * test now covers the gate's own failure separately. A green run proves nothing
 * until it has been seen to go red, and this one had to be made able to.
 *
 * Run: node --import tsx/esm --test src/test/telegraphLifecycle.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphLifecycleRouter from "../routes/telegraphLifecycle.js";
import {
  detectReadRace,
  eligibleRecipients,
  planUnsend,
  receiptFor,
  seenByRecipients,
  unsendRefusalMessage,
  DELIVERED_UNAVAILABLE,
} from "../services/telegraph/unsend.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const DAVE = "dddddddd-0000-4000-8000-000000000004";

const THREAD = "eeeeeeee-0000-4000-8000-00000000000e";
const OTHER_THREAD = "eeeeeeee-0000-4000-8000-00000000000f";

const M_UNSEEN = "11110000-0000-4000-8000-00000000000a";
const M_SEEN = "11110000-0000-4000-8000-00000000000b";
const M_NOT_MINE = "11110000-0000-4000-8000-00000000000c";
const M_DELETED = "11110000-0000-4000-8000-00000000000d";

const NOW = Date.now();
const mins = (n: number) => new Date(NOW + n * 60_000).toISOString();

// ── pure §7 logic ────────────────────────────────────────────────────────────

describe("§7.3 — receipts, derived and not stored", () => {
  const message = { id: "m", thread_id: "t", sender_id: ALICE, created_at: mins(-10) };

  it("is SENT while no eligible recipient has read past it", () => {
    const r = receiptFor(message, [
      { user_id: ALICE, last_read_at: mins(-1) },
      { user_id: BOB, last_read_at: mins(-30) },
      { user_id: CAROL, last_read_at: null },
    ]);
    assert.equal(r.status, "SENT");
    assert.equal(r.seenBy, 0);
    assert.equal(r.recipientCount, 2);
  });

  it("derives §7.3's 'Seen by N' for a group", () => {
    const r = receiptFor(message, [
      { user_id: ALICE, last_read_at: mins(-1) },
      { user_id: BOB, last_read_at: mins(-5) },
      { user_id: CAROL, last_read_at: mins(-2) },
      { user_id: DAVE, last_read_at: mins(-30) },
    ]);
    assert.equal(r.status, "SEEN");
    assert.equal(r.seenBy, 2);
    assert.deepEqual(r.seenByUserIds.sort(), [BOB, CAROL].sort());
    assert.equal(r.recipientCount, 3);
  });

  it("the SENDER's own read never counts as a recipient seeing it", () => {
    const r = receiptFor(message, [{ user_id: ALICE, last_read_at: mins(-1) }]);
    assert.equal(r.seenBy, 0);
    assert.equal(r.recipientCount, 0);
  });

  it("reports DELIVERED as null with a reason, never as a measured false", () => {
    const r = receiptFor(message, [{ user_id: BOB, last_read_at: null }]);
    assert.equal(r.delivered, null);
    assert.match(r.deliveredUnavailableReason, /no per-device acknowledgement/i);
    assert.equal(r.deliveredUnavailableReason, DELIVERED_UNAVAILABLE);
  });

  it("a read stamped exactly at the message's own time includes it", () => {
    const r = receiptFor(message, [{ user_id: BOB, last_read_at: message.created_at }]);
    assert.equal(r.seenBy, 1);
  });
});

describe("§7.4 — one recipient closes the window for everyone", () => {
  const base = { id: M_UNSEEN, thread_id: THREAD, sender_id: ALICE, created_at: mins(-10) };

  it("an unseen message is eligible", () => {
    const plan = planUnsend({
      message: base,
      members: [
        { user_id: ALICE, last_read_at: mins(-1) },
        { user_id: BOB, last_read_at: mins(-40) },
        { user_id: CAROL, last_read_at: null },
      ],
      actorId: ALICE,
      actorIsActiveMember: true,
    });
    assert.equal(plan.eligible, true);
  });

  it("ONE of four recipients seeing it refuses the unsend for all of them", () => {
    const plan = planUnsend({
      message: base,
      members: [
        { user_id: ALICE, last_read_at: mins(-1) },
        { user_id: BOB, last_read_at: mins(-2) }, // saw it
        { user_id: CAROL, last_read_at: mins(-40) },
        { user_id: DAVE, last_read_at: null },
      ],
      actorId: ALICE,
      actorIsActiveMember: true,
    });
    assert.equal(plan.eligible, false);
    assert.equal(plan.eligible === false && plan.refusal, "seen_by_recipient");
    assert.equal(plan.seenBy, 1);
    assert.equal(plan.recipientCount, 3);
  });

  it("a DEPARTED member's stale read does not keep the window shut", () => {
    const members = [
      { user_id: ALICE, last_read_at: mins(-1), left_at: null },
      { user_id: BOB, last_read_at: mins(-2), left_at: mins(-5) }, // read, then left
      { user_id: CAROL, last_read_at: null, left_at: null },
    ];
    assert.deepEqual(seenByRecipients(base, members), []);
    assert.equal(eligibleRecipients(members, ALICE).length, 1);
    const plan = planUnsend({ message: base, members, actorId: ALICE, actorIsActiveMember: true });
    assert.equal(plan.eligible, true);
  });

  it("refuses a non-sender BEFORE computing seen-ness", () => {
    const plan = planUnsend({
      message: base,
      members: [{ user_id: BOB, last_read_at: mins(-1) }],
      actorId: BOB,
      actorIsActiveMember: true,
    });
    assert.equal(plan.eligible === false && plan.refusal, "not_sender");
    // seenBy stays 0 — the refusal leaks nothing about who has read it.
    assert.equal(plan.seenBy, 0);
  });

  it("refuses an already-gone message", () => {
    const plan = planUnsend({
      message: { ...base, deleted_at: mins(-1) },
      members: [{ user_id: BOB, last_read_at: null }],
      actorId: ALICE,
      actorIsActiveMember: true,
    });
    assert.equal(plan.eligible === false && plan.refusal, "already_gone");
  });

  it("refuses a sender who has left the thread", () => {
    const plan = planUnsend({
      message: base,
      members: [{ user_id: BOB, last_read_at: null }],
      actorId: ALICE,
      actorIsActiveMember: false,
    });
    assert.equal(plan.eligible === false && plan.refusal, "not_a_member");
  });

  it("names how many saw it, in words a sender can act on", () => {
    assert.match(unsendRefusalMessage("seen_by_recipient", 1), /Someone has already seen/);
    assert.match(unsendRefusalMessage("seen_by_recipient", 3), /^3 people have already seen/);
  });
});

describe("§7.4 — the race detector compares sets, not counts", () => {
  it("finds a reader who was not there before", () => {
    assert.deepEqual(detectReadRace([BOB], [BOB, CAROL]), [CAROL]);
  });

  it("is not fooled by one leaving as another reads", () => {
    // Same count either side; a count comparison would call this quiet.
    assert.deepEqual(detectReadRace([BOB], [CAROL]), [CAROL]);
  });

  it("reports nothing when nothing changed", () => {
    assert.deepEqual(detectReadRace([BOB], [BOB]), []);
  });
});

// ── the routes ───────────────────────────────────────────────────────────────

interface State {
  errorTable?: string;
  /**
   * Fail member reads AFTER the membership gate's own read.
   *
   * `errorTable: "message_thread_members"` is not enough to test the
   * fail-closed receipt branch: the gate reads that table first, so the
   * request is refused before the receipt read is ever reached. A mutation
   * that made the receipt read fail OPEN stayed green under it — which is how
   * this flag came to exist.
   */
  failMemberReadsAfterGate?: boolean;
  bobReadAt?: string | null;
  /** Stamp this member's read DURING the unsend write, to force the race. */
  raceRead?: { userId: string; at: string };
  restoreFails?: boolean;
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "telegraph_history_bound_enabled", enabled: false }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: mins(-1) },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: state.bobReadAt === undefined ? mins(-40) : state.bobReadAt },
      { thread_id: THREAD, user_id: CAROL, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: OTHER_THREAD, user_id: DAVE, left_at: null, visible_from_at: null, last_read_at: null },
    ],
    messages: [
      { id: M_UNSEEN, thread_id: THREAD, sender_id: ALICE, created_at: mins(-10), deleted_at: null, edited_at: null, body: "meet at the pier" },
      { id: M_SEEN, thread_id: THREAD, sender_id: ALICE, created_at: mins(-50), deleted_at: null, edited_at: null, body: "seen already" },
      { id: M_NOT_MINE, thread_id: THREAD, sender_id: BOB, created_at: mins(-10), deleted_at: null, edited_at: null, body: "bob's" },
      { id: M_DELETED, thread_id: THREAD, sender_id: ALICE, created_at: mins(-10), deleted_at: mins(-2), edited_at: null, body: "" },
    ],
  };
}

const copy = (rows: any[]) => rows.map((r) => ({ ...r }));

function makeClient(state: State) {
  const db = fixture(state);
  let memberReads = 0;

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingUpdate: any = null;

    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const err = () => {
      if (state.errorTable === table) return { message: `injected failure on ${table}`, code: "XX000" };
      if (
        state.failMemberReadsAfterGate &&
        table === "message_thread_members" &&
        memberReads >= 1
      ) {
        return { message: "injected failure on the receipt read", code: "XX000" };
      }
      return null;
    };

    const applyUpdate = () => {
      const hit = rowsNow();
      for (const r of hit) Object.assign(r, pendingUpdate);
      return copy(hit);
    };

    /**
     * PostgREST hands back FRESH JSON on every read; it does not hand back a
     * live reference into the table. An earlier version of this fake returned
     * the stored objects themselves, and the read-vs-unsend race test passed
     * vacuously because the "before" snapshot mutated under the route's feet.
     * Copying is not politeness — it is what makes the race testable at all.
     */

    const settle = () => {
      const e = err();
      if (e) return { data: null, error: e, count: null };
      if (pendingUpdate) {
        if (state.restoreFails && pendingUpdate.deleted_at === null) {
          return { data: null, error: { message: "restore blocked", code: "XX000" }, count: null };
        }
        return { data: applyUpdate(), error: null, count: null };
      }
      // The route reads message_thread_members three times: the membership
      // gate, the receipts BEFORE the write, and the receipts AFTER it. The
      // race is stamped so it is invisible to the second and visible to the
      // third — which is precisely the window compensation exists for.
      if (table === "message_thread_members") {
        memberReads += 1;
      }
      if (table === "message_thread_members" && state.raceRead) {
        if (memberReads === 3) {
          const row = (db.message_thread_members ?? []).find(
            (m) => m.thread_id === THREAD && m.user_id === state.raceRead!.userId,
          );
          if (row) row.last_read_at = state.raceRead.at;
        }
      }
      return { data: copy(rowsNow()), error: null, count: null };
    };

    const target: any = {
      select() { return proxy; },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      gte(col: string, val: any) { filters.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      order() { return proxy; },
      limit() { return proxy; },
      maybeSingle() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : ((s.data as any[]) ?? [])[0] ?? null, error: s.error });
      },
      single() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : ((s.data as any[]) ?? [])[0] ?? null, error: s.error });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        return Promise.resolve(settle()).then(resolve, reject);
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
    _db: db,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let baseUrl = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c, true);
  return c;
}

async function call(method: string, path: string, asUser: string) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphLifecycleRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  await new Promise<void>((r) => server.close(() => r()));
});

describe("POST /threads/:id/messages/:id/unsend", () => {
  it("unsends an unseen message and blanks its body", async () => {
    const c = useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.unsent, true);
    assert.equal(r.body.seenBy, 0);
    const row = c._db.messages.find((m: any) => m.id === M_UNSEEN);
    assert.ok(row.deleted_at, "the row is a tombstone");
    assert.equal(row.body, "", "the body is blanked, not nulled — body is NOT NULL");
  });

  it("REFUSES once a recipient has seen it, and writes nothing", async () => {
    const c = useState({ bobReadAt: mins(-5) });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "seen_by_recipient");
    assert.equal(r.body.seenBy, 1);
    const row = c._db.messages.find((m: any) => m.id === M_UNSEEN);
    assert.equal(row.deleted_at, null, "a refused unsend must not have written");
    assert.equal(row.body, "meet at the pier");
  });

  it("refuses someone else's message", async () => {
    const c = useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_NOT_MINE}/unsend`, ALICE);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_sender");
    assert.equal(c._db.messages.find((m: any) => m.id === M_NOT_MINE).deleted_at, null);
  });

  it("refuses a message that is already gone", async () => {
    useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_DELETED}/unsend`, ALICE);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "already_gone");
  });

  it("refuses a non-member before reading the message at all", async () => {
    useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, DAVE);
    assert.equal(r.status, 403);
  });

  it("404s a message that is not in this thread", async () => {
    useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_SEEN.replace(/b$/, "9")}/unsend`, ALICE);
    assert.equal(r.status, 404);
  });

  it("an unreadable receipt state FAILS CLOSED, never as 'nobody saw it'", async () => {
    // The gate's own read succeeds; the RECEIPT read is what fails. Failing the
    // whole table instead would be refused at the gate and would never reach
    // the branch this test exists for.
    const c = useState({ failMemberReadsAfterGate: true });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.ok(r.status >= 400, "must not succeed on an unreadable receipt state");
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).deleted_at, null);
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).body, "meet at the pier");
  });

  it("a thread whose membership cannot be read is refused at the gate", async () => {
    const c = useState({ errorTable: "message_thread_members" });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.ok(r.status >= 400);
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).deleted_at, null);
  });

  it("says out loud that there is no UNSENT lifecycle state to set", async () => {
    useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.body.lifecycleState, null);
    assert.match(r.body.lifecycleStateUnavailableReason, /no lifecycle column/i);
  });
});

describe("§7.4 — the read-vs-unsend race is compensated, not locked", () => {
  it("puts the message back, body intact, when a read lands during the write", async () => {
    const c = useState({ raceRead: { userId: BOB, at: mins(-1) } });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "seen_by_recipient");
    assert.equal(r.body.raceDetected, true);
    assert.equal(r.body.compensated, true);
    const row = c._db.messages.find((m: any) => m.id === M_UNSEEN);
    assert.equal(row.deleted_at, null, "the message is back");
    assert.equal(row.body, "meet at the pier", "the body is back verbatim");
  });

  it("tells the sender the truth when the compensation itself fails", async () => {
    useState({ raceRead: { userId: BOB, at: mins(-1) }, restoreFails: true });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.raceDetected, true);
    assert.equal(r.body.compensated, false);
    assert.match(r.body.message, /could not put it back/i);
  });
});

describe("GET /threads/:id/receipts", () => {
  it("returns §7.3's receipt for the caller's own messages", async () => {
    useState({ bobReadAt: mins(-5) });
    const r = await call("GET", `/api/threads/${THREAD}/receipts?messageIds=${M_UNSEEN},${M_SEEN}`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.receipts.length, 2);
    const unseen = r.body.receipts.find((x: any) => x.messageId === M_UNSEEN);
    assert.equal(unseen.status, "SEEN");
    assert.equal(unseen.seenBy, 1);
    assert.equal(unseen.recipientCount, 2);
  });

  it("does not answer who read someone ELSE's message", async () => {
    useState({ bobReadAt: mins(-5) });
    const r = await call("GET", `/api/threads/${THREAD}/receipts?messageIds=${M_NOT_MINE}`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.receipts, []);
  });

  it("states §7.3's storage shape rather than only obeying it", async () => {
    useState({});
    const r = await call("GET", `/api/threads/${THREAD}/receipts?messageIds=${M_UNSEEN}`, ALICE);
    assert.equal(r.body.receiptStorage, "one row per member per thread; none per message");
  });

  it("refuses a non-member", async () => {
    useState({});
    const r = await call("GET", `/api/threads/${THREAD}/receipts?messageIds=${M_UNSEEN}`, DAVE);
    assert.equal(r.status, 403);
  });

  it("requires messageIds and caps how many", async () => {
    useState({});
    const empty = await call("GET", `/api/threads/${THREAD}/receipts`, ALICE);
    assert.equal(empty.status, 400);
    const many = Array.from({ length: 101 }, () => M_UNSEEN).join(",");
    const over = await call("GET", `/api/threads/${THREAD}/receipts?messageIds=${many}`, ALICE);
    assert.equal(over.status, 400);
  });

  it("a failed member read is a 500, never an all-unseen receipt", async () => {
    useState({ errorTable: "message_thread_members" });
    const r = await call("GET", `/api/threads/${THREAD}/receipts?messageIds=${M_UNSEEN}`, ALICE);
    assert.ok(r.status >= 400);
  });
});
