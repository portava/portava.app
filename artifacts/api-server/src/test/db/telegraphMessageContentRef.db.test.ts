/**
 * Migration 3936 EXECUTED on a real database (census-telegraph T141, T156, §12 / §12.1):
 * messages.content_ref WRITTEN — `portava:<objectType>:<objectId>` for a Portava object card,
 * derived by the database from the stored body, so every door that writes a card gets it.
 *
 * Pinned here, on PostgreSQL itself:
 *   · a card (msg_type portava_object, a PORTAVA_OBJECT body) gets its reference;
 *   · text, another kind, malformed JSON or an out-of-shape id get NULL — never a guess;
 *   · with telegraph_message_kernel_enabled OFF nothing is written (2810's own rule);
 *   · an unsend or a delete clears the reference in the same UPDATE, flag or no flag;
 *   · a direct write of content_ref is re-derived from the body (it cannot be forged);
 *   · no client role can execute the trigger function.
 *
 * Each case runs in ONE transaction that turns the kernel flag on and is ROLLED BACK, so
 * the shared local database is left exactly as it was.
 *
 * MUTANTS (applied to the local database one at a time, each red, each restored by
 * re-applying 3936 — tgprod/mutants-b3.txt):
 *   CR1 the reference never written ............................................... red
 *   CR2 the tombstone keeps its reference ......................................... red
 *   CR3 the kernel flag ignored ................................................... red
 *   CR4 any JSON body accepted (no PORTAVA_OBJECT kind check) ..................... red
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's local-db job is where this counts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;
const PLACE = "3f1c2b4a-0000-4000-8000-00000000c0de";

/** Run `script` in one transaction with the kernel flag set as given, return its output lines, roll back. */
function rolledBack(kernelOn: boolean, script: string): string[] {
  const r = psql(
    [
      "BEGIN;",
      `UPDATE public.feature_flags SET enabled = ${kernelOn} WHERE flag = 'telegraph_message_kernel_enabled';`,
      "SET LOCAL ROLE service_role;",
      script,
      "ROLLBACK;",
    ].join("\n"),
  );
  if (r.status !== 0) throw new Error(`psql exited ${r.status}:\n${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

const card = (type: string, id: string) =>
  JSON.stringify({ kind: "PORTAVA_OBJECT", objectType: type, objectId: id, caption: null, shareProjectionVersion: 1 }).replace(/'/g, "''");

describe("3936 — messages.content_ref for a Portava object card, on a real database", { skip: SKIP }, () => {
  let alice = "";
  let t = "";

  before(() => {
    alice = seedUser("cr_alice");
    const out = exec(`SET LOCAL ROLE service_role;\nINSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${alice}') RETURNING id;`, { single: true });
    t = out[out.length - 1]!;
  });

  after(() => {
    if (t) exec(`SET LOCAL ROLE service_role;\nDELETE FROM public.message_threads WHERE id = '${t}';`, { single: true });
    if (alice) deleteUser(alice);
  });

  const insert = (msgType: string, body: string) =>
    `INSERT INTO public.messages (thread_id, sender_id, msg_type, body) VALUES ('${t}', '${alice}', '${msgType}', '${body}') RETURNING coalesce(content_ref, '<null>');`;

  it("a card gets portava:<objectType>:<objectId>", () => {
    assert.deepEqual(rolledBack(true, insert("portava_object", card("PLACE", PLACE))), [`portava:PLACE:${PLACE}`]);
  });

  it("text, another kind, malformed JSON and an out-of-shape id get NULL", () => {
    assert.deepEqual(rolledBack(true, insert("text", card("PLACE", PLACE))), ["<null>"], "a text message is not a card, whatever its body says");
    assert.deepEqual(rolledBack(true, insert("portava_object", "not json at all")), ["<null>"]);
    assert.deepEqual(rolledBack(true, insert("portava_object", JSON.stringify({ kind: "ANNOUNCEMENT", objectType: "PLACE", objectId: PLACE }))), ["<null>"]);
    assert.deepEqual(rolledBack(true, insert("portava_object", card("place", PLACE))), ["<null>"], "objectType outside the vocabulary's shape");
    assert.deepEqual(rolledBack(true, insert("portava_object", card("PLACE", "has space"))), ["<null>"]);
  });

  it("with the kernel flag OFF nothing is written", () => {
    assert.deepEqual(rolledBack(false, insert("portava_object", card("PLACE", PLACE))), ["<null>"]);
  });

  it("an unsend or a delete clears the reference in the same UPDATE, flag or no flag", () => {
    const out = rolledBack(true, [
      `WITH m AS (${insert("portava_object", card("TRIP", PLACE)).replace(" RETURNING coalesce(content_ref, '<null>');", " RETURNING id")}) SELECT id FROM m \\gset`,
      `SELECT content_ref FROM public.messages WHERE id = :'id';`,
      `UPDATE public.feature_flags SET enabled = false WHERE flag = 'telegraph_message_kernel_enabled';`,
      `UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = :'id' RETURNING coalesce(content_ref, '<null>');`,
    ].join("\n"));
    assert.deepEqual(out, [`portava:TRIP:${PLACE}`, "<null>"]);
    const unsent = rolledBack(true, [
      `WITH m AS (${insert("portava_object", card("PLACE", PLACE)).replace(" RETURNING coalesce(content_ref, '<null>');", " RETURNING id")}) SELECT id FROM m \\gset`,
      `UPDATE public.messages SET unsent_at = now() WHERE id = :'id' RETURNING coalesce(content_ref, '<null>');`,
    ].join("\n"));
    assert.deepEqual(unsent, ["<null>"]);
  });

  it("a direct write of content_ref is re-derived from the body: the reference cannot be forged", () => {
    const out = rolledBack(true, [
      `WITH m AS (${insert("portava_object", card("PLACE", PLACE)).replace(" RETURNING coalesce(content_ref, '<null>');", " RETURNING id")}) SELECT id FROM m \\gset`,
      `UPDATE public.messages SET content_ref = 'portava:TRIP:someone-elses' WHERE id = :'id' RETURNING content_ref;`,
    ].join("\n"));
    assert.deepEqual(out, [`portava:PLACE:${PLACE}`]);
  });

  it("no client role can execute the trigger function", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.telegraph_message_content_ref()', 'EXECUTE')`), "f", role);
    }
  });
});
