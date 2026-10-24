/**
 * Migration 3937 EXECUTED on a real database (census-telegraph T347, §28 SLO-02): the exact count of
 * duplicate canonical messages under the idempotency contract.
 *
 * Pinned here: two rows one sender put into one conversation under one client message id are ONE
 * duplicate; the unique index makes a second row under one idempotency key impossible (so the count
 * there is 0 by the index, and the index is shown refusing); a message with no key is outside the
 * contract and counted neither way; only the service role can run the count.
 *
 * Every case runs in one transaction that is ROLLED BACK, so the shared local database is unchanged.
 *
 * MUTANT (tgprod/mutants-b3.txt): DC1 the count ignores client_message_id-only rows ............ red
 *
 * Skips without LOCAL_DB_URL; scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = !HAVE_DB;

describe("3937 — telegraph_duplicate_canonical_messages(), on a real database", { skip: SKIP }, () => {
  let alice = "";
  let t = "";
  before(() => {
    alice = seedUser("dc_alice");
    const out = exec(`SET LOCAL ROLE service_role;\nINSERT INTO public.message_threads (thread_type, status, created_by) VALUES ('group', 'active', '${alice}') RETURNING id;`, { single: true });
    t = out[out.length - 1]!;
  });
  after(() => {
    if (t) exec(`SET LOCAL ROLE service_role;\nDELETE FROM public.message_threads WHERE id = '${t}';`, { single: true });
    if (alice) deleteUser(alice);
  });

  /** The count's delta from a baseline taken inside the same rolled-back transaction. */
  function delta(script: string): { dup: number; keyed: number } {
    const r = psql([
      "BEGIN;", "SET LOCAL ROLE service_role;",
      "SELECT duplicate_rows AS d0, keyed_groups AS k0 FROM public.telegraph_duplicate_canonical_messages() \\gset",
      script,
      "SELECT (duplicate_rows - :d0) || ',' || (keyed_groups - :k0) FROM public.telegraph_duplicate_canonical_messages();",
      "ROLLBACK;",
    ].join("\n"));
    if (r.status !== 0) throw new Error(r.stderr);
    const [dup, keyed] = r.stdout.trim().split("\n").pop()!.split(",").map(Number);
    return { dup: dup!, keyed: keyed! };
  }
  const msg = (extra: string) => `INSERT INTO public.messages (thread_id, sender_id, body${extra ? ", " + extra.split("=")[0] : ""}) VALUES ('${t}', '${alice}', 'x'${extra ? ", '" + extra.split("=")[1] + "'" : ""});`;

  it("two rows under one client message id are ONE duplicate; with a second id that is two keyed groups", () => {
    assert.deepEqual(delta([msg("client_message_id=c-1"), msg("client_message_id=c-1"), msg("client_message_id=c-2")].join("\n")), { dup: 1, keyed: 2 });
  });

  it("a message with no key is outside the contract: counted neither way", () => {
    assert.deepEqual(delta([msg(""), msg("")].join("\n")), { dup: 0, keyed: 0 });
  });

  it("under one idempotency key a second row is refused by the index, so the count there is 0 by construction", () => {
    const r = psql(["BEGIN;", "SET LOCAL ROLE service_role;", msg("idempotency_key=k-1"), msg("idempotency_key=k-1"), "ROLLBACK;"].join("\n"));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /messages_idempotency_uniq/);
  });

  it("only the service role can run the count", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.telegraph_duplicate_canonical_messages()', 'EXECUTE')`), "f", role);
    }
    assert.equal(scalar(`SELECT has_function_privilege('service_role', 'public.telegraph_duplicate_canonical_messages()', 'EXECUTE')`), "t");
  });
});
