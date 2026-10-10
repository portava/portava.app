/**
 * Telegraph §7.4 / migration 3000 — `telegraph_unsend_message_before_seen`
 * EXECUTED on a real database, not modelled.
 *
 * WHY THIS FILE EXISTS. #527 made this function the only writer of an unsend,
 * and everything that pinned it lived in fakes: `telegraphUnsendFunctionFake`
 * enumerates 204 states against a TypeScript model of the function, and F-11
 * reads the migration's TEXT for its lock order. Both are worth keeping — they
 * cover combinations no fixture would sit through — but neither one executes a
 * single line of plpgsql. A rehearsal against `portava-ci` did, by hand, and a
 * hand rehearsal is evidence exactly once. This is that rehearsal made durable:
 * the same ten outcomes, the same read-back of what was actually written, and
 * the same `pg_locks` probe, run by the suite against the real function.
 *
 * WHAT IS PROVED HERE
 *   · the outcome for each of ten reachable states, from the function itself;
 *   · that every refusal leaves the message row byte-identical — the refusals
 *     are the half of the matrix a "return the right string" bug still passes;
 *   · that a retry writes once, with `unsent_at` unmoved across a SECOND
 *     transaction, which is the only way that assertion is not vacuous;
 *   · that `message_thread_members` carries no lock before the call and
 *     `RowShareLock` after it — the §7.4 receipt lock, observed;
 *   · the grant posture: `service_role` only.
 *
 * WHAT IS NOT PROVED HERE, and is not claimed anywhere else either: that a
 * competing writer actually BLOCKS. That needs two connections in real
 * contention and this harness has one. The lock is observed; the blocking
 * follows from Postgres semantics, and that is a different sentence from
 * "reproduced".
 *
 * THREE TRAPS, each one met head-on below rather than left for the next reader:
 *
 *   1. `now()` is TRANSACTION-START time. Inside one transaction "the stamp did
 *      not move" is vacuous and "the stamp moved" is a false failure. So every
 *      call here is its own psql invocation, hence its own transaction, and the
 *      decision inputs are explicit timestamps rather than `now()`.
 *   2. A new file under src/test/ DOES NOT RUN until its path is in the explicit
 *      list in package.json's "test" script. `check:test-registration` is the
 *      only thing that catches that, and it is not a member of `check:all`.
 *   3. 2325's body and 3000's differ in vocabulary. The first test below refuses
 *      to run the matrix against a database carrying 2325's body, because there
 *      every outcome assertion would be about a different function.
 *
 * MEASURED, not assumed. Twelve mutations were applied to the live function on
 * the harness database with CREATE OR REPLACE and reverted by re-running the
 * migration. Each one is caught, and by the test that claims to be about it —
 * which is the part a count of failures would hide:
 *
 *   M1  receipt FOR UPDATE removed .................. the pg_locks probe
 *   M2  already_deleted checked before already_unsent  the retry test
 *   M3  a `seen` refusal writes the tombstone anyway   the seen test
 *   M4  recipientCount counts departed members ...... the departed-reader test
 *   M5  a departed recipient closes the window ...... the departed-reader test
 *   M6  lifecycle_state no longer written ........... the CONTROL and happy path
 *   M7  not_found invents a recipientCount .......... the not_found test
 *   M8  authenticated granted EXECUTE ............... the grant test
 *   M9  ownership check removed ..................... the not_sender test
 *   M10 already-deleted check removed ............... the already_deleted test
 *   M11 membership check removed .................... the not_member test
 *   M12 lookup ignores thread_id .................... the wrong-thread test
 *
 * Baseline 12/12 before each mutation and after each revert. M1 is the one worth
 * reading twice: the function still contains the word `FOR UPDATE` with the
 * receipt lock gone, because the message lock uses it too — so the text check in
 * the CONTROL stays green and only the executed probe goes red. That is the
 * whole argument for this file existing beside F-11.
 *
 * Skips without LOCAL_DB_URL exactly as the other db suites do;
 * scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, rows, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

/** The message clock. Fixed, so no assertion below depends on `now()`. */
const SENT_AT = "2026-09-01T12:00:00Z";
/** After SENT_AT: a receipt at this time HAS seen the message. */
const READ_AFTER = "2026-09-01T12:00:01Z";
/** Before SENT_AT: a receipt at this time has NOT seen the message. */
const READ_BEFORE = "2026-09-01T11:59:59Z";

interface Outcome {
  outcome?: string;
  recipientCount?: number;
  seenBy?: number;
  unsentAt?: string;
}

interface MessageRow {
  id: string;
  body: string;
  unsent_at: string | null;
  deleted_at: string | null;
  lifecycle_state: string | null;
  stamps_equal: boolean | null;
}

/** One script as the service role, in ONE transaction (so SET LOCAL holds). */
function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

describe("3000 / telegraph_unsend_message_before_seen — on a real database", { skip: SKIP }, () => {
  let sender = "";
  let reader = "";
  let other = "";
  let threadId = "";

  /** Call the function. `null` messageId exercises the null-argument branch. */
  function unsend(messageId: string | null, actorId = sender, thread = threadId): Outcome {
    const arg = messageId === null ? "NULL::uuid" : `'${messageId}'::uuid`;
    const out = svc(
      `SELECT public.telegraph_unsend_message_before_seen(${arg}, '${actorId}', '${thread}')::text;`,
    );
    return JSON.parse(out.join("\n")) as Outcome;
  }

  /** A message in the thread, with its lifecycle columns set explicitly. */
  function seedMessage(
    label: string,
    opts: { from?: string; deletedAt?: string | null; unsentAt?: string | null } = {},
  ): string {
    const from = opts.from ?? sender;
    const deleted = opts.deletedAt ? `'${opts.deletedAt}'` : "NULL";
    const unsent = opts.unsentAt ? `'${opts.unsentAt}'` : "NULL";
    const out = svc(
      `INSERT INTO public.messages (thread_id, sender_id, body, created_at, deleted_at, unsent_at)\n` +
        `VALUES ('${threadId}', '${from}', '${label}', '${SENT_AT}', ${deleted}, ${unsent})\n` +
        `RETURNING id;`,
    );
    const id = out[out.length - 1]!;
    assert.match(id, /^[0-9a-f-]{36}$/, `seedMessage(${label}) returned no id`);
    return id;
  }

  /** Everything about the row an unsend is supposed to change — and nothing else. */
  function messageRow(id: string): MessageRow {
    const [row] = rows<MessageRow>(
      `SELECT id::text, body, unsent_at::text, deleted_at::text, lifecycle_state,\n` +
        `       (unsent_at = deleted_at) AS stamps_equal\n` +
        `  FROM public.messages WHERE id = '${id}'`,
    );
    assert.ok(row, `no message row ${id}`);
    return row;
  }

  /** Set one member's receipt. `null` clears it. */
  function setRead(userId: string, at: string | null): void {
    svc(
      `UPDATE public.message_thread_members SET last_read_at = ${at ? `'${at}'` : "NULL"}\n` +
        ` WHERE thread_id = '${threadId}' AND user_id = '${userId}';`,
    );
  }

  /** Mark a member as having left the thread, or rejoin them. */
  function setLeft(userId: string, left: boolean): void {
    svc(
      `UPDATE public.message_thread_members SET left_at = ${left ? `'${READ_AFTER}'` : "NULL"}\n` +
        ` WHERE thread_id = '${threadId}' AND user_id = '${userId}';`,
    );
  }

  before(() => {
    sender = seedUser("unsend_sender");
    reader = seedUser("unsend_reader");
    other = seedUser("unsend_other");
    const out = svc(
      `INSERT INTO public.message_threads (thread_type, status, created_by)\n` +
        `VALUES ('direct', 'active', '${sender}') RETURNING id;`,
    );
    threadId = out[out.length - 1]!;
    assert.match(threadId, /^[0-9a-f-]{36}$/);
    svc(
      `INSERT INTO public.message_thread_members (thread_id, user_id, role) VALUES\n` +
        `  ('${threadId}', '${sender}', 'admin'),\n` +
        `  ('${threadId}', '${reader}', 'member'),\n` +
        `  ('${threadId}', '${other}', 'member');`,
    );
  });

  after(() => {
    if (threadId) svc(`DELETE FROM public.message_threads WHERE id = '${threadId}';`);
    for (const id of [sender, reader, other]) if (id) deleteUser(id);
  });

  // ── Trap 3, first, because everything after it depends on the answer ────────
  it("CONTROL — the live function is 3000's body, not 2325's", () => {
    const [row] = rows<{ is_3000: boolean; takes_locks: boolean; writes_state: boolean }>(
      `SELECT prosrc LIKE '%already_unsent%' AS is_3000,\n` +
        `       prosrc LIKE '%FOR UPDATE%'    AS takes_locks,\n` +
        `       prosrc LIKE '%lifecycle_state%' AS writes_state\n` +
        `  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n` +
        ` WHERE n.nspname = 'public' AND p.proname = 'telegraph_unsend_message_before_seen'`,
    );
    assert.ok(row, "telegraph_unsend_message_before_seen does not exist on this database");
    assert.equal(
      row.is_3000,
      true,
      "this database carries 2325's body, which answers 'already_gone' where 3000 answers 'already_unsent' — the outcomes below would be asserted against a different function",
    );
    assert.equal(row.takes_locks, true);
    assert.equal(row.writes_state, true);
  });

  it("no recipient has read it — unsent, and the whole row is written", () => {
    const id = seedMessage("m1 happy path");
    setRead(reader, READ_BEFORE);
    setRead(other, null);

    const got = unsend(id);
    assert.equal(got.outcome, "unsent");
    assert.equal(got.seenBy, 0);
    assert.equal(got.recipientCount, 2);
    assert.ok(got.unsentAt, "unsent must carry unsentAt");

    const row = messageRow(id);
    assert.equal(row.body, "", "the body must be emptied");
    assert.ok(row.unsent_at, "unsent_at must be set");
    assert.ok(row.deleted_at, "deleted_at must be set — suppression is deleted_at in every reader");
    assert.equal(row.lifecycle_state, "unsent");
    assert.equal(row.stamps_equal, true, "unsent_at and deleted_at are one statement's now()");
  });

  it("a recipient who has seen it closes the window for everyone — and writes nothing", () => {
    const id = seedMessage("m5 seen");
    setRead(reader, READ_AFTER);
    setRead(other, null);
    const before = messageRow(id);

    const got = unsend(id);
    assert.equal(got.outcome, "seen");
    assert.equal(got.seenBy, 1, "ONE reader is enough: §7.4's group rule");
    assert.equal(got.recipientCount, 2);

    assert.deepEqual(messageRow(id), before, "a refusal must leave the row untouched");
  });

  // Lead ruling P-T6 / migration 3650 (lane T, verification finding F1): a member in a
  // block with the sender is not an eligible recipient, so their read neither closes the
  // window nor reaches the sender as `seenBy`. Each direction, with the block removed after.
  it("P-T6 (3650): a reader in a block with the sender, either way, neither closes the window nor is counted", () => {
    for (const [blocker, blocked] of [[reader, sender], [sender, reader]] as const) {
      const id = seedMessage(`m-block ${blocker === reader ? "reader-blocked-sender" : "sender-blocked-reader"}`);
      setRead(reader, READ_AFTER);
      setRead(other, null);
      svc(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${blocker}', '${blocked}');`);
      try {
        const got = unsend(id);
        assert.equal(got.outcome, "unsent", `${blocker === reader ? "reader" : "sender"} blocked: a blocked reader's read closed the window`);
        assert.equal(got.seenBy, 0);
        assert.equal(got.recipientCount, 1, "the blocked member is not an eligible recipient");
      } finally {
        svc(`DELETE FROM public.blocks WHERE blocker_id = '${blocker}' AND blocked_id = '${blocked}';`);
      }
    }
  });

  it("caller is not the sender — not_sender, and writes nothing", () => {
    const id = seedMessage("m2 not sender", { from: reader });
    const before = messageRow(id);

    const got = unsend(id);
    assert.equal(got.outcome, "not_sender");
    assert.equal(got.recipientCount, 2);
    assert.deepEqual(messageRow(id), before);
  });

  it("already deleted — already_deleted, and writes nothing", () => {
    const id = seedMessage("m3 already deleted", { deletedAt: SENT_AT });
    const before = messageRow(id);

    const got = unsend(id);
    assert.equal(got.outcome, "already_deleted");
    assert.equal(got.recipientCount, 2);
    assert.deepEqual(messageRow(id), before, "a delete must not be overwritten by an unsend");
  });

  it("a retry writes once — already_unsent, with unsent_at unmoved across transactions", () => {
    const id = seedMessage("m4 double unsend");
    // Set up front, never cleaned up afterwards: an `after`-style reset does not
    // run when the assertion before it fails, and a test whose premise depends
    // on the previous test's cleanup reports the previous test's failure twice.
    setRead(reader, null);
    setRead(other, null);

    const first = unsend(id);
    assert.equal(first.outcome, "unsent");
    const after = messageRow(id);

    // A SECOND psql invocation, therefore a second transaction, therefore a
    // second now(). Without that, "the stamp did not move" proves nothing.
    const retry = unsend(id);
    assert.equal(retry.outcome, "already_unsent");
    assert.equal(retry.unsentAt, first.unsentAt, "the retry must report the FIRST unsend's stamp");
    assert.deepEqual(messageRow(id), after, "the retry must not rewrite the row");

    // The control for the control: the clock really did advance between them.
    const [clock] = rows<{ advanced: boolean }>(
      `SELECT (now() > '${after.unsent_at}'::timestamptz) AS advanced`,
    );
    assert.equal(clock!.advanced, true, "if the clock never advanced, 'unmoved' is vacuous");

    // already_unsent is checked BEFORE already_deleted, and this row carries
    // both — so this also pins the order the migration's comment calls out.
    assert.notEqual(retry.outcome, "already_deleted");
  });

  it("a departed reader does not hold the window open, nor does the sender's own read", () => {
    const id = seedMessage("m6 departed reader");
    setRead(reader, null);
    setLeft(other, true);
    setRead(other, READ_AFTER);
    setRead(sender, READ_AFTER);

    const got = unsend(id);
    assert.equal(got.outcome, "unsent", "left_at IS NOT NULL is not an eligible recipient");
    assert.equal(
      got.recipientCount,
      1,
      "recipientCount counts active members other than the sender — the departed one is out",
    );

    setLeft(other, false);
  });

  it("caller has left the thread — not_member, and writes nothing", () => {
    const id = seedMessage("m7 not member");
    setLeft(sender, true);
    const before = messageRow(id);

    const got = unsend(id);
    assert.equal(got.outcome, "not_member");
    assert.deepEqual(messageRow(id), before);
  });

  it("unknown and null message ids — not_found, with no recipientCount", () => {
    setLeft(sender, false);
    const unknown = unsend("aaaaaaaa-0000-4000-8000-0000000000ff");
    assert.equal(unknown.outcome, "not_found");
    assert.equal(
      "recipientCount" in unknown,
      false,
      "not_found is returned before the roster is counted, and must not invent a number",
    );

    const nulled = unsend(null);
    assert.equal(nulled.outcome, "not_found");
    assert.equal("recipientCount" in nulled, false);
  });

  it("a message in ANOTHER thread is not_found, not not_sender", () => {
    const out = svc(
      `INSERT INTO public.message_threads (thread_type, status, created_by)\n` +
        `VALUES ('direct', 'active', '${sender}') RETURNING id;`,
    );
    const otherThread = out[out.length - 1]!;
    const stray = svc(
      `INSERT INTO public.messages (thread_id, sender_id, body, created_at)\n` +
        `VALUES ('${otherThread}', '${sender}', 'm8 wrong thread', '${SENT_AT}') RETURNING id;`,
    );
    const id = stray[stray.length - 1]!;

    setLeft(sender, false);
    const got = unsend(id);
    assert.equal(got.outcome, "not_found", "the lookup is keyed on (id, thread_id), both");

    svc(`DELETE FROM public.message_threads WHERE id = '${otherThread}';`);
  });

  it("the §7.4 receipt lock is observed in pg_locks — none before, RowShareLock after", () => {
    const id = seedMessage("m9 lock probe");
    setLeft(sender, false);
    setLeft(other, false);
    setRead(reader, null);
    setRead(other, null);
    setRead(sender, null);

    // ONE transaction: relation locks are held to its end, so the before/after
    // pair is the control. The `before` half is what makes the `after` half
    // mean something — without it, a lock the harness already held would read
    // as a lock this call took.
    //
    // Everything comes back as ONE row of JSON. Two result-bearing statements in
    // one psql script would be two lines to pair up by position, and a probe
    // that mis-parses its own output is a probe that can report anything.
    const out = exec(
      `SET LOCAL ROLE service_role;\n` +
        `CREATE TEMP TABLE lock_probe(phase text, mode text, granted boolean);\n` +
        `DO $probe$\n` +
        `DECLARE v jsonb;\n` +
        `BEGIN\n` +
        `  INSERT INTO lock_probe\n` +
        `  SELECT 'before', l.mode, l.granted\n` +
        `    FROM pg_locks l JOIN pg_class c ON c.oid = l.relation\n` +
        `   WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'\n` +
        `     AND c.relname = 'message_thread_members';\n` +
        `  v := public.telegraph_unsend_message_before_seen('${id}', '${sender}', '${threadId}');\n` +
        `  INSERT INTO lock_probe\n` +
        `  SELECT 'after', l.mode, l.granted\n` +
        `    FROM pg_locks l JOIN pg_class c ON c.oid = l.relation\n` +
        `   WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'\n` +
        `     AND c.relname = 'message_thread_members';\n` +
        `  INSERT INTO lock_probe VALUES ('outcome', v->>'outcome', NULL);\n` +
        `END $probe$;\n` +
        `SELECT COALESCE(json_agg(t), '[]'::json)::text\n` +
        `  FROM (SELECT phase, mode, granted FROM lock_probe) t;`,
      { single: true },
    );

    const probes = JSON.parse(out.join("\n")) as { phase: string; mode: string | null; granted: boolean | null }[];
    const outcome = probes.find((p) => p.phase === "outcome");
    assert.equal(outcome?.mode, "unsent", "the probe must observe a call that actually ran");

    const before = probes.filter((p) => p.phase === "before");
    const after = probes.filter((p) => p.phase === "after");

    assert.deepEqual(
      before.map((p) => p.mode),
      [],
      "the harness must hold no lock on message_thread_members before the call",
    );
    assert.ok(
      after.some((p) => p.mode === "RowShareLock" && p.granted),
      `the call must take RowShareLock on message_thread_members (SELECT ... FOR UPDATE); observed ${JSON.stringify(after)}`,
    );
  });

  it("the grant posture is service_role only", () => {
    const sig = "public.telegraph_unsend_message_before_seen(uuid, uuid, uuid)";
    const [row] = rows<{ svc_role: boolean; authed: boolean; anon: boolean }>(
      `SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE')   AS svc_role,\n` +
        `       has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS authed,\n` +
        `       has_function_privilege('anon', '${sig}', 'EXECUTE')          AS anon`,
    );
    assert.equal(row!.svc_role, true);
    assert.equal(row!.authed, false, "a signed-in user must not be able to call this directly");
    assert.equal(row!.anon, false);
  });
});
