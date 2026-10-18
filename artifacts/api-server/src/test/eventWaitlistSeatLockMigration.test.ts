/**
 * Migration 3906 — public.claim_waitlist_seat and public.accept_waitlist_seat: a waitlist offer is claimed, and an
 * offer is accepted, only under the event row's lock, after counting the seats (census-trust, the waitlist
 * corrections' "Still open": "Two passes in the same instant can each offer one person for one seat").
 *
 * WHAT WOULD TURN THIS RED
 *   - a claim that does not count live offers, or counts outside the lock, or claims a row that already holds an offer;
 *   - an accept that seats past max_attendees, seats on an event that is not live, or seats on a lapsed, withdrawn or
 *     missing offer, or writes the RSVP without deleting the queue row (or the reverse);
 *   - either function running under a transaction snapshot, running as its owner, reachable by a client role or
 *     PUBLIC, or unpinned from pg_catalog;
 *   - a file that is not re-runnable, replaces a function it did not make, whose postcondition is not load-bearing
 *     or does not run alone, or whose header rollback does not undo it;
 *   - the route calling either with argument names the functions do not declare.
 *
 * EXECUTED on PGlite (PostgreSQL 16.4 in-process; the repo's convention) over the baseline definitions of the three
 * tables (helpers/eventWaitlistPgliteSchema.ts). PGlite is one session: the two-passes cases run the passes'
 * statements in the race's worst ORDER (both pre-checks before either claim) — what they prove is that the count
 * taken after the lock sees the first writer. The lock WAIT itself needs two sessions: src/test/db/
 * eventWaitlistSeatLock.db.test.ts (CI local-db, real PostgreSQL).
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/eventWaitlistSeatLockMigration.test.ts
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { maskForKeywordScan, postconditionBlocks } from "../scripts/lib/migrationSqlBlocks.js";
import { EVENT_WAITLIST_CORE_SCHEMA } from "./helpers/eventWaitlistPgliteSchema.js";

const FILE = "3906_event_waitlist_seat_under_event_lock.sql";
const sql = readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), "utf8");
const route = readFileSync(new URL("../routes/events.ts", import.meta.url), "utf8");
const CLAIM = "public.claim_waitlist_seat(uuid,uuid,timestamptz)";
const ACCEPT = "public.accept_waitlist_seat(uuid,uuid)";

const HOST = "a3333333-3333-4333-8333-333333333301";
const A1 = "a3333333-3333-4333-8333-333333333302";
const A2 = "a3333333-3333-4333-8333-333333333303";
const W1 = "a3333333-3333-4333-8333-333333333304";
const W2 = "a3333333-3333-4333-8333-333333333305";
const W3 = "a3333333-3333-4333-8333-333333333306";
const EV = "a4444444-4444-4444-8444-444444444401";
const NIL = "00000000-0000-0000-0000-000000000000";

describe("3906 — static shape", () => {
  it("is one transaction: $pre$ first, then the functions; ONE assertion-only postcondition after the COMMIT; no table is written or altered", () => {
    assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1);
    assert.ok(sql.indexOf("DO $pre$") < sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_waitlist_seat"));
    const post = postconditionBlocks(sql);
    assert.equal(post.length, 1);
    assert.ok(sql.indexOf(post[0]!.text) > sql.lastIndexOf("\nCOMMIT;\n"));
    const masked = maskForKeywordScan(sql);
    assert.doesNotMatch(masked, /\b(TRUNCATE|DROP|ALTER\s+TABLE|CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+POLICY|CONCURRENTLY)\b/i);
    const bodies = [...sql.matchAll(/\$fn\$[\s\S]*?\$fn\$/g)];
    assert.equal(bodies.length, 2);
    assert.doesNotMatch(maskForKeywordScan(sql.replace(/\$fn\$[\s\S]*?\$fn\$/g, "'(body)'")), /\b(INSERT|UPDATE|DELETE)\b/, "the only writes are inside the two function bodies");
  });

  it("the house's serialised-decision form (3415 trail_propose, 3977 trail_review_decide): VOLATILE plpgsql, SECURITY INVOKER, search_path pg_catalog, EXECUTE for service_role only", () => {
    for (const [name, sig] of [["claim_waitlist_seat", "uuid, uuid, timestamptz"], ["accept_waitlist_seat", "uuid, uuid"]] as const) {
      const head = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), sql.indexOf("AS $fn$", sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)));
      assert.match(head, /RETURNS text\nLANGUAGE plpgsql\nVOLATILE\nSECURITY INVOKER\nSET search_path = pg_catalog\n$/, name);
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${name}(${sig}) FROM PUBLIC, anon, authenticated;`), name);
      assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${name}(${sig}) TO service_role;`), name);
    }
    assert.doesNotMatch(maskForKeywordScan(sql), /SECURITY\s+DEFINER/i);
  });

  it("the route calls them with exactly the declared argument names (PostgREST binds by name)", () => {
    const calls = [...route.matchAll(/sc\.rpc\("(claim_waitlist_seat|accept_waitlist_seat)", \{([^}]*)\}\)/g)].map((m) => [m[1], [...m[2]!.matchAll(/(p_[a-z_]+):/g)].map((x) => x[1]).join(",")]);
    assert.deepEqual(calls.sort(), [
      ["accept_waitlist_seat", "p_event_id,p_user_id"], ["accept_waitlist_seat", "p_event_id,p_user_id"],
      ["claim_waitlist_seat", "p_event_id,p_user_id,p_offer_expires_at"], ["claim_waitlist_seat", "p_event_id,p_user_id,p_offer_expires_at"],
    ], "one probe and one locked call each");
    assert.match(sql, /public\.claim_waitlist_seat\(p_event_id uuid, p_user_id uuid, p_offer_expires_at timestamptz\)/);
    assert.match(sql, /public\.accept_waitlist_seat\(p_event_id uuid, p_user_id uuid\)/);
  });
});

test("3906 executes on PostgreSQL (PGlite)", async (t) => { // PGlite is a devDependency: this always executes (never a counted skip)
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE ?? "@electric-sql/pglite");
  const fresh = async (opts: { apply?: boolean } = {}) => {
    const db = new PGlite();
    await db.exec(EVENT_WAITLIST_CORE_SCHEMA);
    await db.exec(`INSERT INTO public.profiles (id) VALUES ('${HOST}'), ('${A1}'), ('${A2}'), ('${W1}'), ('${W2}'), ('${W3}');`);
    if (opts.apply !== false) await db.exec(sql);
    return db;
  };
  const one = async (db: any, q: string) => (await db.query(q)).rows[0];
  const val = async (db: any, q: string) => Object.values((await db.query(q)).rows[0] ?? {})[0];
  /** An event of `max` seats (null: unlimited), `going` going, and a queue of [user, position, offer?]. */
  const scene = async (db: any, o: { max: number | null; state?: string; going: string[]; queue: Array<[string, number, "live" | "lapsed" | null]> }) => {
    await db.exec(`DELETE FROM public.events; INSERT INTO public.events (id, host_id, title, state, max_attendees) VALUES ('${EV}', '${HOST}', 'Quiz', '${o.state ?? "waitlist"}', ${o.max ?? "NULL"});`);
    for (const u of o.going) await db.exec(`INSERT INTO public.event_rsvps (event_id, user_id, status) VALUES ('${EV}', '${u}', 'going');`);
    for (const [u, p, offer] of o.queue) await db.exec(`INSERT INTO public.event_waitlist (event_id, user_id, position, offer_expires_at) VALUES ('${EV}', '${u}', ${p}, ${offer === "live" ? "now() + interval '1 day'" : offer === "lapsed" ? "now() - interval '1 minute'" : "NULL"});`);
  };
  const claim = (db: any, u: string) => val(db, `SELECT public.claim_waitlist_seat('${EV}', '${u}', now() + interval '1 day')`);
  const accept = (db: any, u: string) => val(db, `SELECT public.accept_waitlist_seat('${EV}', '${u}')`);
  const live = async (db: any) => (await db.query(`SELECT user_id FROM public.event_waitlist WHERE event_id = '${EV}' AND offer_expires_at > now() ORDER BY position`)).rows.map((r: any) => r.user_id);
  const going = async (db: any) => (await db.query(`SELECT user_id FROM public.event_rsvps WHERE event_id = '${EV}' AND status = 'going' ORDER BY user_id`)).rows.map((r: any) => r.user_id);
  const queued = async (db: any) => (await db.query(`SELECT user_id FROM public.event_waitlist WHERE event_id = '${EV}' ORDER BY position`)).rows.map((r: any) => r.user_id);
  /** The route's pre-claim reads, as PostgREST sends them: "is an offer live?" and "who is next?". */
  const passReads = async (db: any) => ({
    live: (await db.query(`SELECT user_id FROM public.event_waitlist WHERE event_id = '${EV}' AND offer_expires_at > now() LIMIT 1`)).rows.length > 0,
    head: (await db.query(`SELECT user_id FROM public.event_waitlist WHERE event_id = '${EV}' AND offer_expires_at IS NULL ORDER BY position LIMIT 1`)).rows[0]?.user_id ?? null,
  });
  /** Today's claim (routes/events.ts promoteNextWaitlisted): an UPDATE that re-asserts IS NULL and nothing else. */
  const todaysClaim = async (db: any, u: string) => (await db.query(`UPDATE public.event_waitlist SET offer_expires_at = now() + interval '1 day' WHERE event_id = '${EV}' AND user_id = '${u}' AND offer_expires_at IS NULL RETURNING user_id`)).rows.length;

  const db = await fresh();

  await t.test("claim: a free seat is claimed for the named person; the expiry is the one given", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, null], [W2, 2, null]] });
    assert.equal(await val(db, `SELECT public.claim_waitlist_seat('${EV}', '${W1}', '2099-01-01T00:00:00Z')`), "claimed");
    assert.equal(String(await val(db, `SELECT offer_expires_at::text FROM public.event_waitlist WHERE user_id = '${W1}'`)), "2099-01-01 00:00:00+00");
    assert.deepEqual(await live(db), [W1]);
  });

  await t.test("claim: going + LIVE offers >= max_attendees is no_seat, and nothing is written; a LAPSED offer holds no seat", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, "live"], [W2, 2, null]] });
    assert.equal(await claim(db, W2), "no_seat");
    assert.deepEqual(await live(db), [W1]);
    await scene(db, { max: 2, going: [A1, A2], queue: [[W1, 1, null]] });
    assert.equal(await claim(db, W1), "no_seat", "every seat is going");
    assert.deepEqual(await live(db), []);
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, "lapsed"], [W2, 2, null]] });
    assert.equal(await claim(db, W2), "claimed", "a lapsed offer reserves nothing (hasActiveWaitlistOffer's predicate: > now())");
  });

  await t.test("claim: a row that already holds an offer, or is not queued, is contended; no event is no_event; nothing written", async () => {
    await scene(db, { max: 5, going: [A1], queue: [[W1, 1, "live"]] });
    const before = await val(db, `SELECT offer_expires_at::text FROM public.event_waitlist WHERE user_id = '${W1}'`);
    assert.equal(await claim(db, W1), "contended");
    assert.equal(await val(db, `SELECT offer_expires_at::text FROM public.event_waitlist WHERE user_id = '${W1}'`), before);
    assert.equal(await claim(db, W3), "contended");
    assert.equal(await val(db, `SELECT public.claim_waitlist_seat('${NIL}', '${W1}', now() + interval '1 day')`), "no_event");
  });

  await t.test("claim: no max_attendees — nothing to count, the claim proceeds as today's", async () => {
    await scene(db, { max: null, going: [A1, A2], queue: [[W1, 1, "live"], [W2, 2, null]] });
    assert.equal(await claim(db, W2), "claimed");
  });

  await t.test("claim: a past or missing expiry, or a missing id, is refused (22023), nothing written", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, null]] });
    await assert.rejects(db.query(`SELECT public.claim_waitlist_seat('${EV}', '${W1}', now() - interval '1 second')`), (e: any) => e.code === "22023");
    await assert.rejects(db.query(`SELECT public.claim_waitlist_seat('${EV}', NULL, now() + interval '1 day')`), (e: any) => e.code === "22023");
    await assert.rejects(db.query(`SELECT public.claim_waitlist_seat('${EV}', '${W1}', NULL)`), (e: any) => e.code === "22023");
    assert.deepEqual(await live(db), []);
  });

  await t.test("THE CLAIM RACE: both passes read 'no live offer', the second reads the head after the first's claim — TODAY two offers, 3906 one", async () => {
    // Today's statements, in the race's order.
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, null], [W2, 2, null], [W3, 3, null]] });
    const a = await passReads(db); const bLive = (await passReads(db)).live;
    assert.deepEqual([a.live, bLive, a.head], [false, false, W1]);
    assert.equal(await todaysClaim(db, a.head!), 1);
    const bHead = (await passReads(db)).head;
    assert.equal(bHead, W2);
    assert.equal(await todaysClaim(db, bHead!), 1, "today's claim cannot see the first offer");
    assert.deepEqual(await live(db), [W1, W2], "anti-vacuity: two offers for one seat");
    // 3906, same order.
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, null], [W2, 2, null], [W3, 3, null]] });
    const a2 = await passReads(db); const b2Live = (await passReads(db)).live;
    assert.deepEqual([a2.live, b2Live], [false, false]);
    assert.equal(await claim(db, a2.head!), "claimed");
    const b2Head = (await passReads(db)).head;
    assert.equal(b2Head, W2);
    assert.equal(await claim(db, b2Head!), "no_seat", "the count taken after the lock sees the first offer");
    assert.deepEqual(await live(db), [W1]);
  });

  await t.test("accept: a live offer with a free seat is seated — the going RSVP and the queue row's removal together", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, "live"], [W2, 2, null]] });
    assert.equal(await accept(db, W1), "seated");
    assert.deepEqual(await going(db), [A1, W1].sort());
    assert.deepEqual(await queued(db), [W2]);
  });

  await t.test("accept: an existing non-going RSVP is turned to going (the route's upsert), not duplicated", async () => {
    await scene(db, { max: 3, going: [A1], queue: [[W1, 1, "live"]] });
    await db.exec(`INSERT INTO public.event_rsvps (event_id, user_id, status, updated_at) VALUES ('${EV}', '${W1}', 'maybe', '2001-01-01T00:00:00Z');`);
    assert.equal(await accept(db, W1), "seated");
    assert.deepEqual(await one(db, `SELECT status::text AS s, count(*) OVER () AS n, updated_at > '2001-01-02' AS fresh FROM public.event_rsvps WHERE user_id = '${W1}'`), { s: "going", n: 1, fresh: true });
  });

  await t.test("accept: every refusal writes nothing — no_seat, expired, no_offer, not_queued, not_live (each non-live state), no_event", async () => {
    const cases: Array<[string, Parameters<typeof scene>[1], string, string]> = [
      ["going >= max_attendees", { max: 2, going: [A1, A2], queue: [[W1, 1, "live"]] }, W1, "no_seat"],
      ["a lapsed offer", { max: 2, going: [A1], queue: [[W1, 1, "lapsed"]] }, W1, "expired"],
      ["no offer", { max: 2, going: [A1], queue: [[W1, 1, null]] }, W1, "no_offer"],
      ["not queued", { max: 2, going: [A1], queue: [[W1, 1, "live"]] }, W3, "not_queued"],
      ...(["draft", "started", "completed", "cancelled", "archived"] as const).map((s): [string, Parameters<typeof scene>[1], string, string] => [`state ${s}`, { max: 2, state: s, going: [A1], queue: [[W1, 1, "live"]] }, W1, "not_live"]),
    ];
    for (const [label, s, who, want] of cases) {
      await scene(db, s);
      const g = await going(db); const q = await queued(db); const l = await live(db);
      assert.equal(await accept(db, who), want, label);
      assert.deepEqual([await going(db), await queued(db), await live(db)], [g, q, l], `${label}: nothing written`);
    }
    for (const s of ["open", "full", "waitlist"]) {
      await scene(db, { max: 3, state: s, going: [A1], queue: [[W1, 1, "live"]] });
      assert.equal(await accept(db, W1), "seated", `state ${s} is live`);
    }
    assert.equal(await val(db, `SELECT public.accept_waitlist_seat('${NIL}', '${W1}')`), "no_event");
  });

  await t.test("THE ACCEPT RACE: two holders of live offers both pass the count — TODAY both are seated, 3906 seats one", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, "live"], [W2, 2, "live"]] });
    const count = async () => Number(await val(db, `SELECT count(*) FROM public.event_rsvps WHERE event_id = '${EV}' AND status = 'going'`));
    const c1 = await count(); const c2 = await count();
    assert.ok(c1 < 2 && c2 < 2, "both pass the route's overbooking check");
    for (const u of [W1, W2]) await db.exec(`INSERT INTO public.event_rsvps (event_id, user_id, status) VALUES ('${EV}', '${u}', 'going') ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'going'; DELETE FROM public.event_waitlist WHERE user_id = '${u}';`);
    assert.deepEqual(await going(db), [A1, W1, W2].sort(), "anti-vacuity: three going in two seats");
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, "live"], [W2, 2, "live"]] });
    assert.ok((await count()) < 2 && (await count()) < 2);
    assert.deepEqual([await accept(db, W1), await accept(db, W2)], ["seated", "no_seat"]);
    assert.deepEqual(await going(db), [A1, W1].sort());
    assert.deepEqual(await queued(db), [W2], "the loser is untouched; the route withdraws their offer and keeps their place");
  });

  await t.test("a claim and an accept share the lock and the arithmetic: an accept converts an offer into a seat, so the count is unchanged", async () => {
    await scene(db, { max: 3, going: [A1], queue: [[W1, 1, "live"], [W2, 2, null], [W3, 3, null]] });
    assert.equal(await claim(db, W2), "claimed", "1 going + 1 live < 3");
    assert.equal(await accept(db, W1), "seated");
    assert.equal(await claim(db, W3), "no_seat", "2 going + 1 live = 3");
  });

  await t.test("READ COMMITTED only: under a transaction snapshot both refuse (25000) and write nothing", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, "live"], [W2, 2, null]] });
    for (const iso of ["REPEATABLE READ", "SERIALIZABLE"]) {
      await db.exec(`BEGIN ISOLATION LEVEL ${iso}`);
      await assert.rejects(db.query(`SELECT public.claim_waitlist_seat('${EV}', '${W2}', now() + interval '1 day')`), (e: any) => e.code === "25000" && /requires READ COMMITTED/.test(e.message));
      await db.exec("ROLLBACK");
      await db.exec(`BEGIN ISOLATION LEVEL ${iso}`);
      await assert.rejects(db.query(`SELECT public.accept_waitlist_seat('${EV}', '${W1}')`), (e: any) => e.code === "25000");
      await db.exec("ROLLBACK");
    }
    assert.deepEqual([await live(db), await going(db)], [[W1], [A1]]);
  });

  await t.test("a client role cannot call either (42501); service_role can; neither runs as its owner", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, "live"], [W2, 2, null]] });
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.query(`SELECT public.claim_waitlist_seat('${EV}', '${W2}', now() + interval '1 day')`), (e: any) => e.code === "42501", role);
      await assert.rejects(db.query(`SELECT public.accept_waitlist_seat('${EV}', '${W1}')`), (e: any) => e.code === "42501", role);
      await db.exec("RESET ROLE");
    }
    await db.exec("SET ROLE service_role");
    assert.equal(await claim(db, W2), "no_seat");
    assert.equal(await accept(db, W1), "seated");
    await db.exec("RESET ROLE");
    await db.exec("REVOKE UPDATE ON public.events FROM service_role; SET ROLE service_role;");
    await assert.rejects(db.query(`SELECT public.accept_waitlist_seat('${EV}', '${W1}')`), (e: any) => e.code === "42501", "INVOKER: the row lock needs the caller's own UPDATE privilege on events");
    await db.exec("RESET ROLE; GRANT UPDATE ON public.events TO service_role;");
  });

  await t.test("the probe the route sends (a nil event id) answers no_event and writes nothing", async () => {
    await scene(db, { max: 2, going: [A1], queue: [[W1, 1, null]] });
    const snapshot = async () => JSON.stringify([await going(db), await queued(db), await live(db)]);
    const s0 = await snapshot();
    assert.equal(await val(db, `SELECT public.claim_waitlist_seat('${NIL}', '${NIL}', now() + interval '1 day')`), "no_event");
    assert.equal(await val(db, `SELECT public.accept_waitlist_seat('${NIL}', '${NIL}')`), "no_event");
    assert.equal(await snapshot(), s0);
  });

  await t.test("re-applying is a no-op that keeps the definitions and grants", async () => {
    const defs = async () => JSON.stringify((await db.query(`SELECT pg_get_functiondef(p.oid) AS d, p.proacl::text AS acl FROM pg_proc p WHERE p.proname IN ('claim_waitlist_seat', 'accept_waitlist_seat') ORDER BY p.proname`)).rows);
    const d0 = await defs();
    await db.exec(sql);
    assert.equal(await defs(), d0);
  });

  await t.test("the postcondition re-runs alone in a new session, and is load-bearing", async () => {
    const post = postconditionBlocks(sql)[0]!.text;
    await db.exec("DISCARD ALL");
    await db.exec(post);
    const breaks: Array<[string, string, RegExp]> = [
      [`GRANT EXECUTE ON FUNCTION ${CLAIM} TO authenticated`, `REVOKE ALL ON FUNCTION ${CLAIM} FROM authenticated`, /a client role \(or PUBLIC\) may execute public\.claim_waitlist_seat/],
      [`GRANT EXECUTE ON FUNCTION ${ACCEPT} TO PUBLIC`, `REVOKE ALL ON FUNCTION ${ACCEPT} FROM PUBLIC`, /a client role \(or PUBLIC\) may execute public\.accept_waitlist_seat/],
      [`REVOKE EXECUTE ON FUNCTION ${CLAIM} FROM service_role`, `GRANT EXECUTE ON FUNCTION ${CLAIM} TO service_role`, /service_role cannot execute public\.claim_waitlist_seat/],
      [`ALTER FUNCTION ${ACCEPT} SECURITY DEFINER`, `ALTER FUNCTION ${ACCEPT} SECURITY INVOKER`, /accept_waitlist_seat\(uuid,uuid\) must be a VOLATILE SECURITY INVOKER/],
      [`ALTER FUNCTION ${CLAIM} SET search_path = public`, `ALTER FUNCTION ${CLAIM} SET search_path = pg_catalog`, /claim_waitlist_seat\(uuid,uuid,timestamptz\) must be a VOLATILE SECURITY INVOKER/],
      [`ALTER FUNCTION ${CLAIM} STABLE`, `ALTER FUNCTION ${CLAIM} VOLATILE`, /must be a VOLATILE/],
      [`COMMENT ON FUNCTION ${ACCEPT} IS 'someone else''s'`, `COMMENT ON FUNCTION ${ACCEPT} IS '3906 restored'`, /does not carry its 3906 comment/],
    ];
    for (const [breakIt, restore, msg] of breaks) {
      await db.exec(breakIt);
      await assert.rejects(db.exec(post), msg, breakIt);
      await db.exec(restore);
      await db.exec(post);
    }
    await db.exec(sql); // the comments back to the file's own
  });

  await t.test("the postcondition refuses a body that does not lock, or a claim that does not count live offers", async () => {
    const post = postconditionBlocks(sql)[0]!.text;
    const body = String(await val(db, `SELECT pg_get_functiondef('${CLAIM}'::regprocedure)`));
    await db.exec(body.replace(" FOR NO KEY UPDATE;", ";"));
    await assert.rejects(db.exec(post), /claim_waitlist_seat\(uuid,uuid,timestamptz\) does not lock the event row/);
    await db.exec(body.replace("w.offer_expires_at > now()", "w.offer_expires_at IS NOT NULL"));
    await assert.rejects(db.exec(post), /claim_waitlist_seat does not count live offers/);
    await db.exec(body);
    await db.exec(post);
  });

  await t.test("a function of either name that this file did not make is refused, not replaced", async () => {
    await db.exec(`CREATE FUNCTION public.claim_waitlist_seat(p_event_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'theirs' $$;`);
    await assert.rejects(db.exec(sql), /PRECONDITION FAILED \(3906\): a function public\.claim_waitlist_seat\(uuid\) exists that this migration did not make/);
    await db.exec("ROLLBACK").catch(() => undefined); // the file's BEGIN is left open on this single session; psql would discard it at exit
    await db.exec(`DROP FUNCTION public.claim_waitlist_seat(uuid);`);
    await db.exec(`COMMENT ON FUNCTION ${ACCEPT} IS 'hand-made';`);
    await assert.rejects(db.exec(sql), /PRECONDITION FAILED \(3906\): a function public\.accept_waitlist_seat\(uuid, uuid\) exists that this migration did not make/);
    await db.exec("ROLLBACK").catch(() => undefined);
    assert.equal(await val(db, `SELECT obj_description('${ACCEPT}'::regprocedure, 'pg_proc')`), "hand-made", "nothing was replaced");
    await db.exec(`COMMENT ON FUNCTION ${ACCEPT} IS '3906 restored';`);
    await db.exec(sql);
  });

  await t.test("the header's rollback recipe removes both, and the file re-applies after it", async () => {
    await db.exec(`CREATE TABLE public.schema_migration_ledger (filename text PRIMARY KEY); INSERT INTO public.schema_migration_ledger VALUES ('${FILE}');`);
    const recipe = sql.slice(sql.indexOf("-- ROLLBACK"), sql.indexOf("\nBEGIN;\n")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
    assert.match(recipe, /NOTIFY pgrst, 'reload schema';$/);
    await db.exec(recipe);
    assert.deepEqual([await val(db, `SELECT to_regprocedure('${CLAIM}')`), await val(db, `SELECT to_regprocedure('${ACCEPT}')`)], [null, null]);
    assert.equal(await val(db, "SELECT count(*)::int FROM public.schema_migration_ledger"), 0);
    await assert.rejects(db.query(`SELECT public.claim_waitlist_seat('${EV}', '${W1}', now() + interval '1 day')`), (e: any) => e.code === "42883", "what the route reads as 'missing': today's statements");
    await db.exec(sql);
    assert.equal(await val(db, `SELECT public.claim_waitlist_seat('${NIL}', '${NIL}', now() + interval '1 day')`), "no_event");
  });
  await db.close();

  await t.test("refuses without the tables, without the upsert's key, without service_role's privileges, or with a column of another type — and creates nothing", async () => {
    const bare = new PGlite();
    await assert.rejects(bare.exec(sql), /PRECONDITION FAILED \(3906\): public\.events, public\.event_rsvps and public\.event_waitlist must exist/);
    await bare.close();
    const noKey = await fresh({ apply: false });
    await noKey.exec("ALTER TABLE public.event_rsvps DROP CONSTRAINT event_rsvps_pkey;");
    await assert.rejects(noKey.exec(sql), /PRECONDITION FAILED \(3906\): public\.event_rsvps has no unique key on exactly \(event_id, user_id\)/);
    await noKey.exec("ROLLBACK").catch(() => undefined);
    assert.equal(await val(noKey, `SELECT to_regprocedure('${CLAIM}')`), null);
    await noKey.close();
    const noPrivilege = await fresh({ apply: false });
    await noPrivilege.exec("REVOKE UPDATE ON public.events FROM service_role;");
    await assert.rejects(noPrivilege.exec(sql), /PRECONDITION FAILED \(3906\): service_role must hold SELECT and UPDATE on events/);
    await noPrivilege.exec("ROLLBACK").catch(() => undefined);
    assert.equal(await val(noPrivilege, `SELECT to_regprocedure('${CLAIM}')`), null);
    await noPrivilege.close();
    const wrongType = await fresh({ apply: false });
    await wrongType.exec("ALTER TABLE public.event_waitlist ALTER COLUMN offer_expires_at TYPE timestamp;");
    await assert.rejects(wrongType.exec(sql), /PRECONDITION FAILED \(3906\): public\.event_waitlist must carry event_id uuid, user_id uuid and offer_expires_at timestamptz/);
    await wrongType.close();
  });
});
