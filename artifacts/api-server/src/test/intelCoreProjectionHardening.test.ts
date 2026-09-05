/**
 * IG CORE — five verified defects in the claim projection / live read path.
 *
 * Each `describe` below pins ONE of them, and each fails against the code as it
 * stood before the fix:
 *
 *  1. conflict_state VOCABULARY. lib/intelConflict spells the middle state
 *     'minor'; both 2273 CHECKs admit only ('none','contextualized','material').
 *     The version row is appended FIRST and its failure skips the current-state
 *     upsert, so a cohort in MILD disagreement stopped projecting entirely.
 *  2. TIE RESURRECTION. On a value tie the aggregator fell back to the frozen
 *     anchor claim.value — republishing an answer no live cohort member gives,
 *     including one whose author has WITHDRAWN CONSENT.
 *  3. k-ANONYMITY ON THE 'typical' RUNG. readTypicalPatterns served (and badged)
 *     patterns derivable from a SINGLE contributor; the k-floor was applied only
 *     on the live rung.
 *  4. INERT TRUTH BOUNDARY. deriveSourceClass could not bite because
 *     readLiveClaims never SELECTed the source_class column 2279 added.
 *  5. COMMERCIAL DISCLOSURE. The aggregator folded the cohort's source class
 *     with a 'firsthand_unverified' SEED, so a cohort of nothing but disclosed-
 *     commercial ('sponsored') observations was scored — and would have been
 *     badged — as independent community consensus.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  CONFLICT_STATES,
  STORED_CONFLICT_STATES,
  toStoredConflictState,
  normalizeConflictState,
  capForConflict,
} from "../lib/intelConflict.js";
import { projectAndStore } from "../lib/intelProjection.js";
import { assembleClaimInput, type ClaimRow } from "../lib/intelProjectionAggregator.js";
import {
  readLiveClaims,
  readLiveClaimEnvelopes,
  readTypicalPatterns,
  _clearPromotedScopeCache,
} from "../lib/liveClaimRead.js";
import {
  SEED_FRESHNESS_POLICIES,
  invalidateFreshnessPolicyCache,
} from "../lib/freshnessPolicy.js";
import { PRIVACY_THRESHOLD_V1, CLAIM_TYPES } from "../lib/intelContracts.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 20 * 60_000).toISOString();
const T = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const CROWD_TTL = 2700;

const POLICY_ROWS = [
  ...SEED_FRESHNESS_POLICIES.map((p) => ({ claim_type: p.claim_type, ttl_seconds: p.ttl_seconds, note: p.note })),
  ...CLAIM_TYPES.map((c) => ({ claim_type: c.claimType, ttl_seconds: c.ttlSeconds, note: c.note })),
];

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * The conflict_state vocabulary the SCHEMA admits, read out of migration 2273
 * itself so this test cannot drift from the constraint it is protecting.
 * Returns one set per CHECK found (snapshots + versions).
 */
function conflictStateChecksFromMigration(): string[][] {
  const sql = readFileSync(resolve(MIGRATIONS, "2273_intel_replayable_projection.sql"), "utf8");
  const out: string[][] = [];
  const re = /conflict_state\s+IS\s+NULL\s+OR\s+conflict_state\s+IN\s*\(([^)]*)\)/gi;
  for (const m of sql.matchAll(re)) {
    out.push([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return out;
}

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * A projection-write client that ENFORCES migration 2273's CHECK, so a value the
 * live schema would reject is rejected here too (SQLSTATE 23514) instead of being
 * quietly accepted by a permissive fake.
 */
function writeClient(allowed: readonly string[]) {
  const upserts: any[] = [];
  const versions: any[] = [];
  const rejected: any[] = [];
  const check = (row: any) => {
    const v = row?.conflict_state;
    return v == null || allowed.includes(v);
  };
  return {
    upserts,
    versions,
    rejected,
    from(table: string) {
      if (table === "freshness_policies") return { select: async () => ({ data: POLICY_ROWS, error: null }) };
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true }, error: null }) }) }) };
      }
      if (table === "intel_state_snapshots") {
        return {
          upsert: async (row: any) => {
            if (!check(row)) {
              rejected.push(row);
              return { error: { code: "23514", message: 'new row violates check constraint "intel_state_snapshots_conflict_state_check"' } };
            }
            upserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === "intel_state_snapshot_versions") {
        return {
          insert: async (row: any) => {
            if (!check(row)) {
              rejected.push(row);
              return { error: { code: "23514", message: 'new row violates check constraint "intel_state_snapshot_versions_conflict_state_check"' } };
            }
            versions.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient & { upserts: any[]; versions: any[]; rejected: any[] };
}

/** An input that clears the privacy gate, so only the defect under test can suppress it. */
const passing = {
  claimType: "crowd.level",
  value: { level: "busy" },
  observedAt: OBSERVED,
  distinctActors: PRIVACY_THRESHOLD_V1.minUniqueActors,
  distinctGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups,
  maxGroupShare: PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
  components: { presence: 1, freshness: 1, independence: 1, sourceReliability: 1, evidenceQuality: 1, agreement: 1, specificity: 1 },
};

/** Aggregator fake: intel_* reads only, every actor consented unless withdrawn. */
function aggregatorDb(cfg: { observations: any[]; withdrawn?: string[] }) {
  const withdrawn = new Set(cfg.withdrawn ?? []);
  const consentRows = [...new Set(cfg.observations.map((o) => o.actor_id))]
    .filter((id) => !withdrawn.has(id))
    .map((id) => ({ user_id: id, enabled: true, withdrawn_at: null }));
  const tables: Record<string, any[]> = {
    intel_observations: cfg.observations.map((o) => ({
      moderation_state: "allowed", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, ...o,
    })),
    intel_contribution_consent: consentRows,
    intel_confirmations: [],
    intel_evidence: [],
    freshness_policies: [{ claim_type: "crowd.level", ttl_seconds: CROWD_TTL, note: null }],
  };
  return {
    from(table: string) {
      const eqs: [string, any][] = [];
      let inF: [string, any[]] | null = null;
      const rows = () => (tables[table] ?? []).filter((r) =>
        eqs.every(([c, v]) => r[c] === v) && (!inF || inF[1].includes(r[inF[0]])));
      const run = () => {
        if (table === "feature_flags") return { data: { enabled: false }, error: null };
        return { data: rows(), error: null };
      };
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { eqs.push([c, v]); return b; },
        is(c: string, v: any) { eqs.push([c, v]); return b; },
        in(c: string, v: any[]) { inF = [c, v]; return b; },
        maybeSingle() { return Promise.resolve(run()); },
        then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const obsRow = (actor: string, level: string, over: Record<string, unknown> = {}) => ({
  id: `o-${actor}`, actor_id: actor, subject_id: "place-1", claim_type: "crowd.level",
  value: { level }, observed_at: T(5), group_key: `g-${actor}`, ...over,
});

const anchorClaim = (value: unknown): ClaimRow => ({
  id: "c1", subject_id: "place-1", zone_id: null, claim_type: "crowd.level",
  value, status: "active", observed_at: T(30),
});

/**
 * A serving fake that HONOURS the select list — a column the query does not ask
 * for is not returned, exactly as PostgREST behaves. That is what makes a missing
 * projection observable instead of invisible.
 */
function serveClient(rows: any[], opts: { sourceClassMissing?: boolean } = {}) {
  _clearPromotedScopeCache();
  const selects: string[] = [];
  const c: any = {
    selects,
    from(table: string) {
      if (table === "intel_live_promoted_scopes") {
        const pq: any = { select: () => pq };
        return Object.assign(pq, { then: (res: any) => res({ data: [{ scope_key: "|crowd.level" }], error: null }) });
      }
      if (table === "feature_flags") {
        let flag = "";
        const fq: any = {
          select: () => fq,
          eq: (k: string, v: unknown) => { if (k === "flag") flag = String(v); return fq; },
          maybeSingle: async () => ({ data: { enabled: flag !== "disable_intel_live_labels" }, error: null }),
        };
        return fq;
      }
      if (table === "intel_state_snapshots") {
        let cols: string[] = [];
        const q: any = {
          select: (s: string) => { selects.push(s); cols = s.split(",").map((x) => x.trim()); return q; },
          eq: () => q, gt: () => q, in: () => q,
        };
        return Object.assign(q, {
          then: (res: any) => {
            if (opts.sourceClassMissing && cols.includes("source_class")) {
              return res({ data: null, error: { code: "42703", message: 'column intel_state_snapshots.source_class does not exist' } });
            }
            // Project ONLY the requested columns, like the real API would.
            const projected = rows.map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]])));
            return res({ data: projected, error: null });
          },
        });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return c;
}

const snapshotRow = (over: Record<string, unknown> = {}) => ({
  id: "s1", zone_id: "", claim_type: "crowd.level", value: { level: "packed" }, confidence: 0.92,
  source_count: 40, observed_at: T(10), expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
  privacy_eligible: true, conflict_state: "none", computed_at: T(2), ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 1 — conflict_state vocabulary
// ═══════════════════════════════════════════════════════════════════════════
describe("DEFECT 1 — conflict_state written in the vocabulary the CHECKs admit", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("migration 2273 constrains BOTH snapshot tables to the same three values", () => {
    const checks = conflictStateChecksFromMigration();
    assert.equal(checks.length, 2, "expected a CHECK on intel_state_snapshots AND on _versions");
    for (const set of checks) {
      assert.deepEqual([...set].sort(), [...STORED_CONFLICT_STATES].sort(),
        "STORED_CONFLICT_STATES must mirror the schema's vocabulary exactly");
    }
    // The in-memory vocabulary is deliberately NOT the stored one — 'minor' is
    // the spelling the CHECK rejects, which is the whole defect.
    assert.ok(CONFLICT_STATES.includes("minor"));
    assert.ok(!checks[0].includes("minor"), "'minor' is not a value the schema accepts");
  });

  it("every in-memory conflict state maps to a value both CHECKs accept", () => {
    const [snapshots, versions] = conflictStateChecksFromMigration();
    for (const s of CONFLICT_STATES) {
      const stored = toStoredConflictState(s);
      assert.ok(snapshots.includes(stored), `${s} → ${stored} rejected by the snapshots CHECK`);
      assert.ok(versions.includes(stored), `${s} → ${stored} rejected by the versions CHECK`);
    }
  });

  it("a cohort in MINOR conflict still projects (it used to be rejected and stop projecting entirely)", async () => {
    const [allowed] = conflictStateChecksFromMigration();
    const c = writeClient(allowed);
    const t = await projectAndStore(c, "place-1", [{ ...passing, conflictState: "minor" as const }], { now: NOW });

    assert.deepEqual(c.rejected, [], "the write was rejected by the CHECK — projection stopped");
    assert.equal(t.written, 1, "a mildly-disagreeing cohort must still project");
    assert.equal(c.versions.length, 1, "the immutable version row was appended");
    assert.equal(c.upserts.length, 1, "the current-state row was upserted");
    assert.equal(c.versions[0].conflict_state, "contextualized");
    assert.equal(c.upserts[0].conflict_state, "contextualized");
  });

  it("'none' and 'material' are written verbatim — only the middle state is translated", async () => {
    const [allowed] = conflictStateChecksFromMigration();
    for (const state of ["none", "material"] as const) {
      const c = writeClient(allowed);
      await projectAndStore(c, "place-1", [{ ...passing, conflictState: state }], { now: NOW });
      assert.equal(c.upserts[0].conflict_state, state);
    }
  });

  it("the READ path is byte-identical: 'contextualized' reads back as 'minor', and only 'material' caps", () => {
    assert.equal(normalizeConflictState(toStoredConflictState("minor")), "minor");
    assert.equal(normalizeConflictState(toStoredConflictState("none")), "none");
    assert.equal(normalizeConflictState(toStoredConflictState("material")), "material");
    // capForConflict must behave the same for a stored 'contextualized' as it did
    // for an (unwritable) 'minor': no cap at all.
    assert.deepEqual(
      capForConflict(normalizeConflictState("contextualized"), 0.95, "live"),
      capForConflict("minor", 0.95, "live"),
    );
    assert.deepEqual(capForConflict("minor", 0.95, "live"), { confidence: 0.95, band: "live" });
    // ... and a material conflict still caps below the live floor.
    assert.equal(capForConflict("material", 0.95, "live").band, "likely_current");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 2 — a tie must not resurrect an unsupported value
// ═══════════════════════════════════════════════════════════════════════════
describe("DEFECT 2 — a value tie never republishes an unsupported anchor", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("a tie whose anchor author WITHDREW consent publishes nothing", async () => {
    // 'packed' was the frozen anchor, authored by w1 who has since withdrawn.
    // The live cohort ties 2–2 between 'busy' and 'quiet'; neither is 'packed'.
    const db = aggregatorDb({
      observations: [
        obsRow("w1", "packed"),
        obsRow("a1", "busy"), obsRow("a2", "busy"),
        obsRow("b1", "quiet"), obsRow("b2", "quiet"),
      ],
      withdrawn: ["w1"],
    });
    const input = await assembleClaimInput(db, anchorClaim({ level: "packed" }), NOW);

    assert.equal(input.distinctActors, 4, "the withdrawn author is out of the cohort");
    assert.equal(input.cohortSupportsValue, false,
      "no consented cohort member asserts the anchor value — it must not serve");

    // ... and the projection actually WITHHOLDS: nothing is written at all.
    const c = writeClient([...STORED_CONFLICT_STATES]);
    const t = await projectAndStore(c, "place-1", [{ ...passing, ...input }], { now: NOW });
    assert.deepEqual(t, { written: 0, suppressed: 0, skipped: 1 });
    assert.equal(c.versions.length, 0, "no version row for a value nobody supports");
    assert.equal(c.upserts.length, 0, "no current-state row either");
  });

  it("a tie WITH live support publishes a supported value", async () => {
    // Same 2–2 tie, but the anchor value 'busy' is one of the tied answers and is
    // still asserted by consented actors.
    const db = aggregatorDb({
      observations: [
        obsRow("a1", "busy"), obsRow("a2", "busy"),
        obsRow("b1", "quiet"), obsRow("b2", "quiet"),
      ],
    });
    const input = await assembleClaimInput(db, anchorClaim({ level: "busy" }), NOW);
    assert.notEqual(input.cohortSupportsValue, false, "a supported anchor may still serve");
    assert.deepEqual(input.value, { level: "busy" });

    const c = writeClient([...STORED_CONFLICT_STATES]);
    const t = await projectAndStore(c, "place-1", [{ ...passing, ...input }], { now: NOW });
    assert.equal(t.written + t.suppressed, 1, "a supported value still projects");
    assert.deepEqual(c.upserts[0].value, { level: "busy" });
  });

  it("a clear plurality is unaffected, and an empty-valued cohort still falls back to the anchor", async () => {
    const plurality = await assembleClaimInput(
      aggregatorDb({ observations: [obsRow("a1", "busy"), obsRow("a2", "busy"), obsRow("b1", "quiet")] }),
      anchorClaim({ level: "dead" }), NOW,
    );
    assert.notEqual(plurality.cohortSupportsValue, false);
    assert.deepEqual(plurality.value, { level: "busy" }, "plurality still wins over the anchor");

    // Observations with no value at all: nothing contradicts the anchor, and the
    // k-anon gate governs. Unchanged behaviour.
    const noValues = await assembleClaimInput(
      aggregatorDb({ observations: [
        { id: "o-x", actor_id: "x", subject_id: "place-1", claim_type: "crowd.level", observed_at: T(5), group_key: "g-x" },
      ] }),
      anchorClaim({ level: "moderate" }), NOW,
    );
    assert.notEqual(noValues.cohortSupportsValue, false);
    assert.deepEqual(noValues.value, { level: "moderate" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 3 — k-anonymity floor on the 'typical' rung
// ═══════════════════════════════════════════════════════════════════════════
describe("DEFECT 3 — the 'typical' rung enforces the SAME k-floor as the live rung", () => {
  const PNOW = new Date("2026-09-04T20:00:00.000Z"); // Friday, hour 20 UTC
  const pattern = (over: Record<string, unknown> = {}) => ({
    id: "pat-1", zone_id: null, claim_family: "crowd.level", pattern_kind: "typical_crowd_by_weekday_hour",
    time_band: "hour_20", dow: PNOW.getUTCDay(), value_json: { level: "busy" }, confidence: 0.6,
    cohort_size: 30, distinct_contributors: PRIVACY_THRESHOLD_V1.minUniqueActors, window_days: 120,
    is_invalidation: false, computed_at: "2026-09-01T00:00:00.000Z", ...over,
  });
  const patternClient = (rows: any[]) => {
    const selects: string[] = [];
    return {
      selects,
      from(table: string) {
        if (table === "intel_historical_patterns") {
          let cols: string[] = [];
          const q: any = {
            select: (s: string) => { selects.push(s); cols = s.split(",").map((x) => x.trim()); return q; },
            eq: () => q, order: () => q,
          };
          return Object.assign(q, {
            then: (res: any) => res({
              data: rows.map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]]))),
              error: null,
            }),
          });
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as any;
  };

  it("a pattern derivable from a SINGLE contributor does not serve and carries no badge", async () => {
    // Table-19 lets this through at the DB: 'typical_crowd_by_weekday_hour' needs
    // 8 independent VISITS across 4 dates and sets minContributors to 0, so one
    // person's routine satisfies the CHECK.
    const out = await readTypicalPatterns(
      patternClient([pattern({ cohort_size: 8, distinct_contributors: 1 })]), "p1", { now: PNOW });
    assert.deepEqual(out, [], "a one-person routine must not be published as a typical pattern");
  });

  it("withholds every pattern below the live path's k, and serves at the floor", async () => {
    const k = PRIVACY_THRESHOLD_V1.minUniqueActors;
    for (const n of [0, 1, k - 1]) {
      const out = await readTypicalPatterns(patternClient([pattern({ distinct_contributors: n })]), "p1", { now: PNOW });
      assert.deepEqual(out, [], `${n} contributors is below k=${k} and must not serve`);
    }
    const atFloor = await readTypicalPatterns(patternClient([pattern({ distinct_contributors: k })]), "p1", { now: PNOW });
    assert.equal(atFloor.length, 1, "exactly k contributors serves");
    assert.equal(atFloor[0].state, "typical");
    assert.equal(atFloor[0].sourceClass, "historical_pattern");
    assert.equal(atFloor[0].sourceCountBucket, "several");
  });

  it("a row with no contributor count at all is withheld (fail-closed, not assumed large)", async () => {
    const row: any = pattern();
    delete row.distinct_contributors;
    assert.deepEqual(await readTypicalPatterns(patternClient([row]), "p1", { now: PNOW }), []);
  });

  it("the read actually PROJECTS distinct_contributors — a floor over an unselected column is no floor", async () => {
    const c = patternClient([pattern()]);
    await readTypicalPatterns(c, "p1", { now: PNOW });
    assert.ok(c.selects[0].split(",").map((s: string) => s.trim()).includes("distinct_contributors"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 4 — the truth-boundary guard must actually evaluate
// ═══════════════════════════════════════════════════════════════════════════
describe("DEFECT 4 — readLiveClaims projects source_class so deriveSourceClass bites", () => {
  it("selects the column migration 2279 added", async () => {
    const c = serveClient([snapshotRow()]);
    await readLiveClaims(c, "p1", { now: NOW });
    assert.ok(c.selects.length > 0);
    assert.ok(c.selects[0].split(",").map((s: string) => s.trim()).includes("source_class"),
      "source_class must be in the select list or the guard reads undefined forever");
  });

  it("DROPS a class that may never render as live (historical_pattern / portava_prediction)", async () => {
    for (const cls of ["historical_pattern", "portava_prediction"]) {
      const out = await readLiveClaims(serveClient([snapshotRow({ source_class: cls })]), "p1", { now: NOW });
      assert.deepEqual(out, [], `${cls} must never reach a Live label`);
    }
    // Control: an observation class still serves, and carries its real class.
    const ok = await readLiveClaims(serveClient([snapshotRow({ source_class: "verified_firsthand" })]), "p1", { now: NOW });
    assert.equal(ok.length, 1);
    assert.equal(ok[0].sourceClass, "verified_firsthand");
  });

  it("tolerates a schema without the column: retries without it, keeps serving at the default class", async () => {
    const c = serveClient([snapshotRow()], { sourceClassMissing: true });
    const out = await readLiveClaims(c, "p1", { now: NOW });
    assert.equal(c.selects.length, 2, "asked for the column, then retried without it");
    assert.ok(!c.selects[1].includes("source_class"));
    assert.equal(out.length, 1, "a pre-2279 schema must not blank the whole read");
    assert.equal(out[0].sourceClass, "firsthand_unverified");
  });

  it("an unrecognised label is not trusted — it falls back to the default class", async () => {
    const out = await readLiveClaims(serveClient([snapshotRow({ source_class: "totally_made_up" })]), "p1", { now: NOW });
    assert.equal(out.length, 1);
    assert.equal(out[0].sourceClass, "firsthand_unverified");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 5 — disclosed-commercial cohorts earn no consensus badge
// ═══════════════════════════════════════════════════════════════════════════
describe("DEFECT 5 — a wholly disclosed-commercial cohort is not independent consensus", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  const sponsoredCohort = (n: number) => Array.from({ length: n }, (_, i) =>
    obsRow(`s${i}`, "packed", { source_class: "sponsored", commercial_disclosure: "paid" }));

  it("the aggregator reports the cohort's REAL class instead of a seed it never contained", async () => {
    const input = await assembleClaimInput(
      aggregatorDb({ observations: sponsoredCohort(4) }), anchorClaim({ level: "packed" }), NOW);
    assert.equal(input.sourceClass, "sponsored",
      "a cohort of only disclosed-commercial reports is 'sponsored', not firsthand_unverified");
    assert.equal(input.components.sourceReliability, 0.4, "and it is scored at sponsored reliability, not 0.5");
  });

  it("a hearsay-only cohort is likewise not laundered upward", async () => {
    const input = await assembleClaimInput(
      aggregatorDb({ observations: [
        obsRow("h1", "packed", { source_class: "hearsay" }),
        obsRow("h2", "packed", { source_class: "hearsay" }),
      ] }), anchorClaim({ level: "packed" }), NOW);
    assert.equal(input.sourceClass, "hearsay");
    assert.equal(input.components.sourceReliability, 0.2);
  });

  it("an ordinary cohort is unchanged, and one genuine independent report still wins the fold", async () => {
    const plain = await assembleClaimInput(
      aggregatorDb({ observations: [obsRow("a1", "packed"), obsRow("a2", "packed")] }),
      anchorClaim({ level: "packed" }), NOW);
    assert.equal(plain.sourceClass, "firsthand_unverified");
    assert.equal(plain.components.sourceReliability, 0.5);

    const mixed = await assembleClaimInput(
      aggregatorDb({ observations: [
        obsRow("s1", "packed", { source_class: "sponsored" }),
        obsRow("a1", "packed"),
      ] }), anchorClaim({ level: "packed" }), NOW);
    assert.equal(mixed.sourceClass, "firsthand_unverified");
  });

  it("the class reaches the snapshot, and the served envelope then withholds the cohort badge", async () => {
    const input = await assembleClaimInput(
      aggregatorDb({ observations: sponsoredCohort(4) }), anchorClaim({ level: "packed" }), NOW);

    const c = writeClient([...STORED_CONFLICT_STATES]);
    await projectAndStore(c, "place-1", [{ ...passing, ...input, value: input.value }], { now: NOW });
    assert.equal(c.upserts.length, 1);
    assert.equal(c.upserts[0].source_class, "sponsored", "the class must be persisted or the read cannot enforce it");
    // The append-only version table (2273) has no source_class column — it must
    // NOT be written there, or every version insert would fail.
    assert.equal("source_class" in c.versions[0], false);

    const served = await readLiveClaimEnvelopes(
      serveClient([snapshotRow({ source_class: "sponsored", source_count: 40 })]), "p1", { now: NOW });
    assert.equal(served.length, 1, "still served — disclosure is a badge rule, not suppression");
    assert.equal(served[0].sourceClass, "sponsored");
    assert.equal(served[0].sourceCountBucket, null, "no independent-consensus badge for a sponsored cohort");

    // Control: the same cohort size under an independent class DOES badge.
    const independent = await readLiveClaimEnvelopes(
      serveClient([snapshotRow({ source_class: "firsthand_unverified", source_count: 40 })]), "p1", { now: NOW });
    assert.equal(independent[0].sourceCountBucket, "several");
  });
});
