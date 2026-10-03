/**
 * Intel projection scheduler + aggregator (IG-04 driver) — the missing piece that
 * makes claim → snapshot projection run automatically. Proves: the confidence
 * components are derived conservatively; the aggregator counts DISTINCT observers
 * (the k-anon input) and confirmation stances from real rows; and the scheduler
 * pass is flag-gated, fail-closed, groups by (subject, zone), and upserts
 * snapshots — which stay privacy-suppressed while group data is absent (the gate
 * refuses, it is not weakened).
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../lib/logger.js";
import { deriveComponents, derivePenalties, assembleClaimInput, type ClaimEvidence, type ClaimRow } from "../lib/intelProjectionAggregator.js";
import { runIntelProjectionPass } from "../lib/intelProjectionScheduler.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { CLAIM_TYPES } from "../lib/intelContracts.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 15 * 60_000).toISOString(); // 15 min ago

const baseEvidence = (over: Partial<ClaimEvidence> = {}): ClaimEvidence => ({
  distinctActors: 3, agrees: 0, disagrees: 0, maxPresenceLevel: "P0",
  hasEvidence: false, sourceClass: "firsthand_unverified", ageRatio: 0.33, ...over,
});

// PostgREST returns at most this many rows for a read with NEITHER an explicit
// .limit() NOR a .range() — silently, with no error. An explicit limit or range
// overrides that implicit ceiling. STAMP·H6 is a reconciliation read that relied
// on the implicit ceiling, so the fake must reproduce it: a range-less/limit-less
// select truncates to this many rows, while .range() serves the exact slice.
const POSTGREST_IMPLICIT_CAP = 1000;

function makeDb(cfg: {
  flags: Record<string, boolean>; claims?: any[]; observations?: any[]; confirmations?: any[];
  policies?: any[]; snapshots?: any[]; errorTable?: string; withdrawnActors?: string[]; evidence?: any[];
  // Inject an error on a specific PAGINATED page of `table`, but only once the
  // window has advanced to (or past) `minOffset` — lets a test succeed on page 1
  // and fail on a later page, proving a PARTIAL read expires nothing.
  // `columns` narrows it to the read whose select list matches, for a test
  // about ONE of several paged reads of the same table.
  rangeError?: { table: string; minOffset?: number; columns?: RegExp };
  // Reject every UPDATE against this table. supabase-js RESOLVES on a database
  // error, so the rejected update must come back as `{ error }` and mutate
  // NOTHING — modelling a throw here would test a shape the real client never
  // produces.
  updateError?: { table: string };
  // PostgREST's db-max-rows (Supabase "Max rows", 1000 on hosted) caps EVERY
  // response — an explicit .limit(5000) or .range(0, 4999) still returns at most
  // this many rows, with no error. Opt-in so the fixtures above keep their
  // existing semantics; the DV-83 cases below set it.
  serverMaxRows?: number;
  // Without an ORDER BY, PostgreSQL promises no row order, and two requests for
  // consecutive OFFSET windows can each see a DIFFERENT order — so offset pages
  // overlap and skip. Opt-in: an unordered page past the first (OFFSET > 0, or
  // a cursor on id) is served in the reverse of the first page's order, one
  // legal answer the real database may give.
  unstableUnorderedPages?: boolean;
}) {
  const snaps: any[] = [...(cfg.snapshots ?? [])];
  // I1: every snapshot write is preceded by an append to the version table.
  const versions: any[] = [];
  // Every .update(...).in("id",[...]) is recorded here so a test can assert which
  // snapshot ids (if any) the reconciliation force-expired.
  const updates: { table: string; ids: any[]; patch: any }[] = [];
  // Every canonical_events row the pass inserts (the §21 domain emitters).
  const events: any[] = [];
  // D4: every observation actor is consented by default; withdrawnActors lets a
  // test mark some as withdrawn so the aggregator's consent filter can exclude them.
  const withdrawn = new Set(cfg.withdrawnActors ?? []);
  const consentRows = [...new Set((cfg.observations ?? []).map((o: any) => o.actor_id).filter(Boolean))]
    .map((id: string) => ({ user_id: id, enabled: !withdrawn.has(id), withdrawn_at: withdrawn.has(id) ? NOW.toISOString() : null }));
  function from(table: string) {
    let op: "select" | "upsert" | "update" | "insert" = "select"; let payload: any = null;
    const eqs: [string, any][] = []; const gts: [string, any][] = [];
    let inF: [string, any[]] | null = null; let lim = Infinity; let rangeF: [number, number] | null = null;
    let orderF: [string, boolean] | null = null; let cols = ""; let wantCount = false;
    // Observations default to moderation_state 'allowed' (explicit values override),
    // so fixtures that don't care about moderation still pass the aggregator's
    // pilot-claimable .in() filter; a fixture can set 'blocked'/'removed' to test exclusion.
    const src = (): any[] => (({ intel_claims: cfg.claims, intel_observations: (cfg.observations ?? []).map((o: any) => ({ moderation_state: "allowed", ...o })), intel_confirmations: cfg.confirmations, freshness_policies: cfg.policies, intel_state_snapshots: snaps, intel_contribution_consent: consentRows, intel_evidence: cfg.evidence } as any)[table] ?? []);
    const match = (r: any) =>
      eqs.every(([c, v]) => r[c] === v)
      && gts.every(([c, v]) => r[c] != null && r[c] > v)
      && (!inF || inF[1].includes(r[inF[0]]));
    const rows = () => {
      let filtered = src().filter(match);
      if (orderF) {
        const [c, asc] = orderF;
        filtered = [...filtered].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      } else if (cfg.unstableUnorderedPages && ((rangeF && rangeF[0] > 0) || gts.some(([c]) => c === "id"))) {
        // A later OFFSET window sees the rows in the opposite order to the first
        // one did — legal with no ORDER BY, and the worst case for offset paging:
        // the second page re-serves rows the first already had and never reaches
        // the ones neither served.
        filtered = [...filtered].reverse();
      }
      const cap = (xs: any[]) => (cfg.serverMaxRows !== undefined ? xs.slice(0, cfg.serverMaxRows) : xs);
      if (rangeF) return cap(filtered.slice(rangeF[0], rangeF[1] + 1)); // explicit pagination — exact slice
      if (lim !== Infinity) return cap(filtered.slice(0, lim));         // explicit limit — honored as-is
      return filtered.slice(0, cfg.serverMaxRows ?? POSTGREST_IMPLICIT_CAP); // range-less/limit-less — silently capped
    };
    // How far into the ordered result a keyset page starts: the rows at or
    // before its cursor. Lets `rangeError.minOffset` mean the same thing for a
    // keyset page as for an OFFSET page.
    const keysetOffset = (): number | null => {
      const cursor = gts.find(([c]) => orderF && c === orderF[0]);
      if (!cursor) return null;
      return src().filter((r) => eqs.every(([c, v]) => r[c] === v) && (!inF || inF[1].includes(r[inF[0]])) && r[cursor[0]] <= cursor[1]).length;
    };
    const run = () => {
      if (table === "feature_flags") { const f = eqs.find(([c]) => c === "flag")?.[1]; return { data: { enabled: Boolean(cfg.flags[f]) }, error: null }; }
      if (cfg.errorTable === table) return { data: null, error: { message: "boom" } };
      const pageStart = rangeF ? rangeF[0] : keysetOffset();
      if (cfg.rangeError && cfg.rangeError.table === table && pageStart !== null && pageStart >= (cfg.rangeError.minOffset ?? 0)
        && (cfg.rangeError.columns === undefined || cfg.rangeError.columns.test(cols.trim()))) {
        return { data: null, error: { message: "range boom" } };
      }
      if (op === "upsert") { snaps.push(...(Array.isArray(payload) ? payload : [payload])); return { data: null, error: null }; }
      if (op === "insert") {
        if (table === "intel_state_snapshot_versions") versions.push(...(Array.isArray(payload) ? payload : [payload]));
        if (table === "canonical_events") events.push(...(Array.isArray(payload) ? payload : [payload]));
        return { data: null, error: null };
      }
      if (op === "update") {
        const ids = inF && inF[0] === "id" ? [...inF[1]] : [];
        if (cfg.updateError && cfg.updateError.table === table) {
          // Rejected: record the ATTEMPT, change nothing, answer with an error.
          updates.push({ table, ids, patch: payload, rejected: true } as any);
          return { data: null, error: { message: "update boom", code: "42501" } };
        }
        for (const r of src()) if (match(r)) Object.assign(r, payload); // mutate the store in place
        updates.push({ table, ids, patch: payload });
        return { data: null, error: null };
      }
      // `count: "exact"` reports the size of the WHOLE filtered set, which is
      // how a reader learns that the rows it was handed were capped.
      return wantCount ? { data: rows(), error: null, count: src().filter(match).length } : { data: rows(), error: null };
    };
    const b: any = {
      select(c?: string, o?: { count?: string }) { cols = String(c ?? ""); wantCount = !!o?.count; return b; },
      upsert(row: any) { op = "upsert"; payload = row; return Promise.resolve(run()); },
      insert(row: any) { op = "insert"; payload = row; return Promise.resolve(run()); },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      gt(c: string, v: any) { gts.push([c, v]); return b; },
      is(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { inF = [c, v]; return b; },
      order(c: string, o?: { ascending?: boolean }) { orderF = [c, o?.ascending !== false]; return b; },
      range(from: number, to: number) { rangeF = [from, to]; return Promise.resolve(run()); },
      limit(n: number) { lim = n; return Promise.resolve(run()); },
      maybeSingle() { return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _snaps: snaps, _versions: versions, _updates: updates, _events: events };
}

describe("intelProjection aggregator — deriveComponents (conservative)", () => {
  it("maps presence P0→0, P4→1; freshness = 1 − ageRatio^1.5 (spec §9); independence saturates at k", () => {
    assert.equal(deriveComponents(baseEvidence({ maxPresenceLevel: "P0" })).presence, 0);
    assert.equal(deriveComponents(baseEvidence({ maxPresenceLevel: "P4" })).presence, 1);
    assert.equal(deriveComponents(baseEvidence({ ageRatio: 0.25 })).freshness, 1 - Math.pow(0.25, 1.5), "0.875 — the linear curve gave 0.75");
    assert.equal(deriveComponents(baseEvidence({ ageRatio: 0 })).freshness, 1);
    assert.equal(deriveComponents(baseEvidence({ ageRatio: 1 })).freshness, 0, "at the TTL it is 0");
    assert.equal(deriveComponents(baseEvidence({ ageRatio: 2 })).freshness, 0, "stale clamps to 0");
    assert.equal(deriveComponents(baseEvidence({ distinctActors: 15 })).independence, 1, "saturates at k=15");
    assert.equal(deriveComponents(baseEvidence({ distinctActors: 3 })).independence, 0.2);
  });
  it("agreement is neutral with no confirmations, the agree-fraction otherwise", () => {
    assert.equal(deriveComponents(baseEvidence()).agreement, 0.5);
    assert.equal(deriveComponents(baseEvidence({ agrees: 2, disagrees: 1 })).agreement, 2 / 3);
  });
  it("source reliability + evidence quality reflect the strongest evidence", () => {
    assert.equal(deriveComponents(baseEvidence({ sourceClass: "firsthand_unverified" })).sourceReliability, 0.5);
    assert.equal(deriveComponents(baseEvidence({ sourceClass: "official_signed" })).sourceReliability, 1);
    assert.equal(deriveComponents(baseEvidence({ hasEvidence: false })).evidenceQuality, 0.3);
    assert.equal(deriveComponents(baseEvidence({ hasEvidence: true })).evidenceQuality, 0.8);
  });
  it("a conflicting claim carries a material-conflict penalty", () => {
    assert.deepEqual(derivePenalties(baseEvidence({ conflicting: true })), { materialConflict: 0.2 });
    assert.deepEqual(derivePenalties(baseEvidence()), {});
  });
});

describe("intelProjection aggregator — assembleClaimInput (real evidence)", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());
  const claim: ClaimRow = { id: "c1", subject_id: "place-dn-1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: OBSERVED };

  it("EXCLUDES moderation-invalidated content (blocked/removed/restricted) from the cohort", async () => {
    const db = makeDb({
      flags: {},
      observations: [
        { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, moderation_state: "allowed" },
        { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, moderation_state: "pending" },
        { actor_id: "a3", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, moderation_state: "blocked" },
        { actor_id: "a4", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, moderation_state: "removed" },
        { actor_id: "a5", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, moderation_state: "restricted" },
      ],
      confirmations: [],
      policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
    });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 2, "only 'allowed' + 'pending' count; blocked/removed/restricted excluded");
  });

  it("counts DISTINCT fresh observers and confirmation stances", async () => {
    const db = makeDb({
      flags: {},
      observations: [
        { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null },
        { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P1", source_class: "firsthand_unverified", expires_at: null },
        { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null }, // dup actor
      ],
      confirmations: [{ stance: "agree", claim_id: "c1" }, { stance: "agree", claim_id: "c1" }, { stance: "disagree", claim_id: "c1" }],
      policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
    });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 2, "a1 counted once");
    assert.equal(input.claimType, "crowd.level");
    assert.deepEqual(input.value, { level: "busy" });
    assert.equal(input.components.agreement, 2 / 3);
    assert.equal(input.components.presence, 0.25, "strongest presence = P1");
    const fr = input.components.freshness;
    assert.ok(fr !== undefined && fr > 0.75 && fr < 0.85, `fresh (15/45 → 1 − (1/3)^1.5 ≈ 0.81), got ${fr}`);
    assert.deepEqual(input.freshness, { ageSeconds: 15 * 60, ttlSeconds: 2700 }, "the (age, ttl) inputs travel with the input for the replay record");
    assert.deepEqual(input.inputClaimVersions, [{ claim_id: "c1", updated_at: null, version: null, status: "active" }], "Table-17 lineage names the claim row; version fields null until 2274 columns are read");
    assert.deepEqual(input.candidateLineage, { observations_total: 3, after_freshness: 3, after_consent: 3, freshness_extenders: 0 }, "§24 counts: no observation carries observed_at, so none can extend");
    // No group_key on these observations → distinctGroups is 0 (finite), not fabricated.
    // The gate then returns below_group_threshold rather than invalid_input.
    assert.equal(input.distinctGroups, 0, "no group_key → zero groups, never invented");
    assert.equal(input.maxGroupShare, 0, "finite share even with no grouped observations");
  });

  // ── The four reads, and what an unreadable table used to mean ──────────────
  // supabase-js RESOLVES on a database error. Each of these four reads had no
  // `.error` binding, so a rejected read came back as an empty result and the
  // aggregator scored it as a fact about the world.
  describe("a REJECTED read withholds the claim instead of publishing a low input", () => {
    const evidenceCase = (table: string, note: string) => {
      it(`${table}: ${note}`, async () => {
        const db = makeDb({
          flags: {},
          observations: [
            { id: "o1", actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: OBSERVED, group_key: "g1" },
            { id: "o2", actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: OBSERVED, group_key: "g2" },
          ],
          confirmations: [{ claim_id: "c1", stance: "agree" }],
          policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
          errorTable: table,
        });
        const input = await assembleClaimInput(db as any, claim, NOW);
        assert.equal(input.evidenceComplete, false, `a rejected ${table} read was scored as evidence`);
      });
    };
    evidenceCase("intel_observations", "an unreadable cohort is not an empty cohort");
    evidenceCase("intel_contribution_consent", "a consent read that FAILED is not a consent that was refused");
    evidenceCase("intel_evidence", "this one failed OPEN — no clustering means MORE independent groups");
    evidenceCase("intel_confirmations", "zero stances reads as 'nobody disagreed', not as 'we could not look'");

    // DV-83: a read the server CUT is not a read that failed — it resolves with
    // no error and 1000 rows — and it is not the cohort either. The aggregator
    // filters freshness in memory over EVERY observation ever stored for the
    // (subject, claim type), so a busy venue passes 1000 long before its fresh
    // cohort does; the server then hands back an arbitrary 1000 and the actor
    // count, the plurality value and the §11 gate are all computed on a sample.
    const cohort = (n: number) => Array.from({ length: n }, (_, i) => ({
      id: `oc-${String(i).padStart(5, "0")}`, actor_id: `ac-${i}`, subject_id: "place-dn-1", claim_type: "crowd.level",
      presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: OBSERVED, group_key: `g-${i}`,
    }));
    it("intel_observations: a cohort read CUT at the server's row cap withholds the claim", async () => {
      const db = makeDb({ flags: {}, observations: cohort(1200), confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }], serverMaxRows: 1000 });
      const input = await assembleClaimInput(db as any, claim, NOW);
      assert.equal(input.evidenceComplete, false, "1000 of 1200 observations were scored as the whole cohort");
    });
    it("intel_confirmations: a stance read CUT at the server's row cap withholds the claim", async () => {
      const confirmations = Array.from({ length: 1200 }, (_, i) => ({ claim_id: "c1", stance: i < 1000 ? "agree" : "disagree" }));
      const db = makeDb({ flags: {}, observations: cohort(3), confirmations, policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }], serverMaxRows: 1000 });
      const input = await assembleClaimInput(db as any, claim, NOW);
      assert.equal(input.evidenceComplete, false, "the 200 disagreements past the cap were read as 'nobody disagreed'");
    });
    it("intel_evidence: an independence-evidence read CUT at the cap withholds — the rows past it are the shared media that collapse a crew", async () => {
      const evidence = Array.from({ length: 1200 }, (_, i) => ({ observation_id: `oc-0000${i % 3}`, evidence_kind: "media", media_asset_id: `m-${i}`, detail: {} }));
      const db = makeDb({ flags: {}, observations: cohort(3), confirmations: [], evidence, policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }], serverMaxRows: 1000 });
      const input = await assembleClaimInput(db as any, claim, NOW);
      assert.equal(input.evidenceComplete, false);
    });
    it("a cohort and stance set UNDER the cap are complete under the same server rules — the guard is the cut, not the size", async () => {
      const confirmations = Array.from({ length: 999 }, () => ({ claim_id: "c1", stance: "agree" }));
      const db = makeDb({ flags: {}, observations: cohort(999), confirmations, policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }], serverMaxRows: 1000 });
      const input = await assembleClaimInput(db as any, claim, NOW);
      assert.equal(input.evidenceComplete, true);
    });

    it("with every table readable the same fixture is evidenceComplete — so the flag is the error, not the fixture", async () => {
      const db = makeDb({
        flags: {},
        observations: [
          { id: "o1", actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: OBSERVED, group_key: "g1" },
          { id: "o2", actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: OBSERVED, group_key: "g2" },
        ],
        confirmations: [{ claim_id: "c1", stance: "agree" }],
        policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
      });
      const input = await assembleClaimInput(db as any, claim, NOW);
      assert.notEqual(input.evidenceComplete, false);
      assert.equal(input.distinctActors, 2, "vacuity guard: the happy path really did read a cohort");
    });

    it("THE CONSEQUENCE: the pass writes NO snapshot and leaves a serving one untouched", async () => {
      // A snapshot that is live right now. The claim behind it is live-eligible,
      // so the reconciliation will not expire it; the only thing that could
      // change it is the projection writing over it.
      const serving = {
        id: "snap-live", subject_id: "place-dn-1", zone_id: null, claim_type: "crowd.level",
        value: { level: "busy" }, confidence: 0.8, confidence_band: "live",
        privacy_eligible: true, source_count: 20,
        observed_at: OBSERVED, expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      };
      const db = makeDb({
        flags: { intel_claim_projection_crowd: true },
        claims: [{ id: "c1", subject_id: "place-dn-1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: OBSERVED }],
        observations: [], confirmations: [],
        policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
        snapshots: [serving],
        errorTable: "intel_confirmations",
      });
      const r = await runIntelProjectionPass({ client: db as any, now: NOW });
      assert.equal(r.reason, null);
      assert.equal(r.written, 0, "a claim with an unreadable confirmations table was still published");
      assert.equal(r.suppressed, 0, "a rejected read was persisted as privacy_eligible=false — a wrong answer about a real venue");
      assert.equal(r.skipped, 1, "the claim must be SKIPPED, and the count must say so");
      const after = db._snaps.find((x: any) => x.id === "snap-live");
      assert.equal(after.privacy_eligible, true, "the serving snapshot was overwritten on a transient read error");
      assert.equal(db._snaps.length, 1, "a second snapshot row was written for a claim we could not evaluate");
    });
  });

  it("freshness tracks the LATEST observation, not the frozen anchor claim's observed_at", async () => {
    // Anchor claim is STALE (observed 3h ago, TTL 45m → ageRatio > 1), but fresh
    // consented observations arrived 5 min ago. Freshness must reflect the fresh
    // reports, not the frozen anchor (regression: the key went dark forever).
    const staleClaim: ClaimRow = {
      id: "c-old", subject_id: "place-dn-1", zone_id: null, claim_type: "crowd.level",
      value: { level: "busy" }, status: "active",
      observed_at: new Date(NOW.getTime() - 180 * 60_000).toISOString(), // 3h ago
    };
    const recent = new Date(NOW.getTime() - 5 * 60_000).toISOString(); // 5 min ago
    const db = makeDb({
      flags: {},
      observations: [
        { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: recent },
        { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: recent },
      ],
      confirmations: [],
      policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }], // 45m TTL
    });
    const input = await assembleClaimInput(db as any, staleClaim, NOW);
    // 5 min into a 45 min TTL → freshness ≈ 1 − 5/45 ≈ 0.89, NOT 0 (which the
    // frozen 3h-old anchor would have produced).
    assert.ok(input.components.freshness! > 0.8, `expected fresh, got ${input.components.freshness}`);
    assert.equal(input.observedAt, recent, "snapshot observed_at follows the latest observation");
  });

  it("EXCLUDES actors who withdrew consent from the cohort (D4 parity with promotion)", async () => {
    const db = makeDb({
      flags: {},
      observations: [
        { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null },
        { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null },
        { actor_id: "a3", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null },
      ],
      confirmations: [],
      policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
      withdrawnActors: ["a2", "a3"], // withdrew after contributing
    });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 1, "only the consenting actor a1 counts; a2/a3 withdrew");
  });

  it("derives distinctGroups + actor-based maxGroupShare from group_key (leak-safe)", async () => {
    // 15 distinct actors: 5 in one crew (share group_key 'g-crew'), 10 solo (own keys).
    const obs = [
      ...Array.from({ length: 5 }, (_, i) => ({ actor_id: `crew-${i}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: "g-crew" })),
      ...Array.from({ length: 10 }, (_, i) => ({ actor_id: `solo-${i}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: `g-solo-${i}` })),
    ];
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 15);
    assert.equal(input.distinctGroups, 11, "1 crew + 10 solo = 11 groups");
    // Max group = the crew (5 actors) out of 15 grouped actors → 1/3.
    assert.ok(Math.abs((input.maxGroupShare ?? 0) - 5 / 15) < 1e-9, "actor-based share, crew is 5/15");
  });

  it("counts one organized crew as a SINGLE dominating group (the leak it must catch)", async () => {
    const obs = Array.from({ length: 15 }, (_, i) => ({ actor_id: `crew-${i}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: "one-crew" }));
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 15, "15 people");
    assert.equal(input.distinctGroups, 1, "but ONE group — cannot read as 15 independent parties");
    assert.equal(input.maxGroupShare, 1, "the single group is 100% → single_group_dominates at the gate");
  });

  it("maxGroupShare uses the DISTINCT-actor union, so overlapping crews cannot dilute the share", async () => {
    // 15 actors each in 6 shared crews → 6 group_keys, each holding all 15 actors.
    // Summing per-group sizes (90) would give 15/90=0.167 and PUBLISH (the leak);
    // the union denominator (15) gives 15/15=1.0 → single_group_dominates.
    const obs: any[] = [];
    for (let a = 0; a < 15; a++) for (let g = 0; g < 6; g++)
      obs.push({ actor_id: `a${a}`, subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, group_key: `g${g}` });
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.distinctActors, 15);
    assert.equal(input.distinctGroups, 6, "6 overlapping crews");
    assert.equal(input.maxGroupShare, 1, "union share 1.0, NOT the diluted 15/90");
  });

  // ── H1: the SERVED value is the live cohort's plurality, not a frozen anchor ──
  it("serves the cohort PLURALITY value, not the frozen single-anchor claim.value (H1)", async () => {
    // The promoted anchor froze claim.value to one contributor's stale answer
    // ('dead'); the live cohort overwhelmingly says 'busy'. The served value must
    // reflect the cohort, not the anchor.
    const anchored: ClaimRow = { ...claim, value: { level: "dead" } };
    const obs = [
      { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "a3", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "a4", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "quiet" } },
    ];
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, anchored, NOW);
    assert.deepEqual(input.value, { level: "busy" }, "plurality 'busy' (3/4), not the anchor 'dead' nor the minority 'quiet'");
  });

  it("falls back to the anchor value when the cohort has no value (never invents one)", async () => {
    const anchored: ClaimRow = { ...claim, value: { level: "moderate" } };
    // Observations carry no value at all → nothing to tally → serve the anchor.
    const obs = [
      { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null },
      { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null },
    ];
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, anchored, NOW);
    assert.deepEqual(input.value, { level: "moderate" }, "no cohort value → anchor value stands");
  });

  // ── H4: a WITHDRAWN contributor's value stops being served ────────────────────
  it("a withdrawn contributor's value stops being served even when it was the anchor (H4)", async () => {
    // The frozen anchor value ('packed') was one of three actors who have since
    // withdrawn consent. Counting them, 'packed' (3) would beat 'busy' (2); with
    // the consent filter the live cohort is only the two 'busy' reporters, so the
    // served value must be 'busy' and 'packed' must disappear.
    const anchored: ClaimRow = { ...claim, value: { level: "packed" } };
    const obs = [
      { actor_id: "pk1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "packed" } },
      { actor_id: "pk2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "packed" } },
      { actor_id: "pk3", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "packed" } },
      { actor_id: "b1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "b2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
    ];
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }], withdrawnActors: ["pk1", "pk2", "pk3"] });
    const input = await assembleClaimInput(db as any, anchored, NOW);
    assert.equal(input.distinctActors, 2, "only the two consenting actors count");
    assert.deepEqual(input.value, { level: "busy" }, "the withdrawn 'packed' anchor no longer serves");
  });

  // ── Finding 3: the 'conflicting' penalty path is now REACHABLE ─────────────────
  it("marks a genuinely disagreeing cohort as conflicting (value tie OR confirmation split)", async () => {
    // (a) Value tie: 2 say 'busy', 2 say 'quiet' → no plurality → conflict.
    const tie = [
      { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "a3", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "quiet" } },
      { actor_id: "a4", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "quiet" } },
    ];
    const tieInput = await assembleClaimInput(
      makeDb({ flags: {}, observations: tie, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] }) as any,
      claim, NOW,
    );
    assert.deepEqual(tieInput.penalties, { materialConflict: 0.2 }, "a value tie is genuine disagreement");

    // (b) Confirmation split: 4 confirmations, 3 disagree (≥ half) → conflict.
    const confInput = await assembleClaimInput(
      makeDb({
        flags: {},
        observations: [{ actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } }],
        confirmations: [{ stance: "agree", claim_id: "c1" }, { stance: "disagree", claim_id: "c1" }, { stance: "disagree", claim_id: "c1" }, { stance: "disagree", claim_id: "c1" }],
        policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
      }) as any,
      claim, NOW,
    );
    assert.deepEqual(confInput.penalties, { materialConflict: 0.2 }, "a majority-disagree confirmation split is conflict");

    // (c) Control: a clear plurality with agreeing confirmations is NOT conflict.
    const agree = [
      { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "busy" } },
      { actor_id: "a3", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, value: { level: "quiet" } },
    ];
    const okInput = await assembleClaimInput(
      makeDb({ flags: {}, observations: agree, confirmations: [{ stance: "agree", claim_id: "c1" }, { stance: "agree", claim_id: "c1" }], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] }) as any,
      claim, NOW,
    );
    assert.deepEqual(okInput.penalties, {}, "clear plurality + agreement → no conflict penalty");
  });

  // ── I1: Table 16 — only a family-qualified observation EXTENDS the freshness clock ─
  it("REFUSES to extend crowd.level when the anchoring person merely taps again; an independent person extends it", async () => {
    // The anchor observation (a1, 30 min ago) is what the claim's observed_at
    // was copied from. a1 taps again 5 min ago. Before I1 that re-tap moved the
    // freshness clock; Table 16 says crowd level needs an INDEPENDENT
    // reconfirmation, so the clock must stay at the anchor.
    const anchorAt = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const retap = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const anchored: ClaimRow = { ...claim, observed_at: anchorAt };
    const sameActor = [
      { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: anchorAt, value: { level: "busy" } },
      { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: retap, value: { level: "busy" } },
    ];
    const refused = await assembleClaimInput(
      makeDb({ flags: {}, observations: sameActor, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] }) as any,
      anchored, NOW,
    );
    assert.equal(refused.observedAt, anchorAt, "the same person re-tapping does NOT extend crowd level (Table 16: independent reconfirmation)");
    assert.equal(refused.candidateLineage?.freshness_extenders, 0);
    assert.equal(refused.distinctActors, 1, "the re-tap still counts as a person in the cohort — it just does not make the claim young");

    // Same shape, but the second tap is a DIFFERENT person → independent → extends.
    const independent = [sameActor[0], { ...sameActor[1], actor_id: "a2" }];
    const extended = await assembleClaimInput(
      makeDb({ flags: {}, observations: independent, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] }) as any,
      anchored, NOW,
    );
    assert.equal(extended.observedAt, retap, "an independent reconfirmation extends the clock");
    assert.equal(extended.candidateLineage?.freshness_extenders, 1);

    // And a hearsay tip from a third person never extends anything, any family.
    const hearsay = [sameActor[0], { ...sameActor[1], actor_id: "a3", source_class: "hearsay" }];
    const unqualified = await assembleClaimInput(
      makeDb({ flags: {}, observations: hearsay, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] }) as any,
      anchored, NOW,
    );
    assert.equal(unqualified.observedAt, anchorAt, "hearsay is not a qualified source and cannot extend");
  });

  // ── H3: the publication-delay anchor is the EARLIEST observation, not the newest ─
  it("keys the publication-delay anchor to the EARLIEST observation while freshness tracks the newest (H3)", async () => {
    const earliest = new Date(NOW.getTime() - 40 * 60_000).toISOString(); // 40 min ago
    const newest = new Date(NOW.getTime() - 2 * 60_000).toISOString();    // 2 min ago
    const obs = [
      { actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: earliest, value: { level: "busy" } },
      { actor_id: "a2", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: newest, value: { level: "busy" } },
    ];
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, claim, NOW);
    assert.equal(input.observedAt, newest, "freshness/serving clock follows the newest observation");
    assert.equal(input.publicationAnchorAt, earliest, "the publication-delay clock is anchored to the earliest");
  });

  // ── Finding 5: the code-side absolute hard-expiry ceiling is derived ──────────
  it("derives an absolute hard-expiry ceiling from the claim's frozen observed_at (finding 5)", async () => {
    const t0 = new Date(NOW.getTime() - 30 * 60_000).toISOString(); // claim anchored 30 min ago
    const anchored: ClaimRow = { ...claim, observed_at: t0 };
    const obs = [{ actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: new Date(NOW.getTime() - 60_000).toISOString(), value: { level: "busy" } }];
    const db = makeDb({ flags: {}, observations: obs, confirmations: [], policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }] });
    const input = await assembleClaimInput(db as any, anchored, NOW);
    const hardSeconds = CLAIM_TYPES.find((c) => c.claimType === "crowd.level")!.hardExpirySeconds;
    assert.equal(input.hardExpiresAt, new Date(Date.parse(t0) + hardSeconds * 1000).toISOString(),
      "ceiling = frozen anchor observed_at + claim-type hard-expiry, never the moving newest observation");
  });
});

describe("intelProjection scheduler — runIntelProjectionPass (flag-gated, fail-closed)", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());
  const claim = { id: "c1", subject_id: "place-dn-1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: OBSERVED };
  const cfgBase = {
    claims: [claim],
    observations: [{ actor_id: "a1", subject_id: "place-dn-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null }],
    confirmations: [],
    policies: [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }],
  };

  it("no client → no_client; flag off → disabled; neither writes", async () => {
    const off = await runIntelProjectionPass({ client: null });
    assert.equal(off.reason, "no_client");
    const db = makeDb({ ...cfgBase, flags: { intel_claim_projection_crowd: false } });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, "disabled");
    assert.equal(r.skippedRun, true);
    assert.equal(db._snaps.length, 0);
  });

  it("flag on → projects claims into snapshots, suppressed while group data is absent (gate not weakened)", async () => {
    const db = makeDb({ ...cfgBase, flags: { intel_claim_projection_crowd: true } });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, null);
    assert.equal(r.subjects, 1);
    assert.equal(db._snaps.length, 1, "a snapshot was written by the automatic pass");
    assert.equal(db._snaps[0].privacy_eligible, false, "suppressed: no group data, so the privacy gate refuses");
    assert.equal(r.written, 0);
    assert.equal(r.suppressed, 1);
  });

  // The money path, end to end through the real aggregator + gate + projection: a
  // venue with a genuine group signal PUBLISHES; one where the same people are one
  // crew, or carry no group signal, is SUPPRESSED. This is the composition the four
  // merged PRs (scheduler, aggregator, group signal, gate) must produce together.
  const crowdObs = (n: number, groupOf: (i: number) => string | null) =>
    Array.from({ length: n }, (_, i) => ({
      actor_id: `a${i}`, subject_id: "place-dn-1", claim_type: "crowd.level",
      presence_level: "P4", source_class: "firsthand_unverified", expires_at: null, group_key: groupOf(i),
    }));

  it("flag on → PUBLISHES a snapshot when 15 actors form 5 independent groups", async () => {
    const db = makeDb({ ...cfgBase, observations: crowdObs(15, (i) => `g${i % 5}`), flags: { intel_claim_projection_crowd: true } });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, null);
    assert.equal(r.written, 1, "15 actors × 5 independent groups clears every gate");
    assert.equal(r.suppressed, 0);
    const snap = db._snaps[0];
    assert.equal(snap.privacy_eligible, true);
    assert.equal(snap.distinct_actors, 15);
    assert.ok(snap.confidence >= 0.55, "band ≥ likely_current → servable as a LIVE label");
  });

  it("flag on → SUPPRESSES when those 15 actors are ONE crew (single_group_dominates)", async () => {
    const db = makeDb({ ...cfgBase, observations: crowdObs(15, () => "one-crew"), flags: { intel_claim_projection_crowd: true } });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.written, 0, "one organized crew of 15 cannot publish as a crowd");
    assert.equal(r.suppressed, 1);
    assert.equal(db._snaps[0].privacy_eligible, false);
  });

  it("flag on → SUPPRESSES when the 15 actors carry no group signal (below_group_threshold)", async () => {
    const db = makeDb({ ...cfgBase, observations: crowdObs(15, () => null), flags: { intel_claim_projection_crowd: true } });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.written, 0);
    assert.equal(r.suppressed, 1);
    assert.equal(db._snaps[0].privacy_eligible, false);
  });

  it("AT-03: groups claims by (subject, zone) — one snapshot per zone, no cross-zone conflict — and fails closed on a claim-read error", async () => {
    const err = await runIntelProjectionPass({ client: makeDb({ ...cfgBase, flags: { intel_claim_projection_crowd: true }, errorTable: "intel_claims" }) as any, now: NOW });
    assert.equal(err.reason, "error");
    assert.equal(err.skippedRun, true);
  });

  // ── STAMP·H6: snapshot reconciliation must read the FULL live-key set ──────────
  // The expiry step force-expires any servable snapshot whose (subject, zone,
  // claim_type) key is not backed by a live-eligible claim. A range-less PostgREST
  // read silently caps at 1000 rows, so past 1000 live claims the live-key set is
  // incomplete and snapshots backed by claims in the tail are wrongly expired —
  // silent deletion of servable intelligence. The fake below enforces that cap on
  // an unpaginated read but serves .range() slices, so the unpaginated (pre-fix)
  // reconciliation sees only 1000 keys and expires, while the paginated fix does not.
  const RECON_CLAIM_COUNT = 1500;
  const reconClaimType = (i: number) => `ct-${String(i).padStart(4, "0")}`;
  const RECON_TAIL_INDEX = 1200; // beyond the 1000-row cap → only a paginated read reaches it
  const RECON_TAIL_TYPE = reconClaimType(RECON_TAIL_INDEX);
  // 1500 live claims, all one (subject, zone) so the projection groups them once,
  // and each with a claim_type that has NO freshness policy so projectClaim skips
  // it — the projection writes nothing and leaves only the seeded snapshot below.
  const reconClaims = () =>
    Array.from({ length: RECON_CLAIM_COUNT }, (_, i) => ({
      id: `rc-${i}`, subject_id: "subj-recon", zone_id: null,
      claim_type: reconClaimType(i), value: { level: "busy" }, status: "active", observed_at: OBSERVED,
    }));
  // A servable snapshot whose key matches a live claim in the 1001–1500 TAIL.
  const tailSnapshot = () => ({
    id: "snap-tail", subject_id: "subj-recon", zone_id: "", claim_type: RECON_TAIL_TYPE,
    value: { level: "busy" }, confidence: 0.9, confidence_band: "very_current",
    source_count: 15, distinct_actors: 15, privacy_eligible: true,
    observed_at: OBSERVED, expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
  });

  it("does NOT expire a servable snapshot backed by a live claim past the 1000-row read cap (STAMP·H6)", async () => {
    const db = makeDb({
      flags: { intel_claim_projection_crowd: true },
      claims: reconClaims(),
      observations: [],
      confirmations: [],
      policies: [], // no policy → projection skips every claim, writing no snapshots
      snapshots: [tailSnapshot()],
    });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, null, "pass completes");

    // The snapshot's claim (ct-1200) is live-eligible, so it must NOT be expired.
    const expiredTail = db._updates.some((u) => u.ids.includes("snap-tail"));
    assert.equal(expiredTail, false, "the tail snapshot must not be force-expired: its claim is still live");
    const snap = db._snaps.find((s: any) => s.id === "snap-tail");
    assert.ok(snap, "snapshot still present");
    assert.equal(snap.privacy_eligible, true, "snapshot stays servable (privacy_eligible untouched)");
  });

  // ── I1 / §24: completion status of a correction's invalidation targets ──────
  it("AT-09: expires an ORPHANED servable snapshot and emits intel.correction.invalidation.completed naming it (§24 completion status)", async () => {
    // A servable snapshot whose claim has been superseded (a correction's
    // invalidation target) — no live-eligible claim stands behind its key.
    const orphan = { ...tailSnapshot(), id: "snap-orphan", claim_type: "crowd.level" };
    const db = makeDb({
      flags: { intel_claim_projection_crowd: true },
      claims: [{ id: "c-old", subject_id: "subj-recon", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "superseded", observed_at: OBSERVED }],
      observations: [], confirmations: [], policies: [],
      snapshots: [orphan],
    });
    const records: any[] = [];
    const m = mock.method(logger, "info", (obj: unknown) => { records.push(obj); });
    try {
      const r = await runIntelProjectionPass({ client: db as any, now: NOW });
      assert.equal(r.reason, null);
    } finally { m.mock.restore(); }
    assert.ok(db._updates.some((u) => u.ids.includes("snap-orphan")), "the orphan is force-expired");
    const done = records.find((r) => r?.event === "intel.correction.invalidation.completed");
    assert.ok(done, "a structured completion record is emitted");
    assert.deepEqual(done.snapshot_ids, ["snap-orphan"]);
    assert.deepEqual(done.keys, [{ subject_id: "subj-recon", zone_id: "", claim_type: "crowd.level" }]);
    assert.equal(done.expired, 1);
    assert.ok(!JSON.stringify(done).includes("actor"), "keys and ids only — no actor in the completion log");
  });

  it("aborts reconciliation and expires NOTHING when a live-key page errors (partial read is fail-closed)", async () => {
    // Page 1 (offset 0) succeeds with 1000 keys — none of them the tail key — but
    // page 2 (offset 1000, which carries the tail key) errors. A partial read must
    // never delete: the whole reconciliation aborts, expiring nothing.
    const db = makeDb({
      flags: { intel_claim_projection_crowd: true },
      claims: reconClaims(),
      observations: [],
      confirmations: [],
      policies: [],
      snapshots: [tailSnapshot()],
      // The live-key read selects the key and nothing else; the pass's own claim
      // read selects `value` too, and is not this test's subject (it has its own
      // case below).
      rangeError: { table: "intel_claims", minOffset: 1000, columns: /^(id, )?subject_id, zone_id, claim_type$/ },
    });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, null, "pass still completes (reconciliation failure is non-fatal)");

    const anyExpiry = db._updates.some((u) => u.table === "intel_state_snapshots");
    assert.equal(anyExpiry, false, "an errored live-key page must abort expiry entirely");
    const snap = db._snaps.find((s: any) => s.id === "snap-tail");
    assert.equal(snap.privacy_eligible, true, "servable snapshot untouched after a partial live-key read");
  });

  // ── The expiry WRITE, not the reads that decide it ──────────────────────────
  // The reads above are fail-closed to the point of paranoia. The UPDATE that
  // acts on them was awaited and its `.error` never looked at, and TWO things
  // downstream assert it worked: the §24 completion log ("expired: N", by id) and
  // the `intel.state.changed / expired` domain events pushed for the same
  // orphans. supabase-js resolves on a database error, so a rejected update
  // produced both records for an invalidation that did not happen — on an
  // append-only spine that blocks UPDATE and DELETE (2130), i.e. permanently.
  it("a REJECTED expiry update claims nothing: no completion log, no 'expired' domain event", async () => {
    const orphan = { ...tailSnapshot(), id: "snap-orphan", claim_type: "crowd.level" };
    const db = makeDb({
      flags: { intel_claim_projection_crowd: true },
      claims: [{ id: "c-old", subject_id: "subj-recon", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "superseded", observed_at: OBSERVED }],
      observations: [], confirmations: [], policies: [],
      snapshots: [orphan],
      updateError: { table: "intel_state_snapshots" },
    });
    const records: any[] = [];
    const m = mock.method(logger, "info", (obj: unknown) => { records.push(obj); });
    let r: any;
    try {
      r = await runIntelProjectionPass({ client: db as any, now: NOW });
    } finally { m.mock.restore(); }

    assert.equal(r.reason, null, "pass still completes — a failed expiry is not fatal to the projection");
    // It TRIED (vacuity guard: a test that expires nothing because it found no
    // orphan would pass every assertion below for the wrong reason).
    const attempt = db._updates.find((u) => u.table === "intel_state_snapshots" && u.ids.includes("snap-orphan"));
    assert.ok(attempt, "the pass never even attempted the expiry — this test proves nothing");
    // The snapshot is still serving.
    const snap = db._snaps.find((s: any) => s.id === "snap-orphan");
    assert.equal(snap.privacy_eligible, true, "a rejected update must not have changed the row");
    // ...and nothing anywhere says otherwise.
    assert.equal(
      records.some((x) => x?.event === "intel.correction.invalidation.completed"), false,
      "a completion status was recorded for an invalidation the database refused",
    );
    const expiredEvents = db._events.filter((e: any) => e?.payload?.intel?.transition === "expired");
    assert.deepEqual(expiredEvents, [], "an 'expired' transition was written to the append-only spine for a snapshot that is still live");
  });

  it("the SAME fixture with the update accepted DOES record both — so the guard above is the error check, not the fixture", async () => {
    const orphan = { ...tailSnapshot(), id: "snap-orphan", claim_type: "crowd.level" };
    const db = makeDb({
      flags: { intel_claim_projection_crowd: true },
      claims: [{ id: "c-old", subject_id: "subj-recon", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "superseded", observed_at: OBSERVED }],
      observations: [], confirmations: [], policies: [],
      snapshots: [orphan],
    });
    const records: any[] = [];
    const m = mock.method(logger, "info", (obj: unknown) => { records.push(obj); });
    try { await runIntelProjectionPass({ client: db as any, now: NOW }); } finally { m.mock.restore(); }
    assert.ok(records.some((x) => x?.event === "intel.correction.invalidation.completed"), "completion log missing on the happy path");
    assert.equal(db._events.filter((e: any) => e?.payload?.intel?.transition === "expired").length, 1);
  });

  // ── DV-83: the reads that decide what is projected and what is expired ──────
  // The fixtures above model PostgREST's implicit cap on a range-less read but
  // treat an explicit .limit()/.range() as uncapped, and every read as stably
  // ordered. Neither is true of the real server: db-max-rows caps EVERY response,
  // and a read with no ORDER BY has no defined order, so consecutive OFFSET pages
  // may overlap and skip. These cases set both and pin the consequences.
  describe("DV-83 — full, ordered reads under the real server's rules", () => {
    // reconClaims' ids are unpadded, so in id order `rc-1200` sorts before
    // `rc-2` and the tail key would sit in the FIRST page of a keyset read —
    // making every case below vacuous. Padded, the tail is row 1201 of 1500 in
    // id order as well as in insertion order.
    const reconClaimsById = () => reconClaims().map((c, i) => ({ ...c, id: `rc-${String(i).padStart(4, "0")}` }));
    it("projects EVERY live claim when there are more than db-max-rows of them (the claim read is not cut at 1000)", async () => {
      const claims = Array.from({ length: 1200 }, (_, i) => ({
        id: `mc-${String(i).padStart(5, "0")}`, subject_id: `subj-${i}`, zone_id: null,
        claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: OBSERVED,
      }));
      const db = makeDb({ flags: { intel_claim_projection_crowd: true }, claims, observations: [], confirmations: [], policies: [], serverMaxRows: 1000 });
      const r = await runIntelProjectionPass({ client: db as any, now: NOW });
      assert.equal(r.reason, null);
      assert.equal(r.subjects, 1200, "every live claim's subject is projected — a 5000 .limit() does not lift the 1000-row server cap");
    });

    it("a claim-read page that FAILS after the first is an error, not a smaller pass", async () => {
      const claims = Array.from({ length: 1200 }, (_, i) => ({
        id: `mc-${String(i).padStart(5, "0")}`, subject_id: `subj-${i}`, zone_id: null,
        claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: OBSERVED,
      }));
      const db = makeDb({
        flags: { intel_claim_projection_crowd: true }, claims, observations: [], confirmations: [], policies: [],
        serverMaxRows: 1000, rangeError: { table: "intel_claims", minOffset: 1, columns: /value/ },
      });
      const r = await runIntelProjectionPass({ client: db as any, now: NOW });
      assert.equal(r.reason, "error", "a partial claim read must not be reported as a complete pass");
      assert.equal(r.subjects, 0);
    });

    it("does NOT expire a live-backed snapshot when unordered OFFSET pages would overlap and skip its key", async () => {
      const db = makeDb({
        flags: { intel_claim_projection_crowd: true }, claims: reconClaimsById(), observations: [], confirmations: [],
        policies: [], snapshots: [tailSnapshot()], serverMaxRows: 1000, unstableUnorderedPages: true,
      });
      const r = await runIntelProjectionPass({ client: db as any, now: NOW });
      assert.equal(r.reason, null);
      assert.equal(db._updates.some((u) => u.ids.includes("snap-tail")), false,
        "the tail snapshot's claim is live; a page that skipped its key must not delete live intelligence");
      assert.equal(db._snaps.find((s: any) => s.id === "snap-tail").privacy_eligible, true);
    });

    it("does NOT treat a page shortened by a server cap BELOW the page size as the last page", async () => {
      // A Max-rows setting of 500 makes every page short. Ending on a short page
      // reads 500 keys, calls the set complete, and expires the snapshot whose
      // key was in rows 501–1500.
      const db = makeDb({
        flags: { intel_claim_projection_crowd: true }, claims: reconClaimsById(), observations: [], confirmations: [],
        policies: [], snapshots: [tailSnapshot()], serverMaxRows: 500,
      });
      const r = await runIntelProjectionPass({ client: db as any, now: NOW });
      assert.equal(r.reason, null);
      assert.equal(db._updates.some((u) => u.ids.includes("snap-tail")), false,
        "a capped page is not the end of the set; expiring on it deletes live intelligence");
    });

    it("STILL expires a genuine orphan under the same server rules — the guard is the read, not a refusal to expire", async () => {
      const orphan = { ...tailSnapshot(), id: "snap-orphan", claim_type: "ct-9999" };
      const db = makeDb({
        flags: { intel_claim_projection_crowd: true }, claims: reconClaimsById(), observations: [], confirmations: [],
        policies: [], snapshots: [tailSnapshot(), orphan], serverMaxRows: 500, unstableUnorderedPages: true,
      });
      await runIntelProjectionPass({ client: db as any, now: NOW });
      assert.ok(db._updates.some((u) => u.ids.includes("snap-orphan")), "the orphan (no live claim behind it) is expired");
      assert.equal(db._updates.some((u) => u.ids.includes("snap-tail")), false, "the live-backed one is not");
    });
  });
});
