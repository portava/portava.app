/**
 * Intel projection scheduler + aggregator (IG-04 driver) — the missing piece that
 * makes claim → snapshot projection run automatically. Proves: the confidence
 * components are derived conservatively; the aggregator counts DISTINCT observers
 * (the k-anon input) and confirmation stances from real rows; and the scheduler
 * pass is flag-gated, fail-closed, groups by (subject, zone), and upserts
 * snapshots — which stay privacy-suppressed while group data is absent (the gate
 * refuses, it is not weakened).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
  policies?: any[]; snapshots?: any[]; errorTable?: string; withdrawnActors?: string[];
  // Inject an error on a specific PAGINATED page of `table`, but only once the
  // window has advanced to (or past) `minOffset` — lets a test succeed on page 1
  // and fail on a later page, proving a PARTIAL read expires nothing.
  rangeError?: { table: string; minOffset?: number };
}) {
  const snaps: any[] = [...(cfg.snapshots ?? [])];
  // I1: every snapshot write is preceded by an append to the version table.
  const versions: any[] = [];
  // Every .update(...).in("id",[...]) is recorded here so a test can assert which
  // snapshot ids (if any) the reconciliation force-expired.
  const updates: { table: string; ids: any[]; patch: any }[] = [];
  // D4: every observation actor is consented by default; withdrawnActors lets a
  // test mark some as withdrawn so the aggregator's consent filter can exclude them.
  const withdrawn = new Set(cfg.withdrawnActors ?? []);
  const consentRows = [...new Set((cfg.observations ?? []).map((o: any) => o.actor_id).filter(Boolean))]
    .map((id: string) => ({ user_id: id, enabled: !withdrawn.has(id), withdrawn_at: withdrawn.has(id) ? NOW.toISOString() : null }));
  function from(table: string) {
    let op: "select" | "upsert" | "update" | "insert" = "select"; let payload: any = null;
    const eqs: [string, any][] = []; const gts: [string, any][] = [];
    let inF: [string, any[]] | null = null; let lim = Infinity; let rangeF: [number, number] | null = null;
    // Observations default to moderation_state 'allowed' (explicit values override),
    // so fixtures that don't care about moderation still pass the aggregator's
    // pilot-claimable .in() filter; a fixture can set 'blocked'/'removed' to test exclusion.
    const src = (): any[] => (({ intel_claims: cfg.claims, intel_observations: (cfg.observations ?? []).map((o: any) => ({ moderation_state: "allowed", ...o })), intel_confirmations: cfg.confirmations, freshness_policies: cfg.policies, intel_state_snapshots: snaps, intel_contribution_consent: consentRows } as any)[table] ?? []);
    const match = (r: any) =>
      eqs.every(([c, v]) => r[c] === v)
      && gts.every(([c, v]) => r[c] != null && r[c] > v)
      && (!inF || inF[1].includes(r[inF[0]]));
    const rows = () => {
      const filtered = src().filter(match);
      if (rangeF) return filtered.slice(rangeF[0], rangeF[1] + 1);       // explicit pagination — exact slice
      if (lim !== Infinity) return filtered.slice(0, lim);               // explicit limit — honored as-is
      return filtered.slice(0, POSTGREST_IMPLICIT_CAP);                  // range-less/limit-less — silently capped
    };
    const run = () => {
      if (table === "feature_flags") { const f = eqs.find(([c]) => c === "flag")?.[1]; return { data: { enabled: Boolean(cfg.flags[f]) }, error: null }; }
      if (cfg.errorTable === table) return { data: null, error: { message: "boom" } };
      if (cfg.rangeError && cfg.rangeError.table === table && rangeF && rangeF[0] >= (cfg.rangeError.minOffset ?? 0)) {
        return { data: null, error: { message: "range boom" } };
      }
      if (op === "upsert") { snaps.push(...(Array.isArray(payload) ? payload : [payload])); return { data: null, error: null }; }
      if (op === "insert") {
        if (table === "intel_state_snapshot_versions") versions.push(...(Array.isArray(payload) ? payload : [payload]));
        return { data: null, error: null };
      }
      if (op === "update") {
        const ids = inF && inF[0] === "id" ? [...inF[1]] : [];
        for (const r of src()) if (match(r)) Object.assign(r, payload); // mutate the store in place
        updates.push({ table, ids, patch: payload });
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const b: any = {
      select() { return b; },
      upsert(row: any) { op = "upsert"; payload = row; return Promise.resolve(run()); },
      insert(row: any) { op = "insert"; payload = row; return Promise.resolve(run()); },
      update(patch: any) { op = "update"; payload = patch; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      gt(c: string, v: any) { gts.push([c, v]); return b; },
      is(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { inF = [c, v]; return b; },
      range(from: number, to: number) { rangeF = [from, to]; return Promise.resolve(run()); },
      limit(n: number) { lim = n; return Promise.resolve(run()); },
      maybeSingle() { return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _snaps: snaps, _versions: versions, _updates: updates };
}

describe("intelProjection aggregator — deriveComponents (conservative)", () => {
  it("maps presence P0→0, P4→1; freshness = 1 − ageRatio; independence saturates at k", () => {
    assert.equal(deriveComponents(baseEvidence({ maxPresenceLevel: "P0" })).presence, 0);
    assert.equal(deriveComponents(baseEvidence({ maxPresenceLevel: "P4" })).presence, 1);
    assert.equal(deriveComponents(baseEvidence({ ageRatio: 0.25 })).freshness, 0.75);
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
    assert.ok(input.components.freshness > 0.6 && input.components.freshness < 0.8, "fresh (15/45)");
    // No group_key on these observations → distinctGroups is 0 (finite), not fabricated.
    // The gate then returns below_group_threshold rather than invalid_input.
    assert.equal(input.distinctGroups, 0, "no group_key → zero groups, never invented");
    assert.equal(input.maxGroupShare, 0, "finite share even with no grouped observations");
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

  it("groups claims by (subject, zone) and fails closed on a claim-read error", async () => {
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
      rangeError: { table: "intel_claims", minOffset: 1000 },
    });
    const r = await runIntelProjectionPass({ client: db as any, now: NOW });
    assert.equal(r.reason, null, "pass still completes (reconciliation failure is non-fatal)");

    const anyExpiry = db._updates.some((u) => u.table === "intel_state_snapshots");
    assert.equal(anyExpiry, false, "an errored live-key page must abort expiry entirely");
    const snap = db._snaps.find((s: any) => s.id === "snap-tail");
    assert.equal(snap.privacy_eligible, true, "servable snapshot untouched after a partial live-key read");
  });
});
