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
  { table: "intel_observations", column: "lifecycle_state", ownership: "portava_owned", personal: false,
    reason: "Table 4 lifecycle state the envelope was written in (submitted/processing/published/...). Portava's operational vocabulary, says nothing about a person; the row is append-only so later states are derived, not written back." },
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
  // I1 (2274) Table-5 common claim fields. observation_id and lineage are
  // internal pointers/ancestry — see INTERNAL_COLUMNS.
  { table: "intel_claims", column: "qualifiers_json", ownership: "contributor_licensed", personal: false,
    reason: "Table 5 qualifiers (access type, floor, group, traveler mode): context the contributor attached to the value, licensed with it. Never a coordinate or an identity." },
  { table: "intel_claims", column: "asserted_confidence", ownership: "contributor_licensed", personal: false,
    reason: "Table 5 optional 0–1 self-rating by the contributor. A number about the claim, not about a person; never an input to system_confidence (§8)." },
  { table: "intel_claims", column: "source_label", ownership: "portava_owned", personal: false,
    reason: "Table 5 registry label (official/verified_firsthand/consensus/historical/prediction/sponsored/unverified). Portava's truth-boundary vocabulary; must travel with any redistributed value so a prediction is never presented as an observation." },
  { table: "intel_claims", column: "updated_at", ownership: "portava_owned", personal: false,
    reason: "Row-version timestamp stamped by trigger (2274); cited by Table-17 input_claim_versions. A time about the record, not a person." },
  { table: "intel_claims", column: "version", ownership: "portava_owned", personal: false,
    reason: "Monotonic row version bumped by trigger (2274); cited by Table-17 input_claim_versions so a replay names the exact claim state it used." },

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
  // I1 (2273) Table-17 lineage. algorithm_version and conflict_state are part of
  // the published contract (§19: every response carries its versions; Table 28:
  // the Verification product may return contradictions). The replay record and
  // the claim-version array are internal lineage — see INTERNAL_COLUMNS.
  { table: "intel_state_snapshots", column: "algorithm_version", ownership: "portava_owned", personal: false,
    reason: "The projection algorithm version that produced the state. A version string; says nothing about any person and lets a consumer tell two computations apart." },
  { table: "intel_state_snapshots", column: "conflict_state", ownership: "derived_aggregate", personal: false,
    reason: "none/contextualized/material (Table 17). Derived from the cohort, never from one contributor; the 'Reports differ' signal §10 requires be visible rather than averaged away." },

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
  // I1 (2273) replay lineage on intel_state_snapshots. confidence_components is
  // the raw ConfidenceResult (every weighted input, including independence and
  // agreement derived from the cohort) — model internals, replayed by
  // lib/intelReplay, never an API field; a consumer gets confidence + band.
  // input_claim_versions is a pointer array into intel_claims, exactly like
  // superseded_by / claim_id above.
  "confidence_components",
  "input_claim_versions",
  // I1 (2274) intel_claims.lineage: Table-5 ancestry (observation, evidence,
  // confirmations, algorithm, correction) — a record of pointers into the
  // pipeline, exactly like superseded_by / observation_id. Never redistributed.
  "lineage",
];

/** The intel tables this registry covers. */
export const COVERED_TABLES: readonly string[] = [
  "intel_observations", "intel_claims", "intel_evidence",
  "intel_confirmations", "intel_state_snapshots",
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
