/**
 * LAYOVER 165, lane B2-CREW — L130 "L2 mutual discovery — profiles visible under policy", as a PER-PAIR consent,
 * against the REAL migrated schema (lane B1-P's harness: the full chain replayed, real supabase-js through the
 * PostgREST bridge, the real layover routers on loopback).
 *
 * Owner decision 2026-10-18 (§7): "Both parties must explicitly opt in before the corresponding mutual-discovery
 * behavior is enabled. Include consent revocation and authorization tests."
 *
 * THE PRESS: 3875 (layover_discovery_consents) → `layover_mutual_discovery_enabled` ON. Production flags otherwise
 * (`productionBaseFlags`): the presence ladder is OFF there, so GET /:id/presence answers on its L2 branch — which
 * before this lane listed EVERY city-sharing traveller (the global toggle) and now lists only consented pairs.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverMutualDiscovery.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = { migrations: ["3875"], flags: { layover_mutual_discovery_enabled: true } } as const;

let db: PressedDb;
let app: PressedApp;
let seeded: boolean | "absent" = "absent";

interface T { u: PressedUser; sid: string }
const presence = (t: T) => app.call("GET", `/api/airport/sessions/${t.sid}/presence`, t.u);
const discovery = (t: T) => app.call("GET", `/api/airport/sessions/${t.sid}/discovery`, t.u);
const ask = (t: T, handle: string) => app.call("POST", `/api/airport/sessions/${t.sid}/discovery/requests`, t.u, { handle });
const consents = (a: T, b: T) => db.query<any>(`SELECT * FROM public.layover_discovery_consents WHERE (requester_user_id = '${a.u.id}' AND target_user_id = '${b.u.id}') OR (requester_user_id = '${b.u.id}' AND target_user_id = '${a.u.id}') ORDER BY requested_at`);
const sees = async (viewer: T, other: T) => {
  const r = await presence(viewer);
  assert.equal(r.status, 200, r.raw);
  return (r.body.travelers ?? []).some((x: any) => x.id === other.u.id);
};

/** A traveller with a live SIN layover that shares its city. */
async function traveller(label: string, iata = "SIN", departsInH = 9): Promise<T> {
  const u = await db.seedUser(label);
  const sid = (await startSession(app, u, { iata }, { departsInH })).id;
  const s = await app.call("PATCH", `/api/airport/sessions/${sid}/share`, u, { enabled: true });
  if (s.status !== 200) throw new Error(`share: ${s.raw}`);
  return { u, sid };
}

/** A pair with an ACCEPTED consent, made through the routes. */
async function mutualPair(label: string): Promise<{ a: T; b: T; consentId: string }> {
  const a = await traveller(`${label}a`), b = await traveller(`${label}b`);
  const r = await ask(a, b.u.handle);
  assert.equal(r.status, 200, r.raw);
  const inc = await discovery(b);
  const req = (inc.body.incoming ?? []).find((x: any) => x.from.id === a.u.id);
  assert.ok(req, `the target does not see the request: ${inc.raw}`);
  const acc = await app.call("POST", `/api/airport/sessions/${b.sid}/discovery/${req.consentId}/accept`, b.u);
  assert.equal(acc.status, 200, acc.raw);
  return { a, b, consentId: req.consentId };
}

describe("B2-CREW L130 mutual discovery (3875)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    seeded = await db.flag("layover_mutual_discovery_enabled");
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("D0 the press: 3875 seeds layover_mutual_discovery_enabled FALSE", () => { assert.equal(seeded, false); });

    it("D1 a request is ONE side's opt-in: the target sees who asked; neither is shown to the other yet; the requester gets no outgoing list", async () => {
      const a = await traveller("d1a"), b = await traveller("d1b");
      const r = await ask(a, `@${b.u.handle}`);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.sent, true);
      const rows = await consents(a, b);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "requested");
      assert.equal(rows[0].requester_session_id, a.sid);
      assert.equal(rows[0].target_session_id, b.sid);
      const inc = await discovery(b);
      assert.deepEqual((inc.body.incoming ?? []).map((x: any) => x.from.handle), [a.u.handle]);
      assert.deepEqual((await discovery(a)).body.incoming, []);
      assert.ok(!("outgoing" in (await discovery(a)).body), "an outgoing list is the presence oracle");
      assert.equal(await sees(a, b), false, "the requester sees the target before the target agreed");
      assert.equal(await sees(b, a), false, "the target sees the requester before agreeing");
    });

    it("D2 the target's acceptance is the second opt-in: NOW each sees the other (L2), in /presence and in /discovery", async () => {
      const { a, b } = await mutualPair("d2");
      assert.equal(await sees(a, b), true);
      assert.equal(await sees(b, a), true);
      const p = await presence(a);
      assert.equal(p.body.level, "L2_DISCOVERY");
      assert.equal(p.body.count, null, "a count beside a roster (D-PRESENCE-K rule 2)");
      assert.deepEqual((await discovery(a)).body.mutual.map((x: any) => x.id), [b.u.id]);
    });

    it("D3 BOTH ORDERS: the second request of a pair IS the acceptance — one row, accepted, and the other order is not a second consent", async () => {
      const a = await traveller("d3a"), b = await traveller("d3b");
      assert.equal((await ask(a, b.u.handle)).status, 200);
      assert.equal(await sees(a, b), false);
      assert.equal((await ask(b, a.u.handle)).status, 200);
      const rows = await consents(a, b);
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0].status, "accepted");
      assert.equal(await sees(a, b), true);
      assert.equal(await sees(b, a), true);
      // the unique live-pair index refuses a second live row in either order
      await assert.rejects(db.exec(`INSERT INTO public.layover_discovery_consents (requester_session_id, target_session_id, requester_user_id, target_user_id, expires_at) VALUES ('${b.sid}', '${a.sid}', '${b.u.id}', '${a.u.id}', now() + interval '1 hour')`), /duplicate key|23505|unique/i);
    });

    it("D4 REVOCATION by EITHER side takes effect on the next read, for both", async () => {
      for (const side of ["a", "b"] as const) {
        const { a, b, consentId } = await mutualPair(`d4${side}`);
        const actor = side === "a" ? a : b;
        const r = await app.call("DELETE", `/api/airport/sessions/${actor.sid}/discovery/${consentId}`, actor.u);
        assert.equal(r.status, 200, r.raw);
        assert.equal(r.body.status, "revoked");
        assert.equal(await sees(a, b), false, `${side} revoked, the requester still sees`);
        assert.equal(await sees(b, a), false, `${side} revoked, the target still sees`);
        const row = (await consents(a, b))[0];
        assert.equal(row.ended_by_user_id, actor.u.id);
      }
    });

    it("D5 DECLINE and WITHDRAW end a request without anyone being shown", async () => {
      const a = await traveller("d5a"), b = await traveller("d5b");
      await ask(a, b.u.handle);
      const req = (await discovery(b)).body.incoming[0];
      const d = await app.call("POST", `/api/airport/sessions/${b.sid}/discovery/${req.consentId}/decline`, b.u);
      assert.equal(d.status, 200, d.raw);
      assert.equal((await consents(a, b))[0].status, "declined");
      // a declined request cannot then be accepted
      assert.equal((await app.call("POST", `/api/airport/sessions/${b.sid}/discovery/${req.consentId}/accept`, b.u)).status, 404);
      const c = await traveller("d5c");
      await ask(a, c.u.handle);
      const w = await app.call("POST", `/api/airport/sessions/${a.sid}/discovery/withdraw`, a.u, { handle: c.u.handle });
      assert.equal(w.status, 200, w.raw);
      assert.equal((await consents(a, c))[0].status, "withdrawn");
      assert.deepEqual((await discovery(c)).body.incoming, []);
    });

    it("D6 BLOCKS ALWAYS WIN: a block after acceptance hides both ways; a block before the request stores nothing and the requester is told the same words", async () => {
      const { a, b } = await mutualPair("d6");
      await db.exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${b.u.id}', '${a.u.id}')`);
      assert.equal(await sees(a, b), false, "the blocked side still sees the blocker");
      assert.equal(await sees(b, a), false, "the blocker still sees the blocked");
      const c = await traveller("d6c"), d = await traveller("d6d");
      await db.exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${d.u.id}', '${c.u.id}')`);
      const blocked = await ask(c, d.u.handle);
      const nobody = await ask(c, "no_such_handle_anywhere");
      assert.equal(blocked.status, nobody.status);
      assert.deepEqual(blocked.body, nobody.body, "the requester can tell a block from a missing handle");
      assert.equal((await consents(c, d)).length, 0);
      // and the schema refuses it even from the service role
      await assert.rejects(db.exec(`INSERT INTO public.layover_discovery_consents (requester_session_id, target_session_id, requester_user_id, target_user_id, expires_at) VALUES ('${c.sid}', '${d.sid}', '${c.u.id}', '${d.u.id}', now() + interval '1 hour')`), /block/i);
    });

    it("D7 the requester is never told whether the person is here: another city, not sharing, and no such handle all answer alike and store nothing", async () => {
      const a = await traveller("d7a");
      const elsewhere = await traveller("d7b", "NRT");
      const quiet = await traveller("d7c");
      await app.call("PATCH", `/api/airport/sessions/${quiet.sid}/share`, quiet.u, { enabled: false });
      const answers = await Promise.all([ask(a, elsewhere.u.handle), ask(a, quiet.u.handle), ask(a, "nobody_by_this_name")]);
      for (const r of answers) { assert.equal(r.status, 200, r.raw); assert.deepEqual(r.body, answers[0]!.body); }
      assert.equal((await consents(a, elsewhere)).length + (await consents(a, quiet)).length, 0);
    });

    it("D8 CROSS-SESSION FORGERY: a consent on one layover is not a consent on another, nobody else can answer it, and the schema refuses a row naming someone else's session", async () => {
      const { a, b, consentId } = await mutualPair("d8");
      // a's OTHER layover (a different session id) does not inherit the consent
      const a2: T = { u: a.u, sid: (await startSession(app, a.u, { iata: "BKK" }, { departsInH: 30, arrivedHAgo: 0 })).id };
      await app.call("PATCH", `/api/airport/sessions/${a2.sid}/share`, a.u, { enabled: true });
      assert.equal(await sees(a2, b), false, "a consent leaked to another session of the same traveller");
      assert.equal((await app.call("DELETE", `/api/airport/sessions/${a2.sid}/discovery/${consentId}`, a.u)).status, 404, "a consent was ended from another of the same traveller's layovers");
      // a third traveller cannot accept or revoke a's consent with b through their own session
      const x = await traveller("d8x");
      assert.equal((await app.call("DELETE", `/api/airport/sessions/${x.sid}/discovery/${consentId}`, x.u)).status, 404);
      assert.equal((await app.call("DELETE", `/api/airport/sessions/${b.sid}/discovery/${consentId}`, x.u)).status, 404, "a stranger acted through someone else's session");
      assert.equal((await consents(a, b))[0].status, "accepted");
      // the requester cannot accept their OWN request (only the target can)
      const c = await traveller("d8c"), d = await traveller("d8d");
      await ask(c, d.u.handle);
      const own = (await consents(c, d))[0];
      assert.equal((await app.call("POST", `/api/airport/sessions/${c.sid}/discovery/${own.id}/accept`, c.u)).status, 404);
      assert.equal((await consents(c, d))[0].status, "requested");
      // 3875's guard: a row whose session does not belong to the user named for it is refused, service role or not
      await assert.rejects(db.exec(`INSERT INTO public.layover_discovery_consents (requester_session_id, target_session_id, requester_user_id, target_user_id, expires_at) VALUES ('${x.sid}', '${d.sid}', '${c.u.id}', '${d.u.id}', now() + interval '1 hour')`), /belong/i);
      // and an ended_by that is not the transition's party
      await assert.rejects(db.exec(`UPDATE public.layover_discovery_consents SET status = 'declined', responded_at = now(), ended_at = now(), ended_by_user_id = '${c.u.id}' WHERE id = '${own.id}'`), /state_shape|check/i);
    });

    it("D9 a CLIENT cannot forge either party's consent: no read, insert or update for the authenticated role (RLS + no grant)", async () => {
      const { a, b } = await mutualPair("d9");
      const c = await traveller("d9c");
      await assert.rejects(db.asUser(a.u.id, `SELECT * FROM public.layover_discovery_consents`), (e: any) => e?.code === "42501");
      await assert.rejects(db.asUser(c.u.id, `INSERT INTO public.layover_discovery_consents (requester_session_id, target_session_id, requester_user_id, target_user_id, status, responded_at, expires_at) VALUES ('${c.sid}', '${a.sid}', '${c.u.id}', '${a.u.id}', 'accepted', now(), now() + interval '1 hour') RETURNING id`), (e: any) => e?.code === "42501");
      await assert.rejects(db.asUser(b.u.id, `UPDATE public.layover_discovery_consents SET status = 'accepted' RETURNING id`), (e: any) => e?.code === "42501");
      const { error } = await db.userClient(c.u.id).from("layover_discovery_consents").insert({ requester_session_id: c.sid, target_session_id: a.sid, requester_user_id: c.u.id, target_user_id: a.u.id, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      assert.ok(error, "the client's PostgREST insert was accepted");
    });

    it("D10 EXPIRY: the consent ends with the first layover — an ended session hides the pair, and an expired request cannot be accepted", async () => {
      const { a, b } = await mutualPair("d10");
      const e = await app.call("DELETE", `/api/airport/sessions/${b.sid}`, b.u, { outcome: "completed" });
      assert.equal(e.status, 200, e.raw);
      assert.equal(await sees(a, b), false, "a consent outlived the other layover");
      const c = await traveller("d10c"), d = await traveller("d10d");
      await ask(c, d.u.handle);
      const row = (await consents(c, d))[0];
      // expires_at bounded by both departures (the guard), and an expired request is refused at acceptance
      const bound = await db.query<any>(`SELECT (SELECT LEAST(x.departure_time, y.departure_time) FROM public.layover_sessions x, public.layover_sessions y WHERE x.id = '${c.sid}' AND y.id = '${d.sid}') >= '${new Date(row.expires_at).toISOString()}'::timestamptz AS ok`);
      assert.equal(bound[0].ok, true);
      await db.exec(`SET session_replication_role = replica; UPDATE public.layover_discovery_consents SET requested_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = '${row.id}'; SET session_replication_role = origin;`);
      assert.equal((await app.call("POST", `/api/airport/sessions/${d.sid}/discovery/${row.id}/accept`, d.u)).status, 404);
      assert.deepEqual((await discovery(d)).body.incoming, [], "an expired request is still offered");
    });

    it("D11 the viewer's own standing refusal wins: sharing paused → they see nobody and nobody sees them, consent or not", async () => {
      const { a, b } = await mutualPair("d11");
      await db.exec(`INSERT INTO public.location_preferences (user_id, location_mode, sharing_paused) VALUES ('${b.u.id}', 'city_only', true) ON CONFLICT (user_id) DO UPDATE SET sharing_paused = true`);
      assert.equal(await sees(a, b), false, "a paused traveller is still shown");
      assert.equal(await sees(b, a), false, "a paused traveller still sees others");
    });

    it("D12 ladder ON: the aggregate count stays the default and is withheld WHOLE beside a mutual roster (D-PRESENCE-K-3 rule 3)", async () => {
      await db.setFlag("layover_presence_ladder_enabled", true);
      try {
        const { a, b } = await mutualPair("d12");
        const p = await presence(a);
        assert.equal(p.status, 200, p.raw);
        assert.equal(p.body.level, "L2_DISCOVERY");
        assert.deepEqual(p.body.travelers.map((t: any) => t.id), [b.u.id]);
        assert.equal(p.body.count, null);
        const lone = await traveller("d12c");
        const q = await presence(lone);
        assert.equal(q.body.level, "L0_AGGREGATE", "a traveller with no consent is not on L2");
        assert.deepEqual(q.body.travelers, []);
      } finally { await db.setFlag("layover_presence_ladder_enabled", false); }
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 THE GLOBAL TOGGLE IS GONE: two city-sharing travellers with NO consent never see each other's profile — in every arm", async () => {
      const a = await traveller("a1a"), b = await traveller("a1b");
      assert.equal(await sees(a, b), false);
      assert.equal(await sees(b, a), false);
    });

    it("A2 flag OFF (the seed): no profile is served even over an accepted consent, and the discovery routes say unavailable", async () => {
      const on = PRESS_ARM === "pressed";
      let pair: { a: T; b: T } | null = null;
      if (PRESS_ARM !== "absent") { await db.setFlag("layover_mutual_discovery_enabled", true); pair = await mutualPair("a2"); }
      await db.setFlag("layover_mutual_discovery_enabled", false);
      try {
        const t = pair?.a ?? await traveller("a2x");
        assert.equal((await discovery(t)).body.available, false);
        assert.equal((await ask(t, "anyone")).status, 404);
        if (pair) assert.equal(await sees(pair.a, pair.b), false, "flag off fell back to showing people");
      } finally { await db.setFlag("layover_mutual_discovery_enabled", on); }
    });

    it("A3 owner-scoped: no token is 401, someone else's session is 404", async () => {
      const a = await traveller("a3a");
      const x = await db.seedUser("a3x");
      assert.equal((await app.call("GET", `/api/airport/sessions/${a.sid}/discovery`, null)).status, 401);
      assert.equal((await app.call("GET", `/api/airport/sessions/${a.sid}/discovery`, x)).status, 404);
      assert.equal((await app.call("POST", `/api/airport/sessions/${a.sid}/discovery/requests`, x, { handle: "x" })).status, 404);
    });

    it("A4 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
