/**
 * census-layover §85 — the Layover lifecycle audit (2026-10-24), PRESSED: the real routers over the replayed chain,
 * in production's 2026-10-23 flag state (test/db/fixtures/productionFlags20261023.json), with two or three real
 * travellers. Every case ATTEMPTS a cross-user access, or a step a blocked / deleted / banned account must not reach,
 * and asserts it is refused — then shows the legitimate path still works (the control).
 *
 *   I1  B, signed in, names A's session id on every Layover door that takes one: each answers 404 and A's session,
 *       presence, constraints and check-ins are untouched.
 *   I2  B as the CLIENT (role authenticated, B's sub, RLS and grants apply) reads none of A's layover rows and
 *       writes none: sessions, presence, crews, crew members, check-ins, certified computations, location grants.
 *   A1  a crew member whose layover ENDED, or who reads through another session, gets no crewmate's location share
 *       and no crew; the live session it was joined from still does (control).
 *   A2  a session may name only a trip its owner is an accepted member of (POST and PATCH).
 *   A4  Airport Pulse leaves out an author either side of a block (and refuses when blocks are unreadable).
 *   A5  a deactivated, pending-deletion or banned crewmate is no longer published to the crew; restored, they are.
 *   A6  an unreadable re-entry record still serves landside cards and SAYS it could not check (the pinned design; B7).
 *
 * Run (loopback; unsandboxed):
 *   PGTZ=UTC LOCAL_DB_URL=… node --import tsx/esm --test src/test/db/layoverLifecycleAudit.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { keepConstraintsUndeclared, productionBaseFlags, seedConfirmedCorridor, seedCuratedAirport, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/productionFlags20261023.json", import.meta.url), "utf8")) as {
  flags: Record<string, boolean>; metadata: Record<string, Record<string, unknown>>;
};

let db: PressedDb;
let app: PressedApp;

type Member = { u: PressedUser; sid: string };
const S = (sid: string) => `/api/airport/sessions/${sid}`;
const locPath = (m: Member) => `${S(m.sid)}/crew/location`;
const share = (m: Member) => app.call("POST", locPath(m), m.u, { label: "By gate B4", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });

async function traveller(label: string): Promise<Member> {
  const u = await db.seedUser(label);
  return { u, sid: (await startSession(app, u, { iata: "SIN" }, { departsInH: 9 })).id };
}
/** b founds a crew, a joins: two travellers at SIN in one crew. */
async function crewOfTwo(label: string): Promise<{ a: Member; b: Member; crewId: string }> {
  const a = await traveller(`${label}_a`), b = await traveller(`${label}_b`);
  const c = await app.call("POST", `${S(b.sid)}/crew`, b.u, { title: `crew ${label}` });
  assert.equal(c.status, 200, `crew: ${c.raw}`);
  const j = await app.call("POST", `${S(a.sid)}/crew/${c.body.crew.id}/join`, a.u);
  assert.equal(j.status, 200, `join: ${j.raw}`);
  return { a, b, crewId: c.body.crew.id };
}
const count = async (sql: string) => Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`))[0]!.n);

describe("§85 — the Layover lifecycle audit under production's 2026-10-23 flag state", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb();
    keepConstraintsUndeclared();
    await productionBaseFlags(db);
    await db.setFlags({ ...FX.flags });
    for (const [flag, metadata] of Object.entries(FX.metadata)) await db.setFlag(flag, FX.flags[flag] === true, metadata);
    app = await startPressedLayoverApp(db); // mounts the airport and crew-location routers as routes/index.ts does
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("F0 the doors under test are ON in production's state (so a refusal below is the rule, not a dark feature)", async () => {
    for (const f of ["airport_mode_enabled", "airport_pulse_enabled", "layover_crew_location_enabled", "layover_decision_persistence_enabled"]) assert.equal(await db.flag(f), true, f);
  });

  // ── I1: every :id door refuses another traveller's session ───────────────
  it("I1 B names A's session id on every Layover door: 404 each, and A's rows are untouched", async () => {
    const a = await traveller("iso1_a"), b = await traveller("iso1_b");
    await app.call("PUT", `${S(a.sid)}/constraints`, a.u, { baggageMode: "CARRY_ON_ONLY", recheckRequired: false, airportChangeRequired: false });
    const before = JSON.stringify(await db.query(`SELECT status, departure_time, share_city_status, trip_id FROM public.layover_sessions WHERE id = '${a.sid}'`));
    const constraintsBefore = JSON.stringify(await db.query(`SELECT * FROM public.layover_constraints WHERE session_id = '${a.sid}'`));
    const doors: Array<[string, string, unknown?]> = [
      ["GET", ""], ["GET", "/overview"], ["GET", "/safety"], ["GET", "/recommendations"], ["GET", "/presence"], ["GET", "/buddies"],
      ["GET", "/crew"], ["POST", "/crew", { title: "hijack" }], ["GET", "/checkpoints"], ["POST", "/checkpoints", { type: "AIRPORT_REENTRY", operationId: `op-${randomUUID()}` }],
      ["GET", "/constraints"], ["PUT", "/constraints", { baggageMode: "COLLECT_RECHECK", recheckRequired: true, airportChangeRequired: true }],
      ["GET", "/crew/location"], ["POST", "/crew/location", { label: "x", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
      ["POST", "/return-now", {}], ["PATCH", "", { comfortLevel: "adventurous" }], ["PATCH", "/share", { enabled: true }],
      ["POST", "/stops", { title: "x", durationMin: 30 }], ["GET", "/stops"], ["GET", `/decisions/diff?from=snap:${"0".repeat(32)}&to=snap:${"1".repeat(32)}`], ["GET", "/discovery"],
      ["GET", "/presence/intents"], ["DELETE", ""],
    ];
    for (const [method, path, body] of doors) {
      const r = await app.call(method, `${S(a.sid)}${path}`, b.u, body);
      assert.ok(r.status === 404 || r.status === 403, `${method} ${path || "/"} with another traveller's session answered ${r.status}: ${r.raw.slice(0, 200)}`);
    }
    assert.equal(JSON.stringify(await db.query(`SELECT status, departure_time, share_city_status, trip_id FROM public.layover_sessions WHERE id = '${a.sid}'`)), before, "A's session changed");
    assert.equal(JSON.stringify(await db.query(`SELECT * FROM public.layover_constraints WHERE session_id = '${a.sid}'`)), constraintsBefore, "A's constraints changed");
    assert.equal(await count(`public.layover_checkpoints WHERE session_id = '${a.sid}'`), 0, "B checked in on A's layover");
    assert.equal(await count(`public.layover_crews WHERE created_session_id = '${a.sid}'`), 0, "B founded a crew on A's layover");
    // control: A's own door answers
    const own = await app.call("GET", `${S(a.sid)}/overview`, a.u);
    assert.equal(own.status, 200, own.raw);
  });

  // ── I2: the client door (RLS + grants) ────────────────────────────────────
  it("I2 as the client, B reads none of A's layover rows and changes none", async () => {
    const { a, b, crewId } = await crewOfTwo("iso2");
    assert.equal((await share(a)).status, 200);
    await db.exec(`INSERT INTO public.layover_presence (session_id, user_id, intents, available_from, available_until, expires_at) VALUES ('${a.sid}', '${a.u.id}', '{food}', now(), now() + interval '1 hour', now() + interval '1 hour') ON CONFLICT DO NOTHING`);
    const stranger = await traveller("iso2_stranger");
    const reads: Array<[string, string]> = [
      ["layover_sessions", `id = '${a.sid}'`], ["layover_presence", `session_id = '${a.sid}'`], ["layover_crews", `id = '${crewId}'`],
      ["layover_crew_members", `crew_id = '${crewId}'`], ["layover_checkpoints", `session_id = '${a.sid}'`],
      ["layover_certified_computations", `session_id = '${a.sid}'`], ["layover_crew_location_grants", `crew_id = '${crewId}'`],
      ["layover_constraints", `session_id = '${a.sid}'`], ["layover_return_plans", `session_id = '${a.sid}'`],
    ];
    for (const viewer of [b, stranger]) {
      for (const [table, where] of reads) {
        let rows: unknown[] = [];
        try { rows = await db.asUser(viewer.u.id, `SELECT * FROM public.${table} WHERE ${where}`); } catch { rows = []; } // permission denied is a refusal too
        assert.equal(rows.length, 0, `${viewer === b ? "a crewmate" : "a stranger"} read ${table} of another traveller through the client door`);
      }
      await assert.rejects(db.asUser(viewer.u.id, `UPDATE public.layover_sessions SET share_city_status = NOT share_city_status WHERE id = '${a.sid}' RETURNING id`), /permission denied|policy/i, "the client may not write sessions");
      await assert.rejects(db.asUser(viewer.u.id, `INSERT INTO public.layover_checkpoints (session_id, checkpoint_type, observed_at, dedup_key, expires_at) VALUES ('${a.sid}', 'AIRPORT_REENTRY', now(), 'audit-${randomUUID()}', now() + interval '1 hour') RETURNING id`), /permission denied|policy/i, "the client may not check in on a layover");
      await assert.rejects(db.asUser(viewer.u.id, `DELETE FROM public.layover_crew_location_grants WHERE crew_id = '${crewId}' RETURNING crew_id`), /permission denied|policy/i, "the client may not touch location grants");
    }
    // control: the owner reads their own session through the same door
    assert.equal((await db.asUser(a.u.id, `SELECT id FROM public.layover_sessions WHERE id = '${a.sid}'`)).length, 1);
  });

  // ── A1: an ended layover, or another session, sees no crewmate ────────────
  it("A1 a member whose layover ended gets no crewmate's share and no crew; the live session it joined from still does (control)", async () => {
    const { a, b } = await crewOfTwo("ended");
    assert.equal((await share(b)).status, 200);
    const live = await app.call("GET", locPath(a), a.u);
    assert.equal(live.status, 200, live.raw);
    assert.ok((live.body.crewmates ?? []).some((c: any) => c.userId === b.u.id), `control: the live member sees the share: ${live.raw.slice(0, 300)}`);
    const other = await startSession(app, a.u, { iata: "SIN" }, { departsInH: 20 }); // a second layover of A's, not the one the crew was joined from
    const viaOther = await app.call("GET", `${S(other.id)}/crew/location`, a.u);
    assert.equal(viaOther.status, 200, viaOther.raw);
    assert.equal(viaOther.body.inCrew, false, `another session read the crew's shares: ${viaOther.raw.slice(0, 300)}`);
    assert.ok(!viaOther.raw.includes(b.u.id));
    const end = await app.call("DELETE", S(a.sid), a.u);
    assert.ok(end.status === 200 || end.status === 204, end.raw);
    const after = await app.call("GET", locPath(a), a.u);
    assert.equal(after.status, 200, after.raw);
    assert.equal(after.body.inCrew, false, `an ended layover still reads crewmates' shares: ${after.raw.slice(0, 300)}`);
    assert.ok(!after.raw.includes(b.u.id), "the crewmate's identity reached an ended layover");
    const crew = await app.call("GET", `${S(a.sid)}/crew`, a.u);
    assert.equal(crew.status, 200, crew.raw);
    assert.equal(crew.body.inCrew, false); assert.equal(crew.body.reason, "layover_ended");
    assert.ok(!crew.raw.includes(b.u.id), "the crew card reached an ended layover");
    const ctl = await app.call("PUT", `${locPath(a)}/precise-control`, a.u, { enabled: true });
    assert.equal(ctl.status, 409, `an ended layover changed the crew's precise control: ${ctl.raw}`);
    // control: B's live session still reads the crew
    const bCrew = await app.call("GET", `${S(b.sid)}/crew`, b.u);
    assert.equal(bCrew.body.inCrew, true, bCrew.raw.slice(0, 300));
  });

  // ── A2: a session names only its owner's trip ─────────────────────────────
  it("A2 a session may name only a trip its owner is an accepted member of, on create and on edit", async () => {
    const owner = await db.seedUser("trip_owner"), outsider = await db.seedUser("trip_outsider");
    const [trip] = await db.query<{ id: string }>(`INSERT INTO public.trips (owner_id, title, destination_city) VALUES ('${owner.id}', 'Audit trip', 'Singapore') RETURNING id`);
    await db.exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${trip!.id}', '${owner.id}', 'owner', 'accepted') ON CONFLICT DO NOTHING`);
    const now = Date.now();
    const body = { iata: "SIN", arrivalTime: new Date(now - 3_600_000).toISOString(), departureTime: new Date(now + 9 * 3_600_000).toISOString(), flightType: "international", immigrationRequired: true, tripId: trip!.id };
    const foreign = await app.call("POST", "/api/airport/sessions", outsider, body);
    assert.equal(foreign.status, 403, `a session linked to someone else's trip: ${foreign.raw}`);
    assert.equal(await count(`public.layover_sessions WHERE trip_id = '${trip!.id}'`), 0);
    const mine = await app.call("POST", "/api/airport/sessions", owner, body);
    assert.equal(mine.status, 201, `control: the member links their own trip: ${mine.raw}`);
    const oSid = (await startSession(app, outsider, { iata: "SIN" }, { departsInH: 9 })).id;
    const patched = await app.call("PATCH", S(oSid), outsider, { tripId: trip!.id });
    assert.equal(patched.status, 403, `an edit linked someone else's trip: ${patched.raw}`);
    assert.equal((await db.query<{ trip_id: string | null }>(`SELECT trip_id FROM public.layover_sessions WHERE id = '${oSid}'`))[0]!.trip_id, null);
  });

  // ── A4: Airport Pulse and blocks ──────────────────────────────────────────
  it("A4 Airport Pulse leaves out an author either side of a block, and refuses when the block list cannot be read", async () => {
    const viewer = await db.seedUser("pulse_viewer"), blockedAuthor = await db.seedUser("pulse_blocked"), blocker = await db.seedUser("pulse_blocker"), other = await db.seedUser("pulse_other");
    for (const [u, text] of [[blockedAuthor, "blocked-by-viewer"], [blocker, "blocks-the-viewer"], [other, "unblocked-control"]] as const) {
      await db.exec(`INSERT INTO public.posts (author_id, content, location_city) VALUES ('${u.id}', 'pulse ${text}', 'Pulsetown')`);
    }
    await db.exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${viewer.id}', '${blockedAuthor.id}'), ('${blocker.id}', '${viewer.id}')`);
    const r = await app.call("GET", "/api/airport/pulse?city=Pulsetown", viewer);
    assert.equal(r.status, 200, r.raw);
    const authors = (r.body.posts as any[]).map((p) => p.authorId);
    assert.ok(authors.includes(other.id), `control: an unblocked author is served (${r.raw.slice(0, 300)})`);
    assert.ok(!authors.includes(blockedAuthor.id), "a post by someone the viewer blocked was served");
    assert.ok(!authors.includes(blocker.id), "a post by someone who blocked the viewer was served");
    const fault = (q: { target: string }) => (q.target === "blocks" ? { status: 500, body: { code: "XX000", message: "test: blocks unreadable" } } : null);
    db.bridge.faults.push(fault as any);
    try {
      const u = await app.call("GET", "/api/airport/pulse?city=Pulsetown", viewer);
      assert.equal(u.status, 503, `an unreadable block list served the pulse: ${u.raw.slice(0, 200)}`);
    } finally { db.bridge.faults.splice(db.bridge.faults.indexOf(fault as any), 1); }
  });

  // ── A5: a crewmate who is no longer in good standing ──────────────────────
  it("A5 a deactivated, pending-deletion or banned crewmate is no longer published to the crew; restored, they are", async () => {
    const { a, b } = await crewOfTwo("standing");
    assert.equal((await share(b)).status, 200);
    const seesB = async () => {
      const crew = await app.call("GET", `${S(a.sid)}/crew`, a.u);
      assert.equal(crew.status, 200, crew.raw);
      const loc = await app.call("GET", locPath(a), a.u);
      assert.equal(loc.status, 200, loc.raw);
      return { card: JSON.stringify(crew.body.members ?? crew.body.crew?.members ?? crew.body).includes(b.u.id), share: (loc.body.crewmates ?? []).some((c: any) => c.userId === b.u.id) };
    };
    assert.deepEqual(await seesB(), { card: true, share: true }, "control: an active crewmate is published");
    for (const status of ["deactivated", "pending_deletion"]) {
      await db.exec(`UPDATE public.profiles SET account_status = '${status}' WHERE id = '${b.u.id}'`);
      assert.deepEqual(await seesB(), { card: false, share: false }, `a ${status} crewmate was still published`);
      await db.exec(`UPDATE public.profiles SET account_status = 'active' WHERE id = '${b.u.id}'`);
    }
    await db.exec(`INSERT INTO public.user_account_states (user_id, state, reason) VALUES ('${b.u.id}', 'banned', 'audit test')`);
    assert.deepEqual(await seesB(), { card: false, share: false }, "a banned crewmate was still published");
    await db.exec(`DELETE FROM public.user_account_states WHERE user_id = '${b.u.id}'`);
    assert.deepEqual(await seesB(), { card: true, share: true }, "restored, the crewmate is published again");
  });

  // ── A6: an unreadable re-entry record ─────────────────────────────────────
  it("A6 an unreadable re-entry record serves landside cards and says it could not check (the pinned design; B7)", async () => {
    const u = await db.seedUser("reentry_unknown");
    await seedConfirmedCorridor(db, u.id);
    await seedCuratedAirport(app, db, "SIN");
    const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 10 })).id;
    assert.equal((await app.call("PUT", `${S(sid)}/constraints`, u, { baggageMode: "CARRY_ON_ONLY", recheckRequired: false, airportChangeRequired: false })).status, 200);
    await db.exec(`INSERT INTO public.discovery_places (city, name, place_type, status, lat, lng) VALUES ('Singapore', 'Audit Garden', 'attraction', 'active', 1.2834, 103.8607)`);
    const open = await app.call("GET", `${S(sid)}/recommendations`, u);
    assert.equal(open.status, 200, open.raw);
    assert.ok((open.body.recommendations as any[]).some((r) => r.insideAirport !== true), "control: with the record readable, landside cards are served");
    const fault = (q: { target: string; method: string }) => (q.target === "layover_checkpoints" && q.method === "GET" ? { status: 500, body: { code: "XX000", message: "test: checkpoints unreadable" } } : null);
    db.bridge.faults.push(fault as any);
    try {
      const r = await app.call("GET", `${S(sid)}/recommendations`, u);
      assert.equal(r.status, 200, r.raw);
      const cards = r.body.recommendations as any[];
      assert.ok(cards.some((c) => c.insideAirport !== true), `the pinned design (layoverCheckpoints.test.ts) serves landside on an outage; B7 asks whether it should: ${JSON.stringify(cards.map((c) => [c.title, c.insideAirport]))}`);
      assert.equal(r.body.landsideSuppression?.reason, "checkpoints_unreadable");
    } finally { db.bridge.faults.splice(db.bridge.faults.indexOf(fault as any), 1); }
  });
});
