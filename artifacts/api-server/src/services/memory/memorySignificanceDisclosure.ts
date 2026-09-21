/**
 * §8 significance, derived from what this schema actually holds — and the one
 * gate that decides whether a score may cross a boundary.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 8 "Significance and Candidate Ranking"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:295)
 *       Section 1 non-goal: "Publicly scoring users by travel volume, social
 *       value, or memory importance."
 *       Section 18: MemoryTimelineProjection is the one projection whose
 *       `emits_significance` is true, because its audience is OWNER_PRIVATE.
 *
 * CENSUS: H63 (scoring from the listed inputs), H64 (internal, never a public
 *         social score), H65 (media quality must not dominate), H66 (explicit
 *         user intent outranks inferred significance)
 *         (docs/architecture/census-highlights-memories.md, section 8).
 *
 * WHY THIS FILE EXISTS AT ALL. `significance.ts` is the scorer and it is
 * complete: it accepts every input section 8 lists. What it has never had is a
 * CALLER with real rows. Every §8 row is BBW on one sentence — "nothing
 * publishes the score, so the strip has never run in anger". This module is the
 * derivation between the two: canonical `memories` rows in, a
 * `SignificanceInputs` per Memory out.
 *
 * THE ABSENT INPUTS ARE DECLARED, NOT DEFAULTED. Six of section 8's eleven
 * inputs have no source on the deployed schema. Passing `false` or `0` for them
 * would be indistinguishable in the output from a real negative signal, and a
 * partial score that reads as a complete one is exactly the decorated green
 * this census exists to catch. So they are OMITTED from the inputs — the scorer
 * then contributes nothing for them — and the surface that publishes a score
 * publishes UNAVAILABLE_SIGNIFICANCE_INPUTS beside it.
 *
 * WHAT IS *NOT* DERIVED, AND WHY IT MATTERS FOR H65. `media_quality` is one of
 * the six. There is no image analysis anywhere in this repository, so the
 * MEDIA_QUALITY input never fires in production and its cap
 * (MEDIA_QUALITY_MAX_CONTRIBUTION) is exercised only by the unit suite. H65's
 * ceiling is therefore unchanged by this file and is stated rather than
 * quietly closed.
 */

import {
  redactSignificanceForAudience,
  scoreSignificance,
  type SignificanceExplanation,
  type SignificanceInputs,
} from "../memoryProjections/significance.js";
import type { ProjectionDefinition, ProjectionScope } from "../memoryProjections/projectionRegistry.js";

/** The canonical columns this derivation reads. A subset of MEMORY_SELECT. */
export interface SignificanceSourceRow {
  id: string;
  owner_id: string;
  caption: string | null;
  place_id: string | null;
  canonical_location_id: string | null;
  starts_at: string | null;
  created_at: string;
}

export interface SignificanceTagRow {
  memory_id: string;
  tagged_user_id: string;
  status: string;
}

export interface UnavailableInput {
  input: string;
  reason: string;
}

/**
 * Section 8's inputs that have no source on the deployed schema, each with the
 * reason it has none. This list is served beside every published score.
 */
export const UNAVAILABLE_SIGNIFICANCE_INPUTS: readonly UnavailableInput[] = Object.freeze([
  Object.freeze({
    input: "explicit_remember_intent",
    reason: "no column records a 'remember this' request; `memories` has no intent field (§3.1 memory_type / source_mode are not on the deployed schema — H17)",
  }),
  Object.freeze({
    input: "later_user_promotion",
    reason: "promotion presupposes an automatic candidate, and the candidate pipeline does not exist (H2, H67)",
  }),
  Object.freeze({
    input: "user_favorite",
    reason: "`memories` has no owner-favourite column; `memory_saves` is another reader's save, not the owner's",
  }),
  Object.freeze({
    input: "destination_rarity",
    reason: "rarity is a statistic over a destination corpus this service does not hold per owner",
  }),
  Object.freeze({
    input: "trip_goal_match",
    reason: "a trip carries no stated goal to match against",
  }),
  Object.freeze({
    input: "media_quality",
    reason: "no image analysis exists in this repository; the MEDIA_QUALITY cap (§8 'must not dominate') is exercised by the unit suite only — census H65",
  }),
  Object.freeze({
    input: "confidence_band",
    reason: "§6 evidence confidence needs `memory_evidence`, which has no migration in this tree (H24); the scorer defaults to INSUFFICIENT, which withholds AUTO_PRIVATE",
  }),
  Object.freeze({
    input: "policy_eligible",
    reason: "§10's policy eligibility is `memory_visibility_policies` (H33), which does not exist; defaulting false means nothing can silently auto-create",
  }),
]);

/** The place key a repeat visit is counted on. Canonical id wins when present. */
function placeKeyOf(m: SignificanceSourceRow): string | null {
  return m.canonical_location_id ?? m.place_id ?? null;
}

function occurredAt(m: SignificanceSourceRow): string {
  return m.starts_at ?? m.created_at;
}

/**
 * Section 8, per Memory, over the owner's own rows.
 *
 * `rows` is the owner's history as read; rows belonging to anyone else are
 * ignored rather than trusted, because a repeat-visit count computed over other
 * people's Memories would make one owner's significance depend on another's.
 *
 * Deterministic: the only ordering input is (occurred_at, id).
 */
export function deriveSignificance(
  ownerId: string,
  rows: readonly SignificanceSourceRow[],
  tags: readonly SignificanceTagRow[],
): Map<string, SignificanceExplanation> {
  const own = rows
    .filter((m) => m.owner_id === ownerId)
    .slice()
    .sort((a, b) => occurredAt(a).localeCompare(occurredAt(b)) || a.id.localeCompare(b.id));

  const approvedCount = new Map<string, number>();
  for (const t of tags) {
    if (t.status !== "approved") continue;
    approvedCount.set(t.memory_id, (approvedCount.get(t.memory_id) ?? 0) + 1);
  }

  const seenAtPlace = new Map<string, number>();
  const out = new Map<string, SignificanceExplanation>();

  for (const m of own) {
    const key = placeKeyOf(m);
    // Prior visits of THIS owner to THIS place, in occurrence order. A Memory
    // with no place has no first-time and no repeat: an unknown place is not a
    // place the owner has been to before (§28.3 — a missing entity is not a
    // substitute entity).
    const prior = key === null ? null : (seenAtPlace.get(key) ?? 0);
    if (key !== null) seenAtPlace.set(key, (prior ?? 0) + 1);

    const inputs: SignificanceInputs = {
      // Every row in `memories` is authored by its owner: there is no automatic
      // creator on this surface (H2). This is the input §8's never-demote rule
      // turns on, and it is a fact about the table, not an assumption.
      user_created: true,
      user_caption: typeof m.caption === "string" && m.caption.trim().length > 0,
    };
    if (key !== null && prior === 0) inputs.first_time_experience = true;
    if (key !== null && prior !== null && prior > 0) inputs.repeat_visit_count = prior;
    const people = approvedCount.get(m.id) ?? 0;
    if (people > 0) inputs.social_context_people = people;

    out.set(m.id, scoreSignificance(inputs));
  }
  return out;
}

/**
 * H64. Who is reading this projection — its owner, or anybody else?
 *
 * The question is asked of the SCOPE, never of the route, so a route cannot
 * publish a score by forgetting to ask. A projection whose audience is not
 * OWNER_PRIVATE is NON_OWNER even when the reader happens to be the owner: the
 * audience is a property of the destination, and a shared destination stays
 * shared whoever fetched it this time.
 */
export function significanceAudienceFor(
  definition: Pick<ProjectionDefinition, "audience">,
  scope: Pick<ProjectionScope, "owner_id" | "viewer_id">,
): "OWNER" | "NON_OWNER" {
  if (definition.audience !== "OWNER_PRIVATE") return "NON_OWNER";
  const viewer = scope.viewer_id ?? null;
  return viewer !== null && viewer === scope.owner_id ? "OWNER" : "NON_OWNER";
}

/**
 * H64, applied. The last thing that touches a projected row before it is
 * serialized.
 *
 * Two independent refusals, because they fail differently: a projection that
 * does not emit significance must never carry one whatever the audience (a
 * builder bug), and a projection that does must not carry one to a non-owner
 * (a disclosure bug).
 */
export function discloseProjectionRows<T extends Record<string, unknown>>(
  definition: Pick<ProjectionDefinition, "audience" | "emits_significance">,
  scope: Pick<ProjectionScope, "owner_id" | "viewer_id">,
  rows: readonly T[],
): Array<Partial<T>> {
  const audience = definition.emits_significance
    ? significanceAudienceFor(definition, scope)
    : "NON_OWNER";
  return rows.map((r) => redactSignificanceForAudience(r, audience));
}
