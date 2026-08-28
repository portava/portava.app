/**
 * IG-08 coverage PRODUCER — assembly math + the scheduler pass.
 *
 * Proves: an entirely uncovered but demanded cell surfaces as a high-priority gap
 * (never zeroed by the missing-source case); snapshots persist only real gaps; the
 * producer is flag-gated (intel_coverage) and fail-closed; mission generation is
 * SEPARATELY gated (intel_missions) and deduped against open candidates.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  freshestLiveClaim, topContributorShare, demandByZone, subjectZoneMembership,
  bridgeSaves, buildCoverageCells, type ClaimRow, type ObsRow, type SaveRow,
} from "../lib/coverageAssembly.js";
import { computeCoverageScore } from "../lib/coverageScore.js";
import { runIntelCoveragePass } from "../lib/intelCoverageScheduler.js";

const NOW = new Date("2026-08-27T20:00:00.000Z");
const NOW_MS = NOW.getTime();
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
const ahead = (ms: number) => new Date(NOW_MS + ms).toISOString();
const H = 60 * 60 * 1000;

// ── assembly (pure) ───────────────────────────────────────────────────────────
describe("coverageAssembly — topContributorShare", () => {
  it("is 1 for an UNSOURCED cell (maximal gap, never zeroes a real gap's score)", () => {
    assert.equal(topContributorShare([]), 1);
  });
  it("is 1 when a single contributor owns every observation", () => {
    const obs = [{ group_key: null, actor_id: "a" }, { group_key: null, actor_id: "a" }] as any[];
    assert.equal(topContributorShare(obs), 1);
  });
  it("falls as evidence diversifies (two equal groups → 0.5)", () => {
    const obs = [{ group_key: "g1", actor_id: null }, { group_key: "g2", actor_id: null }] as any[];
    assert.equal(topContributorShare(obs), 0.5);
  });
});

describe("coverageAssembly — freshestLiveClaim", () => {
  const base = { subject_id: "p1", zone_id: "z1", claim_type: "crowd.level" };
  it("returns null when the only claim is expired (⇒ claimMissing)", () => {
    const claims: ClaimRow[] = [{ ...base, status: "active", confidence: 0.8, observed_at: ago(3 * H), expires_at: ago(1 * H) }];
    assert.equal(freshestLiveClaim(claims, NOW_MS), null);
  });
  it("returns null when the claim status is not live-eligible", () => {
    const claims: ClaimRow[] = [{ ...base, status: "superseded", confidence: 0.9, observed_at: ago(1 * H), expires_at: ahead(1 * H) }];
    assert.equal(freshestLiveClaim(claims, NOW_MS), null);
  });
  it("returns age-fraction + confidence for the freshest live claim", () => {
    const claims: ClaimRow[] = [
      { ...base, status: "active", confidence: 0.5, observed_at: ago(3 * H), expires_at: ahead(1 * H) },
      { ...base, status: "active", confidence: 0.9, observed_at: ago(1 * H), expires_at: ahead(3 * H) }, // freshest
    ];
    const r = freshestLiveClaim(claims, NOW_MS);
    assert.ok(r);
    assert.equal(r!.confidence, 0.9);
    assert.ok(r!.ageRatio > 0 && r!.ageRatio < 0.5, "age is a fraction of the claim's own TTL span");
  });
});

describe("coverageAssembly — demand is supply-independent (bridged to canonical)", () => {
  it("attributes canonical-keyed saves to a zone via its subject places", () => {
    const membership = subjectZoneMembership(
      [{ subject_id: "p1", zone_id: "z1" }] as ObsRow[],
      [] as ClaimRow[],
    );
    const saves: SaveRow[] = [{ place_id: "p1", saved_at: ago(1 * H) }, { place_id: "p1", saved_at: ago(2 * H) }];
    const d = demandByZone(saves, membership);
    assert.equal(d.get("z1"), 2);
  });

  it("bridgeSaves maps discovery ids → canonical subject ids and drops unlinked saves", () => {
    const disco = new Map([["d1", "p1"], ["d2", "p2"]]); // d3 has no canonical link
    const raw: SaveRow[] = [
      { place_id: "d1", saved_at: ago(1 * H) },
      { place_id: "d2", saved_at: ago(1 * H) },
      { place_id: "d3", saved_at: ago(1 * H) },
    ];
    const bridged = bridgeSaves(raw, disco);
    assert.deepEqual(bridged.map((s) => s.place_id).sort(), ["p1", "p2"], "d3 (no canonical link) is dropped");
  });

  it("a discovery-keyed save does NOT match a canonical subject without bridging", () => {
    // Regression for the id-space bug: saved_places.place_id is a discovery id,
    // intel subject_id is a canonical id — a direct match yields ZERO demand.
    const membership = subjectZoneMembership([{ subject_id: "p1", zone_id: "z1" }] as ObsRow[], []);
    const rawDiscoveryKeyed: SaveRow[] = [{ place_id: "d1", saved_at: ago(1 * H) }];
    assert.equal(demandByZone(rawDiscoveryKeyed, membership).get("z1"), undefined, "unbridged ⇒ no demand");
    const bridged = bridgeSaves(rawDiscoveryKeyed, new Map([["d1", "p1"]]));
    assert.equal(demandByZone(bridged, membership).get("z1"), 1, "bridged ⇒ demand flows");
  });
});

describe("coverageAssembly — the uncovered, demanded cell is a top gap", () => {
  it("a missing high-importance family with demand scores high, not zero", () => {
    // z1 has a subject observed, saves give demand, but NO claim for transit.condition.
    const observations: ObsRow[] = [
      { subject_id: "p1", zone_id: "z1", claim_type: "crowd.level", actor_id: "a", group_key: "g", observed_at: ago(1 * H) },
    ];
    const membership = subjectZoneMembership(observations, []);
    const demand = demandByZone(
      Array.from({ length: 6 }, (_, i) => ({ place_id: "p1", saved_at: ago(i * H) })),
      membership,
    );
    const cells = buildCoverageCells({
      zones: ["z1"], families: ["transit.condition"], claims: [], observations, demand, city: new Map([["z1", "Da Nang"]]), nowMs: NOW_MS,
    });
    assert.equal(cells.length, 1);
    const cell = cells[0];
    assert.equal(cell.claimMissing, true);
    assert.equal(cell.topContributorShare, 1, "no evidence for this family ⇒ maximal diversity gap");
    const s = computeCoverageScore(cell);
    assert.ok(s.score > 0, "a demanded, entirely-uncovered critical family must not score 0");
  });

  it("a well-covered fresh family in the same zone scores far lower", () => {
    const observations: ObsRow[] = [
      { subject_id: "p1", zone_id: "z1", claim_type: "crowd.level", actor_id: "a", group_key: "g1", observed_at: ago(1 * H) },
      { subject_id: "p1", zone_id: "z1", claim_type: "crowd.level", actor_id: "b", group_key: "g2", observed_at: ago(1 * H) },
    ];
    const claims: ClaimRow[] = [
      { subject_id: "p1", zone_id: "z1", claim_type: "crowd.level", status: "active", confidence: 0.95, observed_at: ago(2 * 60 * 1000), expires_at: ahead(3 * H) },
    ];
    const membership = subjectZoneMembership(observations, claims);
    const demand = demandByZone([{ place_id: "p1", saved_at: ago(1 * H) }], membership);
    const [cell] = buildCoverageCells({
      zones: ["z1"], families: ["crowd.level"], claims, observations, demand, city: new Map(), nowMs: NOW_MS,
    });
    assert.equal(cell.claimMissing, false);
    assert.ok(computeCoverageScore(cell).score < 0.2, "fresh, confident, diverse ⇒ near-covered");
  });
});

// ── scheduler pass (fake DB) ──────────────────────────────────────────────────
function makeDb(cfg: { flags: Record<string, boolean>; tables: Record<string, any[]> }) {
  const inserted: Record<string, any[]> = {};
  let seq = 0;
  function from(name: string) {
    const st: any = { op: "select", payload: null, filters: {} as Record<string, any>, single: false };
    const b: any = {
      select() { if (st.op === "insert") st.op = "insert_select"; return b; },
      insert(rows: any) { st.op = "insert"; st.payload = rows; return b; },
      delete() { st.op = "delete"; return b; },
      eq(k: string, v: any) { st.filters[k] = v; return b; },
      in(k: string, v: any) { st.filters["in:" + k] = v; return b; },
      gte(k: string, v: any) { st.filters["gte:" + k] = v; return b; },
      gt(k: string, v: any) { st.filters["gt:" + k] = v; return b; },
      lt(k: string, v: any) { st.filters["lt:" + k] = v; return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { st.single = true; return Promise.resolve(run()); },
      single() { st.single = true; return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    function run() {
      if (name === "feature_flags") {
        return { data: { enabled: Boolean(cfg.flags[st.filters["flag"]]) }, error: null };
      }
      if (st.op === "delete") { return { data: null, error: null }; } // prune is a non-asserted no-op
      if (st.op === "insert" || st.op === "insert_select") {
        const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r: any) => ({ id: `row-${++seq}`, ...r }));
        (inserted[name] ??= []).push(...rows);
        if (st.op === "insert_select") return { data: st.single ? rows[0] : rows, error: null };
        return { data: null, error: null };
      }
      let rows = (cfg.tables[name] ?? []).slice();
      for (const [k, v] of Object.entries(st.filters)) {
        if (k.startsWith("in:")) { const c = k.slice(3); rows = rows.filter((r: any) => (v as any[]).includes(r[c])); }
        else if (k.startsWith("gte:")) { const c = k.slice(4); rows = rows.filter((r: any) => String(r[c]) >= String(v)); }
        else if (k.startsWith("gt:")) { const c = k.slice(3); rows = rows.filter((r: any) => String(r[c]) > String(v)); }
        else if (k.startsWith("lt:")) { const c = k.slice(3); rows = rows.filter((r: any) => String(r[c]) < String(v)); }
        else rows = rows.filter((r: any) => r[k] === v);
      }
      if (st.single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    return b;
  }
  return { from, _inserted: inserted };
}

const subjectObs = (zone: string, family: string): ObsRow =>
  ({ subject_id: "p1", zone_id: zone, claim_type: family, actor_id: "a", group_key: "g", observed_at: ago(1 * H) });

// saved_places keys the DISCOVERY id space; d1 canonicalises to the intel subject p1.
const DISCOVERY = [{ id: "d1", canonical_location_id: "p1" }];
function savesWithin6h(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({ place_id: "d1", saved_at: ago(i * 60 * 1000) })); // discovery-keyed, within the hour
}

describe("intelCoverageScheduler — flag gating (fail-closed)", () => {
  it("is an inert no-op when intel_coverage is off", async () => {
    const db = makeDb({ flags: { intel_coverage: false }, tables: { intel_observations: [subjectObs("z1", "crowd.level")], places: [{ id: "p1", city: "Da Nang" }] } });
    const r = await runIntelCoveragePass({ client: db as any, now: NOW });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "disabled");
    assert.equal((db._inserted.intel_coverage_snapshots ?? []).length, 0);
  });

  it("writes nothing (but is not skipped) when there are no subjects", async () => {
    const db = makeDb({ flags: { intel_coverage: true }, tables: {} });
    const r = await runIntelCoveragePass({ client: db as any, now: NOW });
    assert.equal(r.skipped, false);
    assert.equal(r.snapshots, 0);
    assert.equal((db._inserted.intel_coverage_snapshots ?? []).length, 0);
  });
});

describe("intelCoverageScheduler — persists real gaps", () => {
  it("writes a snapshot for an uncovered, demanded cell", async () => {
    const db = makeDb({
      flags: { intel_coverage: true, intel_missions: false },
      tables: {
        intel_observations: [subjectObs("z1", "crowd.level")],
        places: [{ id: "p1", city: "Da Nang" }],
        discovery_places: DISCOVERY,
        saved_places: savesWithin6h(6),
      },
    });
    const r = await runIntelCoveragePass({ client: db as any, now: NOW });
    assert.equal(r.skipped, false);
    assert.ok(r.snapshots > 0, "at least the missing critical families in z1 are gaps");
    const rows = db._inserted.intel_coverage_snapshots ?? [];
    assert.ok(rows.every((row: any) => Number(row.score) > 0), "only real gaps (score>0) are persisted");
    assert.ok(rows.some((row: any) => row.zone_id === "z1" && row.city === "Da Nang"));
  });
});

describe("intelCoverageScheduler — mission generation is separately gated + deduped", () => {
  const baseTables = () => ({
    intel_observations: [subjectObs("z1", "crowd.level")],
    places: [{ id: "p1", city: "Da Nang" }],
    discovery_places: DISCOVERY,
    saved_places: savesWithin6h(12), // ≥ 10 in 6h ⇒ demand-spike trigger can fire
  });

  it("creates NO missions when intel_missions is off, even with a qualifying gap", async () => {
    const db = makeDb({ flags: { intel_coverage: true, intel_missions: false }, tables: baseTables() });
    const r = await runIntelCoveragePass({ client: db as any, now: NOW });
    assert.ok(r.snapshots > 0);
    assert.equal(r.missionsCreated, 0);
    assert.equal((db._inserted.intel_mission_candidates ?? []).length, 0);
  });

  it("creates missions for demand-spike-missing-family gaps when intel_missions is on", async () => {
    const db = makeDb({ flags: { intel_coverage: true, intel_missions: true }, tables: baseTables() });
    const r = await runIntelCoveragePass({ client: db as any, now: NOW });
    assert.ok(r.missionsCreated > 0, "missing families with ≥10 saves/6h trigger missions");
    const created = db._inserted.intel_mission_candidates ?? [];
    assert.ok(created.every((m: any) => m.cash_amount === 0), "missions are always non-cash");
    assert.ok(created.every((m: any) => m.trigger === "demand_spike_missing_family"));
  });

  it("does not regenerate a mission for a (zone, family) that already has an open candidate", async () => {
    const tables = { ...baseTables(), intel_mission_candidates: [{ zone_id: "z1", claim_family: "crowd.level", status: "dispatched" }] };
    const db = makeDb({ flags: { intel_coverage: true, intel_missions: true }, tables });
    await runIntelCoveragePass({ client: db as any, now: NOW });
    const created = db._inserted.intel_mission_candidates ?? [];
    assert.ok(!created.some((m: any) => m.claim_family === "crowd.level"), "crowd.level already open ⇒ not regenerated");
  });
});
