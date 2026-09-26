/**
 * S112 — an erasure PRODUCES ITS EFFECT on derived state (census-sensing §26).
 *
 * The owner's bar: "Verify that revocation actually produces the required
 * effect; a read-only reach calculation alone is not completion." So the last
 * case here is the whole path with the REAL aggregator and the REAL projection
 * writer against an in-memory database: a snapshot rests on sixteen
 * observations, one of them the departing account's; that observation is
 * erased; the recompute rewrites the snapshot from the fifteen that remain,
 * and the row's provenance no longer names the erased id. The unit cases
 * before it pin each branch of the recompute-or-retract decision with fakes,
 * including the fail-closed ones.
 *
 * RED WHEN: `recomputeSnapshotsAfterErasure` stops re-reading the affected
 * rows after the recompute (the retraction becomes blind), stops retracting a
 * row that still names an erased id, or the projection writer stops writing
 * `input_observation_ids`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { recomputeSnapshotsAfterErasure, type AffectedSnapshot, type RecomputeDeps } from "../services/accountDeletion/sensingErasureRecompute.js";
import { PROJECTION_ALGORITHM_VERSION } from "../lib/intelProjection.js";
import { SEED_FRESHNESS_POLICIES, invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { CLAIM_TYPES } from "../lib/intelContracts.js";
import { resetContributorIdentityShapeMemo } from "../lib/intelConsent.js";

type Row = Record<string, any>;

const NOW = new Date("2026-09-26T12:00:00.000Z");
const T_OBS = new Date(NOW.getTime() - 20 * 60_000).toISOString();
const SUBJECT = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
const uuid = (n: number) => `0000000${n}`.slice(-8).replace(/./g, (c) => c) + "-0000-4000-8000-" + `000000000000${n}`.slice(-12);
const SNAP = "9999e999-9999-4999-8999-999999999999";
const ERASED = uuid(1);

/**
 * An in-memory PostgREST that MUTATES: upsert keys on (subject_id, zone_id,
 * claim_type), update applies its patch to the matched rows, insert appends.
 * Reads filter on eq / in / is / overlaps. `fail` makes a table's reads or
 * writes error by name.
 */
function db(tables: Record<string, Row[]>, fail: Partial<Record<string, "select" | "update" | "insert">> = {}) {
  const ops: Array<{ table: string; op: string }> = [];
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let op: "select" | "update" | "insert" | "upsert" = "select";
    let payload: any = null;
    let single = false;
    const filters: Array<[string, string, any]> = [];
    const match = (r: Row) => filters.every(([k, c, v]) => {
      if (k === "eq") return r[c] === v;
      if (k === "in") return (v as any[]).includes(r[c]);
      if (k === "is") return (r[c] ?? null) === v;
      if (k === "overlaps") return Array.isArray(r[c]) && r[c].some((x: any) => (v as any[]).includes(x));
      return true;
    });
    const run = async () => {
      ops.push({ table, op });
      if (fail[table] === op) return { data: null, error: { code: "08006", message: `${table} ${op} failed` } };
      if (op === "insert") { rows.push({ ...payload }); return { data: null, error: null }; }
      if (op === "update") { for (const r of rows) if (match(r)) Object.assign(r, payload); return { data: null, error: null }; }
      if (op === "upsert") {
        const hit = rows.find((r) => r.subject_id === payload.subject_id && (r.zone_id ?? "") === (payload.zone_id ?? "") && r.claim_type === payload.claim_type);
        if (hit) Object.assign(hit, payload); else rows.push({ id: `snap-${rows.length + 1}`, ...payload });
        return { data: null, error: null };
      }
      const data = rows.filter(match).map((r) => ({ ...r }));
      return single ? { data: data[0] ?? null, error: null } : { data, error: null };
    };
    const b: any = {
      select() { op = "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      upsert(row: any) { op = "upsert"; payload = row; return b; },
      eq(c: string, v: any) { filters.push(["eq", c, v]); return b; },
      in(c: string, v: any[]) { filters.push(["in", c, v]); return b; },
      is(c: string, v: any) { filters.push(["is", c, v]); return b; },
      overlaps(c: string, v: any[]) { filters.push(["overlaps", c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { single = true; return run(); },
      then(res: any, rej: any) { return run().then(res, rej); },
    };
    return b;
  }
  const absent = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  return { from, rpc: async () => absent, _tables: tables, _ops: ops };
}

const affected = (over: Partial<AffectedSnapshot> = {}): AffectedSnapshot[] => [
  { id: SNAP, subjectId: SUBJECT, zoneId: "", claimType: "crowd.level", ...over },
];

function snapshotRow(over: Row = {}): Row {
  return {
    id: SNAP, subject_id: SUBJECT, zone_id: "", claim_type: "crowd.level", value: { level: "busy" },
    confidence: 0.8, confidence_band: "strong", source_count: 16, distinct_actors: 16,
    privacy_eligible: true, observed_at: T_OBS, expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    input_observation_ids: [ERASED, uuid(2), uuid(3)], ...over,
  };
}

/** Deps that stand in for the projection: `project` may rewrite the row or do nothing. */
function fakeDeps(project: (sc: any, subjectId: string, inputs: any[], opts: any) => Promise<{ written: number; suppressed: number; skipped: number }>): RecomputeDeps {
  return {
    assemble: async (_sc, claim) => ({ claimType: claim.claim_type, value: claim.value, observedAt: T_OBS, distinctActors: 15, components: {} }) as any,
    project,
  };
}
const NO_PROJECT = fakeDeps(async () => ({ written: 0, suppressed: 0, skipped: 1 }));
const claimRow = (): Row => ({ id: "claim-1", subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: T_OBS });

describe("recompute-or-retract — each branch, with the projection faked", () => {
  it("nothing affected → nothing read, nothing written", async () => {
    const sc = db({});
    const r = await recomputeSnapshotsAfterErasure(sc, [], [ERASED], NOW, NO_PROJECT);
    assert.equal(r.groups, 0);
    assert.equal(sc._ops.length, 0);
  });

  it("RECOMPUTED: the projection rewrote the row without the erased id → nothing to retract", async () => {
    const sc = db({ intel_claims: [claimRow()], intel_state_snapshots: [snapshotRow()] });
    const deps = fakeDeps(async (client, subjectId) => {
      await client.from("intel_state_snapshots").upsert({ subject_id: subjectId, zone_id: "", claim_type: "crowd.level", input_observation_ids: [uuid(2), uuid(3)], privacy_eligible: true });
      return { written: 1, suppressed: 0, skipped: 0 };
    });
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW, deps);
    assert.equal(r.written, 1);
    assert.equal(r.retracted, 0);
    assert.equal(sc._tables.intel_state_snapshots[0].privacy_eligible, true, "a recomputed row keeps serving");
    assert.equal(sc._tables.intel_state_snapshot_versions, undefined, "no retraction version");
  });

  it("RETRACTED: the projection did not rewrite (flag off / withheld) → the row stops serving and the record says why", async () => {
    const sc = db({ intel_claims: [claimRow()], intel_state_snapshots: [snapshotRow()] });
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW, NO_PROJECT);
    assert.equal(r.retracted, 1);
    assert.equal(r.retractionFailures, 0);
    const row = sc._tables.intel_state_snapshots[0];
    assert.equal(row.privacy_eligible, false);
    assert.equal(row.expires_at, NOW.toISOString(), "expired NOW, so the read path drops it on both of its filters");
    assert.deepEqual(row.input_observation_ids, []);
    const version = sc._tables.intel_state_snapshot_versions[0];
    assert.equal(version.privacy_reason, "input_erased");
    assert.equal(version.privacy_eligible, false);
    assert.equal(version.subject_id, SUBJECT);
    assert.equal(version.claim_type, "crowd.level");
    assert.deepEqual(version.value, { level: "busy" }, "the retracted value is recorded, not blanked");
    assert.equal(version.algorithm_version, PROJECTION_ALGORITHM_VERSION);
    assert.deepEqual(version.input_observation_ids, []);
  });

  it("a row that names NONE of the erased ids after the recompute is left alone even under NO_PROJECT", async () => {
    const sc = db({ intel_claims: [claimRow()], intel_state_snapshots: [snapshotRow({ input_observation_ids: [uuid(2)] })] });
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW, NO_PROJECT);
    assert.equal(r.retracted, 0);
    assert.equal(sc._tables.intel_state_snapshots[0].privacy_eligible, true);
  });

  it("FAIL-CLOSED: an unreadable claim set counts and still retracts what rests on the erased evidence", async () => {
    const sc = db({ intel_claims: [claimRow()], intel_state_snapshots: [snapshotRow()] }, { intel_claims: "select" });
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW, NO_PROJECT);
    assert.equal(r.claimsUnreadable, 1);
    assert.equal(r.retracted, 1);
  });

  it("FAIL-CLOSED: an unreadable post-recompute state retracts EVERY affected row, blind", async () => {
    const sc = db({ intel_claims: [claimRow()], intel_state_snapshots: [snapshotRow({ input_observation_ids: [uuid(2)] })] }, { intel_state_snapshots: "select" });
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW, NO_PROJECT);
    assert.equal(r.verifiedBlind, true);
    assert.equal(r.retracted, 1, "cannot tell → withdraw");
    assert.equal(sc._tables.intel_state_snapshots[0].privacy_eligible, false);
  });

  it("a retraction whose write fails is COUNTED, so the deletion step warns instead of reporting success", async () => {
    const sc = db({ intel_claims: [claimRow()], intel_state_snapshots: [snapshotRow()] }, { intel_state_snapshots: "update" });
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW, NO_PROJECT);
    assert.equal(r.retracted, 0);
    assert.equal(r.retractionFailures, 1);
  });

  it("a projection that THROWS is contained: the group is skipped and its rows are retracted", async () => {
    const sc = db({ intel_claims: [claimRow()], intel_state_snapshots: [snapshotRow()] });
    const deps = fakeDeps(async () => { throw new Error("projection exploded"); });
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW, deps);
    assert.equal(r.skipped, 1);
    assert.equal(r.retracted, 1);
  });
});

// ── The whole path, real aggregator and real writer ──────────────────────────

const POLICY_ROWS = [
  ...SEED_FRESHNESS_POLICIES.map((p) => ({ claim_type: p.claim_type, ttl_seconds: p.ttl_seconds, note: p.note })),
  ...CLAIM_TYPES.map((c) => ({ claim_type: c.claimType, ttl_seconds: c.ttlSeconds, note: c.note })),
];

/**
 * One observation per actor, each its own attested group, and each reported a
 * full minute apart: lib/intelIndependence collapses DIFFERENT actors asserting
 * the IDENTICAL value within SYNC_WINDOW_SECONDS (30 s) into ONE coordinated
 * cluster, so sixteen simultaneous "busy" reports would count as a single
 * independent group and the gate would suppress them — correctly. Staggering
 * keeps every report inside crowd.level's TTL and past the publication delay.
 */
function observation(n: number, actor: string): Row {
  return {
    id: uuid(n), actor_id: actor, subject_id: SUBJECT, claim_type: "crowd.level", value: { level: "busy" },
    presence_level: "P2", source_class: "firsthand_unverified", expires_at: null, group_key: `group-${n}`,
    observed_at: new Date(new Date(T_OBS).getTime() - n * 60_000).toISOString(), moderation_state: "allowed",
  };
}

describe("END TO END — the real aggregator and writer, a real erasure, a verified effect", () => {
  beforeEach(() => { invalidateFreshnessPolicyCache(); resetContributorIdentityShapeMemo(); });

  function world() {
    const departing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const others = Array.from({ length: 15 }, (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${`000000000000${i + 1}`.slice(-12)}`);
    const observations = [observation(1, departing), ...others.map((a, i) => observation(i + 2, a))];
    const tables: Record<string, Row[]> = {
      feature_flags: [{ flag: "intel_claim_projection_crowd", enabled: true }],
      freshness_policies: POLICY_ROWS,
      intel_claims: [claimRow()],
      intel_observations: observations,
      intel_evidence: [],
      intel_confirmations: [],
      // Account-column consent shape (the bridge rpcs are absent in this fake): everyone consented.
      intel_contribution_consent: [departing, ...others].map((user_id) => ({ user_id, enabled: true, withdrawn_at: null })),
      intel_state_snapshots: [snapshotRow({ input_observation_ids: observations.map((o) => o.id), source_count: 16, distinct_actors: 16 })],
      intel_state_snapshot_versions: [],
    };
    return { sc: db(tables), departing, observations };
  }

  it("the snapshot is REWRITTEN from the evidence that remains, and its provenance no longer names the erased observation", async () => {
    const { sc, observations } = world();
    const before = sc._tables.intel_state_snapshots[0];
    assert.ok(before.input_observation_ids.includes(ERASED), "premise: the snapshot rests on the departing account's observation");

    // The erase: erase_intel_for_actor has removed the account's observation.
    sc._tables.intel_observations = sc._tables.intel_observations.filter((o) => o.id !== ERASED);
    assert.equal(sc._tables.intel_observations.length, 15);

    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW);
    assert.equal(r.groups, 1);
    assert.equal(r.written, 1, `the cohort of fifteen re-projects: ${JSON.stringify(r)}`);
    assert.equal(r.retracted, 0, "nothing left to retract — the rewrite already dropped the erased id");

    const after = sc._tables.intel_state_snapshots[0];
    assert.equal(after.privacy_eligible, true, "fifteen consented contributors still clear the gate");
    assert.equal(after.input_observation_ids.includes(ERASED), false, "THE EFFECT: the served state no longer rests on the erased evidence");
    assert.equal(after.input_observation_ids.length, 15);
    assert.deepEqual([...after.input_observation_ids].sort(), observations.filter((o) => o.id !== ERASED).map((o) => o.id).sort());
    assert.equal(after.distinct_actors, 15, "the departed contributor is no longer counted");

    const versions = sc._tables.intel_state_snapshot_versions;
    assert.equal(versions.length, 1, "one new version row records the recompute");
    assert.equal(versions[0].input_observation_ids.includes(ERASED), false);
    assert.equal(versions[0].privacy_eligible, true);
  });

  it("when the erasure leaves too few contributors, the rewrite is SUPPRESSED — and still carries no erased id", async () => {
    const { sc } = world();
    // Erase the departing account AND (for the fixture) twelve others, leaving three.
    const keep = new Set(sc._tables.intel_observations.slice(13).map((o) => o.id));
    const erased = sc._tables.intel_observations.filter((o) => !keep.has(o.id)).map((o) => o.id);
    sc._tables.intel_observations = sc._tables.intel_observations.filter((o) => keep.has(o.id));
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), erased, NOW);
    const after = sc._tables.intel_state_snapshots[0];
    assert.equal(r.suppressed + r.written, 1);
    assert.equal(after.privacy_eligible, false, "three people are below the k-threshold: suppressed, recorded, not served");
    assert.equal(after.input_observation_ids.some((id: string) => erased.includes(id)), false);
    assert.equal(r.retracted, 0, "the rewrite already carried the effect; no retraction was needed");
  });

  it("with the projection flag OFF the writer writes nothing — so the recompute RETRACTS instead of trusting the stale row", async () => {
    const { sc } = world();
    sc._tables.feature_flags = [{ flag: "intel_claim_projection_crowd", enabled: false }];
    sc._tables.intel_observations = sc._tables.intel_observations.filter((o) => o.id !== ERASED);
    const r = await recomputeSnapshotsAfterErasure(sc, affected(), [ERASED], NOW);
    assert.equal(r.written, 0);
    assert.equal(r.retracted, 1);
    const after = sc._tables.intel_state_snapshots[0];
    assert.equal(after.privacy_eligible, false);
    assert.equal(after.expires_at, NOW.toISOString());
    assert.equal(sc._tables.intel_state_snapshot_versions[0].privacy_reason, "input_erased");
  });
});
