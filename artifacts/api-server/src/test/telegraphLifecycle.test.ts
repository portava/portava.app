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
 * And the race: §7.4's "transactionally" is now MET, and this file changed
 * shape because of it. The route no longer reads, decides and writes; it calls
 * `public.telegraph_unsend_message_before_seen` (migration 3000), which takes
 * row locks on the message and on every eligible recipient's receipt row before
 * it reads `last_read_at`. The COMPENSATION scheme the earlier version of this
 * suite tested — write, re-read, put the message back if a read had landed — is
 * gone, and so are its tests. What replaced them asserts the stronger property
 * directly: there is no window to be unsure about, so there is no `raceDetected`
 * to report and no `unverifiable` refusal for when a re-read failed.
 *
 * ── MUTATIONS, RE-MEASURED 2026-09-23 AGAINST THE LOCKING BUILD ─────────────
 * The record below replaces the pre-locking one, which described mutations to
 * `detectReadRace`, the post-write read and the compensation route tests. Those
 * three no longer exist, so their numbers could not be re-measured and are left
 * in git history rather than restated here as if they still meant something.
 *
 * Baseline: this suite 46/46, telegraphCommandRoute 36/36,
 * telegraphUnsendFunctionFake 18/18. Each mutation applied alone and reverted.
 *
 *   M1  `unsendBeforeSeen` ignoring the rpc `error` (`if (error)` -> `void error;`)
 *         -> this suite 45/46, command route 35/36
 *   M2  the closed outcome list opened — `isUnsendOutcome(row.outcome)` relaxed
 *       to `typeof row.outcome === "string"`
 *         -> this suite 45/46, command route 35/36
 *   M3  a null verdict read as success — `if (verdict === null)` in
 *       routes/telegraphLifecycle.ts replaced with `if (false as boolean)`
 *         -> this suite 42/46, command route 36/36 (not that route's code)
 *   M4  MODELLED_OUTCOME_ORDER's two `already_*` entries swapped
 *         -> fake-model suite 17/18
 *   M5  the same two swapped in migration 3000's SQL instead
 *         -> fake-model suite 17/18
 *   M6  `planUnsend` refusing a departed sender BEFORE noticing the message was
 *       already gone — the order it actually shipped with
 *         -> fake-model suite 17/18
 *   M7  §7.4's sentence inverted — `planUnsend` refusing only when
 *       `seen.length === recipientCount`, i.e. "have they ALL seen it?"
 *         -> this suite 45/46, fake-model suite 17/18, command route 36/36
 *   M8  `eligibleRecipients` no longer excluding departed members, so a stale
 *       `last_read_at` keeps the window shut forever
 *         -> this suite 45/46, fake-model suite 17/18, command route 36/36
 *   M9  the receipt-row lock MOVED below the seen-check in migration 3000 —
 *       still two FOR UPDATE clauses, guarantee gone
 *         -> fake-model suite 17/18; the clause-COUNT test stayed green under
 *            it, which is why an order assertion was added beside it
 *   M10 the §13.1 command route treating `already_unsent` as success
 *         -> command route 33/36
 *   M11 the model re-stamping `unsent_at` on the already-unsent path while
 *       still answering `already_unsent`
 *         -> command route 34/36
 *
 * The command route survives M7 and M8 because it decides through the function,
 * not through `planUnsend`. That is not a gap: it is the point of the split, and
 * the cross-check is what stops the unexercised copy from rotting unseen.
 *
 * M11 IS THE SECOND ONE THAT WAS GREEN FOR THE WRONG REASON. The retry test
 * asserts that a retry does not move `unsent_at`, and it passed under M11 —
 * because the fake's `unsentAt` was a pinned constant, so the re-stamp wrote
 * the same string. The option now takes a function, both tests hand it a
 * sequence, and M11 kills. A constant fixture can make a real assertion
 * unfalsifiable without anything about the assertion looking wrong.
 *
 * M1, M2 AND M3 ALL SURVIVED THEIR FIRST MEASUREMENT, and the reasons are worth
 * more than the numbers.
 *
 * M1 survived because an ordinary rpc failure answers `data: null`, which the
 * shape check rejects on its own: a build that never looked at `error` refused
 * anyway, and every test passed for the wrong reason. It only became killable
 * once the fake grew `errorWithSuccessPayload` — an error arriving WITH a
 * plausible success row, the one shape that separates "reads error" from
 * "happens to reject null". PR #472's own M4 recorded the identical trap.
 *
 * M2 and M3 survived HERE while the command-route suite killed M2, because the
 * assertions in this file were `assert.ok(r.status >= 400)`. A build that lets
 * an unknown outcome through falls into the refusal branch and answers
 * `409 already_gone`; a build that reads a null verdict as success crashes into
 * a 500. Both are >= 400, and both are lies about what happened. Four
 * assertions were changed to name the answer — `assert.equal(r.body.error,
 * "db_error")` — and both mutations then killed. The numbers above are the
 * post-strengthening ones.
 *
 * M4 and M5 are one swap from opposite sides, and both are recorded because
 * either alone proves less: killing M4 shows the pin test reads the model,
 * killing M5 shows it reads the migration rather than comparing the model with
 * itself.
 *
 * M6 IS NOT A MUTATION I INVENTED — it is the code that was here. `planUnsend`
 * is documented as "the same rule in TypeScript", and nothing checked that
 * claim, so it had drifted: it refused a departed sender before noticing the
 * message was already gone, and the function answers in the other order. The
 * cross-check in telegraphUnsendFunctionFake.test.ts found it, `planUnsend` was
 * aligned to the function, and both routes' outcome-to-refusal mapping now goes
 * through one exported `refusalForOutcome` so there is no second copy to drift.
 *
 * A green run proves nothing until it has been seen to go red. Four of these
 * eleven were green the first time (M1, M2, M3, M11), and not one of the four
 * was green because the code was right.
 *
 * The earlier fail-closed mutation on `before.ok` is still worth reading for
 * why `failMemberReadsAfterGate` exists: injecting a failure on the whole
 * `message_thread_members` table made the MEMBERSHIP GATE refuse first, so the
 * branch under test never ran and the test asserted a status code a different
 * guard produced. That helper fails the receipt read and only the receipt read,
 * and a second test covers the gate's own failure separately.
 *
 * Run: node --import tsx/esm --test src/test/telegraphLifecycle.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphLifecycleRouter from "../routes/telegraphLifecycle.js";
import { makeUnsendFunctionFake } from "./telegraphUnsendFunctionFake.js";
import {
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
  /**
   * `telegraph_unsend_message_before_seen` itself fails.
   *
   * The receipt reads the route used to do for itself live inside that function
   * now, so this is how "we could not check whether anyone saw it" arrives. The
   * post-write read, and the `raceRead` / `restoreFails` injections that drove
   * the compensation scheme, are gone with the scheme.
   */
  unsendFunctionFails?: boolean;
  /** The function answers with an outcome this build has never heard of. */
  unsendFunctionUnknownOutcome?: boolean;
  /** An error arrives WITH a success-looking payload. */
  unsendFunctionErrorWithPayload?: boolean;
  /** Pin the timestamp the function writes, so a test can assert on the row. */
  unsendAt?: string;
  /** Rows appended to `messages`, so a new case cannot perturb an old one. */
  extraMessages?: any[];
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
      ...(state.extraMessages ?? []),
    ],
  };
}

const copy = (rows: any[]) => rows.map((r) => ({ ...r }));

function makeClient(state: State) {
  const db = fixture(state);
  let memberReads = 0;
  const messageUpdates: any[] = [];

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
        // Recorded so a test can assert the unsend route writes NOTHING here:
        // every column it used to set is set inside the locking function now.
        if (table === "messages") messageUpdates.push(pendingUpdate);
        return { data: applyUpdate(), error: null, count: null };
      }
      // The route reads message_thread_members twice: the membership gate and
      // the receipts. It used to read a third time, after its own write, to
      // detect a read that had landed during it; the lock removed both.
      if (table === "message_thread_members") {
        memberReads += 1;
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
    _messageUpdates: messageUpdates,
    from,
    rpc: makeUnsendFunctionFake(
      () => ({ messages: db.messages as any[], message_thread_members: db.message_thread_members as any[] }),
      {
        rpcError: state.unsendFunctionFails,
        unknownOutcome: state.unsendFunctionUnknownOutcome,
        errorWithSuccessPayload: state.unsendFunctionErrorWithPayload,
        unsentAt: state.unsendAt,
      },
    ),
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
  // 127.0.0.1 explicitly: a host-less listen(0) binds the IPv6 wildcard and the
  // kernel can hand back a port a foreign process already holds on loopback.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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
    // The guarantee is unchanged; where the receipt read lives is not. It used
    // to be this route's second read of message_thread_members, and
    // `failMemberReadsAfterGate` existed to fail that read and only that read.
    // It is inside telegraph_unsend_message_before_seen now, so the whole call
    // failing is how "we could not check" arrives — and the route must still
    // refuse rather than write.
    const c = useState({ unsendFunctionFails: true });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.body.error, "db_error", "must not succeed, and must not read as a refusal");
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).deleted_at, null);
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).body, "meet at the pier");
  });

  it("a thread whose membership cannot be read is refused at the gate", async () => {
    const c = useState({ errorTable: "message_thread_members" });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.ok(r.status >= 400);
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).deleted_at, null);
  });

  it("still says lifecycleState is unavailable, for a reason that has CHANGED", async () => {
    // The old reason was "public.messages has no lifecycle column". Migration
    // 2810 added one and 3000 writes 'unsent' to it, so that sentence became
    // false and had to be replaced rather than kept. The FIELD stays null,
    // because the distinction still does not reach a reader: 81 non-test files
    // read `messages` and four mention `unsent_at`, so a person sees the
    // deleted-message slot either way. Publishing a state here would be a claim
    // about readers that have not changed.
    useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.body.lifecycleState, null);
    assert.doesNotMatch(r.body.lifecycleStateUnavailableReason, /no lifecycle column/i,
      "that reason is no longer true, and a stale reason is worse than none");
    assert.match(r.body.lifecycleStateUnavailableReason, /no reader in this codebase distinguishes it/i);
  });
});

describe("§7.4 — the read-vs-unsend race is LOCKED, not compensated", () => {
  /*
   * This block used to be headed "compensated, not locked" and tested the
   * scheme that stood in for a lock: write, re-read the receipts, and put the
   * message back if a read had landed. Every one of those tests measured a
   * WINDOW — an interval in which a recipient could fetch a tombstone that was
   * about to be restored.
   *
   * The window is gone, so the tests that measured it cannot be kept. What they
   * protected is kept, and is stronger here. The guarantee was always: a
   * message somebody has seen must not stay unsent, and the sender must be told
   * the truth rather than handed a success. Under
   * `telegraph_unsend_message_before_seen` the refusal happens BEFORE the write
   * instead of being undone after it, so there is nothing to put back and no
   * interval to be wrong about.
   */

  it("a seen message is refused BEFORE anything is written", async () => {
    const c = useState({ bobReadAt: mins(-1) });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "seen_by_recipient");
    const row = c._db.messages.find((m: any) => m.id === M_UNSEEN);
    assert.equal(row.deleted_at, null, "never written, so never needed putting back");
    assert.equal(row.body, "meet at the pier");
  });

  it("raceDetected and compensated are FALSE on that refusal, and are facts now", async () => {
    // They used to be measurements that could come back null when the
    // post-write read failed. There is no post-write read.
    useState({ bobReadAt: mins(-1) });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.body.raceDetected, false);
    assert.equal(r.body.compensated, false);
  });

  it("raceDetected is present and FALSE on success, not null", async () => {
    useState({});
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.status, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(r.body, "raceDetected"));
    assert.equal(r.body.raceDetected, false,
      "false, not null: the lock is what turns this negative into a measurement");
    assert.equal(r.body.compensated, false);
  });

  it("there is no `unverifiable` answer any more, because there is nothing to verify", async () => {
    const c = useState({ unsendFunctionFails: true });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.notEqual(r.body.error, "unverifiable");
    assert.equal(r.body.error, "db_error", "a failed call must not read as a success OR as a refusal");
    const row = c._db.messages.find((m: any) => m.id === M_UNSEEN);
    assert.equal(row.deleted_at, null, "nothing was written, so nothing needs undoing");
    assert.equal(row.body, "meet at the pier");
  });

  it("an ERROR is read even when the payload looks like a success", async () => {
    // The injection that separates "reads `error`" from "rejects a null body".
    // An ordinary failure answers data:null and is refused by the shape check
    // alone, so it cannot tell the two apart.
    const c = useState({ unsendFunctionErrorWithPayload: true });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.body.error, "db_error",
      "a FAILURE, named as one — not a refusal (which would say already_gone) and not a crash");
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).deleted_at, null);
  });

  it("an outcome this build has never heard of is a FAILURE, not permission", async () => {
    const c = useState({ unsendFunctionUnknownOutcome: true });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    // `status >= 400` is not enough and was measured to be not enough: a build
    // that let an unknown outcome through would fall into the refusal branch
    // and answer 409 already_gone, which is also >= 400 and is a lie about what
    // happened. The distinction is the whole point of a closed outcome list.
    assert.equal(r.body.error, "db_error");
    assert.equal(c._db.messages.find((m: any) => m.id === M_UNSEEN).deleted_at, null);
  });

  it("the route itself writes nothing to `messages`", async () => {
    // The strongest statement this suite can make about the change: a handler
    // that goes back to deciding in Node has to write, and this fails.
    const c = useState({ unsendAt: mins(0) });
    const r = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(c._messageUpdates, [],
      "every write must come from telegraph_unsend_message_before_seen");
  });

  it("the row the function leaves records an UNSEND, not a delete", async () => {
    // The old `unsentPatch` set deleted_at and body and forgot unsent_at
    // entirely, so an unsend was stored as a delete and §13.2's outbox
    // published message.deleted.
    const c = useState({ unsendAt: mins(0) });
    await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    const row = c._db.messages.find((m: any) => m.id === M_UNSEEN);
    assert.equal(row.unsent_at, mins(0), "unsent_at is what makes it an unsend");
    assert.equal(row.lifecycle_state, "unsent");
    assert.equal(row.deleted_at, mins(0), "and deleted_at is what every reader suppresses on");
    assert.equal(row.body, "");
  });

  it("a repeat unsend is refused as already_gone, on the wire exactly as before", async () => {
    useState({});
    const first = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(first.status, 200);
    const second = await call("POST", `/api/threads/${THREAD}/messages/${M_UNSEEN}/unsend`, ALICE);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "already_gone",
      "the function tells already_unsent from already_deleted; this endpoint published one word and still does");
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

  it("an unreadable receipt state FAILS CLOSED here too, never as 'nobody saw it'", async () => {
    // The gate's own read succeeds and the RECEIPT read is what fails, which is
    // what `failMemberReadsAfterGate` is for. It used to cover the unsend
    // route's receipt read as well; that read moved into the locking function,
    // so this endpoint is where the injection still has a subject — and the
    // rule is the same one. A receipt built on a failed read would assert a
    // negative nobody measured.
    useState({ failMemberReadsAfterGate: true });
    const r = await call("GET", `/api/threads/${THREAD}/receipts?messageIds=${M_UNSEEN}`, ALICE);
    assert.ok(r.status >= 400, "must not answer with receipts it could not read");
    assert.equal(r.body.receipts, undefined);
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

// ── §13.2 `message.seen` — a PER-MESSAGE seen fact ───────────────────────────
//
// census-telegraph T179: "`read.updated` … carries a thread-level
// `lastReadAt`, not a per-message seen fact, so no consumer can answer 'was
// *this* message seen'."
//
// And T70: seen "is whatever the client asserts: `routes/messaging.ts`
// stamps `message_thread_members.last_read_at = now()` on any authenticated
// call, with no visibility predicate the server can check."
//
// Both are about the same hole from two sides. What is asserted here is the
// predicate and the fact:
//   - the threshold a client may assert is a MESSAGE it is authorized to see,
//     not a clock reading, so "seen" cannot run ahead of what was sent;
//   - the event names the message ids that crossed, so a consumer can answer
//     "was this one seen" without re-deriving anything;
//   - the reader's own messages are never announced as seen by the reader;
//   - the marker never moves backwards.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { subscribe as subscribeEvents, type TelegraphEvent } from "../lib/telegraphEvents.js";

function recordEvents(userIds: string[]) {
  const seen = new Map<string, { events: TelegraphEvent[]; stop: () => void }>();
  for (const u of userIds) {
    const events: TelegraphEvent[] = [];
    const stop = subscribeEvents(u, (e) => events.push(e));
    seen.set(u, { events, stop });
  }
  return seen;
}

const settleEvents = () => new Promise<void>((r) => setTimeout(r, 20));

async function postJson(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

describe("POST /threads/:id/seen — §7.2's threshold, §13.2's message.seen", () => {
  it("names the messages that crossed, not a thread-level timestamp", async () => {
    const c = useState({ bobReadAt: mins(-60) });
    const rec = recordEvents([ALICE, BOB, CAROL]);
    const r = await postJson(`/api/threads/${THREAD}/seen`, BOB, { upToMessageId: M_UNSEEN });
    assert.equal(r.status, 200);
    // M_SEEN (-50) and M_UNSEEN (-10) are Alice's and both precede the
    // threshold; M_NOT_MINE is Bob's own and is never "seen by Bob".
    assert.deepEqual([...r.body.seenMessageIds].sort(), [M_SEEN, M_UNSEEN].sort());
    await settleEvents();
    const ev = rec.get(ALICE)!.events.find((e) => e.type === "message.seen");
    assert.ok(ev, "the sender was not told which of their messages were seen");
    assert.equal((ev!.payload as any).readerId, BOB);
    assert.deepEqual([...((ev!.payload as any).messageIds as string[])].sort(), [M_SEEN, M_UNSEEN].sort());
    for (const x of rec.values()) x.stop();
    assert.ok(c);
  });

  it("the marker is the MESSAGE's time, not the request clock — a later message is NOT seen", async () => {
    // M_LATER is sent after the threshold M_UNSEEN. If the marker were stamped
    // `now()` the way the legacy read path does, M_LATER would be swept up as
    // "seen" by a person who has not reached it.
    const M_LATER = "11110000-0000-4000-8000-00000000000e";
    const c = useState({
      bobReadAt: mins(-60),
      extraMessages: [
        { id: M_LATER, thread_id: THREAD, sender_id: CAROL, created_at: mins(-5), deleted_at: null, edited_at: null, body: "after the threshold" },
      ],
    });
    const r = await postJson(`/api/threads/${THREAD}/seen`, BOB, { upToMessageId: M_UNSEEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.seenMessageIds.includes(M_LATER), false, "a message the reader has not reached was marked seen");
    assert.equal(r.body.lastReadAt, mins(-10), "the marker was not the threshold message's own timestamp");
    const bob = c._db.message_thread_members.find((m: any) => m.thread_id === THREAD && m.user_id === BOB);
    assert.equal(bob.last_read_at, mins(-10));
  });

  it("does not announce the reader's OWN messages as seen by the reader", async () => {
    useState({ bobReadAt: mins(-60) });
    const r = await postJson(`/api/threads/${THREAD}/seen`, BOB, { upToMessageId: M_UNSEEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.seenMessageIds.includes(M_NOT_MINE), false);
  });

  it("refuses a threshold that is not a message in this thread — seen cannot outrun what was sent", async () => {
    useState({});
    const r = await postJson(`/api/threads/${THREAD}/seen`, BOB, {
      upToMessageId: "99990000-0000-4000-8000-000000000099",
    });
    assert.equal(r.status, 404);
    // The code, not just the status: before this route existed, express's own
    // 404 satisfied `status === 404` and the assertion could not fail.
    assert.equal(r.body.error, "not_found");
  });

  it("refuses a threshold that belongs to another conversation", async () => {
    useState({});
    // Dave's thread. Bob is not in it and its messages are not his to assert on.
    const r = await postJson(`/api/threads/${OTHER_THREAD}/seen`, BOB, { upToMessageId: M_UNSEEN });
    assert.equal(r.status, 403);
  });

  it("never moves the marker backwards, and says so instead of pretending it did", async () => {
    // Bob has already read past everything.
    const c = useState({ bobReadAt: mins(10) });
    const r = await postJson(`/api/threads/${THREAD}/seen`, BOB, { upToMessageId: M_SEEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.advanced, false);
    assert.deepEqual(r.body.seenMessageIds, []);
    const bob = c._db.message_thread_members.find((m: any) => m.thread_id === THREAD && m.user_id === BOB);
    assert.equal(bob.last_read_at, mins(10), "the read marker went backwards");
  });

  it("a non-member is refused", async () => {
    useState({});
    const r = await postJson(`/api/threads/${THREAD}/seen`, DAVE, { upToMessageId: M_UNSEEN });
    assert.equal(r.status, 403);
  });

  it("an unreadable messages table is a 500, never a silent advance", async () => {
    useState({ errorTable: "messages" });
    const r = await postJson(`/api/threads/${THREAD}/seen`, BOB, { upToMessageId: M_UNSEEN });
    assert.equal(r.status, 500);
  });
});

describe("§13.2 — message.seen is in the event union", () => {
  it("is declared, and read.updated is kept alongside it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../lib/telegraphEvents.ts"), "utf8");
    assert.ok(src.includes('| "message.seen"'), "message.seen is not in TelegraphEventType");
    assert.ok(src.includes('| "read.updated"'), "read.updated was replaced rather than joined");
  });
});
