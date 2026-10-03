/**
 * Telegraph §7.4 / migration 3000 — `telegraph_unsend_message_before_seen`
 * under REAL CONTENTION: two live connections, on a real database.
 *
 * WHY THIS FILE EXISTS, beside telegraphUnsend.db.test.ts and not inside it.
 * ========================================================================
 * That sibling executes the function's ten reachable states and observes the
 * §7.4 receipt lock in `pg_locks`. It says so, and then says what it cannot
 * say, in its own header:
 *
 *     "WHAT IS NOT PROVED HERE, and is not claimed anywhere else either: that
 *      a competing writer actually BLOCKS. That needs two connections in real
 *      contention and this harness has one. The lock is observed; the blocking
 *      follows from Postgres semantics, and that is a different sentence from
 *      'reproduced'."
 *
 * The blocking was then reproduced BY HAND on 2026-10-02 with two live
 * connections, and a hand rehearsal is evidence exactly once. Nothing permanent
 * pinned it. This file is that rehearsal made durable. It is a separate file
 * because every test in it needs machinery the sibling deliberately does not
 * have — long-lived psql children whose transactions the harness opens, parks
 * and commits on command — and because the sibling's one-call-per-transaction
 * discipline is what makes ITS assertions about `now()` sound. Mixing the two
 * would weaken both.
 *
 * THE CONTRACT, AS THE SQL STATES IT (not as the ticket framed it)
 * ===============================================================
 * 3000's body takes TWO `FOR UPDATE` locks, in this order, and the cases below
 * are derived from them rather than from a sketch of what races matter:
 *
 *   (1) the MESSAGE row:
 *         SELECT * INTO v_msg FROM public.messages
 *          WHERE id = p_message_id AND thread_id = p_thread_id FOR UPDATE;
 *       Its comment names its purpose: "A concurrent unsend/edit/delete of the
 *       same message serialises here." So this one lock implies THREE races,
 *       not one, and all three are pinned below (R1, R4, R5) — because a
 *       competing DELETE is as much a competing writer as a competing unsend,
 *       and the outcome the loser gets differs between them.
 *
 *   (2) every eligible recipient's RECEIPT row:
 *         PERFORM 1 FROM public.message_thread_members
 *          WHERE thread_id = p_thread_id AND user_id <> p_actor_id
 *            AND left_at IS NULL FOR UPDATE;
 *       taken BEFORE `last_read_at` is read. This is the read-vs-unsend race
 *       2325 was written for, and it is directional: it must hold in BOTH
 *       orderings, so both are pinned (R2, R3).
 *
 * MEASURED, and the measurement is the reason each case is phrased the way it
 * is. Every outcome below was first reproduced by hand against this harness
 * before it was asserted; none of it is derived from Postgres documentation:
 *
 *   R1  three unsends queued behind a fourth: ONE 'unsent', three
 *       'already_unsent' carrying the FIRST one's stamp, one write.
 *   R2  an unsend behind an uncommitted mark-as-read that makes the message
 *       ineligible: 'seen', and the message row byte-identical INCLUDING xmin.
 *   R3  a mark-as-read behind an in-flight unsend: the read BLOCKS. It cannot
 *       land between the seen-check and the write. That is §7.4's sentence
 *       "the server resolves read-vs-unsend races transactionally", executed.
 *   R4  an unsend behind an uncommitted ordinary delete: 'already_deleted', and
 *       the delete is NOT overwritten — `deleted_at` keeps the deleter's stamp.
 *   R5  an unsend behind an uncommitted hard DELETE of the row: 'not_found',
 *       and the row is not resurrected. This is the `IF NOT FOUND` branch,
 *       which is reachable ONLY under contention.
 *   R6  all of the above are READ COMMITTED's guarantees. 3000 does not assert
 *       its isolation level the way 3415's `trail_propose` does, and at
 *       REPEATABLE READ a losing unsend raises SQLSTATE 40001 instead of
 *       answering 'already_unsent'. The row is still written exactly once, so
 *       this is noise and not corruption — but it is a constraint on the route,
 *       and before this file nothing recorded it.
 *
 * HOW "EXACTLY ONE WRITE" IS ESTABLISHED FROM RESULTING STATE
 * ==========================================================
 * This project asserts on the rows after the transaction, not on what the call
 * returned — a "return the right string" bug must not pass. For a race that is
 * harder than it sounds: `already_unsent` is also what a function that wrote
 * the row a SECOND time could report, and both writes produce a row that looks
 * unsent.
 *
 * So the load-bearing assertion is the system column `messages.xmin`: the id of
 * the transaction that LAST wrote the row. Each racing session is its own
 * transaction, and the harness learns each one's xid from
 * `pg_stat_activity.backend_xid` while that session is parked — from the
 * database, not from anything the session printed. After the race:
 *
 *   xmin = the WINNER's xid   ⇒  no loser wrote. A silent double-apply would
 *                                have left xmin naming the loser.
 *   unsent_at = the winner's transaction clock, and every loser's transaction
 *                                began LATER, so a second write would also have
 *                                moved the stamp forward.
 *
 * R2 uses the same column the other way round: a refusal must leave xmin
 * UNCHANGED from before the race, which is a stronger statement than "the
 * columns look the same" — it says no transaction touched the row at all.
 *
 * NO SLEEPS ARE USED FOR SYNCHRONISATION, anywhere in this file.
 * =============================================================
 * The precedents in this directory hold a transaction open with `pg_sleep` and
 * start the racer after a fixed `setTimeout`. That is a guess twice over: the
 * racer may not have arrived before the sleep ends, and the hold may end before
 * the racer blocks. Here both halves are handshakes against `pg_stat_activity`:
 *
 *   holdingLocks(name)          waits until that session is parked BETWEEN
 *                               statements with an open transaction that has a
 *                               real xid — it has done its work and is holding
 *                               its locks — and returns its pid and xid.
 *   blockedBehind(name, pid, …) waits until that session is actually waiting on
 *                               a lock, inside a statement naming the function
 *                               (or the read), behind the holder at `pid`.
 *
 * Each psql child keeps its stdin OPEN, so the harness decides when the holder
 * commits. Neither helper can pass vacuously: both poll for a condition and
 * THROW when the budget runs out, so a race that failed to form fails the test
 * instead of quietly becoming a serial one.
 *
 * WHY THE BARRIER IS NOT `pg_blocking_pids` ALONE. Measured: with three losers
 * queued on one row, only ONE of them names the holder in `pg_blocking_pids` —
 * the other two are queued behind their peers on the tuple lock. So the barrier
 * asserts that ALL the losers are waiting on a lock AND that at least one is
 * directly behind the holder. Requiring all three to name the holder would have
 * been a barrier that never opens.
 *
 * WHAT THIS FILE DOES NOT PROVE
 * =============================
 *   · Nothing about PostgreSQL 17. This harness is 16, production is 17. The
 *     row-locking semantics used here are not version-specific, but that is an
 *     argument, not a measurement.
 *   · Nothing about the ROUTE. These are direct function calls as
 *     `service_role`; that the command route reaches this function with these
 *     arguments is telegraphCommandRoute.test.ts's subject.
 *   · Nothing about lock WAIT TIMES or throughput. "Blocks" is asserted by
 *     observing the waiter in `pg_stat_activity`, never by how long anything
 *     took, so this file has no timing threshold to tune and cannot go red on a
 *     slow machine.
 *   · Nothing about real data. The harness carries no production rows; these
 *     threads and messages are seeded here and deleted in `after`.
 *
 * Skips without LOCAL_DB_URL exactly as the other db suites do;
 * scripts/local-db/run-tests.sh refuses a run with skipped > 0, and globs this
 * directory, so this file joins that run by existing in it.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { HAVE_DB, LOCAL_DB_URL, deleteUser, exec, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

/** The function under contention, named once. Also the needle the barrier matches on. */
const FN = "telegraph_unsend_message_before_seen";

/** The message clock. Fixed, so no assertion here depends on `now()`. */
const SENT_AT = "2026-09-01T12:00:00Z";
/** After SENT_AT: a receipt at this time HAS seen the message. */
const READ_AFTER = "2026-09-01T12:00:01Z";
/** A delete's stamp. Distinct from every other constant, so "unmoved" is checkable. */
const DELETED_AT = "2026-09-02T00:00:00Z";

/**
 * How long a handshake may wait before the test FAILS.
 *
 * A BUDGET IN TIME, not in poll counts: each poll costs a psql invocation, so a
 * count of iterations means a different deadline on every machine. 15 seconds is
 * two orders of magnitude more than any of these races needs — all five formed
 * on the first or second poll when measured — and well under the 60-second
 * per-test ceiling, so a race that never forms is reported as this file's own
 * assertion failure, naming the session, rather than as a runner timeout.
 */
const BUDGET_MS = 15_000;
const POLL_MS = 20;

/** Unique to this run, so a poll of pg_stat_activity can never see another suite's session. */
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);
const app = (label: string) => `tgu_${RUN}_${label}`;

interface SessionResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One long-lived psql connection whose stdin STAYS OPEN, identified to the
 * server by `application_name` so the handshakes below can find it.
 *
 * psql's stdout is block-buffered on a pipe, so nothing a session prints is
 * readable until it exits. That is why every handshake in this file goes
 * through the database and never through stdout — and why `finish()` is the
 * only place a session's output is read.
 */
interface Session {
  /** Queue SQL on this session's stdin and return immediately. */
  send(sql: string): void;
  /** Optionally send a last statement, close stdin, and wait for psql to exit. */
  finish(sql?: string): Promise<SessionResult>;
}

/**
 * Every session this file has opened, so `afterEach` can close the ones a FAILED
 * test left behind.
 *
 * WHY THIS LIST EXISTS, measured rather than imagined. A handshake that times
 * out fails its test while the holder is still parked in an open transaction
 * holding row locks — and psql will sit there for as long as its stdin is open,
 * which is forever. Reverting migration 3000 to a body with no receipt lock and
 * running this file proved the consequence: R2 failed, as it should have, and
 * then R3, R4 and R5 each ran for a full sixty seconds and failed too, on locks
 * R2's abandoned session was holding. Four red tests, one real defect, and the
 * three innocent ones listed first by duration. So every session is tracked and
 * killed between tests: one regression must produce one failure, or the failure
 * report is a puzzle instead of an answer.
 */
const open: Array<{ name: string; kill: () => void; alive: () => boolean }> = [];

function session(name: string): Session {
  const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PGAPPNAME: name },
  });
  let stdout = "";
  let stderr = "";
  let running = true;
  child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
  child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
  const closed = new Promise<SessionResult>((resolve) => {
    child.on("close", (status) => {
      running = false;
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
  // SIGKILL, not SIGTERM: psql traps SIGTERM to cancel the current query and
  // carry on reading stdin, which is exactly the state being escaped from. The
  // backend's transaction rolls back when the connection drops.
  open.push({ name, kill: () => child.kill("SIGKILL"), alive: () => running });
  return {
    send(sql: string) { child.stdin.write(`${sql}\n`); },
    finish(sql?: string) {
      if (sql) child.stdin.write(`${sql}\n`);
      child.stdin.end();
      return closed;
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `name` is parked BETWEEN statements with an open transaction that
 * has acquired a real xid: it has finished the work the harness gave it and is
 * holding every lock that work took, indefinitely, until told to commit.
 *
 * `state = 'idle in transaction'` EXACTLY, never the `(aborted)` variant: with
 * ON_ERROR_STOP=1 a session whose statement raised lands in the aborted state
 * holding nothing, and treating that as "ready" would open a barrier onto a
 * session that never did the thing. Such a session never satisfies this
 * predicate, so the budget runs out and the test fails — which is the right
 * outcome, and the failure message says which session it was.
 */
async function holdingLocks(name: string): Promise<{ pid: string; xid: string }> {
  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    const [row] = rows<{ pid: number; xid: string | null; state: string }>(
      `SELECT pid, backend_xid::text AS xid, state FROM pg_stat_activity` +
        ` WHERE application_name = '${name}'`,
    );
    if (row && row.state === "idle in transaction" && row.xid) {
      return { pid: String(row.pid), xid: row.xid };
    }
    await wait(POLL_MS);
  }
  const seen = rows<{ state: string; xid: string | null }>(
    `SELECT state, backend_xid::text AS xid FROM pg_stat_activity WHERE application_name = '${name}'`,
  );
  assert.fail(
    `session ${name} never parked in an open transaction holding its locks; ` +
      `pg_stat_activity says ${JSON.stringify(seen)}`,
  );
}

/**
 * Wait until `name` is genuinely WAITING ON A LOCK, inside a statement whose
 * text contains `inStatement`, with the holder at `pid` behind the wait.
 *
 * `n` is how many sessions with this application-name prefix are expected. All
 * of them must be waiting on a lock; at least ONE must name the holder directly
 * in `pg_blocking_pids`. Measured on this harness: with three waiters on one
 * row only the first names the holder, because the rest queue behind their
 * peers on the tuple lock — so "all of them name the holder" is a barrier that
 * never opens, and "at least one does" is what ties the queue to the holder.
 */
async function blockedBehind(
  namePrefix: string,
  pid: string,
  inStatement: string,
  n = 1,
): Promise<void> {
  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    const [row] = rows<{ sessions: number; on_lock: number; behind_holder: number }>(
      `SELECT count(*)::int AS sessions,` +
        ` count(*) FILTER (WHERE wait_event_type = 'Lock' AND query LIKE '%${inStatement}%')::int AS on_lock,` +
        ` count(*) FILTER (WHERE ${pid} = ANY (pg_blocking_pids(pid)))::int AS behind_holder` +
        ` FROM pg_stat_activity WHERE application_name LIKE '${namePrefix}%'`,
    );
    if (row && row.sessions === n && row.on_lock === n && row.behind_holder >= 1) return;
    await wait(POLL_MS);
  }
  const seen = rows<unknown>(
    `SELECT application_name, state, wait_event_type, wait_event, pg_blocking_pids(pid)::text AS blockers` +
      ` FROM pg_stat_activity WHERE application_name LIKE '${namePrefix}%'`,
  );
  assert.fail(
    `expected ${n} session(s) '${namePrefix}*' blocked on a lock inside a statement containing ` +
      `'${inStatement}', at least one behind pid ${pid}; pg_stat_activity says ${JSON.stringify(seen)}`,
  );
}

interface MessageRow {
  body: string;
  unsent_at: string | null;
  deleted_at: string | null;
  lifecycle_state: string | null;
  /** The transaction that LAST wrote this row. The whole no-double-apply argument. */
  xmin: string;
}

interface Outcome {
  outcome?: string;
  unsentAt?: string;
  seenBy?: number;
  recipientCount?: number;
}

describe(`3000 / ${FN} — two connections in real contention`, { skip: SKIP }, () => {
  let sender = "";
  let reader = "";
  let other = "";
  let threadId = "";

  /** One script as the service role, in ONE transaction (so SET LOCAL holds). */
  const svc = (script: string): string[] => exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });

  /** The call, as a session script fragment. */
  const call = (messageId: string) => `SELECT public.${FN}('${messageId}', '${sender}', '${threadId}')::text;`;

  /** The whole script a racing session runs: its own transaction, autocommitted. */
  const racer = (messageId: string) =>
    `BEGIN;\nSET LOCAL ROLE service_role;\n${call(messageId)}\nCOMMIT;`;

  /**
   * A fresh message from the sender, with every receipt cleared. Receipts are
   * reset HERE rather than in an after-hook: a hook does not run when the
   * assertion before it fails, and a test whose premise depends on the previous
   * test's cleanup reports the previous test's failure twice.
   */
  function seedMessage(label: string): string {
    svc(
      `UPDATE public.message_thread_members SET last_read_at = NULL, left_at = NULL\n` +
        ` WHERE thread_id = '${threadId}';`,
    );
    const out = svc(
      `INSERT INTO public.messages (thread_id, sender_id, body, created_at)\n` +
        `VALUES ('${threadId}', '${sender}', '${label}', '${SENT_AT}') RETURNING id;`,
    );
    const id = out[out.length - 1]!;
    assert.match(id, /^[0-9a-f-]{36}$/, `seedMessage(${label}) returned no id`);
    return id;
  }

  /** Everything an unsend is supposed to change, plus who wrote the row last. */
  function messageRow(id: string): MessageRow {
    const [row] = rows<MessageRow>(
      `SELECT body, unsent_at::text, deleted_at::text, lifecycle_state, xmin::text AS xmin\n` +
        `  FROM public.messages WHERE id = '${id}'`,
    );
    assert.ok(row, `no message row ${id}`);
    return row;
  }

  /**
   * Does the row's `unsent_at` equal this timestamp? Asked of the DATABASE, not
   * compared in JavaScript: the function returns `unsentAt` inside jsonb, which
   * serialises as `2026-10-03T06:02:06.701889+00:00`, while `unsent_at::text`
   * is Postgres's own `2026-10-03 06:02:06.701889+00`. Those two strings are
   * never equal and both name the same instant, so the comparison belongs where
   * the type is understood. A string compare here would have failed on a
   * correct function, which is the kind of assertion someone later deletes.
   */
  const stampIs = (id: string, at: string | undefined): string | null => {
    assert.ok(at, "the answer carried no unsentAt to compare the row against");
    return scalar(
      `SELECT (unsent_at = '${at}'::timestamptz)::text FROM public.messages WHERE id = '${id}'`,
    );
  };

  /** The last line a session printed, parsed as the function's jsonb answer. */
  function answer(result: SessionResult): Outcome {
    assert.equal(result.status, 0, `session failed rather than refusing:\n${result.stderr}`);
    const last = result.stdout.split("\n").filter((l) => l.trim().length > 0).pop() ?? "";
    assert.match(last, /^\{/, `session printed no jsonb answer; stdout was ${JSON.stringify(result.stdout)}`);
    return JSON.parse(last) as Outcome;
  }

  before(() => {
    sender = seedUser("unsend_race_sender");
    reader = seedUser("unsend_race_reader");
    other = seedUser("unsend_race_other");
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

  /**
   * Close whatever the test just finished left open. On a PASS there is nothing
   * to do — every session here is awaited to exit. On a FAILURE this is what
   * stops one defect from being reported four times; see `open` above for the
   * measurement that put it here.
   */
  afterEach(() => {
    const leaked = open.filter((s) => s.alive());
    for (const s of leaked) s.kill();
    open.length = 0;
    // Said out loud rather than swallowed: a leaked session means a handshake
    // did not complete, and the assertion that failed is the one to read.
    if (leaked.length > 0) {
      console.error(
        `[telegraphUnsendConcurrency] killed ${leaked.length} session(s) left open by a failed test: ` +
          leaked.map((s) => s.name).join(", "),
      );
    }
  });

  after(() => {
    if (threadId) svc(`DELETE FROM public.message_threads WHERE id = '${threadId}';`);
    for (const id of [sender, reader, other]) if (id) deleteUser(id);
  });

  // ── The control, first, because every case below depends on the answer ──────
  it("CONTROL — the live function is 3000's body and takes row locks", () => {
    const [row] = rows<{ is_3000: boolean; locks_message: boolean; locks_receipts: boolean }>(
      `SELECT prosrc LIKE '%already_unsent%' AS is_3000,\n` +
        `       prosrc LIKE '%FOR UPDATE%'    AS locks_message,\n` +
        `       prosrc LIKE '%PERFORM%'       AS locks_receipts\n` +
        `  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n` +
        ` WHERE n.nspname = 'public' AND p.proname = '${FN}'`,
    );
    assert.ok(row, `${FN} does not exist on this database`);
    assert.equal(
      row.is_3000,
      true,
      "this database carries 2325's body, which answers 'already_gone' where 3000 answers " +
        "'already_unsent' and 'already_deleted' — R1 and R4 below would be about a different function",
    );
    assert.equal(row.locks_message, true);
    assert.equal(row.locks_receipts, true);

    // The text checks above are the WEAK half, kept only so a 2325 database is
    // named as such rather than producing eight confusing failures. Every claim
    // this file actually makes is executed: a body that still contains the words
    // but took no lock would pass the three assertions above and fail R1–R5.
  });

  it("R1. three unsends queued behind a fourth: one wins, the losers are no-ops, the row is written once", async () => {
    const id = seedMessage("r1 four racers");

    // The winner does the unsend and then PARKS, holding the message row lock
    // and every receipt lock, until this harness tells it to commit.
    const winner = session(app("r1_win"));
    winner.send(`BEGIN;\nSET LOCAL ROLE service_role;\n${call(id)}`);
    const held = await holdingLocks(app("r1_win"));

    // Three losers, each its own connection and its own transaction, all of
    // which begin AFTER the winner's — so any write of theirs would carry a
    // later clock as well as a different xid.
    const losers = [1, 2, 3].map((n) => session(app(`r1_lose${n}`)));
    const pending = losers.map((s) => s.finish(racer(id)));

    // The race is PRODUCED, not hoped for: all three are observed waiting on a
    // lock inside the function before the winner is allowed to commit. Without
    // this the file would be three serial calls wearing a race's clothes.
    await blockedBehind(app("r1_lose"), held.pid, FN, 3);

    const wonResult = await winner.finish("COMMIT;");
    const results = await Promise.all(pending);

    // ── resulting state: the load-bearing half ────────────────────────────────
    const row = messageRow(id);
    assert.equal(row.body, "", "the body must be emptied");
    assert.ok(row.unsent_at, "unsent_at must be set");
    assert.ok(row.deleted_at, "deleted_at must be set — suppression is deleted_at in every reader");
    assert.equal(row.lifecycle_state, "unsent");
    assert.equal(row.unsent_at, row.deleted_at, "both stamps are one statement's now()");

    assert.equal(
      row.xmin,
      held.xid,
      "the LAST transaction to write the message row must be the winner's. xmin naming a loser is " +
        "a silent double-apply: the message was unsent twice, the second time after it was already gone",
    );

    // ── and the answers, which must be well-defined rather than a crash ───────
    const won = answer(wonResult);
    assert.equal(won.outcome, "unsent");
    assert.equal(stampIs(id, won.unsentAt), "true", "the winner's stamp is the one on the row");

    const lost = results.map(answer);
    for (const [n, got] of lost.entries()) {
      assert.equal(got.outcome, "already_unsent", `loser ${n + 1} must refuse, not fail and not win`);
      assert.equal(
        stampIs(id, got.unsentAt),
        "true",
        `loser ${n + 1} must report the FIRST unsend's stamp, not its own`,
      );
      assert.equal(got.recipientCount, 2);
    }
    assert.equal(
      lost.filter((g) => g.outcome === "unsent").length,
      0,
      "exactly one session may win; a second 'unsent' is the race the message lock exists to close",
    );
  });

  it("R2. an unsend behind an uncommitted read that makes it ineligible: 'seen', and the row is untouched", async () => {
    const id = seedMessage("r2 read commits first");
    const before = messageRow(id);

    // A mark-as-read — what POST /threads/:id/read does — holding its row lock.
    const read = session(app("r2_read"));
    read.send(
      `BEGIN;\nSET LOCAL ROLE service_role;\n` +
        `UPDATE public.message_thread_members SET last_read_at = '${READ_AFTER}'\n` +
        ` WHERE thread_id = '${threadId}' AND user_id = '${reader}';`,
    );
    const held = await holdingLocks(app("r2_read"));

    const unsend = session(app("r2_unsend"));
    const pending = unsend.finish(racer(id));

    // The unsend blocks on the RECEIPT lock. Nothing holds the message row here,
    // so the receipt rows are the only thing it can be waiting for — which is
    // the §7.4 lock, observed blocking rather than merely present.
    await blockedBehind(app("r2_unsend"), held.pid, FN);

    await read.finish("COMMIT;");
    const result = await pending;

    // ── resulting state ───────────────────────────────────────────────────────
    assert.deepEqual(
      messageRow(id),
      before,
      "a refusal must leave the message row untouched. xmin is part of this comparison on purpose: " +
        "unchanged xmin says NO transaction wrote the row, which is stronger than the columns matching",
    );
    assert.equal(
      scalar(
        `SELECT last_read_at::text FROM public.message_thread_members` +
          ` WHERE thread_id = '${threadId}' AND user_id = '${reader}'`,
      ),
      "2026-09-01 12:00:01+00",
      "the read is what committed, and it stands",
    );

    const got = answer(result);
    assert.equal(got.outcome, "seen", "the receipt the unsend read is the COMMITTED one, not its own snapshot");
    assert.equal(got.seenBy, 1, "ONE reader is enough: §7.4's group rule");
  });

  it("R3. a mark-as-read behind an in-flight unsend BLOCKS — it cannot land between the check and the write", async () => {
    const id = seedMessage("r3 unsend holds the receipt lock");

    // The unsend has decided and written, and is holding the receipt locks.
    const unsend = session(app("r3_unsend"));
    unsend.send(`BEGIN;\nSET LOCAL ROLE service_role;\n${call(id)}`);
    const held = await holdingLocks(app("r3_unsend"));

    const read = session(app("r3_read"));
    const pending = read.finish(
      `BEGIN;\nSET LOCAL ROLE service_role;\n` +
        `UPDATE public.message_thread_members SET last_read_at = '${READ_AFTER}'\n` +
        ` WHERE thread_id = '${threadId}' AND user_id = '${reader}' RETURNING user_id;\nCOMMIT;`,
    );

    // THE POINT OF THIS TEST. The reader is observed WAITING. 2325's header
    // names this exact interleaving as the one a route cannot be made safe
    // against from Node: "a recipient's read landing between (1) and (2) yields
    // an unsend of a message that HAS been seen — precisely the §28 violation
    // whose target is zero". It cannot land, because it is stuck here.
    await blockedBehind(app("r3_read"), held.pid, "last_read_at");

    const unsendResult = await unsend.finish("COMMIT;");
    const readResult = await pending;

    // ── resulting state ───────────────────────────────────────────────────────
    const row = messageRow(id);
    assert.equal(row.body, "");
    assert.ok(row.unsent_at, "the unsend stands: the read arrived after it, not during it");
    assert.equal(row.lifecycle_state, "unsent");
    assert.equal(
      row.xmin,
      held.xid,
      "the unsend's transaction is the one that wrote the message row",
    );

    assert.equal(readResult.status, 0, `the read must be delayed, never refused:\n${readResult.stderr}`);
    assert.equal(
      scalar(
        `SELECT last_read_at::text FROM public.message_thread_members` +
          ` WHERE thread_id = '${threadId}' AND user_id = '${reader}'`,
      ),
      "2026-09-01 12:00:01+00",
      "the read lands too — AFTERWARDS. Blocking is not losing: a receipt is never silently dropped",
    );

    assert.equal(answer(unsendResult).outcome, "unsent");
  });

  it("R4. an unsend behind an uncommitted ordinary delete: 'already_deleted', and the delete is not overwritten", async () => {
    const id = seedMessage("r4 delete commits first");
    const before = messageRow(id);
    assert.equal(before.deleted_at, null, "the premise: this message is not deleted yet");

    // An ordinary delete — the operation 2810 insists is DISTINCT from an
    // unsend — taking the message row lock first.
    const del = session(app("r4_delete"));
    del.send(
      `BEGIN;\nSET LOCAL ROLE service_role;\n` +
        `UPDATE public.messages SET deleted_at = '${DELETED_AT}' WHERE id = '${id}';`,
    );
    const held = await holdingLocks(app("r4_delete"));

    const unsend = session(app("r4_unsend"));
    const pending = unsend.finish(racer(id));
    await blockedBehind(app("r4_unsend"), held.pid, FN);

    await del.finish("COMMIT;");
    const result = await pending;

    // ── resulting state ───────────────────────────────────────────────────────
    const row = messageRow(id);
    assert.equal(
      row.deleted_at,
      "2026-09-02 00:00:00+00",
      "the DELETE's stamp must survive. An unsend that re-stamped deleted_at would be rewriting " +
        "the record of when the message went away",
    );
    assert.equal(
      row.unsent_at,
      null,
      "a deleted message must not acquire unsent_at — unsend and delete stay distinguishable on the record",
    );
    assert.equal(row.lifecycle_state, before.lifecycle_state, "lifecycle_state is not touched either");
    assert.equal(row.body, before.body, "and the body is not redacted a second time");
    assert.equal(
      row.xmin,
      held.xid,
      "the deleter's transaction wrote the row last: the blocked unsend wrote nothing at all",
    );

    const got = answer(result);
    assert.equal(
      got.outcome,
      "already_deleted",
      "the loser saw the COMMITTED delete, not the snapshot it started with",
    );
    assert.notEqual(got.outcome, "unsent", "an unsend must never win against a committed delete");
  });

  it("R5. an unsend behind an uncommitted hard DELETE of the row: 'not_found', and the row is not resurrected", async () => {
    const id = seedMessage("r5 row removed first");

    const del = session(app("r5_delete"));
    del.send(`BEGIN;\nSET LOCAL ROLE service_role;\nDELETE FROM public.messages WHERE id = '${id}';`);
    const held = await holdingLocks(app("r5_delete"));

    const unsend = session(app("r5_unsend"));
    const pending = unsend.finish(racer(id));
    await blockedBehind(app("r5_unsend"), held.pid, FN);

    await del.finish("COMMIT;");
    const result = await pending;

    // ── resulting state ───────────────────────────────────────────────────────
    assert.equal(
      scalar(`SELECT count(*)::text FROM public.messages WHERE id = '${id}'`),
      "0",
      "the row is gone and stays gone: an UPDATE that matched nothing must not insert anything",
    );

    // `IF NOT FOUND` is reachable ONLY like this. A sequential caller asking
    // about an id that never existed takes the same branch, but this is the
    // branch taken when the row existed when the caller looked and did not when
    // the lock was granted — the case where a crash, rather than a refusal,
    // would be an easy mistake to make.
    const got = answer(result);
    assert.equal(got.outcome, "not_found");
    assert.equal(
      "recipientCount" in got,
      false,
      "not_found is returned before the roster is counted, and must not invent a number",
    );
  });
  it("R6. the guarantees above are READ COMMITTED's: at a stricter level the loser ERRORS rather than refusing", async () => {
    const id = seedMessage("r6 isolation level");

    // ── First: the function does NOT assert its own isolation level ────────────
    // 3415's `trail_propose` does, and this directory's trailsProposalRace P4
    // pins that refusal ("requires READ COMMITTED"). 2325 and 3000 do not. So a
    // caller CAN enter at a stricter level, and what happens then is worth a
    // sentence in a file about concurrency rather than a surprise during a
    // rollout. Measured, on an uncontended call: it simply succeeds.
    const uncontended = seedMessage("r6 uncontended at serializable");
    for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
      const s = session(app("r6_iso"));
      const r = await s.finish(
        `BEGIN ISOLATION LEVEL ${level};\nSET LOCAL ROLE service_role;\n${call(uncontended)}\nROLLBACK;`,
      );
      assert.equal(
        r.status,
        0,
        `${level} is accepted, not refused — recorded so that a later migration ADDING an ` +
          `isolation assertion is a deliberate change to this expectation, not a silent one:\n${r.stderr}`,
      );
      open.length = 0;
    }

    // ── Then: under CONTENTION, a stricter level changes the loser's fate ──────
    const winner = session(app("r6_win"));
    winner.send(`BEGIN;\nSET LOCAL ROLE service_role;\n${call(id)}`);
    const held = await holdingLocks(app("r6_win"));

    const loser = session(app("r6_lose"));
    const pending = loser.finish(
      `\\set VERBOSITY verbose\nBEGIN ISOLATION LEVEL REPEATABLE READ;\n` +
        `SET LOCAL ROLE service_role;\n${call(id)}\nCOMMIT;`,
    );
    await blockedBehind(app("r6_lose"), held.pid, FN);

    await winner.finish("COMMIT;");
    const result = await pending;

    // ── resulting state: ONE write, by the winner, exactly as at READ COMMITTED ─
    const row = messageRow(id);
    assert.ok(row.unsent_at, "the winner's unsend landed");
    assert.equal(row.lifecycle_state, "unsent");
    assert.equal(
      row.xmin,
      held.xid,
      "the erroring loser must write NOTHING. This is the half that matters: at either isolation " +
        "level the row is written once, so a stricter caller is noisy, never wrong",
    );

    // ── and the loser's fate, which is an ERROR and not a refusal ──────────────
    assert.notEqual(
      result.status,
      0,
      "at REPEATABLE READ the loser cannot re-read the row the winner rewrote, so the FOR UPDATE " +
        "raises instead of returning 'already_unsent'",
    );
    assert.match(
      result.stderr,
      /ERROR:\s+40001:\s+could not serialize access due to concurrent update/,
      `expected SQLSTATE 40001 from the message FOR UPDATE; psql said:\n${result.stderr}`,
    );

    // WHAT THIS MEANS FOR THE ROUTE, said here because nothing else says it:
    // 40001 is retryable and the API's service client runs at the default READ
    // COMMITTED, so this is not a live hazard today. It is a CONSTRAINT: the
    // idempotent 'already_unsent' answer the command route maps to
    // TELEGRAPH_LIFECYCLE_ALREADY_UNSENT exists only at READ COMMITTED. A route
    // that one day opens its transaction at a stricter level would turn a
    // refusal into a 500 unless it retries. Pinned, not fixed — adding an
    // isolation assertion to the function is a migration, and this file's job is
    // to record what the function does, not to decide that.
  });

});
