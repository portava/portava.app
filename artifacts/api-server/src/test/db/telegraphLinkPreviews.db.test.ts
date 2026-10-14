/**
 * Migration 3825 EXECUTED on a real database: `message_link_previews`, its only
 * writer `telegraph_store_link_preview`, and the drop-on-change trigger
 * (census-telegraph T404 / T446, B58 TM-1).
 *
 * WHAT IS PROVED
 *   - The writer stores at most one row per message, and only while the message
 *     is live, in the named thread, in a thread that is not E2EE, and still has
 *     the body whose sha256 the caller fetched for ('stored' | 'exists' |
 *     'message_gone' | 'stale' | 'e2ee').
 *   - The row lives exactly as long as the body it describes (owner question
 *     Q-LP4, fail-closed default): an edit, the real §7.4 unsend function
 *     (3000), a delete-for-everyone tombstone, a hard delete, the thread's
 *     deletion and the sender's messages going at account erasure each remove
 *     it — the soft paths IN THE SAME TRANSACTION as the change (same `xmin`
 *     is not measurable on a deleted row, so the check is that no committed
 *     state shows the new body beside the old preview). An update that touches
 *     neither the body nor `deleted_at` leaves it. The writer holds the message
 *     row FOR SHARE (observed: the row's locker is the writer's transaction), and
 *     the drop runs as its owner, so a role that may edit messages but holds
 *     nothing on the preview table neither fails nor leaves the row behind.
 *   - Client roles hold nothing: no privilege on the table, no EXECUTE on
 *     either function; an `authenticated` session cannot read a row.
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's local-db job is where this counts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { HAVE_DB, asUser, deleteUser, exec, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe("3825 — link previews on a real database", { skip: SKIP }, () => {
  let alice = "";
  let bob = "";
  let thread = "";
  let e2eeThread = "";
  const extraUsers: string[] = [];

  function newThread(creator: string, members: string[], e2ee = false): string {
    const out = svc(`INSERT INTO public.message_threads (thread_type, status, created_by, is_e2ee) VALUES ('direct', 'active', '${creator}', ${e2ee}) RETURNING id;`);
    const id = out[out.length - 1]!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    svc(members.map((m) => `INSERT INTO public.message_thread_members (thread_id, user_id, role) VALUES ('${id}', '${m}', 'member');`).join("\n"));
    return id;
  }

  function message(threadId: string, from: string, body: string): string {
    const out = svc(`INSERT INTO public.messages (thread_id, sender_id, body) VALUES ('${threadId}', '${from}', ${lit(body)}) RETURNING id;`);
    const id = out[out.length - 1]!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    return id;
  }

  function store(messageId: string, threadId: string, digest: string, status: "ok" | "none" = "ok"): string {
    const ok = status === "ok";
    const out = svc(
      `SELECT public.telegraph_store_link_preview('${messageId}', '${threadId}', '${digest}', '${status}', ` +
        `${ok ? "'https://public.example/a'" : "NULL"}, ${ok ? "'public.example'" : "NULL"}, ` +
        `${ok ? "'Title'" : "NULL"}, ${ok ? "'Description'" : "NULL"}, ${ok ? "'Site'" : "NULL"});`,
    );
    return out[out.length - 1]!;
  }

  const hasPreview = (messageId: string) =>
    scalar(`SELECT count(*) FROM public.message_link_previews WHERE message_id = '${messageId}';`) === "1";

  function previewed(body = "see https://public.example/a"): string {
    const id = message(thread, alice, body);
    assert.equal(store(id, thread, sha(body)), "stored");
    assert.ok(hasPreview(id));
    return id;
  }

  before(() => {
    alice = seedUser("lp_alice");
    bob = seedUser("lp_bob");
    thread = newThread(alice, [alice, bob]);
    e2eeThread = newThread(alice, [alice, bob], true);
  });

  after(() => {
    for (const t of [thread, e2eeThread]) if (t) svc(`DELETE FROM public.message_threads WHERE id = '${t}';`);
    for (const u of [alice, bob, ...extraUsers]) if (u) deleteUser(u);
  });

  it("CONTROL — the table, both functions and the trigger exist; RLS on, no policy, no client privilege", () => {
    assert.equal(scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.message_link_previews'::regclass;`), "true");
    assert.equal(scalar(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'message_link_previews';`), "0");
    assert.equal(
      scalar(`SELECT count(*) FROM information_schema.table_privileges WHERE table_schema = 'public' AND table_name = 'message_link_previews' AND grantee IN ('anon','authenticated','PUBLIC');`),
      "0",
    );
    assert.equal(
      scalar(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('telegraph_store_link_preview','telegraph_link_preview_drop_on_change') AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));`),
      "0",
    );
    assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass AND tgname = 'telegraph_link_preview_drop_on_change';`), "1");
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'telegraph_link_previews_enabled';`), "false");
  });

  it("the writer stores ONE row per message: stored, then exists", () => {
    const body = "one https://public.example/a";
    const id = message(thread, alice, body);
    assert.equal(store(id, thread, sha(body)), "stored");
    assert.equal(store(id, thread, sha(body), "none"), "exists");
    const [r] = rows<{ status: string; host: string }>(`SELECT status, host FROM public.message_link_previews WHERE message_id = '${id}'`);
    assert.deepEqual(r, { status: "ok", host: "public.example" });
  });

  it("the writer refuses a body that changed (stale), a deleted message or a wrong thread (message_gone), and an E2EE thread", () => {
    const body = "two https://public.example/a";
    const id = message(thread, alice, body);
    assert.equal(store(id, thread, sha("a different body")), "stale");
    assert.equal(store(id, e2eeThread, sha(body)), "message_gone");
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${id}';`);
    assert.equal(store(id, thread, sha(body)), "message_gone");
    const inE2ee = svc(`INSERT INTO public.messages (thread_id, sender_id, body, ciphertext) VALUES ('${e2eeThread}', '${alice}', 'x', 'opaque') RETURNING id;`);
    const e2eeId = inE2ee[inE2ee.length - 1]!;
    assert.equal(store(e2eeId, e2eeThread, sha("x")), "e2ee");
    assert.equal(hasPreview(id) || hasPreview(e2eeId), false);
  });

  it("the CHECKs refuse an 'ok' row without a link, a non-https link and a malformed digest", () => {
    const body = "three https://public.example/a";
    const id = message(thread, alice, body);
    const bad = [
      `INSERT INTO public.message_link_previews (message_id, thread_id, status, source_digest) VALUES ('${id}', '${thread}', 'ok', '${sha(body)}');`,
      `INSERT INTO public.message_link_previews (message_id, thread_id, status, url, host, source_digest) VALUES ('${id}', '${thread}', 'ok', 'http://public.example/a', 'public.example', '${sha(body)}');`,
      `INSERT INTO public.message_link_previews (message_id, thread_id, status, source_digest) VALUES ('${id}', '${thread}', 'none', 'not-a-digest');`,
      `INSERT INTO public.message_link_previews (message_id, thread_id, status, url, host, source_digest) VALUES ('${id}', '${thread}', 'none', 'https://public.example/a', 'public.example', '${sha(body)}');`,
    ];
    for (const sql of bad) assert.throws(() => svc(sql), /check constraint|violates/i, sql);
  });

  it("an EDIT removes the preview in the edit's own transaction", () => {
    const id = previewed();
    // One transaction: after the UPDATE, inside it, the row is already gone.
    const out = svc(`UPDATE public.messages SET body = 'edited https://public.example/a', edited_at = now() WHERE id = '${id}';\nSELECT count(*) FROM public.message_link_previews WHERE message_id = '${id}';`);
    assert.equal(out[out.length - 1], "0");
    assert.equal(hasPreview(id), false);
  });

  it("the real §7.4 unsend (3000) removes it", () => {
    const id = previewed();
    const out = svc(`SELECT public.telegraph_unsend_message_before_seen('${id}', '${alice}', '${thread}')::text;`);
    assert.equal(JSON.parse(out[out.length - 1]!).outcome, "unsent");
    assert.equal(hasPreview(id), false);
  });

  it("a delete-for-everyone tombstone (deleted_at + blank body) removes it", () => {
    const id = previewed();
    svc(`UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = '${id}';`);
    assert.equal(hasPreview(id), false);
  });

  it("deleted_at alone (body untouched) removes it too", () => {
    const id = previewed();
    svc(`UPDATE public.messages SET deleted_at = now() WHERE id = '${id}';`);
    assert.equal(hasPreview(id), false);
  });

  it("an update of neither body nor deleted_at keeps it (same body re-written included)", () => {
    const body = "keep https://public.example/a";
    const id = previewed(body);
    svc(`UPDATE public.messages SET edited_at = now(), original_language = 'en' WHERE id = '${id}';`);
    svc(`UPDATE public.messages SET body = ${lit(body)} WHERE id = '${id}';`);
    assert.equal(hasPreview(id), true);
  });

  it("a hard delete of the message, the thread's deletion, and the sender's messages going at erasure all cascade", () => {
    const a = previewed();
    svc(`DELETE FROM public.messages WHERE id = '${a}';`);
    assert.equal(hasPreview(a), false);

    const carol = seedUser("lp_carol");
    extraUsers.push(carol);
    const t2 = newThread(carol, [carol, bob]);
    const body = "erase https://public.example/a";
    const b = message(t2, carol, body);
    assert.equal(store(b, t2, sha(body)), "stored");
    svc(`DELETE FROM public.messages WHERE sender_id = '${carol}';`); // AccountDeletionService's messages step
    assert.equal(hasPreview(b), false);

    const c = message(t2, bob, body);
    assert.equal(store(c, t2, sha(body)), "stored");
    svc(`DELETE FROM public.message_threads WHERE id = '${t2}';`);
    assert.equal(hasPreview(c), false);
  });

  it("the writer holds the message row FOR SHARE, so an edit / unsend / delete racing the store waits for it", () => {
    const body = "lock https://public.example/a";
    const id = message(thread, alice, body);
    const lockState = `SELECT CASE WHEN xmax::text = (txid_current() % 4294967296)::text THEN 'LOCKED' ELSE 'FREE' END FROM public.messages WHERE id = '${id}';`;
    // Control: a transaction that only reads the row leaves it unlocked.
    const control = svc(`SELECT txid_current();\n${lockState}`);
    assert.equal(control[control.length - 1], "FREE");
    // The writer's own transaction holds the row lock when it returns. Measured on a REFUSED store
    // ('stale': nothing is inserted), because an insert's foreign-key check takes its own KEY SHARE
    // lock on the same row — which does not hold off an edit of the body — and would mask the lock
    // under test.
    const out = svc(`SELECT public.telegraph_store_link_preview('${id}', '${thread}', '${sha("not this body")}', 'none', NULL, NULL, NULL, NULL, NULL);\n${lockState}`);
    assert.equal(out[out.length - 2], "stale");
    assert.equal(out[out.length - 1], "LOCKED");
  });

  it("the drop runs as its owner: a role that may edit messages but holds nothing on the preview table still edits, and the row still goes", () => {
    const role = `lp_editor_${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    const body = "definer https://public.example/a";
    const out = exec([
      "BEGIN;",
      `INSERT INTO public.messages (id, thread_id, sender_id, body) VALUES ('${id}', '${thread}', '${alice}', ${lit(body)});`,
      `SELECT public.telegraph_store_link_preview('${id}', '${thread}', '${sha(body)}', 'none', NULL, NULL, NULL, NULL, NULL);`,
      `CREATE ROLE ${role} NOLOGIN BYPASSRLS;`,
      `GRANT USAGE ON SCHEMA public TO ${role};`,
      `GRANT SELECT, UPDATE ON public.messages TO ${role};`,
      `GRANT SELECT ON public.feature_flags TO ${role};`,
      `SET LOCAL ROLE ${role};`,
      `UPDATE public.messages SET body = 'edited by a narrow role' WHERE id = '${id}';`,
      "RESET ROLE;",
      `SELECT 'LEFT=' || count(*) FROM public.message_link_previews WHERE message_id = '${id}';`,
      "ROLLBACK;",
    ].join("\n"));
    assert.ok(out.includes("stored"), out.join(" "));
    assert.ok(out.includes("LEFT=0"), out.join(" "));
  });

  it("an authenticated session (the PostgREST path) reads nothing and cannot call the writer", () => {
    const id = previewed();
    assert.throws(() => asUser(alice, `SELECT count(*) FROM public.message_link_previews;`), /permission denied/i);
    assert.throws(
      () => asUser(alice, `SELECT public.telegraph_store_link_preview('${id}', '${thread}', '${sha("x")}', 'none', NULL, NULL, NULL, NULL, NULL);`),
      /permission denied/i,
    );
    assert.equal(hasPreview(id), true);
  });
});
