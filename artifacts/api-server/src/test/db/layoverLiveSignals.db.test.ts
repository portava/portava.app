/**
 * LAYOVER 165, lane B2-LIVE — the live-signal producer END TO END, on the REAL
 * migrated schema, through the REAL routes a traveller's app calls.
 *
 * Rows: L54, L55, L81, L180, L227, L228, L281, L285, L286, L287.
 *
 * The database is the whole chain (pressedLayoverDb.ts — PGlite replaying every
 * migration, or CI's local-db), so `airport_fact_observations` (2860 + 2982),
 * the crowd channel's flag (3513), `trust_profiles`, the Routes spend function
 * (3856/3971) and 3885's flag are the real ones, and every request goes through
 * routes/airport.ts and the real supabase-js client. Nothing is a double except
 * the two external edges: Google Routes answers from contract fixtures
 * (globalThis.fetch is replaced BEFORE the provider module loads — the
 * singleton captures fetch at construction), and no licensed feed exists (the
 * feed adapter's named absence, which is production's state).
 *
 * THE PRESS: apply 3885 and turn `layover_live_signals_enabled` ON. The crowd
 * channel (3513, B1-P's press) is switched on as BASE state, because travellers
 * cannot report without it.
 *   B1P_ARM=pressed  — every case green;
 *   B1P_ARM=flag-off — the PRESSED cases go red (no live term reaches a session);
 *   B1P_ARM=absent   — the chain WITHOUT 3885 (production today): the PRESSED
 *                      cases go red. The ALWAYS cases stay green in every arm.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<node_modules/@electric-sql with pglite + pglite-postgis> \
 *   node --import tsx/esm --test src/test/db/layoverLiveSignals.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { HAVE_PRESSED_DB, PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

// ── Google Routes: the production provider, answered from contract fixtures ──
process.env.LAYOVER_ROUTED_CORRIDOR_ENABLED = "true";
process.env.GOOGLE_MAPS_API_KEY = "test-placeholder-not-a-key";
process.env.ROUTES_API_DAILY_QUOTA = "500";
process.env.ROUTES_API_DAILY_BUDGET_USD = "10";
process.env.ROUTES_API_COST_PER_CALL_USD = "0.01";
const trafficFixture = (n: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/layoverLiveTraffic/${n}`, import.meta.url), "utf8"));
const spikeAt = new Set<string>();
const key = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;
const googleCalls: Array<{ toAirport: boolean; place: string }> = [];
let airportKey = "";
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (String(url) !== "https://routes.googleapis.com/directions/v2:computeRoutes") throw new Error(`no network in this test: ${String(url)}`);
  const body = JSON.parse(String(init.body));
  const o = body.origin.location.latLng, d = body.destination.location.latLng;
  const toAirport = key(d.latitude, d.longitude) === airportKey;
  const place = toAirport ? key(o.latitude, o.longitude) : key(d.latitude, d.longitude);
  googleCalls.push({ toAirport, place });
  const json = toAirport && spikeAt.has(place) ? trafficFixture("drive-return-spike.json") : trafficFixture("drive-return-normal.json");
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}) as unknown as typeof fetch;

const PRESS = { migrations: ["3885"], flags: { layover_live_signals_enabled: true } } as const;
const FLAG = "layover_live_signals_enabled";
const MIN = 60_000;
const token = () => `b2l-${randomUUID()}`;

let db: PressedDb;
let app: PressedApp;
let seededFlag: boolean | "absent" = "absent";
const users: Record<string, PressedUser> = {};
const sessions: Record<string, string> = {};

async function traveller(label: string, iata: string): Promise<void> {
  users[label] = await db.seedUser(label);
  sessions[label] = (await startSession(app, users[label]!, { iata })).id;
}
const report = (who: string, factType: string, value: number) =>
  app.call("POST", `/api/airport/sessions/${sessions[who]}/observations`, users[who]!, { factType, value, submissionToken: token() });
const safety = async (who: string) => {
  const r = await app.call("GET", `/api/airport/sessions/${sessions[who]}/safety`, users[who]!);
  assert.equal(r.status, 200, r.raw);
  return r.body;
};
const overview = async (who: string) => {
  const r = await app.call("GET", `/api/airport/sessions/${sessions[who]}/overview`, users[who]!);
  assert.equal(r.status, 200, r.raw);
  return r.body;
};
const hard = (b: any) => Date.parse(b.hardReturnTime);
/** An authoritative reading in the store, the way an ingested official feed row lands in 2860. */
async function officialRow(ref: string, value: number, ageMin: number, fact = "security_wait_minutes") {
  const at = Date.now() - ageMin * MIN;
  await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, source_ref, observed_at, expires_at)
    VALUES ('${ref}', '${fact}', 'FAST_LIVE', ${value}, 'official', 'feed:${ref.toLowerCase()}-official', 'feed:${ref.toLowerCase()}-official/${value}@${ageMin}', '${new Date(at).toISOString()}', '${new Date(at + 20 * MIN).toISOString()}')`);
}

describe("B2-LIVE — live airport intelligence on the real chain, through the real routes", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    seededFlag = await db.flag(FLAG);
    await productionBaseFlags(db);
    await db.setFlags({ layover_crowd_reports_enabled: true, layover_routed_corridor_enabled: true }); // BASE: the crowd channel (3513) and the routed corridor's kill-switch — not this press
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    for (const [who, iata] of [["ana", "SIN"], ["ben", "SIN"], ["cai", "SIN"], ["dee", "BKK"], ["eve", "BKK"], ["fay", "BKK"], ["gus", "BKK"],
      ["hal", "HKG"], ["ian", "HKG"], ["jo", "HKG"], ["kim", "HKG"], ["lee", "HKG"], ["mo", "NRT"], ["ned", "ICN"], ["ola", "ICN"], ["pat", "ICN"],
      ["quin", "TPE"], ["rae", "DXB"]] as const) await traveller(who, iata);
  });
  after(async () => { await app?.close(); await db?.close(); });

  it(`L0 [ALWAYS, arm=${PRESS_ARM}] the press is 3885: the chain seeds ${FLAG} FALSE (absent without 3885)`, () => {
    assert.equal(seededFlag, PRESS_ARM === "absent" ? "absent" : false);
  });

  it("E1 [PRESSED] L81 L281 L54 — two travellers' long queue reports move a THIRD traveller's certified deadline, with SECURITY_WAIT_HIGH and a real p50/p90", async () => {
    const before0 = await safety("cai");
    assert.equal(before0.estimates.liveExtra.sourceClass, "STATIC_DEFAULT", "live before anyone reported");
    assert.equal((await report("ana", "queue_report_minutes", 60)).status, 200);
    assert.equal((await report("ben", "queue_report_minutes", 50)).status, 200);
    const after1 = await safety("cai");
    assert.ok(after1.advice.reasonCodes.includes("SECURITY_WAIT_HIGH"), JSON.stringify(after1.advice.reasonCodes));
    assert.equal(hard(before0) - hard(after1), 40 * MIN, "p90 of [50, 60] (thin: the max) − the 20-minute baseline");
    const le = after1.estimates.liveExtra;
    assert.equal(le.sourceClass, "LIVE");
    assert.deepEqual([le.p50Minutes, le.p75Minutes, le.p90Minutes], [35, 37.5, 40], "L54: not one number written three times");
    assert.equal(le.confidence, "LOW", "traveller evidence is never above LOW");
    assert.ok(le.sourceRefs.some((r: string) => r === "portava:layover/traveller-report"), "provenance names the channel");
    assert.equal(after1.breakdown.liveExtra, 40);
    // the dashboard reads the SAME certified record
    const ov = await overview("cai");
    assert.deepEqual(ov.advice.reasonCodes, after1.advice.reasonCodes);
    assert.deepEqual(ov.estimates.liveExtra, le);
  });

  it("E2 [PRESSED] L180 — a reporter the trust engine scored low is stored with that standing and does not count; a trusted second reporter does", async () => {
    await db.exec(`INSERT INTO public.trust_profiles (user_id, overall_score) VALUES ('${users["dee"]!.id}', 10) ON CONFLICT (user_id) DO UPDATE SET overall_score = 10`);
    const before0 = await safety("fay");
    assert.equal((await report("dee", "queue_report_minutes", 90)).status, 200);
    assert.equal((await report("eve", "queue_report_minutes", 90)).status, 200);
    const rows = await db.query<any>(`SELECT observer_trust FROM public.airport_fact_observations WHERE airport_ref = 'BKK' AND fact_type = 'queue_report_minutes' ORDER BY observed_at`);
    assert.deepEqual(rows.map((r) => (r.observer_trust === null ? null : Number(r.observer_trust))), [0.1, null], "the standing is stored coarse, NULL when unscored");
    // the published card (reconcile, unchanged) sees two observers …
    const card = await app.call("GET", `/api/airport/sessions/${sessions["fay"]}/observations`, users["fay"]!);
    assert.equal(card.body.facts.find((f: any) => f.factType === "queue_report_minutes").truth?.value, 90);
    // … the SAFETY path validates: the untrusted reading is out, one stranger is left, nothing moves
    const mid = await safety("fay");
    assert.equal(hard(mid), hard(before0), "an untrusted reporter corroborated a stranger");
    assert.ok(!mid.advice.reasonCodes.includes("SECURITY_WAIT_HIGH"));
    assert.equal((await report("gus", "queue_report_minutes", 85)).status, 200);
    const after1 = await safety("fay");
    assert.equal(hard(before0) - hard(after1), 70 * MIN, "two trusted reporters [85, 90]: p90 90 − 20");
  });

  it("E3 [ALWAYS + mutant] L180 — a MAD outlier among four travellers never reaches the buffer (the card still shows it)", async () => {
    const before0 = await safety("lee");
    for (const [who, v] of [["hal", 15], ["ian", 15], ["jo", 20], ["kim", 90]] as const) assert.equal((await report(who, "queue_report_minutes", v)).status, 200);
    const card = await app.call("GET", `/api/airport/sessions/${sessions["lee"]}/observations`, users["lee"]!);
    assert.equal(card.body.facts.find((f: any) => f.factType === "queue_report_minutes").truth?.value, 90, "the unvalidated card takes the max");
    const after1 = await safety("lee");
    assert.equal(hard(after1), hard(before0), "the outlier moved a deadline");
    assert.ok(!after1.advice.reasonCodes.includes("SECURITY_WAIT_HIGH"));
    // and the spec's store-reading getTruth answers from the VALIDATED window on the real schema
    const { getTruthFromStore } = await import("../../services/airport/LayoverAirportTruth.js");
    const t = await getTruthFromStore(db.client, "HKG", "queue_report_minutes", Date.now());
    assert.ok(t.ok);
    assert.equal(t.ok && t.truth?.value, 20, "getTruthFromStore did not reject the outlier");
    assert.ok(t.ok && t.outcome.validation.rejections.some((r: any) => r.reason === "outlier"));
  });

  it("E4 [PRESSED] L227 L285 — a security spike contracts the envelope MONOTONICALLY; held (DATA_STALE) past its TTL, never re-widened; released only past the hold", async () => {
    const base = await safety("mo");
    const steps: Array<{ v: number; hard: number; usable: number }> = [];
    for (const v of [10, 25, 40, 60, 90, 120]) {
      await db.exec(`DELETE FROM public.airport_fact_observations WHERE airport_ref = 'NRT'`);
      await officialRow("NRT", v, 1);
      const b = await safety("mo");
      steps.push({ v, hard: hard(b), usable: b.usableMinutes });
    }
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i]!.hard <= steps[i - 1]!.hard, `deadline moved LATER at ${steps[i]!.v}: ${JSON.stringify(steps)}`);
      assert.ok(steps[i]!.usable <= steps[i - 1]!.usable, `envelope WIDENED at ${steps[i]!.v}: ${JSON.stringify(steps)}`);
    }
    assert.equal(steps[0]!.hard, hard(base), "a 10-minute queue is inside the baseline: nothing moves");
    assert.equal(steps[0]!.hard - steps[steps.length - 1]!.hard, 100 * MIN, "120 − 20: the spike's whole excess");
    // the same spike, aged 25 min: past the FAST_LIVE 20-minute TTL, inside the 60-minute hold
    await db.exec(`DELETE FROM public.airport_fact_observations WHERE airport_ref = 'NRT'`);
    await officialRow("NRT", 120, 25);
    const held = await safety("mo");
    assert.equal(hard(held), steps[steps.length - 1]!.hard, "the spike re-widened as its evidence aged");
    assert.ok(held.advice.reasonCodes.includes("DATA_STALE"), JSON.stringify(held.advice.reasonCodes));
    assert.equal(held.estimates.liveExtra.fallbackLevel, 1);
    assert.equal(held.estimates.liveExtra.confidence, "LOW");
    // aged 100 min: expired 80 min ago, beyond the hold — no evidence, no live term
    await db.exec(`DELETE FROM public.airport_fact_observations WHERE airport_ref = 'NRT'`);
    await officialRow("NRT", 120, 100);
    const gone = await safety("mo");
    assert.equal(hard(gone), hard(base));
    assert.ok(!gone.advice.reasonCodes.includes("DATA_STALE"));
  });

  it("E5 [PRESSED] L286 — an official 15 and two travellers at 55/60 disagree: SOURCE_CONFLICT, the conservative value, confidence down", async () => {
    const before0 = await safety("pat");
    await officialRow("ICN", 15, 1);
    assert.equal((await report("ned", "queue_report_minutes", 60)).status, 200);
    assert.equal((await report("ola", "queue_report_minutes", 55)).status, 200);
    const b = await safety("pat");
    assert.ok(b.advice.reasonCodes.includes("SOURCE_CONFLICT"), JSON.stringify(b.advice.reasonCodes));
    assert.ok(b.advice.reasonCodes.includes("SECURITY_WAIT_HIGH"));
    assert.equal(hard(before0) - hard(b), 40 * MIN, "the conservative reading (60), not the official one");
    assert.equal(b.estimates.liveExtra.confidence, "MEDIUM", "the official reading's HIGH, one step down for the contradiction");
  });

  it("E6 [PRESSED] L228 L287 — a traffic spike on the return from a planned landside stop moves the deadline earlier, with TRAFFIC_DEGRADED", async () => {
    const before0 = await safety("rae");
    assert.ok(!before0.advice.reasonCodes.includes("TRAFFIC_DEGRADED"));
    const ap = (await db.query<any>(`SELECT p.lat, p.lng FROM public.layover_sessions s JOIN public.airport_profiles p ON p.id = s.airport_id WHERE s.id = '${sessions["rae"]}'`))[0];
    assert.ok(ap && Number(ap.lat) !== 0, "DXB has no coordinate on the chain");
    airportKey = key(Number(ap.lat), Number(ap.lng));
    const stop = { lat: Number(ap.lat) + 0.12, lng: Number(ap.lng) + 0.05 };
    spikeAt.add(key(stop.lat, stop.lng));
    const s = await app.call("POST", `/api/airport/sessions/${sessions["rae"]}/stops`, users["rae"]!, { title: "Old town", durationMin: 60, travelMin: 30, insideAirport: false, lat: stop.lat, lng: stop.lng });
    assert.ok(s.status === 200 || s.status === 201, s.raw);
    const b = await safety("rae");
    assert.ok(googleCalls.some((c) => c.toAirport && c.place === key(stop.lat, stop.lng)), `the return leg was never asked: ${JSON.stringify(googleCalls)}`);
    assert.ok(b.advice.reasonCodes.includes("TRAFFIC_DEGRADED"), JSON.stringify(b.advice.reasonCodes));
    const penalty = 100 - 1085 / 60; // the fixture: 6000 s traffic-aware vs 1085 s free-flow (the provider rounds each conveyance leg to whole minutes, so within one minute)
    const expected = penalty - (b.breakdown.trafficExtra + b.breakdown.returnTransportExtra);
    assert.ok(b.breakdown.liveExtra > 0 && Math.abs(b.breakdown.liveExtra - expected) <= 1, `live extra ${b.breakdown.liveExtra} vs ${expected}`);
    assert.equal(hard(before0) - hard(b), b.breakdown.liveExtra * MIN, "the deadline moved earlier by exactly the traffic excess");
    assert.equal(b.estimates.liveExtra.sourceClass, "LIVE");
    assert.ok(b.estimates.liveExtra.sourceRefs.some((r: string) => r.startsWith("traffic:")), "the route is the provenance");
  });

  it("E8 [PRESSED] the snapshot door carries the same live term: with layover_snapshot_consumers_enabled ON the surfaces read it and agree with the OFF arm", async () => {
    const prior = await db.flag("layover_snapshot_consumers_enabled");
    const off = await safety("cai");
    await db.setFlag("layover_snapshot_consumers_enabled", true);
    const on = await safety("cai");
    const ov = await overview("cai");
    await db.setFlag("layover_snapshot_consumers_enabled", prior);
    assert.ok(on.advice.reasonCodes.includes("SECURITY_WAIT_HIGH"), "the snapshot door lost the live term");
    assert.equal(on.hardReturnTime, off.hardReturnTime);
    assert.deepEqual(on.estimates.liveExtra, off.estimates.liveExtra);
    assert.deepEqual(ov.estimates.liveExtra, on.estimates.liveExtra);
    assert.equal(ov.airportIntelligence.tier, "LIVE");
  });

  it("E9 [PRESSED] Compass retains live return conditions when snapshot consumers are OFF", async () => {
    const prior = await db.flag("layover_snapshot_consumers_enabled");
    await db.setFlag("layover_snapshot_consumers_enabled", false);
    try {
      const current = await safety("cai");
      const answer = await app.call("POST", `/api/airport/sessions/${sessions["cai"]}/compass`, users["cai"]!, { question: "When should I return?" });
      assert.equal(answer.status, 200, answer.raw);
      assert.ok(current.breakdown.liveExtra > 0, "fixture must contain a real validated live penalty");
      assert.equal(answer.body.hardReturnTime, current.hardReturnTime, "Compass must not publish the later static deadline");
      assert.equal(answer.body.bufferMinutes, current.breakdown.totalBuffer);
    } finally { await db.setFlag("layover_snapshot_consumers_enabled", prior); }
  });

  it("E7 [ALWAYS] nothing live at the airport: the producer ON certifies byte-for-byte as OFF", async () => {
    const prior = await db.flag(FLAG);
    await db.setFlag(FLAG, true);
    const on = await safety("quin");
    await db.setFlag(FLAG, false);
    const off = await safety("quin");
    await db.setFlag(FLAG, prior);
    assert.deepEqual(on.estimates, off.estimates);
    assert.deepEqual(on.advice, off.advice);
    assert.equal(on.hardReturnTime, off.hardReturnTime);
    assert.equal(on.estimates.liveExtra.sourceClass, "STATIC_DEFAULT");
  });
});
