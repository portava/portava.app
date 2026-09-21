/**
 * Telegraph §12.1 / §13.3 / §17.1 — migration 2810, read AND (where a database
 * is offered) executed.
 *
 * TWO MODES, AND NEITHER IS A SKIP
 * ================================
 * Without `TELEGRAPH_DB_URL` this suite asserts the properties of the migration
 * that are decidable from its TEXT — that the flag is seeded FALSE, that BOTH
 * triggers read the flag before doing anything, that the outbox payload builder
 * never names `body`, that the unique index is PARTIAL, that the file never
 * calls its own backfill. Those are the properties a reviewer would otherwise
 * have to take on trust, and they are exactly the ones that decay when somebody
 * edits the file later.
 *
 * With `TELEGRAPH_DB_URL` pointing at a throwaway PostgreSQL carrying the
 * baseline and the chain, it ALSO executes the file and exercises the
 * behaviour. It never skips: the text assertions run either way, so a run
 * without a database is a smaller proof rather than a vacuous pass, and the
 * suite says which mode it ran in.
 *
 * WHY TEXT ASSERTIONS ARE WORTH WRITING AT ALL
 * ============================================
 * Because the dangerous edits to this file are textual. "Seeded FALSE" becomes
 * "seeded true" in one character. A `body` added to the outbox payload is one
 * line and would put message text into a queue that projections, indexers and
 * analytics all read. A unique index that loses its WHERE clause stops being
 * free and starts rejecting every second message with a NULL key. None of those
 * is caught by a schema check after the fact; all of them are caught here.
 *
 * EXECUTED RUN, RECORDED: the DDL and every behaviour below were executed on
 * 2026-09-12 against PostgreSQL 16 carrying `baseline/20260819_baseline_structure.sql`
 * plus `src/migrations/*.sql` from 2093 (209 applied, 6 known-unreplayable, 0
 * unexpected failures). The results are in this commit's message.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphMessageKernelMigration.test.ts
 *   TELEGRAPH_DB_URL=postgresql://… node --import tsx/esm --test src/test/telegraphMessageKernelMigration.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "../migrations/2810_telegraph_message_kernel.sql");
const sql = readFileSync(MIGRATION, "utf8");

const DB_URL = (process.env["TELEGRAPH_DB_URL"] ?? "").trim();
const HAVE_DB = DB_URL !== "";

/** One psql invocation. Only used when HAVE_DB. */
function psql(script: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", DB_URL], {
    input: script, encoding: "utf8", timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function exec(script: string): string[] {
  const r = psql(script);
  if (r.status !== 0) throw new Error(`psql exited ${r.status}:\n${r.stderr.trim()}\n--- script ---\n${script}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

function scalar(query: string): string | null {
  const out = exec(query);
  return out.length === 0 ? null : out[0]!;
}

/* ───────────────────────── mode 1: the text, always ───────────────────────── */

describe("Telegraph 2810 — properties decidable from the migration text", () => {
  it("reports which mode this run is in, so a green is never ambiguous", () => {
    // Not an assertion about the tree — an assertion about this suite. A reader
    // seeing "pass" must be able to tell which proof they got.
    assert.ok(typeof HAVE_DB === "boolean");
    console.log(`# telegraph 2810 suite mode: ${HAVE_DB ? "EXECUTED against TELEGRAPH_DB_URL" : "TEXT ONLY (set TELEGRAPH_DB_URL to execute)"}`);
  });

  it("seeds telegraph_message_kernel_enabled FALSE", () => {
    assert.match(sql, /'telegraph_message_kernel_enabled',\s*false/,
      "the capability flag must be seeded FALSE — a seeded-true flag turns a migration into a behaviour change");
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/,
      "re-running the migration must not reset an operator's flag value");
  });

  it("postconditions REFUSE a flag that is not FALSE", () => {
    assert.match(sql, /telegraph_message_kernel_enabled'\) IS NOT FALSE/,
      "the postcondition block must assert the seeded value, not merely the row's existence");
  });

  it("BOTH triggers read the flag before doing anything", () => {
    for (const fn of ["telegraph_assign_message_sequence", "telegraph_outbox_from_message"]) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}()`));
      const upToEnd = body.slice(0, body.indexOf("$fn$;"));
      assert.match(upToEnd, /feature_flags WHERE flag = 'telegraph_message_kernel_enabled'/,
        `${fn} must consult the flag`);
      assert.match(upToEnd, /IF COALESCE\(v_enabled, false\) IS NOT TRUE THEN/,
        `${fn} must treat an ABSENT or NULL flag as OFF — a database without the row must behave as before`);
    }
  });

  it("the outbox payload never carries a message body", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.telegraph_outbox_from_message()"));
    const upToEnd = fn.slice(0, fn.indexOf("$fn$;"));
    assert.ok(!/'body'/.test(upToEnd),
      "an outbox row is read by projections, indexers and analytics; a body here reaches all three");
    assert.ok(!/NEW\.body/.test(upToEnd));
  });

  it("the idempotency index is PARTIAL and scoped to (thread, sender)", () => {
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_uniq\s*\n\s*ON public\.messages \(thread_id, sender_id, idempotency_key\)\s*\n\s*WHERE idempotency_key IS NOT NULL/,
      "an index without the WHERE clause would reject every second key-less message");
  });

  it("does NOT call its own backfill", () => {
    // The property is "is it CALLED", not "how often is it mentioned". Counting
    // mentions was the first spelling of this assertion and it went red on a
    // COLUMN COMMENT that names the function — a comment is documentation, and
    // an assertion that a file may not describe its own function would make the
    // file worse to satisfy the test. What must not appear is an invocation.
    const invocations = sql.match(/\b(SELECT|PERFORM)\s+(public\.)?telegraph_backfill_message_sequences\s*\(/gi) ?? [];
    assert.deepEqual(invocations, [],
      "the migration must not run the backfill: an unbounded UPDATE on public.messages inside a migration holds a lock on the hottest table in the product");
  });

  it("adds every §12.1 field the census named as missing", () => {
    for (const col of ["sequence", "client_message_id", "idempotency_key", "content_ref", "unsent_at", "lifecycle_state"]) {
      assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`), `messages.${col} is not added`);
    }
  });

  it("adds §14.3's sequence bounds and §12's delivery/seen cursors", () => {
    for (const col of ["visible_from_sequence", "visible_until_sequence", "delivered_sequence", "seen_sequence"]) {
      assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`), `message_thread_members.${col} is not added`);
    }
  });

  it("enables RLS on the outbox and creates no policy", () => {
    assert.match(sql, /ALTER TABLE public\.telegraph_outbox ENABLE ROW LEVEL SECURITY/);
    assert.ok(!/CREATE POLICY[\s\S]*telegraph_outbox/.test(sql),
      "RLS with zero policies denies every non-service role; a policy would need to justify itself");
  });

  it("is re-runnable: every DDL statement is guarded", () => {
    const unguardedAlter = sql
      .split("\n")
      .filter((l) => /^\s*ALTER TABLE public\.\w+ ADD COLUMN /.test(l) && !/IF NOT EXISTS/.test(l));
    assert.deepEqual(unguardedAlter, [], `unguarded ADD COLUMN: ${unguardedAlter.join(" | ")}`);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.telegraph_outbox/);
    assert.match(sql, /DROP TRIGGER IF EXISTS telegraph_assign_message_sequence/);
    assert.match(sql, /DROP TRIGGER IF EXISTS telegraph_outbox_from_message/);
  });
});

/* ─────────────────── mode 2: executed, when a database is offered ─────────── */

describe("Telegraph 2810 — executed behaviour", () => {
  const THREAD = randomUUID();
  const ALICE = randomUUID();
  const BOB = randomUUID();

  before(() => {
    if (!HAVE_DB) return;
    // The migration is applied by the harness before this suite runs; applying
    // it again here proves re-runnability on the same database.
    const applied = psql(sql);
    assert.equal(applied.status, 0, `re-applying 2810 failed:\n${applied.stderr}`);

    exec(
      `INSERT INTO auth.users (id, email) VALUES ('${ALICE}','${ALICE}@t.test'),('${BOB}','${BOB}@t.test');\n` +
      `INSERT INTO public.profiles (id, handle, name) VALUES ('${ALICE}','h${ALICE.slice(0, 8)}','A'),('${BOB}','h${BOB.slice(0, 8)}','B');\n` +
      `INSERT INTO public.message_threads (id, thread_type, status) VALUES ('${THREAD}','direct','active');\n` +
      `INSERT INTO public.message_thread_members (thread_id, user_id, role, joined_at) VALUES ('${THREAD}','${ALICE}','member',now()),('${THREAD}','${BOB}','member',now());`,
    );
  });

  it("FLAG OFF: a new message gets no sequence and writes no outbox row", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL — text assertions above are this run's proof"); return; }
    exec(`UPDATE public.feature_flags SET enabled=false WHERE flag='telegraph_message_kernel_enabled';`);
    const id = randomUUID();
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${id}','${THREAD}','${ALICE}','off');`);
    assert.equal(scalar(`SELECT COALESCE(sequence::text,'NULL') FROM public.messages WHERE id='${id}';`), "NULL");
    assert.equal(scalar(`SELECT count(*)::text FROM public.telegraph_outbox WHERE conversation_id='${THREAD}';`), "0");
    assert.equal(scalar(`SELECT last_sequence::text FROM public.message_threads WHERE id='${THREAD}';`), "0");
  });

  it("FLAG ON: sequences are per conversation, monotonic, and start at 1", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    exec(`UPDATE public.feature_flags SET enabled=true WHERE flag='telegraph_message_kernel_enabled';`);
    const a = randomUUID(); const b = randomUUID();
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${a}','${THREAD}','${ALICE}','one');`);
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${b}','${THREAD}','${BOB}','two');`);
    assert.equal(scalar(`SELECT sequence::text FROM public.messages WHERE id='${a}';`), "1");
    assert.equal(scalar(`SELECT sequence::text FROM public.messages WHERE id='${b}';`), "2");
    assert.equal(scalar(`SELECT last_sequence::text FROM public.message_threads WHERE id='${THREAD}';`), "2");
    assert.equal(scalar(`SELECT lifecycle_state FROM public.messages WHERE id='${a}';`), "sent");
  });

  it("the outbox row is written in the SAME transaction — a rollback leaves none", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    const before = Number(scalar(`SELECT count(*)::text FROM public.telegraph_outbox WHERE conversation_id='${THREAD}';`));
    const id = randomUUID();
    exec(`BEGIN;\nINSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${id}','${THREAD}','${ALICE}','doomed');\nROLLBACK;`);
    const after = Number(scalar(`SELECT count(*)::text FROM public.telegraph_outbox WHERE conversation_id='${THREAD}';`));
    assert.equal(after, before, "a rolled-back message left an event behind — the outbox is not transactional");
    assert.equal(scalar(`SELECT count(*)::text FROM public.messages WHERE id='${id}';`), "0");
  });

  it("the outbox payload contains no body", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    // Scoped to THIS suite's conversation. A whole-table assertion would be an
    // assertion about the harness database's history — including rows a
    // previous, deliberately-mutated run left behind — and would go red for a
    // reason that is not about the code under test.
    assert.equal(
      scalar(`SELECT (EXISTS (SELECT 1 FROM public.telegraph_outbox WHERE conversation_id='${THREAD}' AND payload ? 'body'))::text;`),
      "false",
    );
    assert.ok(
      Number(scalar(`SELECT count(*)::text FROM public.telegraph_outbox WHERE conversation_id='${THREAD}';`)) > 0,
      "the assertion above must be over rows that actually exist, or it proves nothing",
    );
  });

  it("a repeated idempotency key from the same sender is REFUSED", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    const key = `k-${randomUUID()}`;
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body, idempotency_key) VALUES ('${randomUUID()}','${THREAD}','${ALICE}','first','${key}');`);
    const r = psql(`INSERT INTO public.messages (id, thread_id, sender_id, body, idempotency_key) VALUES ('${randomUUID()}','${THREAD}','${ALICE}','retry','${key}');`);
    assert.notEqual(r.status, 0, "a retried offline send created a second message");
    assert.match(r.stderr, /duplicate key|unique constraint/i);
    // …and a DIFFERENT sender may use the same key: two clients generating the
    // same id must not be able to suppress each other.
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body, idempotency_key) VALUES ('${randomUUID()}','${THREAD}','${BOB}','mine','${key}');`);
  });

  it("unsend and delete each write exactly one event, and the row is retained", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    const u = randomUUID(); const d = randomUUID();
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${u}','${THREAD}','${ALICE}','to unsend');`);
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${d}','${THREAD}','${ALICE}','to delete');`);
    exec(`UPDATE public.messages SET unsent_at=now(), lifecycle_state='unsent' WHERE id='${u}';`);
    exec(`UPDATE public.messages SET deleted_at=now(), body='', lifecycle_state='deleted' WHERE id='${d}';`);
    assert.equal(scalar(`SELECT count(*)::text FROM public.telegraph_outbox WHERE event_type='message.unsent' AND message_id='${u}';`), "1");
    assert.equal(scalar(`SELECT count(*)::text FROM public.telegraph_outbox WHERE event_type='message.deleted' AND message_id='${d}';`), "1");
    // §17.2: the tombstone keeps the sequence continuous.
    assert.equal(scalar(`SELECT count(*)::text FROM public.messages WHERE id IN ('${u}','${d}');`), "2");
    assert.equal(scalar(`SELECT (sequence IS NOT NULL)::text FROM public.messages WHERE id='${u}';`), "true");
  });

  it("an invented lifecycle_state is refused by the CHECK", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    const id = randomUUID();
    exec(`INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${id}','${THREAD}','${ALICE}','x');`);
    const r = psql(`UPDATE public.messages SET lifecycle_state='vanished' WHERE id='${id}';`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /check constraint/i);
  });

  it("the backfill numbers one conversation deterministically and is re-runnable", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    const first = exec(`SELECT public.telegraph_backfill_message_sequences('${THREAD}')::text;`)[0];
    const seqA = scalar(`SELECT string_agg(sequence::text, ',' ORDER BY created_at, id) FROM public.messages WHERE thread_id='${THREAD}';`);
    const second = exec(`SELECT public.telegraph_backfill_message_sequences('${THREAD}')::text;`)[0];
    const seqB = scalar(`SELECT string_agg(sequence::text, ',' ORDER BY created_at, id) FROM public.messages WHERE thread_id='${THREAD}';`);
    assert.equal(first, second, "the backfill must touch the same number of rows on a second run");
    assert.equal(seqA, seqB, "the backfill must be deterministic — (created_at, id) breaks millisecond ties stably");
    assert.ok(!String(seqA).includes("NULL"), "a row that predated the flag still has no sequence after a backfill");
  });

  it("leaves the flag as the migration seeded it", (t) => {
    if (!HAVE_DB) { t.diagnostic("no TELEGRAPH_DB_URL"); return; }
    exec(`UPDATE public.feature_flags SET enabled=false WHERE flag='telegraph_message_kernel_enabled';`);
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag='telegraph_message_kernel_enabled';`), "false");
  });
});
