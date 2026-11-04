/**
 * Migration 3938 EXECUTED on a real database (census-telegraph T147, §12): every Portava object card is
 * recorded as an explicit, revocable conversation_action_refs row by the database itself.
 *
 * Pinned: a card of one of 2811's eight object types gets one reference (type mapped, uuid id,
 * payload_version = shareProjectionVersion, created_by = the sender); another object type, a non-uuid
 * id, a malformed body or text gets none; with the kernel flag OFF nothing is written; an unsend or a
 * delete-for-everyone ERASES the reference in the same UPDATE, flag or no flag (3936's rule: a tombstone
 * carries no reference — nothing of what the sender took back is retained); a hard DELETE of the message
 * ERASES its references (account deletion erases the account's messages, so no reference outlives them
 * carrying created_by); no client role can read or write a reference, or run the function.
 *
 * Every case runs in ONE transaction that is ROLLED BACK.
 *
 * MUTANTS (tgprod/mutants-b4.txt): AR1 no reference written; AR2 a retraction leaves it live;
 * AR3 a hard delete leaves the row (created_by survives); AR4 the flag ignored; AR5 a retraction only
 * REVOKES (the object id and created_by retained after the sender took the message back).
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;
const PLACE = "3f1c2b4a-0000-4000-8000-00000000c0de";

function rolledBack(kernelOn: boolean, script: string): string[] {
  const r = psql(["BEGIN;", `UPDATE public.feature_flags SET enabled = ${kernelOn} WHERE flag = 'telegraph_message_kernel_enabled';`, "SET LOCAL ROLE service_role;", script, "ROLLBACK;"].join("\n"));
  if (r.status !== 0) throw new Error(`psql exited ${r.status}:\n${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}
const card = (type: string, id: string, v = 1) =>
  JSON.stringify({ kind: "PORTAVA_OBJECT", objectType: type, objectId: id, caption: null, shareProjectionVersion: v }).replace(/'/g, "''");

describe("3938 — conversation_action_refs written for every Portava object card, on a real database", { skip: SKIP }, () => {
  let alice = "";
  let t = "";
  before(() => {
    alice = seedUser("ar_alice");
    const out = exec(`SET LOCAL ROLE service_role;\nINSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${alice}') RETURNING id;`, { single: true });
    t = out[out.length - 1]!;
  });
  after(() => {
    if (t) exec(`SET LOCAL ROLE service_role;\nDELETE FROM public.message_threads WHERE id = '${t}';`, { single: true });
    if (alice) deleteUser(alice);
  });

  const insertCard = (body: string, msgType = "portava_object") =>
    `WITH m AS (INSERT INTO public.messages (thread_id, sender_id, msg_type, body) VALUES ('${t}', '${alice}', '${msgType}', '${body}') RETURNING id) SELECT id FROM m \\gset`;
  const refsOf = () => `SELECT coalesce(string_agg(object_type || ':' || object_id || ':v' || payload_version || ':' || (created_by = '${alice}')::text || ':' || coalesce(revoked_reason, 'live'), ','), '<none>') FROM public.conversation_action_refs WHERE message_id = :'id';`;

  it("a card of one of the eight types gets one reference: type mapped, uuid id, the card's version, the sender", () => {
    assert.deepEqual(rolledBack(true, [insertCard(card("PLACE", PLACE, 2)), refsOf()].join("\n")), [`place:${PLACE}:v2:true:live`]);
    assert.deepEqual(rolledBack(true, [insertCard(card("MEETUP", PLACE)), refsOf()].join("\n")), [`meetup:${PLACE}:v1:true:live`]);
  });

  it("another object type, a non-uuid id, a malformed body or a text message gets none", () => {
    assert.deepEqual(rolledBack(true, [insertCard(card("PROFILE", PLACE)), refsOf()].join("\n")), ["<none>"]);
    assert.deepEqual(rolledBack(true, [insertCard(card("PLACE", "not-a-uuid")), refsOf()].join("\n")), ["<none>"]);
    assert.deepEqual(rolledBack(true, [insertCard("{oops"), refsOf()].join("\n")), ["<none>"]);
    assert.deepEqual(rolledBack(true, [insertCard(card("PLACE", PLACE), "text"), refsOf()].join("\n")), ["<none>"]);
  });

  it("with the kernel flag OFF nothing is written", () => {
    assert.deepEqual(rolledBack(false, [insertCard(card("PLACE", PLACE)), refsOf()].join("\n")), ["<none>"]);
  });

  it("an unsend or a delete-for-everyone ERASES the reference, flag or no flag — nothing of it is retained", () => {
    const anyRow = `SELECT count(*) FROM public.conversation_action_refs WHERE message_id = :'id' OR (created_by = '${alice}' AND object_id = '${PLACE}');`;
    const unsent = rolledBack(true, [insertCard(card("TRIP", PLACE)), refsOf(),
      `UPDATE public.feature_flags SET enabled = false WHERE flag = 'telegraph_message_kernel_enabled';`,
      `UPDATE public.messages SET unsent_at = now(), body = '' WHERE id = :'id';`, anyRow].join("\n"));
    assert.deepEqual(unsent, [`trip:${PLACE}:v1:true:live`, "0"]);
    const deleted = rolledBack(true, [insertCard(card("EVENT", PLACE)), refsOf(), `UPDATE public.messages SET deleted_at = now(), body = '' WHERE id = :'id';`, anyRow].join("\n"));
    assert.deepEqual(deleted, [`event:${PLACE}:v1:true:live`, "0"]);
  });

  it("a hard DELETE of the message ERASES its references, so created_by does not outlive it", () => {
    const out = rolledBack(true, [insertCard(card("PLACE", PLACE)),
      `SELECT count(*) FROM public.conversation_action_refs WHERE message_id = :'id';`,
      `DELETE FROM public.messages WHERE id = :'id';`,
      `SELECT count(*) FROM public.conversation_action_refs WHERE created_by = '${alice}' AND object_id = '${PLACE}';`].join("\n"));
    assert.deepEqual(out, ["1", "0"]);
  });

  it("no client role can read or write a reference, or run the function", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.telegraph_conversation_action_refs_sync()', 'EXECUTE')`), "f", role);
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.conversation_action_refs', '${priv}')`), "f", `${role} ${priv}`);
      }
    }
    const r = psql([
      `SELECT set_config('request.jwt.claim.sub', '${alice}', true);`, `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`, "SET LOCAL ROLE authenticated;",
      `INSERT INTO public.conversation_action_refs (conversation_id, object_type, object_id) VALUES ('${t}', 'place', '${PLACE}');`,
    ].join("\n"), { single: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /row-level security|permission denied/);
  });
});
