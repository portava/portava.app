/**
 * Data-rights registry (IG-08 prerequisite).
 *
 * THE RULE THIS ENFORCES: no field leaves Portava through an external or
 * enterprise API until its ownership and redistribution rights are known. A
 * field does not become redistributable merely because Portava technically holds
 * it — that is the difference between possession and a right.
 *
 * WHY IT EXISTS AS A REGISTRY RATHER THAN A CONVENTION. `ownership_class` appears
 * nowhere in this codebase. Without a registry the first API surface would decide
 * rights implicitly, field by field, in whatever shape the response happened to
 * take — and a field once published is very hard to unpublish. Modelled on
 * deletionDispositions.ts, which is doing the same job for erasure.
 *
 * SCOPE: the intel tables created by 2130. It is deliberately NOT the whole
 * schema — a registry nobody can finish is a registry nobody maintains. Extend it
 * when a surface actually proposes to expose something new; checkDataRights.ts
 * fails on any intel field that is added without a classification.
 */

/** What kind of right Portava holds in a field. */
export const OWNERSHIP_CLASSES = [
  "portava_owned",
  "contributor_licensed",
  "official_partner_licensed",
  "derived_aggregate",
  "third_party_display_only",
  "restricted_no_redistribution",
] as const;
export type OwnershipClass = (typeof OWNERSHIP_CLASSES)[number];

/**
 * Whether a class may be redistributed through an external API AT ALL. This is
 * the coarse gate; a `true` here still does not authorise a specific contract,
 * and per-field notes below carry the conditions.
 *
 * Fail-closed: anything not listed true is false.
 */
export const REDISTRIBUTABLE: Record<OwnershipClass, boolean> = {
  portava_owned: true,
  derived_aggregate: true,
  official_partner_licensed: true,   // subject to the partner agreement's terms
  contributor_licensed: true,        // subject to the contributor licence + attribution
  third_party_display_only: false,   // display in-product only; never re-served
  restricted_no_redistribution: false,
};

export interface FieldRight {
  table: string;
  column: string;
  ownership: OwnershipClass;
  /** Why, in terms someone could defend to a contributor or a partner. */
  reason: string;
  /** True when the field carries or could reconstruct personal data. */
  personal: boolean;
}

/**
 * Every column of the 2130 intel tables that a surface could plausibly expose.
 * Internal bookkeeping (id, created_at, schema_version, idempotency_key) is
 * excluded by INTERNAL_COLUMNS below rather than classified, because it is never
 * a candidate for redistribution.
 */
export const FIELD_RIGHTS: readonly FieldRight[] = [
  // ── intel_observations ────────────────────────────────────────────────────
  { table: "intel_observations", column: "actor_id", ownership: "restricted_no_redistribution", personal: true,
    reason: "Identifies the contributor. Never redistributable; aggregate outputs carry counts, not identities." },
  { table: "intel_observations", column: "subject_id", ownership: "portava_owned", personal: false,
    reason: "Portava's canonical place identifier." },
  { table: "intel_observations", column: "zone_id", ownership: "portava_owned", personal: false,
    reason: "Portava's intra-venue zone label." },
  { table: "intel_observations", column: "claim_type", ownership: "portava_owned", personal: false,
    reason: "Portava's claim taxonomy (IG-01 registry)." },
  { table: "intel_observations", column: "value", ownership: "contributor_licensed", personal: false,
    reason: "The contributor's report about the world. Redistributable only under the contributor licence, with attribution." },
  { table: "intel_observations", column: "source_class", ownership: "portava_owned", personal: false,
    reason: "Portava's epistemic classification of the assertion." },
  { table: "intel_observations", column: "capture_surface", ownership: "portava_owned", personal: false,
    reason: "Which Portava surface captured it — product telemetry." },
  { table: "intel_observations", column: "visibility", ownership: "restricted_no_redistribution", personal: true,
    reason: "The contributor's audience choice. Exposing it would leak an intent they did not publish." },
  { table: "intel_observations", column: "moderation_state", ownership: "restricted_no_redistribution", personal: true,
    reason: "Moderation status about a person's content. Internal safety signal, never an API field." },
  { table: "intel_observations", column: "commercial_disclosure", ownership: "portava_owned", personal: false,
    reason: "Disclosure label. MUST travel with any redistributed value — a sponsored claim without its disclosure is misleading." },
  { table: "intel_observations", column: "presence_level", ownership: "derived_aggregate", personal: true,
    reason: "Derived verification strength. Personal at row level (it implies where someone was); redistributable only aggregated." },
  { table: "intel_observations", column: "presence_attestation", ownership: "restricted_no_redistribution", personal: true,
    reason: "Attested presence facts. Could narrow a person's location; never leaves." },
  { table: "intel_observations", column: "observed_at", ownership: "derived_aggregate", personal: true,
    reason: "Row-level timestamps plus a place reconstruct a movement trail. Redistributable only bucketed." },
  { table: "intel_observations", column: "captured_at", ownership: "restricted_no_redistribution", personal: true,
    reason: "Device capture time — same trail risk, with no aggregate use case." },
  { table: "intel_observations", column: "received_at", ownership: "portava_owned", personal: false,
    reason: "Server receipt time. Operational, not about the person." },
  { table: "intel_observations", column: "expires_at", ownership: "portava_owned", personal: false,
    reason: "Portava's TTL policy applied to the row." },
  { table: "intel_observations", column: "group_key", ownership: "restricted_no_redistribution", personal: true,
    reason: "A non-reversible HMAC derived from the contributor's identity (solo) or their Trip Crew. It is the privacy-gate's independent-group parameter; exposing it would let an attacker correlate a person's captures at a venue. Never leaves." },
  { table: "intel_observations", column: "party_size_bucket", ownership: "restricted_no_redistribution", personal: true,
    reason: "The contributor's 'who are you here with?' attestation — a personal fact about their party. Measurement only; never an API field." },

  // ── intel_claims ──────────────────────────────────────────────────────────
  { table: "intel_claims", column: "subject_id", ownership: "portava_owned", personal: false, reason: "Canonical place identifier." },
  { table: "intel_claims", column: "claim_type", ownership: "portava_owned", personal: false, reason: "Portava's claim taxonomy." },
  { table: "intel_claims", column: "zone_id", ownership: "portava_owned", personal: false,
    reason: "Portava's intra-venue zone label. Coarse by construction — a zone is a named area, never a position." },
  { table: "intel_claims", column: "value", ownership: "derived_aggregate", personal: false,
    reason: "A belief synthesised from many contributors' reports — Portava's derivation, not any one contributor's text." },
  { table: "intel_claims", column: "status", ownership: "portava_owned", personal: false, reason: "Portava's lifecycle state." },
  { table: "intel_claims", column: "confidence", ownership: "derived_aggregate", personal: false,
    reason: "Portava's computed score. Redistributable WITH its band, never as a bare number implying more precision than the formula supports." },
  { table: "intel_claims", column: "confidence_band", ownership: "derived_aggregate", personal: false, reason: "Display banding of the score." },
  { table: "intel_claims", column: "source_count", ownership: "derived_aggregate", personal: false,
    reason: "A count, not identities — but only above the privacy threshold, or it narrows who contributed." },
  { table: "intel_claims", column: "observed_at", ownership: "derived_aggregate", personal: false, reason: "Freshest contributing observation time." },
  { table: "intel_claims", column: "expires_at", ownership: "portava_owned", personal: false,
    reason: "Portava's TTL policy applied to the claim. Must travel with any redistributed value so a consumer cannot present an expired claim as current." },

  // ── intel_state_snapshots ─────────────────────────────────────────────────
  { table: "intel_state_snapshots", column: "subject_id", ownership: "portava_owned", personal: false, reason: "Canonical place identifier." },
  { table: "intel_state_snapshots", column: "claim_type", ownership: "portava_owned", personal: false, reason: "Portava's claim taxonomy." },
  { table: "intel_state_snapshots", column: "zone_id", ownership: "portava_owned", personal: false,
    reason: "Portava's intra-venue zone label. Coarse by construction — a zone is a named area, never a position." },
  { table: "intel_state_snapshots", column: "value", ownership: "derived_aggregate", personal: false,
    reason: "Projected live state. The primary API product, and redistributable only when privacy_eligible is true." },
  { table: "intel_state_snapshots", column: "confidence", ownership: "derived_aggregate", personal: false, reason: "Computed score." },
  { table: "intel_state_snapshots", column: "confidence_band", ownership: "derived_aggregate", personal: false, reason: "Display banding." },
  { table: "intel_state_snapshots", column: "source_count", ownership: "derived_aggregate", personal: false, reason: "Count above threshold only." },
  { table: "intel_state_snapshots", column: "distinct_actors", ownership: "restricted_no_redistribution", personal: true,
    reason: "The exact cohort size is the privacy parameter itself; publishing it helps an attacker reason about who was counted." },
  { table: "intel_state_snapshots", column: "privacy_eligible", ownership: "portava_owned", personal: false, reason: "Portava's gate decision." },
  { table: "intel_state_snapshots", column: "observed_at", ownership: "derived_aggregate", personal: false, reason: "Aggregate observation time." },
  { table: "intel_state_snapshots", column: "expires_at", ownership: "portava_owned", personal: false,
    reason: "Portava's TTL policy applied to the snapshot. Redistributing live state without its expiry invites a consumer to cache it indefinitely." },

  // ── intel_evidence / intel_confirmations ──────────────────────────────────
  { table: "intel_evidence", column: "actor_id", ownership: "restricted_no_redistribution", personal: true, reason: "Identifies the contributor." },
  { table: "intel_evidence", column: "evidence_kind", ownership: "portava_owned", personal: false, reason: "Portava's evidence taxonomy." },
  { table: "intel_evidence", column: "reference", ownership: "restricted_no_redistribution", personal: true,
    reason: "A storage key. Handing it out is handing out the artifact, and the object may carry more than the claim did." },
  { table: "intel_evidence", column: "expires_at", ownership: "portava_owned", personal: false,
    reason: "Portava's retention deadline for the artifact. Internal scheduling; it says when evidence goes, not what it contains." },
  { table: "intel_evidence", column: "detail", ownership: "contributor_licensed", personal: true,
    reason: "Contributor-supplied detail. Unstructured, so it may contain personal data — never redistributed unreviewed." },
  { table: "intel_confirmations", column: "actor_id", ownership: "restricted_no_redistribution", personal: true, reason: "Identifies the confirmer." },
  { table: "intel_confirmations", column: "stance", ownership: "derived_aggregate", personal: false,
    reason: "Individually it is one person's opinion tied to a place and time; only the aggregate leaves." },
  { table: "intel_confirmations", column: "presence_level", ownership: "derived_aggregate", personal: true, reason: "As per observations." },
  { table: "intel_confirmations", column: "observed_at", ownership: "derived_aggregate", personal: true, reason: "As per observations." },

  // ── intel_attributions (I4a, 2277) ────────────────────────────────────────
  // A row links a CONTRIBUTOR to a traveler's outcome. Nothing here leaves at
  // row level: the only redistributable products are aggregates (contradiction
  // counts, scoped reliability badges — Table 28 'Verification').
  { table: "intel_attributions", column: "actor_id", ownership: "restricted_no_redistribution", personal: true,
    reason: "Identifies the credited contributor. Never redistributable; badges and counts carry no identity." },
  { table: "intel_attributions", column: "touch", ownership: "restricted_no_redistribution", personal: true,
    reason: "How the REPORTER interacted with the contribution (Table 22 touch) — behavioural telemetry about a person, kept internal." },
  { table: "intel_attributions", column: "weight", ownership: "derived_aggregate", personal: false,
    reason: "Portava's computed attribution weight. May leave only inside an aggregate, never with a contributor identity." },
  { table: "intel_attributions", column: "outcome", ownership: "derived_aggregate", personal: false,
    reason: "The Appendix-A outcome copied from the event; leaves only as an aggregate (e.g. contradiction rate per claim family), never as a row." },
  { table: "intel_attributions", column: "outcome_score", ownership: "derived_aggregate", personal: false,
    reason: "Portava's accuracy grade of the outcome. Aggregate-only, like outcome." },
  { table: "intel_attributions", column: "expected_accuracy", ownership: "derived_aggregate", personal: false,
    reason: "The served confidence at report time — Portava's own calibration target." },
  { table: "intel_attributions", column: "counterfactual", ownership: "restricted_no_redistribution", personal: true,
    reason: "The reporter's stated counterfactual ('would have made the same choice') — a personal statement, internal only." },
  { table: "intel_attributions", column: "contradiction", ownership: "derived_aggregate", personal: false,
    reason: "Whether the outcome contradicted the served state. The Verification product may surface contradiction COUNTS (Table 28)." },
  { table: "intel_attributions", column: "scope_key", ownership: "portava_owned", personal: false,
    reason: "Portava's §15 scope bucket (city-level geography × family × band × mode × season) — a label, never a coordinate." },

  // ── intel_scoped_trust (I4a, 2278) ────────────────────────────────────────
  // "Internal Trust remains purpose-limited" (§15): every number here is about
  // ONE person's reliability in ONE scope and never leaves at row level. The
  // only public product is the read-only badge derivation (lib/intelScopedTrust
  // deriveScopedBadges), which carries no number.
  { table: "intel_scoped_trust", column: "actor_id", ownership: "restricted_no_redistribution", personal: true,
    reason: "Identifies the contributor whose scoped reliability this is. Never redistributable." },
  { table: "intel_scoped_trust", column: "scope_key", ownership: "portava_owned", personal: false,
    reason: "Portava's §15 scope bucket — a label, never a coordinate." },
  { table: "intel_scoped_trust", column: "trust", ownership: "restricted_no_redistribution", personal: true,
    reason: "The internal, purpose-limited scoped trust number (§15). Public UI shows badges, never this value." },
  { table: "intel_scoped_trust", column: "outcomes", ownership: "restricted_no_redistribution", personal: true,
    reason: "A person's graded-outcome count in a scope — evidence-portfolio input, internal only." },
  { table: "intel_scoped_trust", column: "successes", ownership: "restricted_no_redistribution", personal: true,
    reason: "As per outcomes." },
  { table: "intel_scoped_trust", column: "contradictions", ownership: "restricted_no_redistribution", personal: true,
    reason: "As per outcomes — a per-person contradiction count; only claim-level aggregates may surface (Table 28)." },
  { table: "intel_scoped_trust", column: "calibration_error", ownership: "restricted_no_redistribution", personal: true,
    reason: "A person's calibration measure in a scope. Feeds the calibrated badge; the number stays internal." },
  { table: "intel_scoped_trust", column: "calibration_samples", ownership: "restricted_no_redistribution", personal: true,
    reason: "Denominator of calibration_error — same treatment." },
];

/** Columns never considered for redistribution, so never classified. */
export const INTERNAL_COLUMNS: readonly string[] = [
  "id", "created_at", "computed_at", "schema_version", "event_version",
  "idempotency_key", "superseded_by", "observation_id", "claim_id",
  "hard_expires_at", "subject_kind",
  // intel_evidence.media_asset_id (2255): an internal FK/lineage pointer to the
  // canonical media asset, exactly like observation_id/claim_id. Never itself
  // redistributed — a bare UUID hands out nothing; the artifact is reachable
  // only through media_assets + storage access, and the storage KEY that would
  // hand out the artifact is `reference`, already classified restricted.
  "media_asset_id",
  // Internal promotion provenance ('admin' | 'system'): never surfaced publicly,
  // never redistributed — pure lineage, like superseded_by.
  "promotion_source",
  // I4a lineage pointers + versioning (2277/2278): an FK to the outcome event on
  // the spine, the algorithm version a row was computed under, and the
  // scoped-trust application bookkeeping. Pure lineage, like superseded_by.
  "outcome_event_id",
  "algorithm_version",
  "last_attribution_id",
  "last_attribution_at",
  "last_updated_at",
];

/** The intel tables this registry covers. */
export const COVERED_TABLES: readonly string[] = [
  "intel_observations", "intel_claims", "intel_evidence",
  "intel_confirmations", "intel_state_snapshots",
  // I4a (2277 / 2278).
  "intel_attributions", "intel_scoped_trust",
];

/** May this field be redistributed at all? Fail-closed on an unknown field. */
export function mayRedistribute(table: string, column: string): boolean {
  const f = FIELD_RIGHTS.find((r) => r.table === table && r.column === column);
  if (!f) return false; // unregistered => never
  return REDISTRIBUTABLE[f.ownership] === true;
}

/** Every field that may leave, for building an API projection. */
export function redistributableFields(table: string): FieldRight[] {
  return FIELD_RIGHTS.filter((r) => r.table === table && REDISTRIBUTABLE[r.ownership]);
}
