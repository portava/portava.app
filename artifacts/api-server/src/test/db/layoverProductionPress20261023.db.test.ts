/**
 * census-layover §82 — the rows this lane grades C after the 2026-10-23
 * production press, driven together under PRODUCTION'S OWN flag state.
 *
 * Every pressed-state suite before this one turns on its own subset of flags
 * over the 2026-09-22 snapshot. Production stopped looking like any one subset
 * on 2026-10-23 10:02Z, when the owner switched most layover flags on at once.
 * This suite sets the 55 airport/layover-adjacent flags to the values
 * production's `public.feature_flags` holds (read-only, 2026-10-23 ~20:40Z, and
 * re-read after the lead turned `layover_crew_abort_notify_enabled` and
 * `layover_presence_intents_enabled` back OFF at 21:55:57Z), so the rows below are
 * proven in the combination a traveller now reaches, on the full migrated chain,
 * through the real router:
 *
 *   L193 §19 step 2 — constraints, snapshots, time budgets and return plans:
 *        every one of the four tables is written by the traveller's own calls.
 *   L35  BaggageMode — each of the four members a traveller declares is the
 *        member stored; a session that declares nothing stores UNKNOWN.
 *   L26  layover_recommendations — every generated card row carries all eight
 *        members (snapshot_id citing a stored snapshot, candidate type, status,
 *        plan_json, utility_score, risk_band, confidence, expires_at).
 *   L21  layover_sessions — state, detected_source, expires_at, active
 *        snapshot and confidence band are server-stamped on a typed session.
 *   L203 crew location rows — the route refuses a sharer with no crew, and the
 *        database refuses a grant row with no live membership.
 *   L196 (held W) — no client role can read or write the presence, crew or crew
 *        location tables, and while `layover_presence_intents_enabled` is OFF the
 *        intents writer refuses and layover_presence stays empty.
 *
 * Run: LOCAL_DB_URL=… node --import tsx/esm --test src/test/db/layoverProductionPress20261023.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, seedConfirmedCorridor, seedCuratedAirport, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

/** production `public.feature_flags`, read-only, 2026-10-23 ~20:40Z and re-read after 21:55:57Z (census-layover §82.1). */
export const PRODUCTION_FLAGS_20261023: Readonly<Record<string, boolean>> = Object.freeze({
  airport_mode_enabled: true, airport_pulse_enabled: true, disable_rent_buddy_booking: false, hidden_gems_layover_enabled: true,
  intel_claim_projection_crowd: true, intel_live_label_crowd: true,
  layover_activity_commitment_enabled: false, layover_buddy_specialist_enabled: false, layover_canonical_snapshot_enabled: true,
  layover_compass_assistant_enabled: true, layover_compass_enabled: true, layover_compass_replan_enabled: true,
  layover_constraints_enabled: true, layover_crew_abort_notify_enabled: false, layover_crew_location_enabled: true,
  layover_crew_split_plans_enabled: true, layover_crowd_reports_enabled: true, layover_decision_persistence_enabled: true,
  layover_discovery_mode_enabled: true, layover_entry_forbid_landside_enabled: false, layover_event_ingest_enabled: false,
  layover_events_post_session_pseudonymisation_enabled: false, layover_experience_execution_enabled: true,
  layover_flight_connections_enabled: true, layover_lifecycle_machine_enabled: true, layover_live_intersection_enabled: true,
  layover_live_signals_enabled: true, layover_map_bands_enabled: true, layover_map_budget_chips_enabled: true,
  layover_maturity_gate_enabled: false, layover_mutual_discovery_enabled: true, layover_objective_evidence_enabled: true,
  layover_place_dwell_enabled: true, layover_plans_enabled: true, layover_presence_intents_enabled: false,
  layover_presence_ladder_enabled: true, layover_recommendation_snapshot_enabled: true, layover_recommendation_status_enabled: true,
  layover_route_fanout_enabled: false, layover_route_subjects_enabled: false, layover_routed_corridor_enabled: false,
  layover_safe_return_product_enabled: true, layover_safe_return_status_enabled: true, layover_safety_engine_enabled: true,
  layover_service_write_audit_enabled: false, layover_snapshot_compaction_enabled: false, layover_snapshot_consumers_enabled: true,
  layover_stable_recommendation_ids_enabled: true, map_crowd_flow_enabled: true, passport_entry_intelligence_enabled: true,
  rent_buddy_enabled: false, trip_flight_segments_enabled: true, trip_routes_api_enabled: false, wall_rab_integration_enabled: false,
});

const BAGGAGE = ["CHECKED_THROUGH", "COLLECT_RECHECK", "CARRY_ON_ONLY", "UNKNOWN"] as const;
const REC_STATUSES = ["ELIGIBLE", "TIGHT", "BLOCKED", "STALE", "EXPIRED", "SUPERSEDED"];
const RISK = ["LOW", "MODERATE", "HIGH", "UNSAFE"];
const CONF = ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"];

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser;

describe("§82 — production's 2026-10-23 flag state, on the migrated chain", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb(); keepConstraintsUndeclared(); // this suite declares for itself
    await productionBaseFlags(db);
    await db.setFlags({ ...PRODUCTION_FLAGS_20261023 });
    // `layover_ranking_mode` is a metadata flag: production holds { mode: "on", cohort: { kind: "all" } }.
    await db.setFlag("layover_ranking_mode", true, { mode: "on", modes: ["legacy", "shadow", "on"], cohort: { kind: "all" }, rollout: "b58-lay-4" });
    app = await startPressedLayoverApp(db);
    ana = await db.seedUser("prod_press_ana");
    await seedConfirmedCorridor(db, ana.id, "US", "SG");
    await seedCuratedAirport(app, db, "SIN");
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("F0 the flag state is production's: every listed flag reads back as production holds it", async () => {
    for (const [flag, on] of Object.entries(PRODUCTION_FLAGS_20261023)) assert.equal(await db.flag(flag), on, flag);
  });

  it("L21 — a typed session is server-stamped with state, source, expiry, the active snapshot and its confidence band", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 8 })).id;
    const o = await app.call("GET", `/api/airport/sessions/${sid}/overview`, ana);
    assert.equal(o.status, 200, o.raw);
    const [s] = await db.query<any>(`SELECT state, detected_source, expires_at, departure_time, active_snapshot_id, confidence_band, created_at, airport_id FROM public.layover_sessions WHERE id = '${sid}'`);
    assert.ok(typeof s.state === "string" && s.state.length > 0, `state: ${JSON.stringify(s)}`);
    assert.equal(s.detected_source, "manual");
    assert.equal(Date.parse(s.expires_at), Date.parse(s.departure_time));
    assert.ok(s.active_snapshot_id, "the overview's stored computation is the session's active snapshot");
    assert.ok(CONF.includes(s.confidence_band), `confidence_band: ${s.confidence_band}`);
    assert.ok(s.created_at && s.airport_id, "started_at = created_at, airport_place_id = airport_id");
    const [c] = await db.query<any>(`SELECT confidence FROM public.layover_certified_computations WHERE snapshot_id = '${s.active_snapshot_id}'`);
    assert.equal(c?.confidence, s.confidence_band, "the band is the active computation's own confidence");
  });

  it("L35 L193 — each declared BaggageMode is the member stored; the four §19 step-2 tables are written by the traveller's own calls", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    assert.equal((await app.call("GET", `/api/airport/sessions/${sid}/overview`, ana)).status, 200);
    for (const mode of BAGGAGE) {
      const r = await app.call("PUT", `/api/airport/sessions/${sid}/constraints`, ana, { baggageMode: mode });
      assert.equal(r.status, 200, `${mode}: ${r.raw}`);
      assert.equal(r.body.stored, "versioned", `${mode}: ${r.raw}`);
    }
    const versions = await db.query<any>(`SELECT version, baggage_mode FROM public.layover_constraints WHERE session_id = '${sid}' ORDER BY version`);
    assert.deepEqual(versions.map((v) => v.baggage_mode), [...BAGGAGE], "each declaration appended the member it named");
    const other = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    const rc = await app.call("PUT", `/api/airport/sessions/${other}/constraints`, ana, { recheckRequired: false });
    assert.equal(rc.status, 200, rc.raw);
    const [undeclared] = await db.query<any>(`SELECT baggage_mode FROM public.layover_constraints WHERE session_id = '${other}'`);
    assert.equal(undeclared.baggage_mode, "UNKNOWN", "a traveller who did not say keeps UNKNOWN, never a guess");
    for (const table of ["layover_constraints", "layover_certified_computations", "layover_time_budgets", "layover_return_plans"]) {
      const [n] = await db.query<any>(`SELECT count(*)::int AS n FROM public.${table} WHERE session_id = '${sid}'`);
      assert.ok(n.n >= 1, `${table} holds nothing for the session`);
    }
  });

  it("L26 — every generated card row carries the eight §4 members, and its snapshot is a stored one", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    assert.equal((await app.call("GET", `/api/airport/sessions/${sid}/overview`, ana)).status, 200);
    const r = await app.call("GET", `/api/airport/sessions/${sid}/recommendations`, ana);
    assert.equal(r.status, 200, r.raw);
    const rows = await db.query<any>(`SELECT r.*, (SELECT count(*)::int FROM public.layover_certified_computations c WHERE c.snapshot_id = r.snapshot_id) AS stored FROM public.layover_recommendations r WHERE r.session_id = '${sid}' AND r.recommendation_status IS DISTINCT FROM 'SUPERSEDED'`);
    assert.ok(rows.length > 0, "the generator wrote no card");
    for (const row of rows) {
      const label = `${row.rec_type}:${row.title}`;
      assert.equal(row.stored, 1, `${label}: snapshot_id cites no stored snapshot`);
      assert.ok(typeof row.rec_type === "string" && row.rec_type.length > 0, `${label}: candidate_type`);
      assert.ok(REC_STATUSES.includes(row.recommendation_status), `${label}: status ${row.recommendation_status}`);
      assert.equal(typeof row.plan_json, "object", `${label}: plan_json`);
      assert.ok(row.plan_json && !Array.isArray(row.plan_json), `${label}: plan_json is an object`);
      assert.ok(row.utility_score !== null && Number.isFinite(Number(row.utility_score)), `${label}: utility_score ${row.utility_score}`);
      assert.ok(RISK.includes(row.risk_band), `${label}: risk_band ${row.risk_band}`);
      assert.ok(CONF.includes(row.confidence), `${label}: confidence ${row.confidence}`);
      assert.ok(row.expires_at, `${label}: expires_at`);
    }
    // ...and the wire carries the served status the app now reads (§82's client half).
    for (const card of r.body.recommendations as any[]) {
      assert.equal(typeof card.available, "boolean", `${card.title}: available`);
      assert.ok(REC_STATUSES.includes(card.status), `${card.title}: status ${card.status}`);
    }
  });

  it("L203 — no crew, no share (the route); no live membership, no grant row (the database)", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    const r = await app.call("POST", `/api/airport/sessions/${sid}/crew/location`, ana, { label: "By gate B4", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.reason, "not_in_crew", r.raw);
    await assert.rejects(
      db.exec(`INSERT INTO public.layover_crew_location_grants (crew_id, user_id, session_id, purpose, precision, label, granted_at, expires_at)
                 VALUES ('${randomUUID()}', '${ana.id}', '${sid}', 'presence_in_context', 'area', 'Gate', now(), now() + interval '1 hour')`),
      (e: any) => e?.code === "23503" || e?.code === "23514",
      "a grant with no membership row must be refused",
    );
  });

  it("L203 — the guard trigger itself: a membership row that EXISTS (so the FK holds) is still refused unless it is live, on its own session, and exact has the control", async () => {
    const ua = await db.seedUser("guard_a"), ub = await db.seedUser("guard_b");
    const a = (await startSession(app, ua, { iata: "SIN" }, { departsInH: 9 })).id;
    const aOther = (await startSession(app, ua, { iata: "SIN" }, { departsInH: 9 })).id;
    const b = (await startSession(app, ub, { iata: "SIN" }, { departsInH: 9 })).id;
    const c = await app.call("POST", `/api/airport/sessions/${b}/crew`, ub, { title: "guard crew" });
    assert.equal(c.status, 200, c.raw);
    const crewId = c.body.crew.id as string;
    const j = await app.call("POST", `/api/airport/sessions/${a}/crew/${crewId}/join`, ua);
    assert.equal(j.status, 200, j.raw);
    const insert = (session: string, precision: "area" | "exact") => db.exec(
      `INSERT INTO public.layover_crew_location_grants (crew_id, user_id, session_id, purpose, precision, label, lat, lng, granted_at, expires_at)
         VALUES ('${crewId}', '${ua.id}', '${session}', '${precision === "exact" ? "live_session_sharing" : "presence_in_context"}', '${precision}', 'Gate B4',
                 ${precision === "exact" ? "1.3644, 103.9915" : "NULL, NULL"}, now(), now() + interval '1 hour')`);
    const byGuard = (why: RegExp) => (e: any) => e?.code === "23514" && /^3996: /.test(String(e?.message ?? "")) && why.test(String(e?.message ?? ""));
    // control: every FK and CHECK is satisfied, and a live member on their own session may share
    await insert(a, "area");
    await db.exec(`DELETE FROM public.layover_crew_location_grants WHERE crew_id = '${crewId}' AND user_id = '${ua.id}'`);
    await assert.rejects(insert(aOther, "area"), byGuard(/session the member joined with/), "another of the member's own sessions (a valid session FK) must be refused");
    await assert.rejects(insert(a, "exact"), byGuard(/precise-sharing control/), "exact with no control row must be refused");
    const l = await app.call("POST", `/api/airport/sessions/${a}/crew/leave`, ua);
    assert.equal(l.status, 200, l.raw);
    assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_crew_members WHERE crew_id = '${crewId}' AND user_id = '${ua.id}' AND left_at IS NOT NULL`)).length, 1, "the left membership row still exists, so the FK alone would admit the insert");
    await assert.rejects(insert(a, "area"), byGuard(/LIVE crew membership/), "a member who left must be refused");
  });

  it("L196 (held W) — the restrictive tables hold, and with presence intents OFF the writer refuses and writes nothing", async () => {
    const sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
    const sh = await app.call("PATCH", `/api/airport/sessions/${sid}/share`, ana, { enabled: true });
    assert.equal(sh.status, 200, sh.raw);
    const p = await app.call("PUT", `/api/airport/sessions/${sid}/presence/intents`, ana, { intents: ["food"], availableUntil: new Date(Date.now() + 3_600_000).toISOString(), maxTravelMinutes: 30 });
    assert.notEqual(p.status, 200, `the intents writer is closed while layover_presence_intents_enabled is OFF: ${p.raw}`);
    assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_presence WHERE session_id = '${sid}'`)).length, 0);
    for (const table of ["layover_presence", "layover_crew_location_grants", "layover_crew_location_controls", "layover_crews", "layover_crew_members"]) {
      await assert.rejects(db.asUser(ana.id, `SELECT * FROM public.${table}`), (e: any) => e?.code === "42501", `${table}: a client role read it`);
    }
  });
});

import { keepConstraintsUndeclared } from "./pressedLayoverApp.js"; // census-layover §83: this suite owns its constraint declarations under PRESSED_BASE
