/**
 * OD-1012-DEL-1 / migration 3770 — a trip that still has its conversation is
 * refused a hard delete with a TYPED refusal (SQLSTATE PT409) before anything
 * cascades, on the replayed chain with the real kernel.
 *
 * THE DEFECT. `message_threads.trip_id` is ON DELETE SET NULL while
 * `chk_thread_context` (3660) requires a `trip` thread to carry a trip_id, so
 * the referential action can never succeed: the delete failed with a raw 23514
 * about `message_threads`, a table the deleter never named. Owner ruling: do not
 * bypass the constraint, do not cascade-delete chat history, bring back the
 * undecided fate of the conversation. 3770 decides nothing; it refuses clearly.
 *
 * WHAT IS PROVED HERE:
 *   · service path: the delete of a trip with its thread is refused PT409
 *     (`trip_delete_refused`), and the trip, its crew, its kernel events, the
 *     thread, its roster and its message are all still there;
 *   · PostgREST path: the owner over RLS, having LEFT the crew thread (so
 *     mt_select hides it from them), still gets PT409, not the raw 23514;
 *   · one statement deleting two trips, one of them with a thread, removes
 *     neither;
 *   · a trip with no thread hard-deletes exactly as before;
 *   · account deletion on the chain (auth.users -> profiles; 2139 made
 *     trips.owner_id SET NULL) is NOT blocked: the trip, its thread and the other
 *     member's message survive with the owner nulled.
 *
 * The full matrix (apply / re-apply / $post$ alone / rollback / the baseline's
 * CASCADE edge / SQL mutants) is the PGlite rehearsal named in docs/migrations.md.
 *
 * Run: LOCAL_DB_URL=... node --import tsx/esm --test src/test/db/tripHardDeleteThreadGuard.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

/** One script as the service role, in ONE transaction (so SET LOCAL holds). */
function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

/** Run a statement and return psql's exit status plus the error line with its SQLSTATE (VERBOSITY verbose). */
function attempt(script: string, asUser?: string): { status: number; err: string } {
  const who = asUser
    ? `SELECT set_config('request.jwt.claim.sub', '${asUser}', true);\nSELECT set_config('request.jwt.claim.role', 'authenticated', true);\nSET LOCAL ROLE authenticated;`
    : "SET LOCAL ROLE service_role;";
  const r = psql(`\\set VERBOSITY verbose\n${who}\n${script}`, { single: true });
  return { status: r.status, err: r.stderr };
}

const count = (sql: string): number => Number(scalar(`SELECT (${sql})::int;`));

describe("3770 trips_refuse_delete_with_thread — on the replayed chain", { skip: SKIP }, () => {
  let owner = ""; let bob = ""; let cleo = "";
  const threads: string[] = [];
  const users: string[] = [];

  function trip(by: string, members: string[]): string {
    const tripId = randomUUID();
    const r = kernel(command({ actor_user_id: by, trip_id: tripId, type: "CREATE_TRIP",
      payload: { title: "td", destination_city: "Porto", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const m of members) {
      const a = kernel(command({ actor_user_id: by, trip_id: tripId, type: "ADD_PARTICIPANT", payload: { user_id: m, role: "member" } }));
      assert.equal(a.ok, true, JSON.stringify(a));
    }
    return tripId;
  }
  function thread(tripId: string, roster: Array<[string, boolean]>, sender: string): { threadId: string; messageId: string } {
    const t = svc(`INSERT INTO public.message_threads (thread_type, trip_id, status, title) VALUES ('trip', '${tripId}', 'active', 'td') RETURNING id;`);
    const threadId = t[t.length - 1]!;
    threads.push(threadId);
    for (const [u, left] of roster) {
      svc(`INSERT INTO public.message_thread_members (thread_id, user_id, role, left_at) VALUES ('${threadId}', '${u}', 'member', ${left ? "now()" : "NULL"});`);
    }
    const m = svc(`INSERT INTO public.messages (thread_id, sender_id, body) VALUES ('${threadId}', '${sender}', 'crew only') RETURNING id;`);
    return { threadId, messageId: m[m.length - 1]! };
  }
  function intact(tripId: string, threadId: string, messageId: string): void {
    assert.equal(count(`SELECT count(*) FROM public.trips WHERE id = '${tripId}'`), 1, "the trip");
    assert.ok(count(`SELECT count(*) FROM public.trip_members WHERE trip_id = '${tripId}'`) > 0, "its crew");
    assert.ok(count(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`) > 0, "its kernel events");
    assert.equal(count(`SELECT count(*) FROM public.message_threads WHERE id = '${threadId}' AND trip_id = '${tripId}' AND thread_type = 'trip'`), 1, "the thread, still a trip thread");
    assert.ok(count(`SELECT count(*) FROM public.message_thread_members WHERE thread_id = '${threadId}'`) > 0, "its roster");
    assert.equal(count(`SELECT count(*) FROM public.messages WHERE id = '${messageId}'`), 1, "its message");
  }

  before(() => {
    owner = seedUser("td_owner"); bob = seedUser("td_bob"); cleo = seedUser("td_cleo");
    users.push(owner, bob, cleo);
  });

  after(() => {
    // Threads first: that is the very refusal under test.
    for (const id of threads) svc(`DELETE FROM public.message_threads WHERE id = '${id}';`);
    for (const id of users) if (id) deleteUser(id);
  });

  it("CONTROL: the trigger is installed, BEFORE DELETE on trips, and no client role can execute its function", () => {
    const def = scalar(`SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.trips'::regclass AND tgname = 'trips_refuse_delete_with_thread' AND NOT tgisinternal;`);
    assert.match(def ?? "", /BEFORE DELETE ON public\.trips FOR EACH ROW EXECUTE FUNCTION trips_refuse_delete_with_thread\(\)/);
    assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public.trips_refuse_delete_with_thread()', 'EXECUTE')::text;`), "false");
    assert.equal(scalar(`SELECT has_function_privilege('anon', 'public.trips_refuse_delete_with_thread()', 'EXECUTE')::text;`), "false");
  });

  it("service path: a trip with its thread is refused PT409, not the raw 23514 — and nothing moved", () => {
    const tripId = trip(owner, [bob]);
    const { threadId, messageId } = thread(tripId, [[owner, false], [bob, false]], bob);
    const r = attempt(`DELETE FROM public.trips WHERE id = '${tripId}';`);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /PT409: trip_delete_refused: trip [0-9a-f-]{36} still has its crew conversation/);
    assert.doesNotMatch(r.err, /23514|chk_thread_context/);
    assert.match(r.err, /OD-1012-DEL-1/);
    intact(tripId, threadId, messageId);
  });

  it("PostgREST path: the owner, hidden from the thread they left, still gets PT409 — and nothing moved", () => {
    const tripId = trip(owner, [bob]);
    const { threadId, messageId } = thread(tripId, [[owner, true], [bob, false]], bob);
    const r = attempt(`DELETE FROM public.trips WHERE id = '${tripId}';`, owner);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /PT409: trip_delete_refused/);
    intact(tripId, threadId, messageId);
  });

  it("one statement over two trips, one with a thread, removes neither", () => {
    const plain = trip(cleo, []);
    const crewed = trip(cleo, [bob]);
    const { threadId, messageId } = thread(crewed, [[cleo, false], [bob, false]], bob);
    const r = attempt(`DELETE FROM public.trips WHERE id IN ('${plain}', '${crewed}');`);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /PT409/);
    assert.equal(count(`SELECT count(*) FROM public.trips WHERE id = '${plain}'`), 1, "the thread-less trip survived the refused statement");
    intact(crewed, threadId, messageId);
  });

  it("a trip with no thread hard-deletes exactly as before", () => {
    const tripId = trip(owner, [bob]);
    const r = attempt(`DELETE FROM public.trips WHERE id = '${tripId}';`);
    assert.equal(r.status, 0, r.err);
    assert.equal(count(`SELECT count(*) FROM public.trips WHERE id = '${tripId}'`), 0);
    assert.equal(count(`SELECT count(*) FROM public.trip_members WHERE trip_id = '${tripId}'`), 0);
  });

  it("account deletion on the chain is not blocked: the trip, its thread and the other member's message survive, owner nulled (2139)", () => {
    const leaver = seedUser("td_leaver");
    const tripId = trip(leaver, [bob]);
    const { threadId, messageId } = thread(tripId, [[leaver, false], [bob, false]], bob);
    // What auth.admin.deleteUser does on a schema carrying profiles_id_fkey.
    exec(`DELETE FROM auth.users WHERE id = '${leaver}';`);
    assert.equal(count(`SELECT count(*) FROM public.profiles WHERE id = '${leaver}'`), 0, "the profile cascaded away");
    assert.equal(scalar(`SELECT coalesce(owner_id::text, 'null') FROM public.trips WHERE id = '${tripId}';`), "null");
    assert.equal(count(`SELECT count(*) FROM public.message_threads WHERE id = '${threadId}' AND trip_id = '${tripId}'`), 1);
    assert.equal(count(`SELECT count(*) FROM public.messages WHERE id = '${messageId}'`), 1);
    // The orphaned trip is removed by hand once its thread is gone (harness hygiene).
    svc(`DELETE FROM public.message_threads WHERE id = '${threadId}';\nDELETE FROM public.trips WHERE id = '${tripId}';`);
  });
});
