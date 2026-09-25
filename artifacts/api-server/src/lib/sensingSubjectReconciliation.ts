/**
 * sensingSubjectReconciliation — §18.3 entity reconciliation for an observed
 * activity cluster: Place? Event? Temporary world object? Unknown?
 *
 *   "Observed activity cluster → Place? Event? Temporary world object? Unknown?
 *    Never assign to the nearest place merely to satisfy a foreign key."  (§18.3)
 *   "Temporary activity must not be forced onto nearest place ID when ownership
 *    is unknown."                                                       (§14)
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * This module is the rule: a four-outcome subject reference and one pure
 * resolver whose default answer is `unknown`. It used to be a rule with nowhere
 * to apply it — `intel_observations.subject_id` was `NOT NULL REFERENCES
 * places(id)`, so `unknown` and `temporary_world_object` could not be STORED.
 * `3002_intel_contribution_identity.sql` made that column nullable (keeping the
 * places FK for non-null subjects) and added the two subject kinds plus
 * `intel_observations_subject_resolution_check`, so all four outcomes are
 * storable and `routes/mapObservations.ts` calls this instead of snapping.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * A cluster is assigned to a Place or an Event ONLY on an explicit OWNERSHIP
 * signal: a venue anchor / check-in / event QR tying the zone to that entity,
 * or an operator assignment. Proximity is not ownership. A candidate that is
 * merely the nearest place — however near — resolves to `unknown`, and a
 * cluster that persists without an owner is a `temporary_world_object`, keyed
 * on the zone, never a fake `places` row (§7 "do not fake permanent Place rows
 * for transient clusters").
 *
 * There is deliberately no `distanceMeters` threshold in this file. The moment
 * one exists, "close enough" becomes ownership, which is exactly the snap §18.3
 * forbids. lib/mapObjects and lib/mapAggregation already emit transient
 * clusters as cell/edge geometry with no place row; this resolver is what a
 * sensing consumer calls before it is allowed to say "at <place>".
 *
 * PURE. No I/O, no clock, no geometry.
 */

/** How a candidate came to be associated with a zone. Only some are ownership. */
export const SUBJECT_EVIDENCE_KINDS = [
  /** A canonical anchor (venue beacon / registered zone→place mapping). */
  "venue_anchor",
  /** Contributors checked in / scanned the event's QR at this zone. */
  "checkin",
  "event_qr",
  /** A human operator assigned the zone to this entity. */
  "operator_assignment",
  /** The entity is merely near the zone. NOT ownership. */
  "proximity",
  /** A textual/label similarity between the zone and the entity. NOT ownership. */
  "name_match",
] as const;
export type SubjectEvidenceKind = (typeof SUBJECT_EVIDENCE_KINDS)[number];

/** The evidence kinds that establish ownership. Proximity and name matching are not among them. */
export const OWNERSHIP_EVIDENCE: readonly SubjectEvidenceKind[] = [
  "venue_anchor",
  "checkin",
  "event_qr",
  "operator_assignment",
] as const;

export interface SubjectCandidate {
  kind: "place" | "event";
  id: string;
  evidence: SubjectEvidenceKind;
}

/** §18.3's four outcomes. `unknown` is the default; nothing resolves to a place by proximity. */
export type SensingSubjectRef =
  | { kind: "place"; id: string; evidence: SubjectEvidenceKind }
  | { kind: "event"; id: string; evidence: SubjectEvidenceKind }
  | { kind: "temporary_world_object"; zoneId: string }
  | { kind: "unknown"; zoneId: string };

export interface ReconcileInput {
  /** The coarse zone the cluster was observed in. */
  zoneId: string;
  candidates: readonly SubjectCandidate[];
  /**
   * True when the cluster has persisted across more than one time bucket
   * without an owner — the signal that it is a transient world object rather
   * than a momentary unknown. Absent/false ⇒ `unknown`.
   */
  persistent?: boolean;
}

export function isOwnershipEvidence(kind: SubjectEvidenceKind): boolean {
  return OWNERSHIP_EVIDENCE.includes(kind);
}

/**
 * Resolve a cluster to a subject. Deterministic: with several owned
 * candidates, an `operator_assignment` wins, then the first owned candidate in
 * input order (a caller that has two competing anchors has a data problem this
 * resolver will not hide by picking the nearer one — there is no "nearer" here).
 */
export function reconcileSensingSubject(input: ReconcileInput): SensingSubjectRef {
  if (!input || !input.zoneId) throw new Error("reconcileSensingSubject: zoneId is required");
  const owned = (input.candidates ?? []).filter(
    (c) => c && (c.kind === "place" || c.kind === "event") && !!c.id && isOwnershipEvidence(c.evidence),
  );
  const chosen = owned.find((c) => c.evidence === "operator_assignment") ?? owned[0];
  if (chosen) return { kind: chosen.kind, id: chosen.id, evidence: chosen.evidence };
  if (input.persistent === true) return { kind: "temporary_world_object", zoneId: input.zoneId };
  return { kind: "unknown", zoneId: input.zoneId };
}

/** True when a subject reference may be rendered as "at <place/event>". */
export function subjectMayBeNamed(ref: SensingSubjectRef): boolean {
  return ref.kind === "place" || ref.kind === "event";
}

// ── The storage shape ─────────────────────────────────────────────────────────
//
// One resolver answer, expressed in the three columns intel_observations keys a
// subject on. It lives here rather than in the caller so that every consumer
// files an unowned cluster the SAME way, and so the mapping from a §18.3
// outcome to a row is reviewable in one place.
//
// The two unowned outcomes deliberately produce `subjectId: null`. That is not a
// missing value to be filled in later by something helpful — it is the answer.
// `intel_observations_subject_resolution_check` (migration 3002) refuses the row
// if a caller pairs an unowned kind with a place id, so a future "just use the
// nearest one" cannot be reintroduced quietly.

export interface SensingSubjectStorage {
  /** intel_observations.subject_kind */
  subjectKind: string;
  /** intel_observations.subject_id — NULL for `unknown` / `temporary_world_object`. */
  subjectId: string | null;
  /** intel_observations.zone_id — REQUIRED whenever subjectId is null. */
  zoneId: string | null;
}

/**
 * Map a resolved subject onto the columns an observation stores it in.
 *
 * `place` keeps the caller's own subject kind (the intel vocabulary calls a
 * venue subject `experience`, not `place`), because the kind is about what the
 * subject IS to the claim system, not about how it was resolved. `event`,
 * `temporary_world_object` and `unknown` each name themselves.
 */
export function subjectStorageFor(
  ref: SensingSubjectRef,
  opts: { placeSubjectKind?: string; zoneId?: string | null } = {},
): SensingSubjectStorage {
  switch (ref.kind) {
    case "place":
      return {
        subjectKind: opts.placeSubjectKind ?? "experience",
        subjectId: ref.id,
        zoneId: opts.zoneId ?? null,
      };
    case "event":
      return { subjectKind: "event", subjectId: ref.id, zoneId: opts.zoneId ?? null };
    case "temporary_world_object":
      return { subjectKind: "temporary_world_object", subjectId: null, zoneId: ref.zoneId };
    case "unknown":
      return { subjectKind: "unknown", subjectId: null, zoneId: ref.zoneId };
  }
}

/** The subject kinds that assert NO canonical owner. Stored with a null subject_id. */
export const UNOWNED_SUBJECT_KINDS = ["temporary_world_object", "unknown"] as const;

export function isUnownedSubjectKind(kind: string): boolean {
  return (UNOWNED_SUBJECT_KINDS as readonly string[]).includes(kind);
}
