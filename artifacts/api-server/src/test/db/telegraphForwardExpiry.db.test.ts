/**
 * Migration 3665 EXECUTED on a real database: `telegraph_record_forward` and
 * the EXPIRES_WITH_SOURCE trigger (census-telegraph T406 / T407 / T353).
 *
 * T353 asks that share revocation be "fast enough to prevent stale
 * authorization bypass". The latency is MEASURED here, and the unit is
 * transactions, not milliseconds: after a source is unsent through the real
 * §7.4 function (3000), every EXPIRES_WITH_SOURCE derivative's row carries the
 * SAME `xmin` as the source's — it was tombstoned by the same transaction — so
 * there is no committed state of the database, and therefore no reader on any
 * path (API, PostgREST, realtime), in which the source is gone and a derivative
 * is live. A millisecond figure would be a property of the machine; this is a
 * property of the design.
 *
 * WHAT IS NOT MEASURED HERE: a client that already DOWNLOADED a derivative keeps
 * what is on its screen until its next read or until the `message.deleted`
 * event (outbox, 2810) reaches it. No server can recall bytes from a device.
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

  function thread(creator: string, members: string[]): string {
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${creator}') RETURNING id;`);
    const id = out[out.length - 1]!;
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

  function state(id: string): { deleted: boolean; body: string; xmin: string } {
    const [r] = rows<{ deleted: boolean; body: string; xmin: string }>(
      `SELECT (deleted_at IS NOT NULL) AS deleted, body, xmin::text AS xmin FROM public.messages WHERE id = '${id}'`,
    );
    assert.ok(r, `no message ${id}`);
    return r;
  }

  before(() => {
    alice = seedUser("fwd_alice");
    bob = seedUser("fwd_bob");
    carol = seedUser("fwd_carol");
    srcThread = thread(alice, [alice, bob]);
    tgtThread = thread(bob, [bob, carol]);
  });

  after(() => {
    for (const t of [tgtThread, srcThread]) if (t) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    for (const u of [alice, bob, carol]) if (u) deleteUser(u);
  });

  it("CONTROL — 3665's functions and both triggers exist", () => {
    const n = scalar(
      `SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass AND tgname IN ('telegraph_forward_expire_on_tombstone','telegraph_forward_expire_on_delete');`,
    );
    assert.equal(n, "2");
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

  it("T353: an unsend tombstones every EXPIRES_WITH_SOURCE derivative IN THE SAME TRANSACTION (latency: zero commits)", () => {
    const src = message(srcThread, alice, "expiring words", "EXPIRES_WITH_SOURCE");
    const fwd = record(src, bob, "EXPIRES_WITH_SOURCE");
    assert.equal(fwd.outcome, "forwarded");
    const copy = fwd.messageId!;
    assert.equal(state(copy).deleted, false);
    assert.equal(state(copy).body, "copied words");

    const out = svc(`SELECT public.telegraph_unsend_message_before_seen('${src}', '${alice}', '${srcThread}')::text;`);
    assert.equal(JSON.parse(out[out.length - 1]!).outcome, "unsent");

    const s = state(src);
    const c = state(copy);
    assert.equal(c.deleted, true, "the derivative outlived its source's unsend");
    assert.equal(c.body, "", "the derivative's words survived the tombstone");
    assert.equal(c.xmin, s.xmin, "the derivative was tombstoned by a DIFFERENT transaction than the unsend — a window existed");
    assert.equal(scalar(`SELECT (revoked_at IS NOT NULL)::text FROM public.message_forwards WHERE target_message_id = '${copy}';`), "true");
  });

  it("a chain of EXPIRES_WITH_SOURCE forwards expires to its end, in one transaction", () => {
    const src = message(srcThread, alice, "chain", "EXPIRES_WITH_SOURCE");
    const first = record(src, bob, "EXPIRES_WITH_SOURCE").messageId!;
    // The first derivative inherits EXPIRES_WITH_SOURCE; forwarding IT must be decided under that.
    const second = record(first, carol, "EXPIRES_WITH_SOURCE").messageId!;
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${src}';`);
    const x = state(src).xmin;
    assert.equal(state(first).deleted, true);
    assert.equal(state(second).deleted, true, "the second link survived");
    assert.equal(state(second).xmin, x);
  });

  it("ALLOW derivatives survive their source; a later EXPIRES_WITH_SOURCE from the author reaches them", () => {
    const keep = message(srcThread, alice, "allowed", "ALLOW");
    const keptCopy = record(keep, bob, "ALLOW").messageId!;
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${keep}';`);
    assert.equal(state(keptCopy).deleted, false, "an ALLOW derivative was expired");

    const tighten = message(srcThread, alice, "tightened", "ALLOW");
    const tCopy = record(tighten, bob, "ALLOW").messageId!;
    svc(`UPDATE public.message_content_capabilities SET capability = 'EXPIRES_WITH_SOURCE' WHERE message_id = '${tighten}';`);
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${tighten}';`);
    assert.equal(state(tCopy).deleted, true, "the author's later EXPIRES_WITH_SOURCE did not reach the derivative");
  });

  it("a HARD delete of the source expires its derivatives first and keeps the derivative's provenance row", () => {
    const src = message(srcThread, alice, "hard", "EXPIRES_WITH_SOURCE");
    const copy = record(src, bob, "EXPIRES_WITH_SOURCE").messageId!;
    svc(`DELETE FROM public.messages WHERE id = '${src}';`);
    assert.equal(state(copy).deleted, true);
    const [f] = rows<{ source: string | null; revoked: boolean; provenance: string }>(
      `SELECT source_message_id::text AS source, (revoked_at IS NOT NULL) AS revoked, provenance FROM public.message_forwards WHERE target_message_id = '${copy}'`,
    );
    assert.deepEqual(f, { source: null, revoked: true, provenance: "FORWARDED" });
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

  it("deleting a message nobody forwarded is untouched by the trigger", () => {
    const m = message(srcThread, alice, "plain");
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${m}';`);
    assert.equal(state(m).deleted, true);
  });
});
