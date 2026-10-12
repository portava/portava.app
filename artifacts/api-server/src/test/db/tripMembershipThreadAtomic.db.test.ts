/**
 * census-telegraph T319 / migration 3763 — a trip membership that ends takes the
 * person's trip-thread membership with it, IN THE SAME TRANSACTION, executed on
 * the replayed chain with the REAL `trip_kernel_execute` (not a stub).
 *
 * THE DEFECT. Every trip-membership writer changed `trip_members` and left the
 * thread to a fire-and-forget `syncTripChatMembers` after the response. Until it
 * ran — forever, if it failed — a removed member kept `left_at IS NULL` on the
 * crew thread, and `msg_select` (2402: `authz.is_active_thread_member`, which
 * reads only `message_thread_members`) kept serving them the crew's messages
 * over PostgREST and realtime.
 *
 * WHAT IS PROVED HERE, with NO sync run anywhere in this file:
 *   · CONTROL: the trigger is installed, and an accepted member reads the
 *     thread's message through RLS;
 *   · the kernel's REMOVE_PARTICIPANT alone ends the thread row, the stamp is
 *     the kernel event's `recorded_at` (both `now()` — one transaction), and the
 *     removed member's next RLS read of the thread returns nothing;
 *   · the flag-off write (a direct DELETE / role UPDATE as service_role, which
 *     is what routes/trips.ts and routes/requests.ts issue) does the same;
 *   · failure midway: when the thread write raises, the kernel's delete, its
 *     version bump and its event do not survive — nothing is half-applied;
 *   · a write that keeps the person crew changes nothing; no client role can
 *     execute the trigger function.
 *
 * The full matrix (cascades, scope, every mutant) is the PGlite rehearsal named
 * in docs/migrations.md; this file is the part only the real kernel can answer.
 *
 * Run: LOCAL_DB_URL=... node --import tsx/esm --test src/test/db/tripMembershipThreadAtomic.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, exec, kernel, psql, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

/** One script as the service role, in ONE transaction (so SET LOCAL holds). */
function svc(script: string): string[] {
  return exec(`SET LOCAL ROLE service_role;\n${script}`, { single: true });
}

describe("3763 trip_members_end_thread_membership — on the real kernel", { skip: SKIP }, () => {
  let owner = ""; let bob = ""; let cleo = ""; let dan = ""; let eve = "";
  let tripId = ""; let threadId = ""; let messageId = "";

  const ok = (over: Record<string, unknown>) => {
    const r = kernel(command({ actor_user_id: owner, trip_id: tripId, ...over }));
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  };
  /** The row's left_at as text; null while active (psql prints NULL as an empty line, which exec drops). */
  const leftAt = (u: string): string | null =>
    scalar(`SELECT left_at::text FROM public.message_thread_members WHERE thread_id = '${threadId}' AND user_id = '${u}'`);
  const readsMessage = (u: string): boolean =>
    asUser(u, `SELECT count(*)::text FROM public.messages WHERE id = '${messageId}';`).at(-1) === "1";
  const role = (u: string) => scalar(`SELECT coalesce((SELECT role::text FROM public.trip_members WHERE trip_id = '${tripId}' AND user_id = '${u}'), 'none')`);

  before(() => {
    owner = seedUser("mt_owner"); bob = seedUser("mt_bob"); cleo = seedUser("mt_cleo"); dan = seedUser("mt_dan"); eve = seedUser("mt_eve");
    tripId = randomUUID();
    ok({ type: "CREATE_TRIP", payload: { title: "atomic", destination_city: "Porto", destination_country: "Portugal", visibility: "private" } });
    for (const u of [bob, cleo, dan, eve]) ok({ type: "ADD_PARTICIPANT", payload: { user_id: u, role: "member" } });
    const t = svc(`INSERT INTO public.message_threads (thread_type, trip_id, status, title) VALUES ('trip', '${tripId}', 'active', 'atomic') RETURNING id;`);
    threadId = t[t.length - 1]!;
    assert.match(threadId, /^[0-9a-f-]{36}$/);
    svc(`INSERT INTO public.message_thread_members (thread_id, user_id, role, joined_at) VALUES
           ('${threadId}', '${owner}', 'admin', now() - interval '1 hour'), ('${threadId}', '${bob}', 'member', now() - interval '1 hour'),
           ('${threadId}', '${cleo}', 'member', now() - interval '1 hour'), ('${threadId}', '${dan}', 'member', now() - interval '1 hour'),
           ('${threadId}', '${eve}', 'member', now() - interval '1 hour');`);
    const m = svc(`INSERT INTO public.messages (thread_id, sender_id, body) VALUES ('${threadId}', '${owner}', 'crew only') RETURNING id;`);
    messageId = m[m.length - 1]!;
  });

  after(() => {
    // The thread first: deleting a trip that still has its 'trip' thread trips
    // chk_thread_context through the SET NULL FK (pre-existing; not 3763's).
    if (threadId) svc(`DELETE FROM public.message_threads WHERE id = '${threadId}';`);
    for (const id of [owner, bob, cleo, dan, eve]) if (id) deleteUser(id);
  });

  it("CONTROL — the trigger is installed and covers every write that can end a membership", () => {
    const def = scalar(`SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = 'public.trip_members'::regclass AND t.tgname = 'trip_members_end_thread_membership' AND NOT t.tgisinternal`);
    assert.ok(def, "3763 is not applied to this database");
    assert.match(def!, /AFTER DELETE OR UPDATE OF role, status, user_id, trip_id ON public\.trip_members FOR EACH ROW/);
  });

  it("CONTROL — an accepted member reads the crew's message through RLS", () => {
    assert.equal(readsMessage(bob), true, "the RLS read this suite relies on does not work for a member");
  });

  it("kernel REMOVE_PARTICIPANT alone ends the thread row in its own transaction; the next RLS read is empty", () => {
    ok({ type: "REMOVE_PARTICIPANT", payload: { user_id: bob } });
    assert.equal(role(bob), "none");
    const left = leftAt(bob);
    assert.ok(left, "the removed member is still active on the crew thread with no sync run");
    const recorded = scalar(`SELECT recorded_at::text FROM public.trip_events WHERE trip_id = '${tripId}' AND type = 'trip.participant_removed' AND payload_json->'result'->>'user_id' = '${bob}' ORDER BY sequence DESC LIMIT 1`);
    assert.equal(left, recorded, "left_at and the event's recorded_at are both now(): equal only inside ONE transaction");
    assert.equal(readsMessage(bob), false, "the removed member still reads the crew thread");
    assert.equal(readsMessage(cleo), true, "another member lost access");
  });

  it("the flag-off writes (direct DELETE, demotion to invited) end it the same way", () => {
    svc(`DELETE FROM public.trip_members WHERE trip_id = '${tripId}' AND user_id = '${cleo}';`);
    assert.ok(leftAt(cleo), "a direct DELETE left the member on the thread");
    assert.equal(readsMessage(cleo), false);
    svc(`UPDATE public.trip_members SET role = 'invited' WHERE trip_id = '${tripId}' AND user_id = '${dan}';`);
    assert.ok(leftAt(dan), "a demotion to invited left the member on the thread");
    assert.equal(readsMessage(dan), false);
  });

  it("failure midway: the thread write raises and the kernel's delete, version bump and event are all rolled back", () => {
    const version = scalar(`SELECT version::text FROM public.trips WHERE id = '${tripId}'`);
    const events = scalar(`SELECT count(*)::text FROM public.trip_events WHERE trip_id = '${tripId}'`);
    const fn = `zz_boom_${randomUUID().replace(/-/g, "")}`;
    const r = psql(
      `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RAISE EXCEPTION 'boom'; END $b$;\n` +
        `CREATE TRIGGER ${fn} BEFORE UPDATE ON public.message_thread_members FOR EACH ROW WHEN (OLD.user_id = '${eve}') EXECUTE FUNCTION public.${fn}();\n` +
        `SET LOCAL ROLE service_role;\n` +
        `SELECT public.trip_kernel_execute('${JSON.stringify(command({ actor_user_id: owner, trip_id: tripId, type: "REMOVE_PARTICIPANT", payload: { user_id: eve } }))}'::jsonb)::text;`,
      { single: true },
    );
    // Either the kernel lets the exception escape (psql fails, the whole script
    // rolls back) or it catches it and answers ok:false (its subtransaction rolls
    // back). The one outcome that may not happen is ok:true.
    assert.ok(r.status !== 0 || !/"ok"\s*:\s*true/.test(r.stdout), `the removal reported success although the thread write failed: ${r.stdout}`);
    assert.equal(role(eve), "member", "the membership change survived a failed thread write");
    assert.equal(leftAt(eve), null, "the thread row changed");
    assert.equal(scalar(`SELECT version::text FROM public.trips WHERE id = '${tripId}'`), version, "the version bump survived");
    assert.equal(scalar(`SELECT count(*)::text FROM public.trip_events WHERE trip_id = '${tripId}'`), events, "the event survived");
    assert.equal(scalar(`SELECT count(*)::text FROM pg_trigger WHERE tgname = '${fn}'`), "0", "the probe trigger outlived its transaction");
  });

  it("a write that keeps the person crew changes nothing", () => {
    svc(`UPDATE public.trip_members SET permissions = '{"probe": true}'::jsonb WHERE trip_id = '${tripId}' AND user_id = '${eve}';`);
    svc(`UPDATE public.trip_members SET role = 'member' WHERE trip_id = '${tripId}' AND user_id = '${eve}';`);
    assert.equal(leftAt(eve), null);
    assert.equal(readsMessage(eve), true);
  });

  it("no client role can execute the trigger function", () => {
    const [g] = rows<{ anon: boolean; auth: boolean }>(
      `SELECT has_function_privilege('anon', 'public.trip_members_end_thread_membership()', 'EXECUTE') AS anon,\n` +
        `       has_function_privilege('authenticated', 'public.trip_members_end_thread_membership()', 'EXECUTE') AS auth`,
    );
    assert.deepEqual(g, { anon: false, auth: false });
  });
});
