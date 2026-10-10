/**
 * Migration 3665 EXECUTED on a real database: `telegraph_record_forward` and
 * the EXPIRES_WITH_SOURCE triggers (census-telegraph T406 / T407 / T353).
 *
 * T353 asks that share revocation be "fast enough to prevent stale
 * authorization bypass". The latency is MEASURED here, and the unit is
 * transactions, not milliseconds:
 *   · SOFT path (unsend / delete set `deleted_at`): after a source is unsent
 *     through the real §7.4 function (3000), every EXPIRES_WITH_SOURCE
 *     derivative's row carries the SAME `xmin` as the source's — it was
 *     tombstoned by the same transaction.
 *   · HARD path (DELETE): the derivative is tombstoned by the AFTER DELETE
 *     statement trigger at the end of the deleting statement — again the same
 *     transaction, so again the same `xmin`.
 * Either way there is no committed state of the database, and therefore no
 * reader on any path, in which the source is gone and a derivative is live.
 *
 * DELETION IS NEVER BLOCKED (verification V-TP F1). A BEFORE DELETE trigger that
 * wrote `messages` aborted any multi-row DELETE holding a source and its live
 * derivative — AccountDeletionService's `delete messages` step among them. The
 * three shapes that failed are cases below, each asserting the statement
 * SUCCEEDS and erases every row it names.
 *
 * WHAT IS NOT MEASURED HERE: a client that already DOWNLOADED a derivative keeps
 * what is on its screen until its next read or until the `message.deleted`
 * event (outbox, 2810) reaches it. No server can recall bytes from a device.
 *
 * Threads are `direct`: the baseline's `chk_thread_context` admits only
 * trip / circle / direct (V-TP F2 — a `group` fixture made before() throw).
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's local-db job is where this counts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

interface Fwd { outcome: string; messageId?: string }

describe("3665 — forwarding provenance and EXPIRES_WITH_SOURCE, on a real database", { skip: SKIP }, () => {
  let alice = "";
  let bob = "";
  let carol = "";
  let srcThread = "";
  let tgtThread = "";
  const extraUsers: string[] = [];
  const extraThreads: string[] = [];

  function thread(creator: string, members: string[]): string {
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('direct', 'active', '${creator}') RETURNING id;`);
    const id = out[out.length - 1]!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    svc(members.map((m) => `INSERT INTO public.message_thread_members (thread_id, user_id, role) VALUES ('${id}', '${m}', 'member');`).join("\n"));
    return id;
  }

  function message(threadId: string, from: string, body: string, capability?: string): string {
    const out = svc(`INSERT INTO public.messages (thread_id, sender_id, body) VALUES ('${threadId}', '${from}', '${body}') RETURNING id;`);
    const id = out[out.length - 1]!;
    if (capability) {
      svc(`INSERT INTO public.message_content_capabilities (message_id, capability, set_by) VALUES ('${id}', '${capability}', '${from}');`);
    }
    return id;
  }

  function record(source: string, forwarder: string, capability: string, target = tgtThread, provenance = "FORWARDED"): Fwd {
    const out = svc(
      `SELECT public.telegraph_record_forward('${source}', '${target}', '${forwarder}', 'copied words', 'text', NULL, '${provenance}', '${capability}')::text;`,
    );
    return JSON.parse(out[out.length - 1]!) as Fwd;
  }

  function forwarded(source: string, forwarder: string, capability: string, target = tgtThread): string {
    const r = record(source, forwarder, capability, target);
    assert.equal(r.outcome, "forwarded", JSON.stringify(r));
    return r.messageId!;
  }

  function state(id: string): { deleted: boolean; body: string; xmin: string } | null {
    const [r] = rows<{ deleted: boolean; body: string; xmin: string }>(
      `SELECT (deleted_at IS NOT NULL) AS deleted, body, xmin::text AS xmin FROM public.messages WHERE id = '${id}'`,
    );
    return r ?? null;
  }

  const live = (id: string) => {
    const s = state(id);
    return s !== null && !s.deleted;
  };

  before(() => {
    alice = seedUser("fwd_alice");
    bob = seedUser("fwd_bob");
    carol = seedUser("fwd_carol");
    srcThread = thread(alice, [alice, bob]);
    tgtThread = thread(bob, [bob, carol]);
  });

  after(() => {
    for (const t of [tgtThread, srcThread, ...extraThreads]) if (t) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    for (const u of [alice, bob, carol, ...extraUsers]) if (u) deleteUser(u);
  });

  it("CONTROL — 3665's functions and all four triggers exist", () => {
    assert.equal(
      scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass AND tgname IN ('telegraph_forward_expire_on_tombstone','telegraph_forward_expire_on_delete','telegraph_forward_expire_after_delete');`),
      "3",
    );
    assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname = 'telegraph_forward_capability_ratchet';`), "1");
    assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'telegraph_record_forward';`), "1");
  });

  it("the lineage is service-role only: no client role can read it or write a derivative", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.message_forwards', 'SELECT')::text;`), "false", role);
      assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.message_content_capabilities', 'SELECT')::text;`), "false", role);
      assert.equal(
        scalar(`SELECT has_function_privilege('${role}', 'public.telegraph_record_forward(uuid,uuid,uuid,text,text,text,text,text)', 'EXECUTE')::text;`),
        "false",
        role,
      );
    }
  });

  it("T353 soft path: an unsend tombstones every EXPIRES_WITH_SOURCE derivative IN THE SAME TRANSACTION", () => {
    const src = message(srcThread, alice, "expiring words", "EXPIRES_WITH_SOURCE");
    const copy = forwarded(src, bob, "EXPIRES_WITH_SOURCE");
    assert.equal(state(copy)!.body, "copied words");

    const out = svc(`SELECT public.telegraph_unsend_message_before_seen('${src}', '${alice}', '${srcThread}')::text;`);
    assert.equal(JSON.parse(out[out.length - 1]!).outcome, "unsent");

    const s = state(src)!;
    const c = state(copy)!;
    assert.equal(c.deleted, true, "the derivative outlived its source's unsend");
    assert.equal(c.body, "", "the derivative's words survived the tombstone");
    assert.equal(c.xmin, s.xmin, "the derivative was tombstoned by a DIFFERENT transaction than the unsend — a window existed");
    assert.equal(scalar(`SELECT (revoked_at IS NOT NULL)::text FROM public.message_forwards WHERE target_message_id = '${copy}';`), "true");
  });

  it("T353 hard path: a DELETE expires the derivative at the end of the deleting statement, same transaction", () => {
    const src = message(srcThread, alice, "hard", "EXPIRES_WITH_SOURCE");
    const copy = forwarded(src, bob, "EXPIRES_WITH_SOURCE");
    // One transaction that deletes the source and then reads txid; the derivative's xmin must be it.
    const out = svc(`DELETE FROM public.messages WHERE id = '${src}';\nSELECT txid_current()::text;`);
    const txid = out[out.length - 1]!;
    const c = state(copy)!;
    assert.equal(c.deleted, true);
    assert.equal(c.body, "");
    assert.equal(c.xmin, String(Number(txid) % 2 ** 32), "the hard-path tombstone was not written by the deleting transaction");
    const [f] = rows<{ source: string | null; revoked: boolean; pending: boolean; provenance: string }>(
      `SELECT source_message_id::text AS source, (revoked_at IS NOT NULL) AS revoked, expire_pending AS pending, provenance FROM public.message_forwards WHERE target_message_id = '${copy}'`,
    );
    assert.deepEqual(f, { source: null, revoked: true, pending: false, provenance: "FORWARDED" });
  });

  it("a chain of EXPIRES_WITH_SOURCE forwards expires to its end, in one transaction", () => {
    const src = message(srcThread, alice, "chain", "EXPIRES_WITH_SOURCE");
    const first = forwarded(src, bob, "EXPIRES_WITH_SOURCE");
    const second = forwarded(first, carol, "EXPIRES_WITH_SOURCE");
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${src}';`);
    const x = state(src)!.xmin;
    assert.equal(state(first)!.deleted, true);
    assert.equal(state(second)!.deleted, true, "the second link survived");
    assert.equal(state(second)!.xmin, x);
  });

  it("ALLOW derivatives survive their source", () => {
    const keep = message(srcThread, alice, "allowed", "ALLOW");
    const keptCopy = forwarded(keep, bob, "ALLOW");
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${keep}';`);
    assert.equal(live(keptCopy), true, "an ALLOW derivative was expired");
  });

  it("V-TP F3: an author's LATER EXPIRES_WITH_SOURCE reaches the whole chain — grandchildren included — and reads as such", () => {
    const a = message(srcThread, alice, "tightened", "ALLOW");
    const b = forwarded(a, bob, "ALLOW");
    const c = forwarded(b, carol, "ALLOW");
    svc(`UPDATE public.message_content_capabilities SET capability = 'EXPIRES_WITH_SOURCE' WHERE message_id = '${a}';`);
    // The ratchet is visible BEFORE anything is deleted: the thread read reports the truth.
    assert.equal(scalar(`SELECT capability FROM public.message_forwards WHERE target_message_id = '${c}';`), "EXPIRES_WITH_SOURCE");
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${a}';`);
    assert.equal(live(b), false, "the child survived the tightened source");
    assert.equal(live(c), false, "the GRANDCHILD survived the tightened source");
  });

  // ── V-TP F1: deletion is never blocked ─────────────────────────────────────

  it("F1(a) account deletion's own statement: DELETE … WHERE sender_id erases a source AND its same-author derivative", () => {
    const dave = seedUser("fwd_dave");
    extraUsers.push(dave);
    const t1 = thread(dave, [dave, alice]);
    const t2 = thread(dave, [dave, carol]);
    extraThreads.push(t1, t2);
    const a = message(t1, dave, "dave's words", "EXPIRES_WITH_SOURCE");
    const ownCopy = forwarded(a, dave, "EXPIRES_WITH_SOURCE", t2); // the author forwards their own words (P-TPLAT-1's path)
    const othersCopy = forwarded(a, alice, "EXPIRES_WITH_SOURCE", srcThread); // someone else's derivative of it
    const plain = message(t1, dave, "another");
    // AccountDeletionService.ts: sc.from("messages").delete().eq("sender_id", userId)
    svc(`DELETE FROM public.messages WHERE sender_id = '${dave}';`);
    assert.equal(scalar(`SELECT count(*) FROM public.messages WHERE sender_id = '${dave}';`), "0", "the person's messages were not all erased");
    for (const id of [a, ownCopy, plain]) assert.equal(state(id), null, id);
    assert.equal(live(othersCopy), false, "another member's EXPIRES_WITH_SOURCE derivative outlived the author's account");
    assert.equal(scalar(`SELECT count(*) FROM public.message_forwards WHERE expire_pending;`), "0", "a pending marker was left behind");
  });

  it("F1(b) a chain forwarder's account deletion: DELETE … WHERE sender_id over a copy AND a re-forward of it", () => {
    const erin = seedUser("fwd_erin");
    extraUsers.push(erin);
    const t3 = thread(erin, [erin, bob]);
    extraThreads.push(t3);
    const a = message(srcThread, alice, "root", "EXPIRES_WITH_SOURCE");
    const first = forwarded(a, erin, "EXPIRES_WITH_SOURCE", t3);
    const second = forwarded(first, erin, "EXPIRES_WITH_SOURCE", t3);
    const third = forwarded(second, bob, "EXPIRES_WITH_SOURCE", t3);
    svc(`DELETE FROM public.messages WHERE sender_id = '${erin}';`);
    assert.equal(state(first), null);
    assert.equal(state(second), null);
    assert.equal(live(third), false, "Bob's derivative of the deleted copy survived");
    assert.equal(live(a), true, "the root, which is not the forwarder's, was touched");
  });

  it("F1(c) a thread's cascade delete after a same-thread forward", () => {
    const t4 = thread(alice, [alice, bob]);
    const a = message(t4, alice, "same thread", "EXPIRES_WITH_SOURCE");
    const sameThreadCopy = forwarded(a, bob, "EXPIRES_WITH_SOURCE", t4);
    const elsewhere = forwarded(a, bob, "EXPIRES_WITH_SOURCE", tgtThread);
    svc(`DELETE FROM public.message_threads WHERE id = '${t4}';`);
    assert.equal(scalar(`SELECT count(*) FROM public.messages WHERE thread_id = '${t4}';`), "0");
    assert.equal(state(sameThreadCopy), null);
    assert.equal(live(elsewhere), false, "a derivative in another thread outlived its thread-deleted source");
  });

  it("the writer re-checks under lock: NO_FORWARD, a gone source and a stale capability write nothing; COPIED_ATTACHMENT is refused", () => {
    const count = () => scalar(`SELECT count(*) FROM public.messages WHERE thread_id = '${tgtThread}';`);
    const n0 = count();
    const nf = message(srcThread, alice, "never", "NO_FORWARD");
    assert.equal(record(nf, bob, "ALLOW").outcome, "restricted");
    const gone = message(srcThread, alice, "gone");
    svc(`UPDATE public.messages SET deleted_at = now() WHERE id = '${gone}';`);
    assert.equal(record(gone, bob, "SOURCE_POLICY").outcome, "source_gone");
    const def = message(srcThread, alice, "default");
    assert.equal(record(def, bob, "ALLOW").outcome, "capability_changed", "a caller's stale ALLOW beat the stored default");
    assert.equal(count(), n0, "a refused forward wrote a message");
    assert.throws(() => record(def, alice, "SOURCE_POLICY", tgtThread, "COPIED_ATTACHMENT"));
  });

  it("deleting or tombstoning a message nobody forwarded is untouched by the triggers", () => {
    const m = message(srcThread, alice, "plain");
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${m}';`);
    assert.equal(state(m)!.deleted, true);
    const h = message(srcThread, alice, "plain hard");
    svc(`DELETE FROM public.messages WHERE id = '${h}';`);
    assert.equal(state(h), null);
  });
});
