/**
 * LAYOVER 165, lane B2-CURATE — the curation policy (airportCurationPolicy.ts):
 * the quality checks a human curator's validation runs, the TTL policy per §10
 * class, and the projection the engine reads. Pure; no database.
 *
 *   P1  every kind: a complete, consistent, sourced value passes, and the report says WHICH checks ran
 *   P2  required fields per kind (timing_assumptions states every buffer, and why)
 *   P3  plausibility ranges (walking link 1..90, journey 1..240, buffers within the admin bounds)
 *   P4  internal consistency: ids unique, every gate/checkpoint/link names a declared terminal, ranges ordered
 *   P5  cross-fact consistency: transport/lounges/lodging may only name terminals the PUBLISHED topology declares
 *   P6  provenance: an official source needs its https URL; a curator source must say what it rests on
 *   P7  TTL: forward, within the class bound (static ≤ 180 d, semi-live ≤ 7 d), not stale at validation; defaults per class
 *   P8  an unknown field is refused (data nobody validated)
 *   P9  the projection: expired = not curated; an unmigrated row = not curated; calibrated bands are sanitised
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURATED_TTL_MS,
  calibratedExtraFromRow,
  curatedLive,
  curationProjectionFromRow,
  defaultExpiryMs,
  validateCuratedFact,
  type CuratedFactKind,
  type CuratedSource,
} from "../services/airport/airportCurationPolicy.js";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const SRC: CuratedSource = { kind: "official_airport", url: "https://example.test/airport", title: "t", note: null, retrievedAt: new Date(NOW - 3_600_000).toISOString() };
const EXP_STATIC = NOW + 20 * 86_400_000;
const EXP_SEMI = NOW + 24 * 3_600_000;
const TERMINALS = new Set(["T1", "T2"]);

const GOOD: Record<CuratedFactKind, unknown> = {
  terminal_topology: {
    terminals: [{ id: "T1", name: "Terminal 1", serves: ["international"] }, { id: "T2", name: "Terminal 2" }],
    gates: [{ terminalId: "T1", label: "A1-A20" }],
    checkpoints: [{ id: "S1", terminalId: "T1", kind: "security" }],
    walkingLinks: [{ fromTerminalId: "T1", toTerminalId: "T2", minutes: 10, mode: "train" }],
  },
  ground_transport: { modes: [{ mode: "rail", name: "Line", toCity: "Centre", journeyMinutes: { min: 20, max: 30 }, terminalIds: ["T1"] }] },
  timing_assumptions: {
    domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, rationale: "because",
  },
  entry_restrictions: { landsideExitForTransit: "requires_entry", transitSummary: "Leaving the airport means entering the country." },
  security_layout: { checkpoints: [{ id: "S1", terminalId: "T1", name: "Central", kind: "security", hours: "24h", fastTrack: true }] },
  lounge_hours: { lounges: [{ name: "Lounge", terminalId: "T2", side: "airside", hours: { open: "05:00", close: "23:00" } }] },
  transport_schedules: { services: [{ mode: "rail", name: "Line", firstDeparture: "05:30", lastDeparture: "23:45", frequencyMinutes: 10, journeyMinutes: 30 }] },
  overnight_lodging: { options: [{ name: "Transit Hotel", kind: "transit_hotel", side: "airside", terminalId: "T1", hours: "24h" }] },
};
const expFor = (k: CuratedFactKind) => (["security_layout", "lounge_hours", "transport_schedules", "overnight_lodging"].includes(k) ? EXP_SEMI : EXP_STATIC);
const check = (k: CuratedFactKind, v: unknown, over: { src?: Partial<CuratedSource>; exp?: number; terminals?: Set<string> | null } = {}) =>
  validateCuratedFact(k, v, { ...SRC, ...(over.src ?? {}) }, over.exp ?? expFor(k), NOW, { publishedTerminals: over.terminals === undefined ? TERMINALS : over.terminals });
const problems = (r: ReturnType<typeof check>) => r.issues.map((i) => `${i.path}: ${i.problem}`).join(" | ");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("airport curation quality checks", () => {
  it("P1 every kind: a complete, consistent, sourced value passes, and the report names the checks", () => {
    for (const k of Object.keys(GOOD) as CuratedFactKind[]) {
      const r = check(k, GOOD[k]);
      assert.equal(r.ok, true, `${k}: ${problems(r)}`);
      assert.ok(r.checks.length >= 3 && r.checks.includes("official_source_url") && r.checks.includes("ttl_class_bound"), `${k}: ${r.checks}`);
    }
  });

  it("P2 required fields: every timing buffer, a rationale, a terminal list, first/last departures", () => {
    const t = clone(GOOD.timing_assumptions) as any;
    delete t.trafficExtraMin;
    assert.match(problems(check("timing_assumptions", t)), /trafficExtraMin: is required/);
    const t2 = clone(GOOD.timing_assumptions) as any; delete t2.rationale;
    assert.match(problems(check("timing_assumptions", t2)), /rationale/);
    assert.match(problems(check("terminal_topology", { terminals: [] })), /value.terminals: must be a list of 1/);
    const s = clone(GOOD.transport_schedules) as any; delete s.services[0].lastDeparture;
    assert.match(problems(check("transport_schedules", s)), /lastDeparture: must be HH:MM/);
  });

  it("P3 plausibility ranges", () => {
    const topo = clone(GOOD.terminal_topology) as any; topo.walkingLinks[0].minutes = 91;
    assert.match(problems(check("terminal_topology", topo)), /minutes: must be a whole number of minutes, 1..90/);
    const g = clone(GOOD.ground_transport) as any; g.modes[0].journeyMinutes = { min: 0, max: 30 };
    assert.match(problems(check("ground_transport", g)), /1..240/);
    const t = clone(GOOD.timing_assumptions) as any; t.trafficExtraMin = 61;
    assert.match(problems(check("timing_assumptions", t)), /trafficExtraMin: must be whole minutes, 0..60/);
    const s = clone(GOOD.transport_schedules) as any; s.services[0].frequencyMinutes = 0;
    assert.match(problems(check("transport_schedules", s)), /frequencyMinutes/);
  });

  it("P4 internal consistency: unique ids, references resolve, ranges ordered, a link has two ends", () => {
    const dup = clone(GOOD.terminal_topology) as any; dup.terminals[1].id = "T1";
    assert.match(problems(check("terminal_topology", dup)), /is declared twice/);
    const badGate = clone(GOOD.terminal_topology) as any; badGate.gates[0].terminalId = "T9";
    assert.match(problems(check("terminal_topology", badGate)), /gates\[0\].terminalId: names terminal "T9"/);
    const badCp = clone(GOOD.terminal_topology) as any; badCp.checkpoints[0].terminalId = "TX";
    assert.match(problems(check("terminal_topology", badCp)), /checkpoints\[0\].terminalId/);
    const loop = clone(GOOD.terminal_topology) as any; loop.walkingLinks[0].toTerminalId = "T1";
    assert.match(problems(check("terminal_topology", loop)), /links a terminal to itself/);
    const inv = clone(GOOD.timing_assumptions) as any; inv.internationalBufferMin = 200; inv.internationalBufferMax = 180;
    assert.match(problems(check("timing_assumptions", inv)), /internationalBufferMin: is above internationalBufferMax/);
    const j = clone(GOOD.ground_transport) as any; j.modes[0].journeyMinutes = { min: 40, max: 30 };
    assert.match(problems(check("ground_transport", j)), /min is above max/);
    const h = clone(GOOD.lounge_hours) as any; h.lounges[0].hours = { open: "05:00", close: "05:00" };
    assert.match(problems(check("lounge_hours", h)), /opens and closes at the same minute/);
  });

  it("P5 cross-fact: a reference to a terminal the PUBLISHED topology lacks fails; with no topology published it fails too", () => {
    const g = clone(GOOD.ground_transport) as any; g.modes[0].terminalIds = ["T7"];
    assert.match(problems(check("ground_transport", g)), /published topology does not declare/);
    assert.match(problems(check("ground_transport", GOOD.ground_transport, { terminals: null })), /no topology is published/);
    assert.match(problems(check("overnight_lodging", GOOD.overnight_lodging, { terminals: new Set(["T2"]) })), /T1/);
    assert.match(problems(check("security_layout", GOOD.security_layout, { terminals: null })), /no topology is published/);
    // A fact that names no terminal needs none.
    const noRef = clone(GOOD.lounge_hours) as any; delete noRef.lounges[0].terminalId;
    assert.equal(check("lounge_hours", noRef, { terminals: null }).ok, true);
  });

  it("P6 provenance: an official source needs its https URL; a curator's own source must say what it rests on", () => {
    assert.match(problems(check("lounge_hours", GOOD.lounge_hours, { src: { url: null } })), /source.url/);
    assert.match(problems(check("lounge_hours", GOOD.lounge_hours, { src: { url: "http://insecure.test/x" } })), /source.url/);
    assert.match(problems(check("timing_assumptions", GOOD.timing_assumptions, { src: { kind: "curator_judgment", url: null, note: null } })), /source.note/);
    assert.equal(check("timing_assumptions", GOOD.timing_assumptions, { src: { kind: "curator_judgment", url: null, note: "measured on site" } }).ok, true);
    assert.match(problems(check("lounge_hours", GOOD.lounge_hours, { src: { retrievedAt: "yesterday" } })), /retrievedAt: must be an ISO-8601/);
    assert.match(problems(check("lounge_hours", GOOD.lounge_hours, { src: { retrievedAt: new Date(NOW + 3_600_000).toISOString() } })), /is in the future/);
  });

  it("P7 TTL: forward, within the class bound, not stale at validation; class defaults", () => {
    assert.match(problems(check("lounge_hours", GOOD.lounge_hours, { exp: NOW + 8 * 86_400_000 })), /beyond the OPERATIONAL_SEMI_LIVE maximum/);
    assert.equal(check("lounge_hours", GOOD.lounge_hours, { exp: Date.parse(SRC.retrievedAt) + 7 * 86_400_000 }).ok, true);
    assert.match(problems(check("terminal_topology", GOOD.terminal_topology, { exp: NOW + 181 * 86_400_000 })), /STATIC_TOPOLOGY maximum/);
    assert.match(problems(check("terminal_topology", GOOD.terminal_topology, { exp: NOW - 1 })), /has already passed/);
    assert.match(problems(check("terminal_topology", GOOD.terminal_topology, { exp: Date.parse(SRC.retrievedAt) - 1 })), /must be after retrievedAt/);
    assert.equal(defaultExpiryMs("lounge_hours", NOW) - NOW, CURATED_TTL_MS.OPERATIONAL_SEMI_LIVE.default);
    assert.equal(defaultExpiryMs("terminal_topology", NOW) - NOW, CURATED_TTL_MS.STATIC_TOPOLOGY.default);
    assert.ok(CURATED_TTL_MS.OPERATIONAL_SEMI_LIVE.max <= 7 * 86_400_000 && CURATED_TTL_MS.STATIC_TOPOLOGY.default >= 7 * 86_400_000,
      "§10: semi-live is hours/days, static is weeks/months");
  });

  it("P8 an unknown field is refused", () => {
    const v = clone(GOOD.lounge_hours) as any; v.lounges[0].rating = 5;
    assert.match(problems(check("lounge_hours", v)), /rating: is not a field of this kind/);
    assert.match(problems(check("entry_restrictions", { landsideExitForTransit: "maybe" })), /requires_entry or not_permitted/);
  });

  it("P9 the projection: expired is not curated; an unmigrated row is not curated; calibrated bands are sanitised", () => {
    const row = {
      curated_timing_fact_id: "f1", curated_timing_expires_at: new Date(NOW + 1000).toISOString(),
      curated_topology_fact_id: "f2", curated_topology_expires_at: new Date(NOW - 1000).toISOString(),
      curated_transport_fact_id: null, curated_transport_expires_at: null, topology_version: 4,
      calibration_version: 2, calibration_expires_at: new Date(NOW + 1000).toISOString(),
      calibrated_checkpoint_extra: { "8": 10, "9": -3, "25": 40, x: 5, "10": "abc", "11": 300 },
    };
    const p = curationProjectionFromRow(row);
    assert.equal(curatedLive(p.timing, NOW), true);
    assert.equal(curatedLive(p.topology, NOW), false, "a published fact past its expiry is not curated");
    assert.equal(p.transport, null);
    assert.equal(p.topologyVersion, 4);
    const unmigrated = curationProjectionFromRow({ verified: true, terminal_info: { terminals: [] } });
    assert.deepEqual([unmigrated.timing, unmigrated.topology, unmigrated.transport, unmigrated.topologyVersion], [null, null, null, 0]);
    const bands = calibratedExtraFromRow(row, NOW)!;
    assert.equal(bands.length, 24);
    assert.equal(bands[8], 10);
    assert.equal(bands[9], 0, "a negative extra is dropped, never coerced");
    assert.equal(bands[11], 0, "an implausible extra is dropped");
    assert.equal(calibratedExtraFromRow({ ...row, calibration_expires_at: new Date(NOW - 1).toISOString() }, NOW), null, "an expired calibration is not read");
  });
});
