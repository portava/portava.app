/**
 * census-layover §83 — rows whose only remaining dependency is the owner's signed-in production retest, proven here on
 * the full migrated chain through the real router under production's OWN flag state (all 382 flags as read read-only
 * on 2026-10-23 after the lead's 21:55Z changes: test/db/fixtures/productionFlags20261023.json). Every case below is a
 * traveller's own sequence of calls; nothing is seeded behind the router except the fixtures a traveller cannot make
 * (a curated airport, a passport corridor, a crewmate).
 *
 * Rows (each case names its own): L49, L230 (entry and critical-unknown fail-closed), L222/L284, L224/L283, L229/L279
 * (the §21.1 constraint scenarios and their Appendix A codes), L64 (every card cites its stored snapshot), L95 (a replan
 * stores a new immutable snapshot), L190 (the stored diff), L173 (recordCheckpoint), L43 (re-entry stops landside and
 * refreshes gate/security), L132/L158/L166/L124 (the crew location ladder, server half), L294 (a schema failure is never
 * an empty answer), and the two members this batch builds: L24 (recommended return) and L25 (3951's safe_envelope_ref).
 *
 * Run: LOCAL_DB_URL=… node --import tsx/esm --test src/test/db/layoverRetestRows20261023.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { safeEnvelopeRefOfServed } from "../../services/layover/LayoverSnapshotEnvelopeRef.js";
import { RETURN_SOON_LEAD_MIN } from "../../services/airport/LayoverSafetyEngine.js";
import { keepConstraintsUndeclared, productionBaseFlags, seedConfirmedCorridor, seedCuratedAirport, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/productionFlags20261023.json", import.meta.url), "utf8")) as {
  flags: Record<string, boolean>; metadata: Record<string, Record<string, unknown>>;
};
const DECLARED = { baggageMode: "CARRY_ON_ONLY", recheckRequired: false, airportChangeRequired: false } as const;

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser, nopass: PressedUser;

const declare = (u: PressedUser, sid: string, body: Record<string, unknown>) => app.call("PUT", `/api/airport/sessions/${sid}/constraints`, u, body);
const overview = (u: PressedUser, sid: string) => app.call("GET", `/api/airport/sessions/${sid}/overview`, u);
const recs = (u: PressedUser, sid: string) => app.call("GET", `/api/airport/sessions/${sid}/recommendations`, u);
const availableLandside = (body: any) => ((body?.recommendations ?? []) as any[]).filter((c) => c.insideAirport !== true && c.available !== false);

describe("§83 — retest rows under production's 2026-10-23 flag state", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb();
    keepConstraintsUndeclared(); // every case states its own answers
    await productionBaseFlags(db);
    await db.setFlags({ ...FX.flags });
    for (const [flag, metadata] of Object.entries(FX.metadata)) await db.setFlag(flag, FX.flags[flag] === true, metadata);
    app = await startPressedLayoverApp(db, { extraRouters: [(await import("../../routes/layoverConnections.js")).default, (await import("../../server/trips/flightSegmentRoute.js")).default] }); // L153: Trips' flights and the connection route, as routes/index.ts mounts them
    ana = await db.seedUser("retest_ana");
    nopass = await db.seedUser("retest_nopass");
    await seedConfirmedCorridor(db, ana.id, "US", "SG");
    await seedCuratedAirport(app, db, "SIN");
    await db.exec(`INSERT INTO public.discovery_places (city, name, place_type, status, lat, lng) VALUES ('Singapore', 'Retest Garden', 'attraction', 'active', 1.2834, 103.8607)`);
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("F0 the flag state is production's (382 rows, the two 21:55Z changes included)", async () => {
    assert.equal(Object.keys(FX.flags).length, 382);
    for (const f of ["layover_constraints_enabled", "layover_recommendation_status_enabled", "layover_canonical_snapshot_enabled", "layover_crew_location_enabled"]) assert.equal(await db.flag(f), true, f);
    for (const f of ["layover_presence_intents_enabled", "layover_crew_abort_notify_enabled", "layover_entry_forbid_landside_enabled", "layover_routed_corridor_enabled"]) assert.equal(await db.flag(f), false, f);
  });

  it("L49 — a critical unknown (an undeclared airport change) makes confidence INSUFFICIENT and forbids landside", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN", baggageMode: "CARRY_ON_ONLY" }, { departsInH: 9 })).id; // the creation sheet sends baggage only
    const o = await overview(ana, sid);
    assert.equal(o.status, 200, o.raw);
    assert.equal(o.body.certification.confidence, "INSUFFICIENT", o.raw.slice(0, 400));
    assert.equal(o.body.landsideGate.status, "closed");
    assert.ok(o.body.landsideGate.criticalUnknowns.includes("airport_change_required"), JSON.stringify(o.body.landsideGate));
    const r = await recs(ana, sid);
    assert.equal(r.status, 200, r.raw);
    assert.equal(availableLandside(r.body).length, 0, "a landside card was offered while a critical fact was unknown");
  });

  it("L230 — unknown entry permission (no passport on file) offers no landside recommendation, whatever else is declared", async () => {
    const sid = (await startSession(app, nopass, { iata: "SIN" }, { departsInH: 9 })).id;
    const d = await declare(nopass, sid, DECLARED);
    assert.equal(d.status, 200, d.raw);
    assert.notEqual(d.body.landsideGate.entryPermissionState, "CONFIRMED_ALLOWED", JSON.stringify(d.body.landsideGate));
    assert.notEqual(d.body.landsideGate.status, "open", "landside opened on an unconfirmed border");
    const r = await recs(nopass, sid);
    assert.equal(availableLandside(r.body).length, 0, "a landside card was offered on unknown entry permission");
    // control: the same declaration for a traveller whose corridor is confirmed opens landside
    const ok = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    const c = await declare(ana, ok, DECLARED);
    assert.equal(c.body.landsideGate.entryPermissionState, "CONFIRMED_ALLOWED");
    assert.equal(c.body.landsideGate.status, "open", JSON.stringify(c.body.landsideGate));
  });

  it("L224 L283 — a declared airport change subordinates exploration: landside closes with AIRPORT_CHANGE_REQUIRED", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    const d = await declare(ana, sid, { ...DECLARED, airportChangeRequired: true });
    assert.equal(d.status, 200, d.raw);
    assert.ok(d.body.reasonCodes.includes("AIRPORT_CHANGE_REQUIRED"), JSON.stringify(d.body.reasonCodes));
    assert.notEqual(d.body.landsideGate.status, "open");
    assert.equal(availableLandside((await recs(ana, sid)).body).length, 0);
  });

  it("L222 L284 — a self-transfer (recheck) is charged as friction and named SELF_TRANSFER_FRICTION", async () => {
    const plain = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    const recheck = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    const a = await declare(ana, plain, DECLARED);
    const b = await declare(ana, recheck, { ...DECLARED, recheckRequired: true });
    assert.equal(b.status, 200, b.raw);
    assert.ok(b.body.reasonCodes.includes("SELF_TRANSFER_FRICTION"), JSON.stringify(b.body.reasonCodes));
    assert.equal(a.body.reasonCodes.includes("SELF_TRANSFER_FRICTION"), false);
    const ua = (await overview(ana, plain)).body.window.usableMinutes, ub = (await overview(ana, recheck)).body.window.usableMinutes;
    assert.ok(ub < ua, `recheck friction was not charged: ${ub} vs ${ua}`);
  });

  it("L229 L279 — on a window where one bag decides, UNKNOWN baggage fails closed with BAGGAGE_STATUS_CRITICAL_UNKNOWN; answering lifts it", async () => {
    let found: { sid: string; minutes: number } | null = null;
    for (let minutes = 180; minutes <= 600 && !found; minutes += 5) {
      const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: minutes / 60, arrivedHAgo: 0.25 })).id;
      const d = await declare(ana, sid, { ...DECLARED, baggageMode: "UNKNOWN" });
      if (d.body.verdict === "no" && d.body.reasonCodes.includes("BAGGAGE_STATUS_CRITICAL_UNKNOWN")) found = { sid, minutes };
    }
    assert.ok(found, "no window between 3 h and 10 h where one bag decides");
    const g = (await overview(ana, found.sid)).body.landsideGate;
    assert.equal(g.status, "closed");
    assert.deepEqual(g.criticalUnknowns, ["baggage_mode"]);
    const lifted = await declare(ana, found.sid, { baggageMode: "CARRY_ON_ONLY" });
    assert.notEqual(lifted.body.verdict, "no", lifted.raw.slice(0, 400));
    assert.equal(lifted.body.reasonCodes.includes("BAGGAGE_STATUS_CRITICAL_UNKNOWN"), false);
  });

  it("L64 — every generated card stores the snapshot it was certified under, and that snapshot is a stored one", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    await declare(ana, sid, DECLARED);
    const r = await recs(ana, sid);
    assert.equal(r.status, 200, r.raw);
    const rows = await db.query<any>(`SELECT r.snapshot_id, (SELECT count(*)::int FROM public.layover_certified_computations c WHERE c.snapshot_id = r.snapshot_id) AS stored FROM public.layover_recommendations r WHERE r.session_id = '${sid}' AND r.recommendation_status IS DISTINCT FROM 'SUPERSEDED'`);
    assert.ok(rows.length > 0);
    for (const row of rows) { assert.ok(row.snapshot_id, "a card with no snapshot"); assert.equal(row.stored, 1, "a card citing an unstored snapshot"); }
    assert.ok(rows.every((x) => x.snapshot_id === r.body.snapshotId), "the cards and the response name different snapshots");
  });

  it("L95 L190 — a replan stores a NEW immutable snapshot, and the stored diff names what moved", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    await declare(ana, sid, DECLARED);
    const before = (await overview(ana, sid)).body.snapshotId;
    const p = await app.call("PATCH", `/api/airport/sessions/${sid}`, ana, { departureTime: new Date(Date.now() + 7 * 3_600_000).toISOString() });
    assert.equal(p.status, 200, p.raw);
    assert.equal(p.body.replan.ran, true);
    assert.equal(p.body.replan.snapshotPersisted, true, JSON.stringify(p.body.replan).slice(0, 300));
    const after = p.body.replan.snapshotId;
    assert.notEqual(after, before);
    const v = await db.query<any>(`SELECT snapshot_id, snapshot_version FROM public.layover_certified_computations WHERE session_id = '${sid}' ORDER BY snapshot_version`);
    assert.equal(v[v.length - 1].snapshot_id, after, "the replan's snapshot is the session's newest version");
    await assert.rejects(db.exec(`UPDATE public.layover_certified_computations SET usable_minutes = usable_minutes + 1 WHERE snapshot_id = '${after}'`), /IMMUTABLE/);
    const df = await app.call("GET", `/api/airport/sessions/${sid}/decisions/diff?from=${encodeURIComponent(before)}&to=${encodeURIComponent(after)}`, ana);
    assert.equal(df.status, 200, df.raw);
    assert.equal(df.body.state, "stored");
    assert.equal(df.body.diff.materiallyChanged, true);
    assert.ok(df.body.changes.some((c: any) => c.field === "hardReturnTime" && c.minutesMoved < 0), df.raw.slice(0, 400));
  });

  it("L173 L43 — recordCheckpoint stores the traveller's re-entry once; re-entry stops landside discovery and refreshes gate and security", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    await declare(ana, sid, DECLARED);
    const landsideBefore = (((await recs(ana, sid)).body.recommendations ?? []) as any[]).filter((x) => x.insideAirport !== true).length;
    assert.ok(landsideBefore > 0, "control: landside cards are served before re-entry (Routes dark: served BLOCKED, available false)");
    const op = `op-${randomUUID()}`;
    const c1 = await app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, ana, { type: "AIRPORT_REENTRY", operationId: op });
    assert.equal(c1.status, 201, c1.raw);
    const c2 = await app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, ana, { type: "AIRPORT_REENTRY", operationId: op });
    assert.equal(c2.body.duplicate, true);
    assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_checkpoints WHERE session_id = '${sid}'`)).length, 1, "a retried tap stored twice");
    const o = await overview(ana, sid);
    assert.equal(o.body.reentry.state, "reentered", JSON.stringify(o.body.reentry));
    assert.ok(o.body.reentry.flight && o.body.reentry.security, "REFRESH_GATE_AND_SECURITY: both are re-read (and named when absent)");
    assert.equal(o.body.lifecycle.state, "AIRPORT_REENTERED");
    assert.ok(o.body.lifecycle.intents.includes("STOP_LANDSIDE_DISCOVERY") && o.body.lifecycle.intents.includes("REFRESH_GATE_AND_SECURITY"));
    const r = await recs(ana, sid);
    assert.equal(r.body.landsideSuppression?.reason, "airport_reentered");
    assert.equal(((r.body.recommendations ?? []) as any[]).filter((x) => x.insideAirport !== true).length, 0, "landside discovery continued after re-entry");
  });

  it("L166 L132 L158 L124 — precise crew sharing is a separate control, off by default; shares are scoped, bounded and end with the control", async () => {
    const ua = await db.seedUser("retest_crew_a"), ub = await db.seedUser("retest_crew_b");
    const a = (await startSession(app, ua, { iata: "SIN" }, { departsInH: 9 })).id;
    const b = (await startSession(app, ub, { iata: "SIN" }, { departsInH: 9 })).id;
    const crew = await app.call("POST", `/api/airport/sessions/${b}/crew`, ub, { title: "retest crew" });
    assert.equal(crew.status, 200, crew.raw);
    const j = await app.call("POST", `/api/airport/sessions/${a}/crew/${crew.body.crew.id}/join`, ua);
    assert.equal(j.status, 200, j.raw);
    const view = await app.call("GET", `/api/airport/sessions/${a}/crew/location`, ua);
    assert.equal(view.status, 200, view.raw);
    assert.deepEqual(view.body.preciseControl, { enabled: false }, "L166: off by default");
    const in1h = new Date(Date.now() + 3_600_000).toISOString();
    const exactOff = await app.call("POST", `/api/airport/sessions/${a}/crew/location`, ua, { label: "Gate B4", precision: "exact", lat: 1.3644, lng: 103.9915, expiresAt: in1h });
    assert.equal(exactOff.status, 409, exactOff.raw);
    assert.equal(exactOff.body.reason, "precise_control_off");
    const tooLong = await app.call("POST", `/api/airport/sessions/${a}/crew/location`, ua, { label: "Gate B4", expiresAt: new Date(Date.now() + 9 * 3_600_000).toISOString() });
    assert.equal(tooLong.status, 400, `L132: a share past the 4-hour ceiling must be refused: ${tooLong.raw}`);
    const on = await app.call("PUT", `/api/airport/sessions/${a}/crew/location/precise-control`, ua, { enabled: true });
    assert.equal(on.status, 200, on.raw);
    const exact = await app.call("POST", `/api/airport/sessions/${a}/crew/location`, ua, { label: "Gate B4", precision: "exact", lat: 1.3644, lng: 103.9915, expiresAt: in1h });
    assert.equal(exact.status, 200, exact.raw);
    const seen = await app.call("GET", `/api/airport/sessions/${b}/crew/location`, ub);
    assert.ok((seen.body.crewmates ?? []).some((c: any) => c.userId === ua.id), "L124: the crewmate's explicit share reaches the other member's view (the map's crewLocations read)");
    const grant = await db.query<any>(`SELECT purpose, precision, session_id, expires_at, granted_at FROM public.layover_crew_location_grants WHERE user_id = '${ua.id}'`);
    assert.equal(grant.length, 1);
    assert.equal(grant[0].precision, "exact");
    assert.equal(grant[0].purpose, "live_session_sharing");
    assert.equal(grant[0].session_id, a, "L158: session scoped");
    assert.ok(Date.parse(grant[0].expires_at) - Date.parse(grant[0].granted_at) <= 4 * 3_600_000, "L132: bounded");
    const off = await app.call("PUT", `/api/airport/sessions/${a}/crew/location/precise-control`, ua, { enabled: false });
    assert.equal(off.status, 200, off.raw);
    assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_crew_location_grants WHERE user_id = '${ua.id}' AND precision = 'exact'`)).length, 0, "L158/L166: turning the control off ends the exact share");
  });

  it("L294 — a schema failure on a layover read is a refusal, never a plausible empty answer", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    await declare(ana, sid, DECLARED);
    const okRead = await app.call("GET", `/api/airport/sessions/${sid}/checkpoints`, ana);
    assert.equal(okRead.status, 200, okRead.raw);
    await db.exec(`ALTER TABLE public.layover_checkpoints RENAME TO layover_checkpoints_retest_hidden`);
    try {
      const broken = await app.call("GET", `/api/airport/sessions/${sid}/checkpoints`, ana);
      assert.equal(broken.status, 503, `an unreadable store was answered as data: ${broken.raw.slice(0, 300)}`);
      assert.equal(broken.body?.checkpoints, undefined, "no checkpoints array rides a refusal");
    } finally {
      await db.exec(`ALTER TABLE public.layover_checkpoints_retest_hidden RENAME TO layover_checkpoints`);
    }
  });

  it("L24 — the stored return plan's recommended return is the certified RETURN_SOON instant, and latest activity departure is not guessed", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    await declare(ana, sid, DECLARED);
    const o = await overview(ana, sid);
    assert.equal(o.status, 200, o.raw);
    const [rp] = await db.query<any>(`SELECT hard_return_by, recommended_return_by, latest_activity_departure_at FROM public.layover_return_plans WHERE snapshot_id = '${o.body.snapshotId}'`);
    assert.ok(rp, "the overview's snapshot has its return plan stored");
    assert.equal(Date.parse(rp.hard_return_by) - Date.parse(rp.recommended_return_by), RETURN_SOON_LEAD_MIN * 60_000);
    assert.equal(rp.latest_activity_departure_at, null);
  });

  it("L25 — 3951: OFF the snapshot records no ref (NULL, not recorded); ON it names exactly the envelope the router served, or why none was", async () => {
    assert.equal(await db.flag("layover_snapshot_envelope_ref_enabled"), false, "3951 seeds it FALSE and production has no row for it");
    const off = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    await declare(ana, off, DECLARED);
    const oOff = await overview(ana, off);
    const [rOff] = await db.query<any>(`SELECT safe_envelope_ref FROM public.layover_certified_computations WHERE snapshot_id = '${oOff.body.snapshotId}'`);
    assert.equal(rOff.safe_envelope_ref, null);
    await db.setFlag("layover_snapshot_envelope_ref_enabled", true);
    try {
      const open = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
      await declare(ana, open, DECLARED);
      const o = await overview(ana, open);
      assert.equal(o.status, 200, o.raw);
      assert.ok(o.body.safeEnvelope, `an open landside serves an envelope: ${JSON.stringify(o.body.safeEnvelopeGate)}`);
      const [r] = await db.query<any>(`SELECT safe_envelope_ref FROM public.layover_certified_computations WHERE snapshot_id = '${o.body.snapshotId}'`);
      assert.equal(r.safe_envelope_ref, safeEnvelopeRefOfServed(o.body.safeEnvelope), "the stored ref is the hash of the envelope the traveller was served");
      const shut = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
      await declare(ana, shut, { ...DECLARED, airportChangeRequired: true });
      const oc = await overview(ana, shut);
      assert.equal(oc.body.safeEnvelope, null);
      const [rc] = await db.query<any>(`SELECT safe_envelope_ref FROM public.layover_certified_computations WHERE snapshot_id = '${oc.body.snapshotId}'`);
      assert.equal(rc.safe_envelope_ref, "env:withheld:landside_closed");
      await assert.rejects(db.exec(`UPDATE public.layover_certified_computations SET safe_envelope_ref = 'env:made-up' WHERE snapshot_id = '${o.body.snapshotId}'`), /IMMUTABLE|layover_certcomp_safe_envelope_ref_shape/);
    } finally {
      await db.setFlag("layover_snapshot_envelope_ref_enabled", false);
    }
  });

  it("L153 L43 — the offline bundle caches the onward flight's last RECORDED gate, with who recorded it and when, stale from the observation; re-entry re-reads it", async () => {
    const u = await db.seedUser("retest_flight");
    const tripId = randomUUID();
    const k = await db.query<any>(`SELECT public.trip_kernel_execute(jsonb_build_object('trip_id', '${tripId}', 'actor_user_id', '${u.id}', 'command_id', gen_random_uuid(), 'idempotency_key', 'create-${tripId}', 'type', 'CREATE_TRIP', 'payload', jsonb_build_object('title', 'Singapore', 'destination_city', 'Singapore', 'destination_country', 'SG'))) AS r`);
    assert.equal(k[0].r.ok, true, JSON.stringify(k[0].r));
    const t0 = Math.floor(Date.now() / 60_000) * 60_000;
    const inbound = await app.call("POST", `/api/trips/${tripId}/flight-segments`, u, { flight: "SQ 0031", departureAirport: "SFO", arrivalAirport: "SIN", departureLocal: wall("America/Los_Angeles", t0 - 17 * HOUR), arrivalLocal: wall("Asia/Singapore", t0 - HOUR), bookingRef: "RET153" }, { "idempotency-key": `in-${tripId}` });
    assert.equal(inbound.status, 201, inbound.raw);
    const onward = await app.call("POST", `/api/trips/${tripId}/flight-segments`, u, { flight: "SQ 0322", departureAirport: "SIN", arrivalAirport: "LHR", departureLocal: wall("Asia/Singapore", t0 + 8 * HOUR), arrivalLocal: wall("Europe/London", t0 + 22 * HOUR), bookingRef: "RET153" }, { "idempotency-key": `out-${tripId}` });
    assert.equal(onward.status, 201, onward.raw);
    const conn = await app.call("POST", `/api/trips/${tripId}/layover-connections`, u, { arrivalSegmentId: inbound.body.segment.id, departureSegmentId: onward.body.segment.id });
    assert.equal(conn.status, 201, conn.raw);
    const sid = conn.body.session.id as string;
    const first = await overview(u, sid);
    assert.equal(first.status, 200, first.raw);
    assert.deepEqual(first.body.offlineBundle.flightStatus, { available: false, value: null, reason: "no_flight_observation" }, "a linked flight nobody observed is not dressed up as a status");
    const st = await app.call("POST", `/api/trips/${tripId}/flight-segments/${onward.body.segment.id}/status`, u, { departureGate: "B4", departureTerminal: "3" });
    assert.equal(st.status, 200, st.raw);
    const after = await overview(u, sid);
    const f = after.body.offlineBundle.flightStatus;
    assert.equal(f.available, true, JSON.stringify(f));
    assert.equal(f.value.gate, "B4");
    assert.equal(f.value.terminal, "3");
    assert.equal(f.value.source, "traveller", "who recorded it travels with it");
    assert.equal(Date.parse(f.value.staleAfter) - Date.parse(f.value.observedAt), 15 * 60_000, "stale from the OBSERVATION instant (the bundle TTL), never renewed");
    const ck = await app.call("POST", `/api/airport/sessions/${sid}/checkpoints`, u, { type: "AIRPORT_REENTRY", operationId: `op-${randomUUID()}` });
    assert.equal(ck.status, 201, ck.raw);
    const re = await overview(u, sid);
    assert.equal(re.body.reentry.state, "reentered", JSON.stringify(re.body.reentry));
    assert.equal(re.body.reentry.flight.state, "observed", JSON.stringify(re.body.reentry.flight));
    assert.equal(re.body.reentry.flight.flight.gate, "B4", "REFRESH_GATE_AND_SECURITY re-reads the recorded gate");
  });
});

const HOUR = 3_600_000;
/** "YYYY-MM-DDTHH:mm" in `tz` (the Trips flight route takes local wall times). */
function wall(tz: string, ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
