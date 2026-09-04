/**
 * Intel projection aggregator (IG-04) — the missing PRODUCER-side assembly that
 * turns stored claims + their evidence into the ProjectionInput lib/intelProjection
 * consumes. Before this, projectAndStore was only ever called by tests with a
 * hand-built input, so nothing drove the projection in production.
 *
 * WHAT IT DERIVES, AND HOW CONSERVATIVELY. The one value that MUST be exact is
 * `distinctActors` — the privacy gate (lib/privacyGate) refuses to publish an
 * aggregate below k distinct contributors, so an over-count would be a k=1 leak.
 * It is counted as the number of DISTINCT observers of (subject, claim_type)
 * within the freshness window — real people, from intel_observations.actor_id.
 *
 * The seven confidence components are derived v1-conservatively: unknown or thin
 * evidence scores LOW, never high. That is fail-safe by construction — the
 * confidence FLOOR in lib/liveClaimRead only shows a snapshot as LIVE above a
 * band, so under-scoring hides a label; it never invents one. Presence is P0 for
 * all Phase-1 quick signals (capture hard-codes it), so a single unverified
 * report scores low and, lacking corroboration, is suppressed — exactly right.
 *
 * RUNTIME EFFECT: NONE on its own. The scheduler (lib/intelProjectionScheduler)
 * drives it, gated by intel_claim_projection_crowd.
 */
import type { ProjectionInput } from "./intelProjection.js";
import type { ConfidenceComponents, ConfidencePenalties } from "./confidenceScore.js";
import { PRIVACY_THRESHOLD_V1, PILOT_CLAIMABLE_MODERATION_STATES, CLAIM_TYPES } from "./intelContracts.js";
import { getPolicy } from "./freshnessPolicy.js";
import { isFlagEnabled } from "./featureFlags.js";
import { observationsHaveEligibleMediaEvidence } from "./media/mediaEvidenceLink.js";
import { assessConflict, type ConflictAssessment, type ConflictVote } from "./intelConflict.js";
import { clusterByIndependence, type IndependenceObservation } from "./intelIndependence.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * A stable, order-independent key for a claim value so equal values (including
 * equal objects whose keys were serialized in a different order) tally together.
 * Object keys are sorted recursively; primitives and arrays serialize as-is.
 */
function stableValueKey(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>).sort().reduce<Record<string, unknown>>(
          (acc, k) => { acc[k] = (val as Record<string, unknown>)[k]; return acc; }, {})
      : val,
  );
}

/** Presence attestation strength → [0,1]. Phase-1 capture is P0 (unverified). */
const PRESENCE_STRENGTH: Record<string, number> = { P0: 0, P1: 0.25, P2: 0.5, P3: 0.75, P4: 1 };

/** Epistemic reliability of a source class → [0,1] (spec §5 source classes). */
const SOURCE_RELIABILITY: Record<string, number> = {
  official_signed: 1.0,
  verified_firsthand: 0.9,
  imported_owned: 0.6,
  firsthand_unverified: 0.5,
  historical_pattern: 0.5,
  portava_prediction: 0.4,
  sponsored: 0.4,
  hearsay: 0.2,
};

export interface ClaimEvidence {
  /** Distinct real contributors to (subject, claim_type), fresh — the k-anon input. */
  distinctActors: number;
  /** Distinct independent groups/parties, if derivable (else undefined → gate uses actors only). */
  distinctGroups?: number;
  maxGroupShare?: number;
  agrees: number;
  disagrees: number;
  /** Strongest presence attestation among the supporting observations ('P0'..'P4'). */
  maxPresenceLevel: string;
  hasEvidence: boolean;
  /** Strongest source class among the supporting observations. */
  sourceClass: string;
  /** age / ttl of the freshest observation, 0..1+ (>1 means already stale). */
  ageRatio: number;
  sensitiveSubject?: boolean;
  /** True for a claim in the 'conflicting' state — applies a material-conflict penalty. */
  conflicting?: boolean;
}

/**
 * Derive the seven confidence components from a claim's evidence. Conservative:
 * thin evidence scores low. Every output is clamped to [0,1].
 */
export function deriveComponents(ev: ClaimEvidence): ConfidenceComponents {
  const totalConfirmations = ev.agrees + ev.disagrees;
  return {
    presence: PRESENCE_STRENGTH[ev.maxPresenceLevel] ?? 0,
    freshness: clamp01(1 - ev.ageRatio),
    // More distinct contributors ⇒ more independent corroboration; saturates at
    // the k-anonymity threshold so a barely-publishable aggregate is not also
    // treated as maximally independent.
    independence: clamp01(ev.distinctActors / Math.max(1, PRIVACY_THRESHOLD_V1.minUniqueActors)),
    sourceReliability: SOURCE_RELIABILITY[ev.sourceClass] ?? 0.3,
    evidenceQuality: ev.hasEvidence ? 0.8 : 0.3,
    // No confirmations ⇒ neutral (0.5), not assumed-agreement; with confirmations,
    // the agree fraction.
    agreement: totalConfirmations > 0 ? clamp01(ev.agrees / totalConfirmations) : 0.5,
    // v1 default — claim-value specificity scoring is deferred; a mid value neither
    // inflates nor zeroes confidence.
    specificity: 0.5,
  };
}

/** Penalties from the claim's state. A conflicting claim carries a material-conflict penalty. */
export function derivePenalties(ev: ClaimEvidence): Partial<ConfidencePenalties> {
  return ev.conflicting ? { materialConflict: 0.2 } : {};
}

/** A claim row as read from intel_claims for projection. */
export interface ClaimRow {
  id: string;
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  value: unknown;
  status: string;
  observed_at: string;
}

/**
 * Assemble the ProjectionInput for one active claim by gathering its real
 * evidence: distinct fresh observers, confirmation stances, strongest presence
 * and source class, evidence presence, and freshness. All reads are fail-soft —
 * a query error yields a conservative (low) input, never a fabricated high one.
 */
export async function assembleClaimInput(sc: any, claim: ClaimRow, now: Date): Promise<ProjectionInput> {
  const nowIso = now.toISOString();

  // Distinct fresh observers of (subject, claim_type) — the cohort the privacy
  // gate counts. Fresh = expires_at null or in the future. Content that has been
  // explicitly invalidated (restricted/blocked/removed) is EXCLUDED here so it can
  // never contribute to a claim, snapshot, or live label (owner pilot ruling): the
  // whitelist .in() is fail-closed, and it re-runs every projection pass, so a row
  // invalidated after a snapshot was written drops out at the next pass.
  const { data: obs } = await sc
    .from("intel_observations")
    .select("id, actor_id, presence_level, source_class, expires_at, group_key, observed_at, value")
    .eq("subject_id", claim.subject_id)
    .eq("claim_type", claim.claim_type)
    .in("moderation_state", PILOT_CLAIMABLE_MODERATION_STATES as unknown as string[]);
  const freshObsAll = ((obs as any[]) ?? []).filter((o) => !o.expires_at || o.expires_at > nowIso);

  // D4 consent parity with system promotion (2174, which JOINs
  // intel_contribution_consent): an actor who WITHDREW consent must not keep
  // inflating the privacy-gate cohort for an existing claim. Keep only
  // observations from actors with a currently-valid consent (enabled AND not
  // withdrawn). Fail-soft/conservative in keeping with this module's design — a
  // consent-query error leaves the consented set EMPTY (the count drops), it can
  // never inflate a cohort.
  const actorIds = [...new Set(freshObsAll.map((o) => o.actor_id).filter(Boolean))];
  let consentedActors = new Set<string>();
  if (actorIds.length > 0) {
    const { data: consentRows } = await sc
      .from("intel_contribution_consent")
      .select("user_id")
      .in("user_id", actorIds)
      .eq("enabled", true)
      .is("withdrawn_at", null);
    consentedActors = new Set(((consentRows as any[]) ?? []).map((r) => r.user_id as string));
  }
  const freshObs = freshObsAll.filter((o) => o.actor_id && consentedActors.has(o.actor_id));
  const distinctActors = new Set(freshObs.map((o) => o.actor_id)).size;

  // Independence evidence (§11 / Table 30). Read the media/source artifacts
  // attached to the fresh observations so coordinated reports collapse into one
  // cluster before they can count as independent corroboration. SECURITY: this
  // NEVER selects intel_evidence.reference — a raw storage key for unmoderated
  // contributor media (mapMediaEvidence's "nobody selects reference" invariant).
  // Shared media is keyed by the TYPED media_asset_id FK (2255) or a content hash
  // carried in detail; common source by the feed identifier in detail. None of
  // these are contributor bytes and none leave the projection (they only cluster
  // reporters). Fail-soft: a query error leaves the maps empty, so clustering
  // falls back to group_key + synchronized behaviour — it can never invent
  // independence, only fail to detect it.
  const obsIds = freshObs.map((o) => o.id).filter(Boolean);
  const mediaByObs = new Map<string, Set<string>>();
  const sourceByObs = new Map<string, Set<string>>();
  if (obsIds.length > 0) {
    const { data: evidence } = await sc
      .from("intel_evidence")
      .select("observation_id, evidence_kind, media_asset_id, detail")
      .in("observation_id", obsIds);
    for (const e of ((evidence as any[]) ?? [])) {
      const oid = e.observation_id;
      if (!oid) continue;
      const detail = e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : {};
      // A shared MEDIA asset is keyed by its typed asset id (a re-post of the same
      // asset shares it) or a content hash in detail — never the storage key.
      const contentHash = [detail.content_hash, detail.contentHash, detail.hash, detail.sha256]
        .find((h) => typeof h === "string" && h.length > 0) as string | undefined;
      if (["photo", "receipt", "sensor", "video"].includes(e.evidence_kind)) {
        const assetKey = (typeof e.media_asset_id === "string" && e.media_asset_id.length > 0
          ? `asset:${e.media_asset_id}` : null) ?? (contentHash ? `hash:${contentHash}` : null);
        if (assetKey) { let s = mediaByObs.get(oid); if (!s) { s = new Set(); mediaByObs.set(oid, s); } s.add(assetKey); }
      }
      // A COMMON SOURCE is the official feed / partner-API identifier carried in
      // detail (never the raw reference).
      if (["official_feed", "partner_api"].includes(e.evidence_kind)) {
        const feed = [detail.feed, detail.source, detail.source_label, detail.source_id]
          .find((r) => typeof r === "string" && r.length > 0) as string | undefined;
        if (feed) { let s = sourceByObs.get(oid); if (!s) { s = new Set(); sourceByObs.set(oid, s); } s.add(feed); }
      }
    }
  }

  // Independent-group signal (V1 + §11 clustering). Collapse coordinated reports
  // (shared crew token, shared media asset, common feed, or unusually synchronized
  // identical values) into one cluster BEFORE counting independent groups, so a
  // handful of copies cannot manufacture consensus (AT-04). A cluster earns a
  // "verified group" seat only when it carries a non-null group_key; an unattested
  // solo actor counts as a person but never as an independent group (unchanged
  // rule). distinctGroups/maxGroupShare are read off the merged clusters — both
  // can only ever shrink the group count / raise the dominant share (stricter).
  const independenceObs: IndependenceObservation[] = freshObs
    .filter((o) => o.actor_id)
    .map((o) => ({
      actorId: o.actor_id as string,
      groupKey: o.group_key == null || o.group_key === "" ? null : String(o.group_key),
      valueKey: stableValueKey(o.value),
      observedAtMs: o.observed_at ? new Date(o.observed_at).getTime() : Number.NaN,
      mediaRefs: [...(mediaByObs.get(o.id) ?? [])],
      sourceRefs: [...(sourceByObs.get(o.id) ?? [])],
    }));
  const independence = clusterByIndependence(independenceObs);
  const distinctGroups = independence.distinctGroups;
  const maxGroupShare = independence.maxGroupShare;
  const maxPresenceLevel = freshObs.reduce(
    (m, o) => ((PRESENCE_STRENGTH[o.presence_level] ?? 0) > (PRESENCE_STRENGTH[m] ?? 0) ? o.presence_level : m),
    "P0",
  );
  const sourceClass = freshObs.reduce(
    (m, o) => ((SOURCE_RELIABILITY[o.source_class] ?? 0) > (SOURCE_RELIABILITY[m] ?? 0) ? o.source_class : m),
    "firsthand_unverified",
  );

  // Confirmation stances for this claim.
  const { data: confs } = await sc.from("intel_confirmations").select("stance").eq("claim_id", claim.id);
  let agrees = 0, disagrees = 0;
  for (const c of ((confs as any[]) ?? [])) {
    if (c.stance === "agree") agrees++;
    else if (c.stance === "disagree") disagrees++;
  }

  // Served value from the LIVE COHORT, not one frozen anchor (H1/H4). System
  // promotion freezes claim.value to a single DISTINCT-ON anchor observation, so
  // serving claim.value publishes one contributor's verbatim answer under a
  // cohort-sized source_count — and if that anchor's actor later withdrew, the
  // count already dropped them (above) but their value would keep serving (H4).
  // Instead take each consented actor's MOST RECENT value (one person, one vote),
  // tally by value, and serve the plurality. Because the tally runs over freshObs
  // (already consent-filtered), a withdrawn contributor's value cannot win. Fall
  // back to the anchor's value when the cohort supplies no value or has no clear
  // winner (a tie for the lead) — never invent a value the cohort did not give.
  const latestValueByActor = new Map<string, { value: unknown; at: number; groupKey: string | null }>();
  for (const o of freshObs) {
    if (o.value === undefined || o.actor_id == null) continue;
    const at = o.observed_at ? new Date(o.observed_at).getTime() : 0;
    const prev = latestValueByActor.get(o.actor_id);
    if (!prev || at >= prev.at) {
      latestValueByActor.set(o.actor_id, {
        value: o.value,
        at,
        groupKey: o.group_key == null || o.group_key === "" ? null : String(o.group_key),
      });
    }
  }
  const valueVotes = new Map<string, { value: unknown; count: number }>();
  for (const { value } of latestValueByActor.values()) {
    const key = stableValueKey(value);
    const cur = valueVotes.get(key);
    if (cur) cur.count++;
    else valueVotes.set(key, { value, count: 1 });
  }
  let topCount = 0;
  let topValue: unknown;
  let tieAtTop = false;
  for (const v of valueVotes.values()) {
    if (v.count > topCount) { topCount = v.count; topValue = v.value; tieAtTop = false; }
    else if (v.count === topCount) { tieAtTop = true; }
  }
  const hasPlurality = topCount > 0 && !tieAtTop;
  const derivedValue = hasPlurality ? topValue : claim.value;

  // Reachable 'conflicting' path (the disagreement penalty derivePenalties/the
  // gate already handle but nothing ever produced). The cohort genuinely disagrees
  // when either its most-recent values TIE for the lead (no plurality across two
  // or more distinct answers) OR its confirmations are at least half disagree
  // (with a floor of two confirmations, so a single dissent is not "conflict").
  const totalConfirmations = agrees + disagrees;
  const valueConflict = valueVotes.size >= 2 && tieAtTop;
  const confirmationConflict = totalConfirmations >= 2 && disagrees / totalConfirmations >= 0.5;
  const cohortConflicting = valueConflict || confirmationConflict;

  // Publication-delay anchor (H3): a STABLE timestamp — the EARLIEST fresh,
  // consented observation — not the newest. The privacy gate suppresses while
  // (now − anchor) < publicationDelayMinutes; keying that clock to the newest
  // observation (as observedAt does, for freshness) means a venue getting fresh
  // signals faster than the delay NEVER clears it, and a quiet-then-active venue
  // flaps. The earliest fresh observation only moves forward as old ones expire,
  // so a sustained cohort spanning the delay stays published. Falls back to the
  // claim's frozen observed_at when no observation carries a timestamp.
  const earliestObservedAtMs = freshObs.reduce(
    (min, o) => (o.observed_at ? Math.min(min, new Date(o.observed_at).getTime()) : min),
    Number.POSITIVE_INFINITY,
  );
  const publicationAnchorAt = Number.isFinite(earliestObservedAtMs)
    ? new Date(earliestObservedAtMs).toISOString()
    : claim.observed_at;

  // Absolute hard-expiry ceiling (finding 5): system promotion inserts
  // hard_expires_at = NULL and nothing in serving reads it, so a claim kept fresh
  // by a continuous drip of new observations could serve indefinitely with no
  // absolute age cap. Compute the ceiling in code from the claim-type registry,
  // anchored to the claim's frozen (first-anchor) observed_at — the one timestamp
  // that never re-anchors, so the ceiling can never be pushed out. projectClaim
  // caps the servable expires_at at this. Unknown claim types (no spec) get no
  // code ceiling, matching today's behaviour rather than inventing one.
  const hardSpec = CLAIM_TYPES.find((c) => c.claimType === claim.claim_type);
  const anchorMs = new Date(claim.observed_at).getTime();
  const hardExpiresAt = hardSpec && Number.isFinite(anchorMs)
    ? new Date(anchorMs + hardSpec.hardExpirySeconds * 1000).toISOString()
    : null;

  // ── Evidence quality — media→intel evidence seam (Media v2 Phase 5, §9/§35) ──
  // GATED by the master flag `media_evidence_enabled`, seeded OFF (migration
  // 2255). THE SAFETY INVARIANT: while the flag is OFF — or unreadable —
  // hasEvidence is EXACTLY `false`, byte-identical to the pre-seam aggregator
  // (evidenceQuality stays 0.3; no confidence band moves, live serving is
  // unchanged). ONLY when an admin flips the flag ON does a linked, STILL-§35-
  // eligible media raise hasEvidence (→ evidenceQuality 0.8). The flag read is
  // fail-closed (isFlagEnabled returns false on any error), so an unhealthy DB
  // keeps the seam OFF. When ON, observationsHaveEligibleMediaEvidence re-checks
  // each linked asset's §35 eligibility and is itself fail-soft (never invents
  // evidence). This is the ONLY live-serving change in this file, and it is inert
  // until the owner's explicit flag press.
  // Flag name is a LITERAL here (not the imported MEDIA_EVIDENCE_FLAG const) so
  // check-flag-polarity can statically resolve which flag this call reads.
  const mediaEvidenceEnabled = await isFlagEnabled(sc, "media_evidence_enabled");
  const hasEvidence = mediaEvidenceEnabled
    ? await observationsHaveEligibleMediaEvidence(
        sc,
        freshObs.map((o) => o.id).filter(Boolean),
        now.getTime(),
      )
    : false; // flag OFF ⇒ EXACTLY false (byte-identical to pre-seam main)

  // Freshness clock: the LATEST fresh, consented observation of this
  // (subject, claim_type) — NOT the promoted anchor claim's frozen observed_at.
  // The system promotion copies the first observation's observed_at into the
  // claim and never re-anchors, so deriving freshness from claim.observed_at made
  // every key go permanently dark one TTL after its first report even as fresh
  // observations kept arriving. Using the newest observation lets fresh reports
  // keep a key live. Fall back to the claim's observed_at when no observation
  // carries a timestamp (should not happen for a promoted claim).
  const latestObservedAtMs = freshObs.reduce(
    (max, o) => (o.observed_at ? Math.max(max, new Date(o.observed_at).getTime()) : max),
    0,
  );
  const effectiveObservedAt = latestObservedAtMs > 0
    ? new Date(latestObservedAtMs).toISOString()
    : claim.observed_at;

  // Freshness: age of the freshest observation relative to the claim TTL.
  const policy = await getPolicy(sc, claim.claim_type);
  const ttl = policy?.ttlSeconds ?? 0;
  const ageSeconds = Math.max(0, (now.getTime() - new Date(effectiveObservedAt).getTime()) / 1000);
  const ageRatio = ttl > 0 ? ageSeconds / ttl : 1;

  // ── Material conflict (§10, AT-07) — lib/intelConflict ─────────────────────
  // One vote per consented actor (their most recent value), weighted by
  // INDEPENDENCE CLUSTER: a shared group_key is one cluster and carries a
  // verifiable identity (weight 1); an actor with no group_key is their own
  // "unclear" cluster (weight 0.5) — they can never be inferred into someone
  // else's party, and they never earn full independent weight either. The
  // predicate then needs distant values, qualifying weight on BOTH sides, and
  // overlapping observation windows before it says 'material'. This runs over
  // the same freshObs cohort as everything above, so a withdrawn or moderated
  // contributor cannot manufacture a conflict.
  // Cluster ids come from the SAME independence clustering that fed distinctGroups
  // (shared media / common source / synchronized behaviour, not group_key alone),
  // so three copied reports are one side-cluster of weight 1 — they cannot inflate
  // a side past CONFLICT_MIN_WEIGHT (AT-04). `independent` is the cluster's
  // attestation: a merged copy-cluster with no group_key is 'unclear' (0.5).
  const conflictVotes: ConflictVote[] = [];
  for (const [actorId, v] of latestValueByActor) {
    conflictVotes.push({
      actorId,
      clusterId: independence.clusterForUnit(v.groupKey, actorId),
      independent: independence.attestedForUnit(v.groupKey, actorId),
      value: v.value,
      observedAt: new Date(v.at).toISOString(),
    });
  }
  const conflict: ConflictAssessment = assessConflict({ claimType: claim.claim_type, ttlSeconds: ttl, votes: conflictVotes });

  const evidence: ClaimEvidence = {
    distinctActors,
    agrees,
    disagrees,
    maxPresenceLevel,
    hasEvidence,
    sourceClass,
    ageRatio,
    // Reachable now: either the frozen claim status (still honoured) OR a
    // genuinely disagreeing live cohort (a tie at the top, or ≥half disagree
    // confirmations) OR a MATERIAL conflict under the §10 predicate. The penalty
    // only ever adds; a material conflict can never raise confidence.
    conflicting: claim.status === "conflicting" || cohortConflicting || conflict.state === "material",
  };

  return {
    claimType: claim.claim_type,
    // Cohort plurality, not the frozen single-anchor value (H1/H4).
    value: derivedValue,
    // Snapshot observed_at + expires_at derive from the freshest observation so a
    // key stays live while fresh reports arrive (see effectiveObservedAt above).
    observedAt: effectiveObservedAt,
    // Publication-delay clock keyed to the EARLIEST observation (H3), separate
    // from the newest-observation freshness clock above.
    publicationAnchorAt,
    // Absolute serving ceiling anchored to the claim's frozen observed_at (finding 5).
    hardExpiresAt,
    distinctActors,
    distinctGroups,
    maxGroupShare,
    sensitiveSubject: false,
    components: deriveComponents(evidence),
    penalties: derivePenalties(evidence),
    // §10 conflict state, persisted on the snapshot (intel_state_snapshots.
    // conflict_state, migration 2275) so the read path can suppress the strong
    // Live label and surface "Reports differ" without recomputing the cohort.
    conflictState: conflict.state,
  };
}
