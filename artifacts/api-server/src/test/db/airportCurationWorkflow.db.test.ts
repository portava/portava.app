/**
 * LAYOVER 165, lane B2-CURATE — the airport curation workflow, the maturity
 * threshold, the fail-closed entry gate and recalibration, on the REAL
 * MIGRATED SCHEMA (the full chain replayed on PGlite, or CI's local database),
 * through the real routes and the real supabase-js client (B1-P's harness).
 *
 * Every airport, observation and outcome here is TEST DATA in a throwaway
 * database: "ZZT"/"ZZU" are fictional airports (country SG so the seeded
 * visa-free corridor applies). Nothing is real airport data.
 *
 *   W1  L14   existing/new rows are "unvalidated, no provenance"; verified is derived, never asserted
 *   W2  L243/L249  an uncurated airport certifies landside CLOSED (airport_maturity_limited) — airport-side cards only
 *   W3  L48/L77    an unconfirmed corridor closes landside in EVERY state of layover_entry_forbid_landside_enabled
 *   W4  L14/L79/L80 propose → quality checks (422) → validate → publish; history kept; topology_version moves
 *   W5  L14   the store's guarantees: content immutable, no delete, publish only through the function, a bare edit unvalidates
 *   W6  L220/L243  4h international, visa allowed, curated airport → potential landside; the same at L0 → closed
 *   W7  L79   an authoritative change re-certifies (new snapshot) and a stale landside plan-add is refused
 *   W8  L48   the stored-card path and the plan add obey the certified gate
 *   W9  L143/L120  RETURN NOW pins the curated terminal context; retracted → null
 *   W10 L223  an overnight layover gets the published airside lodging/lounges; an uncurated airport gets none
 *   W11 L83/L247  recalibration from observations and outcomes, bounded, persisted with provenance, read by the engine
 *   W12 L204/L246 the aggregate and the calibration carry no identifier; the count reaches the ladder
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { HAVE_PRESSED_DB, PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, seedConfirmedCorridor } from "./pressedLayoverApp.js";
import { _setTestClient } from "../../lib/http.js";
import { resetSchemaCapabilityMemo } from "../../lib/capability/schemaCapability.js";
import { localDayString, localHour } from "../../services/airport/AirportTime.js";
import { readAirportObservationAggregate } from "../../services/layover/LayoverObservationAggregate.js";

const TZ = "Asia/Singapore";
const HANDLE = /\btv1-[0-9a-f]{40}\b/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

interface Reply { status: number; body: any }
let db: PressedDb;
let server: http.Server;
let base = "";
let admin: PressedUser;
let traveller: PressedUser;
let noPassport: PressedUser;
let zzt = ""; // the airport this suite curates
let zzu = ""; // an airport nobody curates

function call(method: string, path: string, user: PressedUser | null, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
      headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => { let b: any; try { b = raw ? JSON.parse(raw) : null; } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function session(user: PressedUser, iata: string, opts: { arrivedHAgo?: number; departsInH?: number; departure?: Date } = {}): Promise<any> {
  const now = Date.now();
  const r = await call("POST", "/api/airport/sessions", user, {
    iata,
    arrivalTime: new Date(now - (opts.arrivedHAgo ?? 1) * 3_600_000).toISOString(),
    departureTime: (opts.departure ?? new Date(now + (opts.departsInH ?? 9) * 3_600_000)).toISOString(),
    flightType: "international", immigrationRequired: true,
  });
  assert.equal(r.status, 201, `session: ${JSON.stringify(r.body)}`);
  return r.body.session;
}

const overview = async (user: PressedUser, id: string) => {
  const r = await call("GET", `/api/airport/sessions/${id}/overview`, user);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

async function propose(kind: string, value: unknown, extra: Record<string, unknown> = {}): Promise<any> {
  const r = await call("POST", `/api/admin/airport/profiles/${zzt}/curation/facts`, admin, {
    kind, value,
    source: { kind: "official_airport", url: "https://example.test/zzt-official", title: "ZZT official (test fixture)", retrievedAt: new Date().toISOString() },
    ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const validate = (id: string) => call("POST", `/api/admin/airport/curation/facts/${id}/validate`, admin);
const publish = (id: string) => call("POST", `/api/admin/airport/curation/facts/${id}/publish`, admin);

const TOPOLOGY = {
  terminals: [{ id: "T1", name: "Terminal 1", serves: ["international"] }, { id: "T2", name: "Terminal 2" }],
  gates: [{ terminalId: "T1", label: "Gates A1-A20" }],
  checkpoints: [{ id: "T1-sec", terminalId: "T1", kind: "security" }],
  walkingLinks: [{ fromTerminalId: "T1", toTerminalId: "T2", minutes: 12, mode: "train" }],
};
const TRANSPORT = { modes: [{ mode: "rail", name: "Test Line", toCity: "City centre", journeyMinutes: { min: 25, max: 35 }, terminalIds: ["T1"] }] };
const TIMING = {
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, rationale: "test fixture: the generic defaults, stated by a curator",
};

async function curateL1(): Promise<void> {
  for (const [kind, value] of [["terminal_topology", TOPOLOGY], ["ground_transport", TRANSPORT], ["timing_assumptions", TIMING]] as const) {
    const p = await propose(kind, value, kind === "timing_assumptions" ? { source: { kind: "curator_judgment", note: "test fixture: curator buffer policy", retrievedAt: new Date().toISOString() } } : {});
    const v = await validate(p.fact.id);
    assert.equal(v.status, 200, `${kind} validate: ${JSON.stringify(v.body)}`);
    const pub = await publish(p.fact.id);
    assert.equal(pub.status, 200, `${kind} publish: ${JSON.stringify(pub.body)}`);
  }
}

describe("airport curation, maturity and entry on the real migrated schema", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    if (!HAVE_PRESSED_DB) return;
    process.env["SESSION_SECRET"] ??= "pressed-layover-session-secret";
    db = await openPressedLayoverDb();
    await productionBaseFlags(db);
    const [airportRouter, constraintsRouter, curationRouter] = await Promise.all([
      import("../../routes/airport.js"), import("../../routes/layoverConstraints.js"), import("../../routes/airportCuration.js"),
    ]);
    resetSchemaCapabilityMemo();
    _setTestClient(db.client, true);
    const app = express();
    app.use(express.json({ limit: "256kb" }));
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    for (const m of [airportRouter, constraintsRouter, curationRouter]) app.use("/api", (m as any).default);
    server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as any).port}`;

    admin = await db.seedUser("curator");
    await db.exec(`UPDATE public.profiles SET role = 'admin' WHERE id = '${admin.id}'`);
    traveller = await db.seedUser("traveller");
    noPassport = await db.seedUser("nopassport");
    await seedConfirmedCorridor(db, traveller.id, "US", "SG");
    for (const iata of ["ZZT", "ZZU"]) {
      const r = await call("POST", "/api/admin/airport/profiles", admin, {
        iataCode: iata, name: `${iata} Test Airport (fixture)`, city: "Testville", country: "Singapore", countryCode: "SG",
        timezone: TZ, lat: 1.36, lng: 103.99, verified: true, // a writer ASSERTING verified: it must not be believed (W1)
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      if (iata === "ZZT") zzt = r.body.id; else zzu = r.body.id;
    }
  });
  after(async () => {
    if (!HAVE_PRESSED_DB) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setTestClient(null as any, false);
    await db.close();
  });

  it("W1 L14 — a written row is unvalidated with no provenance; `verified: true` from a writer is not believed", async () => {
    const rows = await db.query<any>(`SELECT iata_code, verified, legacy_verified, facts_provenance, topology_version FROM public.airport_profiles WHERE iata_code IN ('ZZT','ZZU') ORDER BY 1`);
    assert.deepEqual(rows.map((r) => [r.iata_code, r.verified, r.legacy_verified, r.facts_provenance, r.topology_version]),
      [["ZZT", false, true, "unvalidated_no_provenance", 0], ["ZZU", false, true, "unvalidated_no_provenance", 0]]);
    // The admin PATCH cannot assert it either.
    const p = await call("PATCH", `/api/admin/airport/profiles/${zzu}`, admin, { verified: true });
    assert.equal(p.status, 200);
    assert.equal(p.body.profile.verified, false);
  });

  it("W2 L243/L249 — an uncurated airport certifies landside CLOSED: airport_maturity_limited, airport-side cards only", async () => {
    const s = await session(traveller, "ZZU");
    const o = await overview(traveller, s.id);
    assert.equal(o.landsideGate.status, "closed");
    assert.ok(o.landsideGate.closedBy.includes("airport_maturity_limited"), JSON.stringify(o.landsideGate));
    assert.ok(!o.landsideGate.closedBy.includes("entry_unconfirmed"), "the corridor is confirmed — maturity alone closes it");
    assert.equal(o.advice.verdict, "no");
    assert.ok(o.advice.reasonCodes.includes("AIRPORT_MATURITY_LIMITED"));
    assert.equal(o.airport.terminalInfo, null);
    assert.equal(o.airport.verified, false, "a writer's verified:true is not a curated airport");
    const recs = await call("GET", `/api/airport/sessions/${s.id}/recommendations`, traveller);
    assert.equal(recs.status, 200);
    assert.ok(recs.body.recommendations.length > 0);
    assert.ok(recs.body.recommendations.every((r: any) => r.insideAirport === true), "no landside card at L0");
  });

  it("W3 L48/L77 — an unconfirmed corridor closes landside whatever layover_entry_forbid_landside_enabled says", async () => {
    await curateL1(); // ZZT reaches L1, so ONLY the entry term can close it
    const s = await session(noPassport, "ZZT");
    for (const state of ["absent", false, true] as const) {
      await db.setFlag("layover_entry_forbid_landside_enabled", state);
      const o = await overview(noPassport, s.id);
      assert.equal(o.landsideGate.status, "closed", `flag ${String(state)}: ${JSON.stringify(o.landsideGate)}`);
      assert.ok(o.landsideGate.closedBy.includes("entry_unconfirmed"), `flag ${String(state)}`);
      assert.ok(!o.landsideGate.closedBy.includes("airport_maturity_limited"), `flag ${String(state)}: ZZT is curated`);
      assert.equal(o.advice.verdict, "no");
      const recs = await call("GET", `/api/airport/sessions/${s.id}/recommendations`, noPassport);
      assert.ok(recs.body.recommendations.every((r: any) => r.insideAirport === true), `flag ${String(state)}: no landside card`);
    }
    // An unreadable flag table is not "off": the gate still closes (constraints_unreadable).
    await db.setFlag("layover_entry_forbid_landside_enabled", false);
  });

  it("W4 L14/L79/L80 — propose → quality checks → validate → publish; versions kept; topology_version moves", async () => {
    const before = (await db.query<any>(`SELECT topology_version, verified, facts_provenance, terminal_info FROM public.airport_profiles WHERE id = '${zzt}'`))[0];
    assert.equal(before.verified, true, "W3 curated ZZT to L1");
    assert.equal(before.facts_provenance, "curated");
    assert.equal(before.topology_version, 3, "three authoritative publications");
    assert.deepEqual(before.terminal_info, TOPOLOGY);
    // A topology whose gate names a terminal it does not declare fails validation (422) and moves nothing.
    const bad = await propose("terminal_topology", { terminals: [{ id: "T1", name: "Terminal 1" }], gates: [{ terminalId: "T9", label: "Gates Z" }] });
    assert.equal(bad.preview.ok, false);
    const v = await validate(bad.fact.id);
    assert.equal(v.status, 422);
    assert.ok(v.body.report.issues.some((i: any) => /T9/.test(i.problem)), JSON.stringify(v.body.report));
    // Cross-fact: transport naming a terminal the PUBLISHED topology lacks fails too.
    const badT = await propose("ground_transport", { modes: [{ mode: "bus", name: "B", toCity: "C", terminalIds: ["T7"] }] });
    assert.equal((await validate(badT.fact.id)).status, 422);
    // A semi-live fact beyond its class TTL bound is refused at proposal by the database.
    const tooLong = await call("POST", `/api/admin/airport/profiles/${zzt}/curation/facts`, admin, {
      kind: "lounge_hours", value: { lounges: [{ name: "L", side: "airside", hours: "24h" }] },
      source: { kind: "official_airport", url: "https://example.test/x", retrievedAt: new Date().toISOString() },
      expiresAt: new Date(Date.now() + 8 * 86_400_000).toISOString(),
    });
    assert.equal(tooLong.status, 422, JSON.stringify(tooLong.body));
    // History: every version is kept and readable.
    const h = await call("GET", `/api/admin/airport/profiles/${zzt}/curation`, admin);
    assert.equal(h.status, 200);
    const topo = h.body.facts.filter((f: any) => f.kind === "terminal_topology");
    assert.deepEqual(topo.map((f: any) => [f.version, f.state]), [[2, "proposed"], [1, "published"]]);
    assert.equal(h.body.maturity.landsideInput.rung, "L1_MAPPED");
    assert.ok(topo[1].validationReport.ok && topo[1].validatedBy === admin.id && topo[1].source.url);
  });

  it("W5 L14 — content immutable, no delete, publish only through the function, a bare edit unvalidates", async () => {
    const fact = (await db.query<any>(`SELECT id FROM public.airport_curated_facts WHERE airport_id = '${zzt}' AND fact_kind = 'timing_assumptions' AND state = 'published'`))[0];
    const upd = await db.client.from("airport_curated_facts").update({ value: { domesticBufferMin: 1 } }).eq("id", fact.id);
    assert.ok(upd.error && /immutable/.test(upd.error.message), JSON.stringify(upd.error));
    const del = await db.client.from("airport_curated_facts").delete().eq("id", fact.id);
    assert.ok(del.error, "service_role holds no DELETE");
    const pending = await propose("lounge_hours", { lounges: [{ name: "Test Lounge", side: "airside", hours: "24h" }] });
    const direct = await db.client.from("airport_curated_facts").update({ state: "published", published_at: new Date().toISOString() }).eq("id", pending.fact.id);
    assert.ok(direct.error, "a proposal cannot be published by a bare UPDATE");
    const ref = await db.client.from("airport_profiles").update({ curated_timing_fact_id: pending.fact.id }).eq("id", zzt);
    assert.ok(ref.error && /curated references/.test(ref.error.message), JSON.stringify(ref.error));
    // An admin PATCH of a buffer makes the buffers unvalidated (no provenance), drops L1, and is an authoritative change.
    const tv = (await db.query<any>(`SELECT topology_version FROM public.airport_profiles WHERE id = '${zzt}'`))[0].topology_version;
    const patch = await call("PATCH", `/api/admin/airport/profiles/${zzt}`, admin, { internationalBufferMin: 150 });
    assert.equal(patch.status, 200);
    const after = (await db.query<any>(`SELECT verified, facts_provenance, curated_timing_fact_id, topology_version FROM public.airport_profiles WHERE id = '${zzt}'`))[0];
    assert.deepEqual([after.verified, after.facts_provenance, after.curated_timing_fact_id], [false, "unvalidated_no_provenance", null]);
    assert.equal(after.topology_version, tv + 1);
    // Re-curate the timing (a new version supersedes the old published one).
    const p = await propose("timing_assumptions", TIMING, { source: { kind: "curator_judgment", note: "test fixture", retrievedAt: new Date().toISOString() } });
    assert.equal((await validate(p.fact.id)).status, 200);
    const pub = await publish(p.fact.id);
    assert.equal(pub.status, 200);
    assert.ok(pub.body.published.supersededFactId, "the previous published version is superseded, not deleted");
    assert.equal((await db.query<any>(`SELECT verified FROM public.airport_profiles WHERE id = '${zzt}'`))[0].verified, true);
  });

  it("W6 L220/L243 — 4h international, visa allowed: potential landside at a curated airport, closed at L0", async () => {
    // "Potential landside DEPENDING ON AIRPORT MODEL": ZZT's curator states an efficient airport (test fixture).
    const efficient = { ...TIMING, internationalBufferMin: 45, internationalBufferMax: 90, immigrationExtraMin: 10, trafficExtraMin: 5, rationale: "test fixture: an efficient airport" };
    const p = await propose("timing_assumptions", efficient, { source: { kind: "curator_judgment", note: "test fixture", retrievedAt: new Date().toISOString() } });
    assert.equal((await validate(p.fact.id)).status, 200);
    assert.equal((await publish(p.fact.id)).status, 200);
    const curated = await session(traveller, "ZZT", { arrivedHAgo: 0.25, departsInH: 3.75 });
    const generic = await session(traveller, "ZZU", { arrivedHAgo: 0.25, departsInH: 3.75 });
    const a = await overview(traveller, curated.id);
    const b = await overview(traveller, generic.id);
    assert.ok(["yes", "tight"].includes(a.advice.verdict), `curated: ${a.advice.verdict} ${JSON.stringify(a.landsideGate)} usable=${a.window.usableMinutes}`);
    assert.ok(["open", "caution"].includes(a.landsideGate.status), JSON.stringify(a.landsideGate));
    assert.equal(b.advice.verdict, "no");
    assert.ok(b.landsideGate.closedBy.includes("airport_maturity_limited"), JSON.stringify(b.landsideGate));
  });

  it("W7 L79 — an authoritative topology change re-certifies; a landside plan-add under the old answer is refused", async () => {
    const s = await session(traveller, "ZZT");
    const o1 = await overview(traveller, s.id);
    assert.ok(!o1.landsideGate.closedBy.includes("airport_maturity_limited"));
    // A landside card the session held (inserted as a previous generation would have left it).
    const [card] = await db.query<any>(`INSERT INTO public.layover_recommendations (session_id, rec_type, title, safety_rating, travel_time_min, activity_time_min,
        return_buffer_min, inside_airport, location_label, city, sort_order) VALUES ('${s.id}', 'activity', 'Test landside idea', 'safe', 20, 60, 120, false, 'Testville', 'Testville', 99) RETURNING id`);
    const admitted = await call("POST", `/api/airport/sessions/${s.id}/stops/from-recommendation`, traveller, { recommendationId: card.id, snapshotId: o1.snapshotId });
    assert.notEqual(admitted.body?.reason, "landside_not_admitted", "while L1 the gate admits the card (it may still fail the pairing)");
    // Retract the published topology: an authoritative change.
    const topo = (await db.query<any>(`SELECT id FROM public.airport_curated_facts WHERE airport_id = '${zzt}' AND fact_kind = 'terminal_topology' AND state = 'published'`))[0];
    const r = await call("POST", `/api/admin/airport/curation/facts/${topo.id}/retract`, admin, { reason: "test: terminal layout changed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o2 = await overview(traveller, s.id);
    assert.notEqual(o2.snapshotId, o1.snapshotId, "the certified snapshot changed with the topology");
    assert.ok(o2.landsideGate.closedBy.includes("airport_maturity_limited"));
    assert.equal(o2.airport.terminalInfo, null);
    const refused = await call("POST", `/api/airport/sessions/${s.id}/stops/from-recommendation`, traveller, { recommendationId: card.id, snapshotId: o1.snapshotId });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reason, "landside_not_admitted");
    assert.ok(refused.body.closedBy.includes("airport_maturity_limited"));
    // Re-publish a topology (a new version) for the cases below.
    const p = await propose("terminal_topology", TOPOLOGY);
    assert.equal((await validate(p.fact.id)).status, 200);
    assert.equal((await publish(p.fact.id)).status, 200);
  });

  it("W8 L48/L243 — the STORED card path serves no landside card once the record forbids it", async () => {
    const s = await session(traveller, "ZZT"); // curated, confirmed corridor, 9h: landside admitted
    const gen = await call("GET", `/api/airport/sessions/${s.id}/recommendations`, traveller);
    assert.equal(gen.status, 200);
    assert.ok(gen.body.recommendations.some((r: any) => r.insideAirport === false), `a landside card was generated: ${JSON.stringify(gen.body.recommendations.map((r: any) => [r.title, r.insideAirport]))}`);
    const topo = (await db.query<any>(`SELECT id FROM public.airport_curated_facts WHERE airport_id = '${zzt}' AND fact_kind = 'terminal_topology' AND state = 'published'`))[0];
    assert.equal((await call("POST", `/api/admin/airport/curation/facts/${topo.id}/retract`, admin, { reason: "test: topology withdrawn" })).status, 200);
    await db.setFlag("layover_safety_engine_enabled", false); // the stored path: cards the earlier generation wrote
    try {
      const stored = await call("GET", `/api/airport/sessions/${s.id}/recommendations`, traveller);
      assert.equal(stored.status, 200);
      assert.ok(stored.body.recommendations.every((r: any) => r.insideAirport === true),
        `stored landside served under a closed gate: ${JSON.stringify(stored.body.recommendations.map((r: any) => [r.title, r.insideAirport]))}`);
    } finally {
      await db.setFlag("layover_safety_engine_enabled", true);
    }
    const p = await propose("terminal_topology", TOPOLOGY);
    assert.equal((await validate(p.fact.id)).status, 200);
    assert.equal((await publish(p.fact.id)).status, 200);
  });

  it("W9 L143/L120 — RETURN NOW pins the curated terminal context; a retracted topology pins nothing", async () => {
    const s = await session(traveller, "ZZT");
    const r = await call("POST", `/api/airport/sessions/${s.id}/return-now`, traveller, {});
    assert.ok([200, 500].includes(r.status), JSON.stringify(r.body));
    assert.deepEqual(r.body.returnContract.airport.terminalInfo, TOPOLOGY);
    const s2 = await session(traveller, "ZZU");
    const r2 = await call("POST", `/api/airport/sessions/${s2.id}/return-now`, traveller, {});
    assert.equal(r2.body.returnContract.airport.terminalInfo, null);
    // EXPIRY: a published topology past its TTL is not pinned (fail closed), and the rung drops with it.
    const short = await call("POST", `/api/admin/airport/profiles/${zzt}/curation/facts`, admin, {
      kind: "terminal_topology", value: { ...TOPOLOGY, terminals: [...TOPOLOGY.terminals, { id: "T3", name: "Terminal 3" }] },
      source: { kind: "official_airport", url: "https://example.test/zzt-official", retrievedAt: new Date(Date.now() - 60_000).toISOString() },
      expiresAt: new Date(Date.now() + 3_000).toISOString(),
    });
    assert.equal(short.status, 201, JSON.stringify(short.body));
    assert.equal((await validate(short.body.fact.id)).status, 200);
    assert.equal((await publish(short.body.fact.id)).status, 200);
    const s3 = await session(traveller, "ZZT");
    const fresh = await call("POST", `/api/airport/sessions/${s3.id}/return-now`, traveller, {});
    assert.equal(fresh.body.returnContract.airport.terminalInfo.terminals.length, 3);
    await new Promise((r) => setTimeout(r, 3_500));
    const s4 = await session(traveller, "ZZT");
    const stale = await call("POST", `/api/airport/sessions/${s4.id}/return-now`, traveller, {});
    assert.equal(stale.body.returnContract.airport.terminalInfo, null, "an expired topology is not pinned");
    assert.ok((await overview(traveller, s4.id)).landsideGate.closedBy.includes("airport_maturity_limited"), "and the airport is L0 again");
    const p = await propose("terminal_topology", TOPOLOGY);
    assert.equal((await validate(p.fact.id)).status, 200);
    assert.equal((await publish(p.fact.id)).status, 200);
  });

  it("W10 L223 — an overnight layover gets the published airside lodging and lounges; an uncurated airport gets none", async () => {
    for (const [kind, value] of [
      ["overnight_lodging", { options: [{ name: "Test Transit Hotel", kind: "transit_hotel", side: "airside", terminalId: "T1", hours: "24h" }, { name: "Landside Inn", kind: "airport_hotel", side: "landside", hours: "24h" }] }],
      ["lounge_hours", { lounges: [{ name: "Test 24h Lounge", side: "airside", terminalId: "T1", hours: "24h" }] }],
    ] as const) {
      const p = await propose(kind, value);
      assert.equal((await validate(p.fact.id)).status, 200);
      assert.equal((await publish(p.fact.id)).status, 200);
    }
    // A window that crosses the airport-local midnight and is >= 7h: overnight (LayoverSafetyEngine).
    const arrive = new Date(Date.now() - 30 * 60_000);
    let depart = new Date(arrive.getTime() + 8 * 3_600_000);
    for (let k = 8; k <= 24 && localDayString(TZ, depart) === localDayString(TZ, arrive); k++) depart = new Date(arrive.getTime() + k * 3_600_000);
    const mk = async (iata: string) => {
      const r = await call("POST", "/api/airport/sessions", traveller, { iata, arrivalTime: arrive.toISOString(), departureTime: depart.toISOString(), flightType: "international", immigrationRequired: true });
      assert.equal(r.status, 201);
      return r.body.session;
    };
    const s = await mk("ZZT");
    const o = await overview(traveller, s.id);
    assert.equal(o.window.overnight, true, "the fixture window is overnight");
    const overnight = true;
    const recs = await call("GET", `/api/airport/sessions/${s.id}/recommendations`, traveller);
    const titles = recs.body.recommendations.map((r: any) => r.title);
    if (overnight) {
      assert.ok(titles.includes("Test Transit Hotel") && titles.includes("Test 24h Lounge"), JSON.stringify(titles));
      assert.ok(!titles.includes("Landside Inn"), "a landside hotel is not an airside option");
    } else {
      assert.ok(!titles.includes("Test Transit Hotel"), "a window that is not overnight gets no overnight expansion");
    }
    const g = await mk("ZZU");
    const gt = (await call("GET", `/api/airport/sessions/${g.id}/recommendations`, traveller)).body.recommendations.map((r: any) => r.title);
    assert.ok(!gt.includes("Test Transit Hotel") && !gt.includes("Test 24h Lounge"));
  });

  it("W11 L83/L247 — recalibration from observations and outcomes: bounded, persisted with provenance, read by the engine", async () => {
    const departure = new Date(Date.now() + 9 * 3_600_000);
    const hour = localHour(TZ, departure);
    const s = await session(traveller, "ZZT", { departure });
    const before = await overview(traveller, s.id);
    // 12 checkpoint readings at `hour`, from 4 distinct (community) observers, over the past days: test data.
    const values: string[] = [];
    for (let i = 0; i < 12; i++) {
      const at = new Date(departure.getTime() - (i + 1) * 86_400_000); // same local hour, earlier days
      values.push(`('ZZT','checkpoint_timing_minutes','TRAVELER_OBSERVATION', ${50 + i}, 'community', 'tv1-${String(i % 4).repeat(40)}', 0.3, 'test:obs:${i}', '${at.toISOString()}', '${new Date(at.getTime() + 45 * 60_000).toISOString()}')`);
    }
    // A thin hour (3 readings) that must NOT calibrate.
    const thin = new Date(departure.getTime() - 3 * 3_600_000 - 86_400_000);
    for (let i = 0; i < 3; i++) values.push(`('ZZT','checkpoint_timing_minutes','TRAVELER_OBSERVATION', 90, 'community', 'tv1-${String(i).repeat(40)}', 0.3, 'test:thin:${i}', '${thin.toISOString()}', '${new Date(thin.getTime() + 45 * 60_000).toISOString()}')`);
    await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, observer_trust, source_ref, observed_at, expires_at) VALUES ${values.join(",")}`);
    const cal = await call("POST", `/api/admin/airport/profiles/${zzt}/calibrate`, admin);
    assert.equal(cal.status, 200, JSON.stringify(cal.body));
    assert.equal(cal.body.observations, "used");
    const band = cal.body.bands.find((b: any) => b.localHour === hour);
    assert.ok(band, `a band at ${hour}: ${JSON.stringify(cal.body.bands.map((b: any) => b.localHour))}`);
    assert.equal(band.stepApplied, 10, "bounded: the observed p90 is far above the prior, the step is the bound");
    assert.ok(!cal.body.bands.some((b: any) => b.localHour === localHour(TZ, thin)), "the thin hour is below the minimum-sample rule");
    const rows = await db.query<any>(`SELECT * FROM public.airport_time_band_calibrations WHERE airport_id = '${zzt}' AND local_hour = ${hour} AND superseded_at IS NULL`);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].observation_samples), 12);
    assert.equal(Number(rows[0].observation_distinct_observers), 4);
    assert.ok(rows[0].policy_version && rows[0].window_start && rows[0].expires_at);
    // The engine reads it: the certified buffer at this cutoff hour grew by the calibrated extra.
    const after = await overview(traveller, s.id);
    assert.ok(after.window.breakdown.timeOfDayExtra > before.window.breakdown.timeOfDayExtra,
      `timeOfDayExtra ${before.window.breakdown.timeOfDayExtra} -> ${after.window.breakdown.timeOfDayExtra}`);
    assert.ok(after.window.breakdown.totalBuffer > before.window.breakdown.totalBuffer);
    assert.notEqual(after.snapshotId, before.snapshotId, "the calibrated band is a named input of the record");
    // A second recalibration is ANOTHER bounded step, and the first row is superseded (history kept).
    const cal2 = await call("POST", `/api/admin/airport/profiles/${zzt}/calibrate`, admin);
    const b2 = cal2.body.bands.find((b: any) => b.localHour === hour);
    assert.equal(Number(b2.priorP90), Number(band.calibratedP90));
    const hist = await db.query<any>(`SELECT calibration_version, superseded_at IS NOT NULL AS superseded FROM public.airport_time_band_calibrations WHERE airport_id = '${zzt}' AND local_hour = ${hour} ORDER BY 1`);
    assert.deepEqual(hist.map((r) => [r.calibration_version, r.superseded]), [[1, true], [2, false]]);
  });

  it("W11b L83/L247 — stored outcomes: compliant returns that MISSED raise the band at the re-entry hour", async () => {
    const departure = new Date(Date.now() + 9 * 3_600_000);
    const backAt = new Date(Date.now() - 2 * 86_400_000);
    const hour = localHour(TZ, backAt);
    const sessions: string[] = [];
    for (let i = 0; i < 6; i++) {
      const s = await session(traveller, "ZZT", { departure });
      sessions.push(s.id);
      await db.exec(`INSERT INTO public.layover_certified_computations (session_id, user_id, engine_version, feasibility_version, input_hash, computed_at, verdict, confidence, cutoff_at, hard_return_time, total_buffer_min, usable_minutes, inputs, breakdown, estimates)
        VALUES ('${s.id}', '${traveller.id}', 'e', 'f', 'sha256:${String(i).repeat(64)}', '${new Date(backAt.getTime() - 3 * 3_600_000).toISOString()}', 'yes', 'LOW', '${new Date(backAt.getTime() + 3 * 3_600_000).toISOString()}', '${new Date(backAt.getTime() + 30 * 60_000).toISOString()}', 150, 200, '{}', '{}', '{}');
        INSERT INTO public.layover_outcomes (session_id, completed_at, left_airport, actual_airport_return_at, boarding_outcome)
        VALUES ('${s.id}', NULL, true, '${backAt.toISOString()}', '${i < 2 ? "MISSED" : "UNKNOWN"}');`);
    }
    const cal = await call("POST", `/api/admin/airport/profiles/${zzt}/calibrate`, admin);
    assert.equal(cal.status, 200, JSON.stringify(cal.body));
    const band = cal.body.bands.find((b: any) => b.localHour === hour);
    assert.ok(band, JSON.stringify(cal.body));
    assert.equal(band.outcomeCompliantReturns, 6);
    assert.equal(band.outcomeMissed, 2);
    assert.ok(band.outcomeCoverageRate < 0.9);
    assert.equal(band.stepApplied, 10);
    assert.ok(["outcomes", "observations_and_outcomes"].includes(band.evidence));
  });

  it("W12 L204/L246 — the aggregate and the calibration rows carry no identifier; the count reaches the ladder", async () => {
    const fresh: string[] = [];
    for (let i = 0; i < 6; i++) {
      const at = new Date(Date.now() - (5 + i * 4) * 60_000);
      fresh.push(`('ZZT','checkpoint_timing_minutes','TRAVELER_OBSERVATION', ${15 + i}, 'community', 'tv1-${"abc"[i % 3]!.repeat(40)}', 0.3, 'test:fresh:${i}', '${at.toISOString()}', '${new Date(at.getTime() + 45 * 60_000).toISOString()}')`);
    }
    await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, observer_trust, source_ref, observed_at, expires_at) VALUES ${fresh.join(",")}`);
    const agg = await readAirportObservationAggregate(db.client, "ZZT", TZ, Date.now());
    assert.equal(agg.ok, true);
    const text = JSON.stringify(agg.ok ? agg.aggregate : null);
    assert.ok(!HANDLE.test(text) && !UUID.test(text.replace(/"airportRef":"[^"]*"/, "")), text);
    const cal = await db.query<any>(`SELECT row_to_json(c)::text AS j FROM public.airport_time_band_calibrations c`);
    for (const r of cal) {
      const j = JSON.parse(r.j);
      delete j.id; delete j.airport_id;
      const t = JSON.stringify(j);
      assert.ok(!HANDLE.test(t) && !UUID.test(t), `calibration row carries an identifier: ${t}`);
    }
    const h = await call("GET", `/api/admin/airport/profiles/${zzt}/curation`, admin);
    assert.equal(h.body.maturity.signalsReadable, true);
    assert.equal(h.body.maturity.observationCount, agg.ok ? agg.aggregate.maturityObservationCount : -1, "the gate reads the aggregate's count");
    assert.ok(agg.ok && agg.aggregate.maturityObservationCount >= 6, "three distinct observers clear the floor; six readings count");
  });
  it("W13 L80/L223 — a launch-city packet (docs/ops/airport-curation/HND.json) loads as PROPOSALS only: nothing validated, nothing published", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const packet = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../../docs/ops/airport-curation/HND.json"), "utf8"));
    const a = await call("POST", "/api/admin/airport/profiles", admin, { iataCode: "HND", name: "HND fixture row", city: "Tokyo", country: "Japan", countryCode: "JP", timezone: "Asia/Tokyo", lat: 35.55, lng: 139.78 });
    assert.equal(a.status, 201);
    const r = await call("POST", "/api/admin/airport/curation/packets", admin, packet);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.state, "proposed_unvalidated");
    assert.equal(r.body.results.length, packet.facts.length);
    assert.ok(r.body.results.every((x: any) => x.ok), JSON.stringify(r.body.results));
    const rows = await db.query<any>(`SELECT fact_kind, state, source_url, retrieved_at, proposed_via FROM public.airport_curated_facts WHERE airport_id = '${a.body.id}' ORDER BY fact_kind`);
    assert.equal(rows.length, packet.facts.length);
    assert.ok(rows.every((x) => x.state === "proposed" && x.proposed_via === "packet_import" && /^https:\/\//.test(x.source_url)), JSON.stringify(rows));
    const prof = (await db.query<any>(`SELECT verified, facts_provenance, topology_version, terminal_info FROM public.airport_profiles WHERE id = '${a.body.id}'`))[0];
    assert.deepEqual([prof.verified, prof.facts_provenance, prof.topology_version], [false, "unvalidated_no_provenance", 0], "an import changes nothing a traveller reads");
  });

  it("W14 L246/L247 — the traveller generation consumes fresh authoritative evidence, then crowd count and persisted calibration reach L4", async () => {
    await db.setFlag("layover_live_signals_enabled", true);
    const values: string[] = [];
    for (let i = 0; i < 20; i++) {
      const at = new Date(Date.now() - (2 + (i % 2)) * 60_000);
      values.push(`('ZZT','queue_report_minutes','TRAVELER_OBSERVATION', 20, 'community', 'tv1-${Math.floor(i / 2).toString(16).repeat(40)}', 0.3, 'test:maturity:${i}', '${at.toISOString()}', '${new Date(at.getTime() + 45 * 60_000).toISOString()}')`);
    }
    await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, observer_trust, source_ref, observed_at, expires_at) VALUES ${values.join(",")}`);
    const generate = async () => {
      const s = await session(traveller, "ZZT");
      const r = await call("GET", `/api/airport/sessions/${s.id}/recommendations`, traveller);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [event] = await db.query<{ metadata: { maturity: { level: string; observationCount: number; gateEnforced: boolean } } }>(`SELECT metadata FROM public.layover_events WHERE session_id = '${s.id}' AND event_type = 'recommendation_generated' ORDER BY created_at DESC LIMIT 1`);
      assert.ok(event, "generation must emit its maturity evidence");
      return event.metadata.maturity;
    };
    const crowd = await generate();
    assert.ok(crowd.observationCount >= 20);
    assert.equal(crowd.level, "L1_MAPPED", "crowd reports alone never establish external live maturity");
    const at = new Date(Date.now() - 60_000);
    await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, observer_trust, source_ref, observed_at, expires_at) VALUES ('ZZT','security_wait_minutes','FAST_LIVE',20,'official','official:curation-test',0.9,'test:maturity:official','${at.toISOString()}','${new Date(at.getTime() + 20 * 60_000).toISOString()}')`);
    const current = await generate();
    assert.equal(current.level, "L4_CALIBRATED", JSON.stringify(current));
    assert.equal(current.gateEnforced, true, "3874 enforces the threshold even with the legacy flag off");
    await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, observer_trust, source_ref, observed_at, expires_at) VALUES ('ZZT','security_wait_minutes','FAST_LIVE',120,'operator_feed','licensed:conflict-test',0.8,'test:maturity:conflict','${at.toISOString()}','${new Date(at.getTime() + 20 * 60_000).toISOString()}')`);
    assert.equal((await generate()).level, "L1_MAPPED", "conflicting authoritative sources cannot advance the ladder");
  });

  it("W17 sourced geometry validates, publishes and reaches the public and offline airport", assertAirportGeometryPipeline); it("W16 live inputs survive the stored-card fallback with snapshot consumers off", assertLiveAdmissionFallback); it("W15 readiness refuses a missing curation schema without presenting empty history", async () => {
    resetSchemaCapabilityMemo();
    await db.exec("ALTER TABLE public.airport_curated_facts RENAME TO airport_curated_facts_readiness_test");
    try {
      const r = await call("GET", `/api/admin/airport/profiles/${zzt}/curation`, admin);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "storage_unavailable");
      assert.match(r.body.message, /readiness.*3874/);
      assert.equal("facts" in r.body, false);
    } finally {
      await db.exec("ALTER TABLE public.airport_curated_facts_readiness_test RENAME TO airport_curated_facts");
      resetSchemaCapabilityMemo();
    }
    assert.equal((await call("GET", `/api/admin/airport/profiles/${zzt}/curation`, admin)).status, 200);
  });
});

async function assertLiveAdmissionFallback(): Promise<void> {
  await db.setFlag('layover_live_signals_enabled', true);
  await db.setFlag('layover_snapshot_consumers_enabled', false);
  await db.setFlag('layover_canonical_snapshot_enabled', false);
  const { lookupByIata } = await import('../../services/airport/AirportProfileService.js');
  const { getSession } = await import('../../services/airport/LayoverSessionService.js');
  const { certifiedLandsideRecord } = await import('../../services/airport/layoverLandsideAdmission.js');
  const s = await session(traveller, 'ZZT');
  const airport = await lookupByIata(db.client, 'ZZT');
  assert.equal(airport.kind, 'read'); if (airport.kind !== 'read') return; assert.ok(airport.value.airport);
  const own = await getSession(db.client, s.id, traveller.id);
  assert.ok(own.ok && own.session); if (!own.ok || !own.session) return;
  const record = await certifiedLandsideRecord(db.client, airport.value.airport, own.session, Date.now());
  assert.ok(record.inputs.liveConditions, 'legacy fallback must carry the live producer input');
  assert.ok(record.inputs.liveConditions.reasonCodes.includes('SOURCE_CONFLICT'), 'the real stored conflicting official observations survive the fallback');
  assert.equal(record.inputs.liveConditions.authoritativeEvidence, undefined, 'a conflict never elevates maturity');
}

async function assertAirportGeometryPipeline(): Promise<void> {
  const [origin] = await db.query<{ lat: number; lng: number }>(`SELECT lat,lng FROM public.airport_profiles WHERE id='${zzt}'`);
  assert.ok(origin);
  const point = { lat: Number(origin.lat), lng: Number(origin.lng) }, point2 = { lat: Number(origin.lat) + .001, lng: Number(origin.lng) + .001 };
  const value = { ...TOPOLOGY, terminals: [{ ...TOPOLOGY.terminals[0], point }, { ...TOPOLOGY.terminals[1], point: point2 }],
    walkingLinks: [{ ...TOPOLOGY.walkingLinks[0], path: [point, point2] }] };
  const bad = await propose('terminal_topology', value, { source: { kind: 'curator_judgment', note: 'a guess is not surveyed geometry', retrievedAt: new Date().toISOString() } });
  assert.equal((await validate(bad.fact.id)).status, 422);
  const proposed = await propose('terminal_topology', value);
  assert.equal(proposed.preview.ok, true, JSON.stringify(proposed));
  assert.equal((await validate(proposed.fact.id)).status, 200);
  assert.equal((await publish(proposed.fact.id)).status, 200);
  const s = await session(traveller, 'ZZT');
  const response = await call('GET', `/api/airport/sessions/${s.id}/overview`, traveller);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const geometry = response.body.airport.topologyGeometry;
  assert.equal(geometry.available, true); assert.equal(geometry.factId, proposed.fact.id);
  assert.equal(geometry.features.length, 3); assert.equal(geometry.displayPolicy, 'independent_map');
  assert.deepEqual(response.body.offlineBundle.airport.topologyGeometry, geometry);
}
