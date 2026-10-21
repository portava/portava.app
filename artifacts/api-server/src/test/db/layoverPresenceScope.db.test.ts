/**
 * LAYOVER 165, lane B2-CREW — L202 "Presence is only readable according to visibility scope and safety policy"
 * (spec §19.1), proven on the REAL migrated schema (lane B1-P's harness), for every door a client has:
 *
 *   ROUTES      every presence-bearing route (presence, overview, presence intents, discovery, crew, crew location)
 *   POSTGREST   the client's own supabase-js as the `authenticated` role (RLS and grants apply), and the `anon` role's
 *               privileges on every presence table
 *
 * against four viewers the policy must keep out: ANON (no token), an AUTHENTICATED NON-MEMBER, a BLOCKED traveller,
 * and a traveller whose layover has ENDED (expired). Lead ruling 2026-10-07 (L205) stands: presence reads run on the
 * service client with app-level scoping; what this suite proves is that NO path — route or direct table access —
 * returns presence outside its scope.
 *
 * THE PRESS: 3875 (consents) + `layover_mutual_discovery_enabled`; 3900 (layover_presence) + intents flag; 3996 (crew
 * location grants) + `layover_crew_location_enabled`. With the press withheld every door must stay closed too.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPresenceScope.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = {
  migrations: ["3875", "3900", "3996"],
  flags: { layover_mutual_discovery_enabled: true, layover_presence_intents_enabled: true, layover_crew_location_enabled: true },
} as const;

/** Every table that holds who is where, or who is open to what, on a layover. */
const PRESENCE_TABLES = ["layover_sessions", "layover_presence", "layover_discovery_consents", "layover_crew_location_grants", "layover_crews", "layover_crew_members"] as const;

let db: PressedDb;
let app: PressedApp;

interface T { u: PressedUser; sid: string }
let a: T, b: T, blocked: T, ended: T, x: PressedUser;
let routes: (t: T) => string[];

async function traveller(label: string): Promise<T> {
  const u = await db.seedUser(label);
  const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 9 })).id;
  const s = await app.call("PATCH", `/api/airport/sessions/${sid}/share`, u, { enabled: true });
  if (s.status !== 200) throw new Error(`share: ${s.raw}`);
  return { u, sid };
}
async function consent(p: T, q: T): Promise<void> {
  const r = await app.call("POST", `/api/airport/sessions/${p.sid}/discovery/requests`, p.u, { handle: q.u.handle });
  if (r.status !== 200) throw new Error(`ask: ${r.raw}`);
  const back = await app.call("POST", `/api/airport/sessions/${q.sid}/discovery/requests`, q.u, { handle: p.u.handle });
  if (back.status !== 200) throw new Error(`ask back: ${back.raw}`);
}

describe("B2-CREW L202 presence scope on every door", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    a = await traveller("scope_a");
    b = await traveller("scope_b");
    blocked = await traveller("scope_blocked");
    ended = await traveller("scope_ended");
    x = await db.seedUser("scope_stranger");
    routes = (t) => [
      `/api/airport/sessions/${t.sid}/presence`,
      `/api/airport/sessions/${t.sid}/overview`,
      `/api/airport/sessions/${t.sid}/presence/intents`,
      `/api/airport/sessions/${t.sid}/discovery`,
      `/api/airport/sessions/${t.sid}/crew`,
      `/api/airport/sessions/${t.sid}/crew/location`,
    ];
    if (PRESS_ARM === "pressed") {
      // b is open to food (L1) and has an accepted mutual consent with a (L2); `blocked` had one with a, then a blocked them.
      const i = await app.call("PUT", `/api/airport/sessions/${b.sid}/presence/intents`, b.u, { intents: ["food"] });
      if (i.status !== 200) throw new Error(`intents: ${i.raw}`);
      await consent(a, b);
      await consent(a, blocked);
      await consent(a, ended);
    }
    await db.exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${a.u.id}', '${blocked.u.id}')`);
    const e = await app.call("DELETE", `/api/airport/sessions/${ended.sid}`, ended.u, { outcome: "completed" });
    if (e.status !== 200) throw new Error(`end: ${e.raw}`);
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("S0 control: under consent + policy, a sees b (L2) — so the closed doors below are closed by scope, not by an empty world", async () => {
      const r = await app.call("GET", `/api/airport/sessions/${a.sid}/presence`, a.u);
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual(r.body.travelers.map((t: any) => t.id), [b.u.id]);
    });

    it("S1 BLOCKED: a traveller a blocked is gone from a's presence and a from theirs, though an accepted consent still exists", async () => {
      const mine = await app.call("GET", `/api/airport/sessions/${a.sid}/presence`, a.u);
      assert.ok(!mine.raw.includes(blocked.u.id), "the blocked traveller is in the blocker's presence");
      const theirs = await app.call("GET", `/api/airport/sessions/${blocked.sid}/presence`, blocked.u);
      assert.ok(!theirs.raw.includes(a.u.id), "the blocker is in the blocked traveller's presence");
      assert.equal((await db.query<any>(`SELECT status FROM public.layover_discovery_consents WHERE (requester_user_id = '${a.u.id}' AND target_user_id = '${blocked.u.id}') OR (requester_user_id = '${blocked.u.id}' AND target_user_id = '${a.u.id}')`))[0]?.status, "accepted");
    });

    it("S2 EXPIRED: a traveller whose layover ended is not served to anyone, consent or not, and their own ended session serves nobody", async () => {
      for (const p of routes(a).slice(0, 4)) {
        const r = await app.call("GET", p, a.u);
        assert.ok(!r.raw.includes(ended.u.id), `${p} serves an ended traveller`);
      }
      const own = await app.call("GET", `/api/airport/sessions/${ended.sid}/presence`, ended.u);
      assert.ok(!own.raw.includes(a.u.id) && !own.raw.includes(b.u.id), "an ended session still shows people");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 ANON: every presence route without a token is 401 and carries nobody", async () => {
      for (const p of routes(a)) {
        const r = await app.call("GET", p, null);
        assert.equal(r.status, 401, `${p}: ${r.status}`);
        assert.ok(!r.raw.includes(b.u.id) && !r.raw.includes(a.u.id), `${p} leaked an id to anon`);
      }
    });

    it("A2 ANON at the database: no presence table grants the anon role anything (catalog), and RLS is on for each", async () => {
      for (const t of PRESENCE_TABLES) {
        if (!(await db.hasTable(t))) continue; // the absent arm: nothing to read
        const r = await db.query<any>(`SELECT has_table_privilege('anon', 'public.${t}', 'SELECT') AS s, has_table_privilege('anon', 'public.${t}', 'INSERT') AS i, has_table_privilege('anon', 'public.${t}', 'UPDATE') AS u, (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass) AS rls`);
        assert.equal(r[0].rls, true, `${t}: RLS is off`);
        if (t !== "layover_sessions") assert.deepEqual([r[0].s, r[0].i, r[0].u], [false, false, false], `${t}: anon holds a privilege`);
      }
      // layover_sessions is owner-scoped by policy: anon has no uid, so no row can match (0127 / 3620).
      const pol = await db.query<any>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layover_sessions' AND 'anon' = ANY(roles) AND qual NOT LIKE '%auth.uid()%'`);
      assert.equal(pol[0].n, 0, "a layover_sessions policy lets anon read without an owner check");
    });

    it("A3 AUTHENTICATED NON-MEMBER, direct PostgREST: the stranger's own client reads no other traveller's session row and gets a refusal on every other presence table", async () => {
      const client = db.userClient(x.id);
      const s = await client.from("layover_sessions").select("id, user_id, share_city_status");
      assert.equal(s.error, null, JSON.stringify(s.error));
      assert.deepEqual(s.data, [], "a stranger's PostgREST client read someone's layover session");
      for (const t of PRESENCE_TABLES.filter((n) => n !== "layover_sessions")) {
        const r = await client.from(t).select("*");
        assert.ok(r.error || (Array.isArray(r.data) && r.data.length === 0), `${t}: ${JSON.stringify(r.data)?.slice(0, 200)}`);
        if (await db.hasTable(t)) assert.ok(r.error, `${t}: the authenticated role could read the table at all`);
      }
    });

    it("A4 a SHARER's own client reads only their own session row — never another sharer's presence — and cannot write a presence row", async () => {
      const client = db.userClient(a.u.id);
      const s = await client.from("layover_sessions").select("id, user_id");
      assert.equal(s.error, null, JSON.stringify(s.error));
      assert.deepEqual([...new Set((s.data ?? []).map((r: any) => r.user_id))], [a.u.id]);
      if (await db.hasTable("layover_presence")) {
        const w = await client.from("layover_presence").insert({ session_id: b.sid, intents: ["food"] });
        assert.ok(w.error, "a client wrote a presence row");
      }
    });

    it("A5 AUTHENTICATED NON-MEMBER through the routes: someone else's session is 404 on every presence route", async () => {
      for (const p of routes(a)) {
        const r = await app.call("GET", p, x);
        assert.equal(r.status, 404, `${p}: ${r.status}`);
        assert.ok(!r.raw.includes(a.u.id) && !r.raw.includes(b.u.id), `${p} leaked an id`);
      }
    });

    it("A6 a traveller with NO consent with anyone sees no one by name on any route (the global toggle is gone), whatever the press", async () => {
      const lone = await traveller("scope_lone");
      for (const p of routes(lone)) {
        const r = await app.call("GET", p, lone.u);
        assert.equal(r.status, 200, `${p}: ${r.raw.slice(0, 200)}`);
        for (const other of [a, b, blocked, ended]) assert.ok(!r.raw.includes(other.u.id), `${p} names ${other.u.handle} to a traveller with no consent`);
      }
    });

    it("A7 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
