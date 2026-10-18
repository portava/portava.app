/**
 * eventWaitlistSeatLock — migration 3906 on the replayed chain, executed against real PostgreSQL (CI's
 * postgis/postgis:16-3.4 service, scripts/local-db/up.sh): the events waitlist's offer and accept are decided under the
 * event row's lock. The PGlite proofs (src/test/eventWaitlistSeatLockMigration.test.ts, and the real router in
 * src/test/eventsWaitlistSeatLockRace.test.ts) run one session; the lock WAIT needs two, and that is this suite.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/eventWaitlistSeatLock.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * PROPERTIES
 *   L1  3906 is in force on the real chain: both functions, SECURITY INVOKER, search_path pg_catalog, EXECUTE for
 *       service_role only.
 *   L2  anti-vacuity — today's statements, each its own transaction (as PostgREST sends them), in the race's order:
 *       both passes read "no live offer", the first claims its head, the second reads the head after that claim and
 *       claims it: two offers for one seat.
 *   L3  the claim race on 3906: session A claims and holds its transaction open; session B's claim for the same event
 *       is SEEN WAITING on a lock (pg_stat_activity), and after A commits answers no_seat. One offer.
 *   L4  the accept race on 3906: the same, for two holders of live offers and the last seat. One seated.
 *   L5  a client role cannot call either; a transaction snapshot is refused.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { HAVE_DB, LOCAL_DB_URL, exec, psql, scalar, seedUser, asUser } from "./localDb.js";

const users: Record<string, string> = {};
const events: string[] = [];

/** One psql session run asynchronously, as `service_role`, in one transaction. */
function session(sqlText: string): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn("psql", ["-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => { out += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { err += c; });
    child.on("close", (status) => resolve({ status, stdout: out, stderr: err, ms: Date.now() - t0 }));
    child.stdin.end(`SET LOCAL ROLE service_role;\n${sqlText}\n`);
  });
}

/** Poll until `query` (run as the harness role) answers "t", or fail. */
async function until(query: string, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (scalar(query) === "t") return;
    if (Date.now() - t0 > ms) throw new Error(`not observed within ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleeping = (tag: string) => `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE query LIKE '%${tag}%' AND query LIKE '%pg_sleep%' AND state = 'active' AND wait_event = 'PgSleep' AND pid <> pg_backend_pid());`;
const waitingOnLock = (tag: string) => `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE query LIKE '%${tag}%' AND wait_event_type = 'Lock' AND pid <> pg_backend_pid());`;

/** An event of `max` seats, `going` going, a queue of [user, position, live offer?]. */
function scene(max: number, going: string[], queue: Array<[string, number, boolean]>): string {
  const host = users["host"]!;
  const id = scalar(`INSERT INTO public.events (host_id, title, state, max_attendees) VALUES ('${host}', '3906 seat lock', 'waitlist', ${max}) RETURNING id;`)!;
  events.push(id);
  const rows = [
    ...going.map((u) => `INSERT INTO public.event_rsvps (event_id, user_id, status) VALUES ('${id}', '${u}', 'going');`),
    ...queue.map(([u, p, live]) => `INSERT INTO public.event_waitlist (event_id, user_id, position, offer_expires_at) VALUES ('${id}', '${u}', ${p}, ${live ? "now() + interval '1 day'" : "NULL"});`),
  ];
  if (rows.length) exec(rows.join("\n"), { single: true });
  return id;
}
const liveOffers = (ev: string) => exec(`SELECT user_id FROM public.event_waitlist WHERE event_id = '${ev}' AND offer_expires_at > now() ORDER BY position;`);
const going = (ev: string) => exec(`SELECT user_id FROM public.event_rsvps WHERE event_id = '${ev}' AND status = 'going' ORDER BY user_id;`);

describe("events waitlist — 3906: the offer and the accept are decided under the event row's lock", { skip: !HAVE_DB }, () => {
  before(() => {
    for (const k of ["host", "a1", "w1", "w2", "w3"]) users[k] = seedUser(`wl3906${k}`);
  });

  after(() => {
    if (!users["host"]) return;
    for (const ev of events) exec(`DELETE FROM public.events WHERE id = '${ev}';`);
    for (const id of Object.values(users)) exec(`DELETE FROM public.profiles WHERE id = '${id}';\nDELETE FROM auth.users WHERE id = '${id}';`);
  });

  it("L1 — 3906 is in force: both functions, SECURITY INVOKER, search_path pg_catalog, EXECUTE for service_role only", () => {
    for (const f of ["public.claim_waitlist_seat(uuid,uuid,timestamptz)", "public.accept_waitlist_seat(uuid,uuid)"]) {
      assert.equal(scalar(`SELECT (NOT prosecdef AND 'search_path=pg_catalog' = ANY (proconfig))::text FROM pg_proc WHERE oid = to_regprocedure('${f}');`), "true", f);
      assert.equal(scalar(`SELECT (has_function_privilege('service_role', '${f}', 'EXECUTE') AND NOT has_function_privilege('anon', '${f}', 'EXECUTE') AND NOT has_function_privilege('authenticated', '${f}', 'EXECUTE'))::text;`), "true", f);
    }
  });

  it("L2 — anti-vacuity: today's statements, each its own transaction as PostgREST sends them, in the race's order, make two offers for one seat", () => {
    const { a1, w1, w2, w3 } = users as Record<string, string>;
    const ev = scene(2, [a1!], [[w1!, 1, false], [w2!, 2, false], [w3!, 3, false]]);
    const check = () => scalar(`SET ROLE service_role; SELECT count(*) FROM public.event_waitlist WHERE event_id = '${ev}' AND offer_expires_at > now();`);
    const head = () => scalar(`SET ROLE service_role; SELECT user_id FROM public.event_waitlist WHERE event_id = '${ev}' AND offer_expires_at IS NULL ORDER BY position LIMIT 1;`);
    const claim = (u: string) => scalar(`SET ROLE service_role; WITH c AS (UPDATE public.event_waitlist SET offer_expires_at = now() + interval '1 day' WHERE event_id = '${ev}' AND user_id = '${u}' AND offer_expires_at IS NULL RETURNING 1) SELECT count(*) FROM c;`);
    assert.deepEqual([check(), check()], ["0", "0"], "pass A and pass B both read 'no live offer'");
    const aHead = head()!;
    assert.equal(claim(aHead), "1");
    const bHead = head()!;
    assert.deepEqual([aHead, bHead], [w1, w2]);
    assert.equal(claim(bHead), "1", "today's claim re-asserts only IS NULL");
    assert.deepEqual(liveOffers(ev), [w1, w2], "two offers for one seat");
  });

  it("L3 — the claim race on 3906: B's claim WAITS on A's lock, then counts A's offer and answers no_seat", async () => {
    const { a1, w1, w2, w3 } = users as Record<string, string>;
    const ev = scene(2, [a1!], [[w1!, 1, false], [w2!, 2, false], [w3!, 3, false]]);
    const a = session(`SELECT public.claim_waitlist_seat('${ev}', '${w1}', now() + interval '1 day');\nSELECT /* wl3906-L3a */ pg_sleep(1.5);`);
    await until(sleeping("wl3906-L3a"), "session A claimed and is holding its transaction");
    assert.deepEqual(liveOffers(ev), [], "A's claim is not committed yet");
    const b = session(`SELECT /* wl3906-L3b */ public.claim_waitlist_seat('${ev}', '${w2}', now() + interval '1 day');`);
    await until(waitingOnLock("wl3906-L3b"), "session B is waiting on the event row lock");
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr); assert.equal(rb.status, 0, rb.stderr);
    assert.equal(ra.stdout.trim().split("\n")[0], "claimed");
    assert.equal(rb.stdout.trim(), "no_seat", "after A committed, B counted A's offer");
    assert.deepEqual(liveOffers(ev), [w1], "one offer for one seat");
  });

  it("L4 — the accept race on 3906: B's accept WAITS on A's lock, then counts A's seat and answers no_seat", async () => {
    const { a1, w1, w2 } = users as Record<string, string>;
    const ev = scene(2, [a1!], [[w1!, 1, true], [w2!, 2, true]]);
    const a = session(`SELECT public.accept_waitlist_seat('${ev}', '${w1}');\nSELECT /* wl3906-L4a */ pg_sleep(1.5);`);
    await until(sleeping("wl3906-L4a"), "session A seated W1 and is holding its transaction");
    const b = session(`SELECT /* wl3906-L4b */ public.accept_waitlist_seat('${ev}', '${w2}');`);
    await until(waitingOnLock("wl3906-L4b"), "session B is waiting on the event row lock");
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 0, ra.stderr); assert.equal(rb.status, 0, rb.stderr);
    assert.equal(ra.stdout.trim().split("\n")[0], "seated");
    assert.equal(rb.stdout.trim(), "no_seat");
    assert.deepEqual(going(ev), [a1, w1].sort(), "two going in two seats");
    assert.deepEqual(exec(`SELECT user_id FROM public.event_waitlist WHERE event_id = '${ev}';`), [w2], "the loser is untouched (the route withdraws their offer)");
  });

  it("L5 — a client role cannot call either; a transaction snapshot is refused", () => {
    const { a1, w1, w2 } = users as Record<string, string>;
    const ev = scene(2, [a1!], [[w1!, 1, true], [w2!, 2, false]]);
    assert.throws(() => asUser(w1!, `SELECT public.accept_waitlist_seat('${ev}', '${w1}');`), /permission denied for function accept_waitlist_seat/);
    assert.throws(() => asUser(w2!, `SELECT public.claim_waitlist_seat('${ev}', '${w2}', now() + interval '1 day');`), /permission denied for function claim_waitlist_seat/);
    const rr = psql(`BEGIN ISOLATION LEVEL REPEATABLE READ;\nSET LOCAL ROLE service_role;\nSELECT public.claim_waitlist_seat('${ev}', '${w2}', now() + interval '1 day');\nCOMMIT;`);
    assert.notEqual(rr.status, 0);
    assert.match(rr.stderr, /requires READ COMMITTED/);
    assert.deepEqual(liveOffers(ev), [w1], "nothing written");
    assert.deepEqual(going(ev), [a1]);
  });
});
