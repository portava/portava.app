/**
 * The nine hard invariant tests.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 "Hard invariant tests" (:656-665). The nine below are that list,
 *       verbatim and in the spec's order.
 *
 * CENSUS: H236-H244 (docs/architecture/census-highlights-memories.md §B).
 *
 * ── THE STATUS VOCABULARY IS THE POINT ───────────────────────────────────────
 *
 * An invariant checker with two answers — pass and fail — has to call an
 * invariant with nothing to check a PASS. That is the single most dangerous
 * thing this file could do, because it converts "we never built the surface"
 * into "the surface is certified". So there are three:
 *
 *   HELD        the invariant was evaluated against real production code and
 *               the property held.
 *   VIOLATED    it was evaluated and the property did NOT hold.
 *   NO_SURFACE  there is nothing in this repository the invariant could be
 *               evaluated against. This is NOT a pass. `runCertification`
 *               reports it separately and the census scores it as NOT-BUILT.
 *
 * Every outcome also carries `surface`: the module and function the invariant
 * was actually asserted against, so a reader can tell an invariant proved on a
 * live route from one proved on a module no route imports. That distinction is
 * the whole difference between a guarantee and a hope, and section A.2 of the
 * census already scores it, so this file records it rather than flattening it.
 *
 * ── WHAT IS DELIBERATELY NOT CLAIMED ─────────────────────────────────────────
 *
 * These run against the TypeScript layer through the in-memory store in
 * `world.ts`. They therefore say nothing about RLS, grants, CHECK constraints
 * or any migration that has not been applied. Where the real enforcement would
 * live in the database, the outcome says so in `detail` rather than implying
 * the database was consulted.
 */

import {
  DERIVATIVE_REGISTRY_TABLE,
  rebuildProjection,
  revokeDerivativesForMemory,
  type ClientLike,
} from "../memoryProjections/derivativeRegistry.js";
import { getProjectionDefinition } from "../memoryProjections/projectionRegistry.js";
import type { ProjectedRow } from "../memoryProjections/projectionRegistry.js";
import {
  mergeByPrecedence,
  normalizeEvidence,
  evaluateEligibility,
  type NormalizedEvidence,
} from "../memoryProjections/evidence.js";
import { searchMemories } from "../memoryRetrieval/searchMemories.js";
import {
  LOCATION_PRECISION_LADDER,
  locationPrecisionRank,
  resolveLocationDisclosure,
  strictestPrecision,
  type LocationPrecisionRung,
} from "../highlights/highlightProjectionPolicy.js";
import {
  CONTROL_EFFECTS,
  isSuppressed,
  suppressions,
} from "../highlights/highlightResurfacing.js";
import { MEMORY_COMMAND_TYPES_NOT_DECLARED } from "../../lib/memoryCommandBus.js";
import {
  certificationClient,
  tablesFor,
  type CertificationWorld,
} from "./world.js";
import {
  HIGHLIGHT_IDS,
  HIGHLIGHT_PRECISION_WORLD,
  MEMORY_IDS,
  getFixture,
} from "./fixtures.js";

export const INVARIANT_IDS = [
  "PRIVATE_NOT_IN_PUBLIC_SEARCH",
  "DELETED_NOT_IN_COMPASS_RETRIEVAL",
  "REJECTED_CANDIDATE_NOT_A_HIGHLIGHT",
  "PLANNED_WITHOUT_OCCURRENCE_NOT_A_VISIT",
  "BLOCKED_PERSON_NOT_RESURFACED",
  "PUBLIC_PRECISION_WITHIN_OWNER_POLICY",
  "CORRECTION_NOT_OVERWRITTEN_BY_INFERENCE",
  "HISTORICAL_NOT_CURRENT_AVAILABILITY",
  "CONSUMERS_TOLERATE_DUPLICATE_AND_OUT_OF_ORDER",
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

export type InvariantStatus = "HELD" | "VIOLATED" | "NO_SURFACE";

export interface InvariantOutcome {
  readonly id: InvariantId;
  readonly census_id: string;
  readonly spec_line: number;
  readonly spec_text: string;
  readonly status: InvariantStatus;
  /** The production code the invariant was asserted against. */
  readonly surface: string;
  /** Whether anything outside src/test/ and this module reaches that surface. */
  readonly reachable_from_a_route: boolean;
  readonly detail: string;
}

interface InvariantDefinition {
  readonly id: InvariantId;
  readonly census_id: string;
  readonly spec_line: number;
  readonly spec_text: string;
  readonly surface: string;
  readonly reachable_from_a_route: boolean;
  run(): Promise<{ status: InvariantStatus; detail: string }>;
}

function normalizedFrom(world: CertificationWorld): NormalizedEvidence[] {
  const now = new Date(world.now);
  const out: NormalizedEvidence[] = [];
  for (const raw of world.signals) {
    const r = normalizeEvidence(raw, now);
    if (r.ok) out.push(r.evidence);
  }
  return out;
}

async function seededClient(world: CertificationWorld): Promise<ClientLike> {
  return certificationClient(tablesFor(world));
}

function idsOf(rows: readonly ProjectedRow[]): string[] {
  return rows.map((r) => String(r.memory_id)).sort();
}

// ── 1. PRIVATE memory cannot appear in public search ─────────────────────────

async function privateNotInPublicSearch(): Promise<{ status: InvariantStatus; detail: string }> {
  // A world with one public row and four that must never reach a public surface:
  // only_me, a `custom` row whose allow-list contains the searcher, a draft, and
  // a deleted one. The `custom` row is the interesting one — being permitted to
  // read something when you ask for it is not permission to be shown it in a
  // global surface.
  const fixture = getFixture("PUBLIC_TO_PRIVATE_REVOCATION");
  const world: CertificationWorld = {
    ...fixture.world,
    memories: [
      ...fixture.world.memories,
      { ...fixture.world.memories[0]!, id: "cert-only-me", visibility: "only_me", title: "only me" },
      { ...fixture.world.memories[0]!, id: "cert-custom", visibility: "custom", title: "custom", allowed_user_ids: ["cert-searcher"] },
      { ...fixture.world.memories[0]!, id: "cert-draft", visibility: "public", state: "draft", title: "draft" },
      { ...fixture.world.memories[0]!, id: "cert-deleted", visibility: "public", state: "deleted", title: "deleted" },
    ],
  };
  const client = await seededClient(world);
  const scope = { owner_id: world.owner_id, viewer_id: null };
  const built = await rebuildProjection(client, "PublicMemoryProjection", scope, new Date(world.now));
  if (!built.ok) return { status: "VIOLATED", detail: `PublicMemoryProjection would not build: ${built.detail}` };

  const leaked = idsOf(built.value.rows).filter((id) => id !== MEMORY_IDS.published);
  if (leaked.length > 0) {
    return { status: "VIOLATED", detail: `public derivative carried non-public rows: ${leaked.join(", ")}` };
  }

  // The namespace gate, on the way in: the PUBLIC namespace must refuse to read
  // an owner-private projection at all rather than read it and filter after.
  const crossNamespace = await searchMemories(client, {
    ownerId: world.owner_id,
    viewerId: "cert-searcher",
    namespace: "PUBLIC",
    authorizedProjection: "MemoryTimelineProjection",
    now: new Date(world.now),
  });
  if (crossNamespace.ok || crossNamespace.reason !== "projection_not_in_namespace") {
    return {
      status: "VIOLATED",
      detail: `PUBLIC namespace did not refuse MemoryTimelineProjection: ${JSON.stringify(crossNamespace)}`,
    };
  }

  // And the legal request must still work, or the refusal above proves nothing.
  const legal = await searchMemories(client, {
    ownerId: world.owner_id,
    viewerId: "cert-searcher",
    namespace: "PUBLIC",
    authorizedProjection: "PublicMemoryProjection",
    now: new Date(world.now),
  });
  if (!legal.ok) return { status: "VIOLATED", detail: `legal public search failed: ${legal.detail}` };
  const hitIds = legal.value.hits.map((h) => h.memory_id).sort();
  if (hitIds.length !== 1 || hitIds[0] !== MEMORY_IDS.published) {
    return { status: "VIOLATED", detail: `public search returned ${JSON.stringify(hitIds)}` };
  }
  return {
    status: "HELD",
    detail:
      "PublicMemoryProjection emitted only the published+public row (only_me, custom-with-allow-list, draft and deleted all absent); " +
      "the PUBLIC namespace refused MemoryTimelineProjection on the way in with projection_not_in_namespace, and the legal request returned the one row. " +
      "CEILING: this is the §15/§18 retrieval path, which no route imports. The public Memory surface production actually serves is GET /memories in routes/memories.ts, " +
      "a canonical read whose privacy predicates run in the query — a different surface, separately certified by src/test/memoriesPublicFeedPrivacy.test.ts, and still not the derivative §10 asks for",
  };
}

// ── 2. Deleted memory cannot remain in Compass retrieval ─────────────────────

async function deletedNotInCompassRetrieval(): Promise<{ status: InvariantStatus; detail: string }> {
  const fixture = getFixture("DELETE_WITH_DERIVATIVES");
  const tables = tablesFor(fixture.world);
  const client = certificationClient(tables);
  const now = new Date(fixture.world.now);
  const scope = { owner_id: fixture.world.owner_id, viewer_id: fixture.world.owner_id };

  const before = await rebuildProjection(client, "CompassMemoryProjection", scope, now);
  if (!before.ok) return { status: "VIOLATED", detail: `CompassMemoryProjection would not build: ${before.detail}` };
  if (!idsOf(before.value.rows).includes(MEMORY_IDS.deleted)) {
    return { status: "VIOLATED", detail: "fixture is inert: the memory under deletion was never in the projection" };
  }

  // Delete it the way the product does — a state write — then walk the cleanup graph.
  const row = tables.memories!.find((m) => m.id === MEMORY_IDS.deleted);
  if (!row) return { status: "VIOLATED", detail: "fixture row missing" };
  row.state = "deleted";
  row.updated_at = fixture.world.now;

  const revoked = await revokeDerivativesForMemory(client, MEMORY_IDS.deleted, "memory deleted", now);
  if (!revoked.ok) return { status: "VIOLATED", detail: `cleanup graph failed: ${revoked.detail}` };
  if (revoked.value.revoked === 0) {
    return { status: "VIOLATED", detail: "the registration carrying the deleted memory was not revoked" };
  }

  // Reading the revoked derivative must REFUSE, not return an empty page: "this
  // index was revoked" and "you have no memories" are different answers.
  const read = await searchMemories(client, {
    ownerId: fixture.world.owner_id,
    viewerId: fixture.world.owner_id,
    namespace: "PRIVATE_PERSONAL",
    authorizedProjection: "CompassMemoryProjection",
    now,
  });
  if (read.ok || read.reason !== "derivative_revoked") {
    return { status: "VIOLATED", detail: `revoked derivative did not refuse: ${JSON.stringify(read)}` };
  }

  // And a rebuild after the delete must not carry the row back.
  const registry = tables[DERIVATIVE_REGISTRY_TABLE]!;
  registry.length = 0;
  const after = await rebuildProjection(client, "CompassMemoryProjection", scope, now);
  if (!after.ok) return { status: "VIOLATED", detail: `rebuild after delete failed: ${after.detail}` };
  if (idsOf(after.value.rows).includes(MEMORY_IDS.deleted)) {
    return { status: "VIOLATED", detail: "a rebuild after deletion carried the deleted memory back" };
  }
  return {
    status: "HELD",
    detail:
      "the deleted Memory left CompassMemoryProjection, its registration was revoked with an emptied payload, and reading the revoked derivative refused with derivative_revoked rather than returning an empty page. " +
      "CEILING: CompassMemoryProjection is the only Compass-facing memory artifact in this repository — compass/CompassTools.ts declares no memory tool, so the §16 tool surface this invariant names does not exist to test",
  };
}

// ── 3. Rejected candidate cannot become a Highlight ──────────────────────────

async function rejectedCandidateNotAHighlight(): Promise<{ status: InvariantStatus; detail: string }> {
  // The rejection half is real and is asserted, so the fixture is not inert.
  const fixture = getFixture("WALK_PAST_NOT_VISIT");
  const evidence = normalizedFrom(fixture.world).filter((e) => e.source_type === "GPS_PROXIMITY");
  const verdict = evaluateEligibility(evidence, { mode: "AUTOMATIC" });
  if (verdict.eligible) {
    return { status: "VIOLATED", detail: "a 90-second pass-by was ruled an eligible candidate" };
  }
  // The other half has nothing to assert against. There is no function anywhere
  // in this repository that turns a candidate into a Highlight: `highlights`
  // rows are inserted from a client-supplied mediaUrl and `highlight_sources`
  // (migration 2722) is unapplied and has no TypeScript writer. An invariant
  // about a path that does not exist is not satisfied by the path's absence —
  // when someone builds it, nothing here would notice.
  return {
    status: "NO_SURFACE",
    detail:
      `eligibility correctly rejected the candidate (${verdict.reason}), but no candidate-to-Highlight path exists to assert the second half against: ` +
      "highlight_sources is migration 2722, unapplied, with no TypeScript writer, and POST /highlights inserts a client-supplied mediaUrl with no source Memory",
  };
}

// ── 4. Planned activity without occurrence cannot earn a visit ───────────────

async function plannedWithoutOccurrence(): Promise<{ status: InvariantStatus; detail: string }> {
  const now = new Date("2026-05-06T20:00:00.000Z");
  const planned = normalizeEvidence(
    {
      owner_id: "cert-owner", source_type: "TRIP_OUTCOME", source_id: "plan-x",
      assertion_type: "PLANNED", observed_at: "2026-05-06T10:00:00.000Z",
      assertion_json: { place_id: "place-x", plan_id: "plan-x" },
    },
    now,
  );
  const saved = normalizeEvidence(
    {
      owner_id: "cert-owner", source_type: "TELEGRAPH_MESSAGE", source_id: "saved-x",
      assertion_type: "SAVED", observed_at: "2026-05-06T11:00:00.000Z",
      assertion_json: { place_id: "place-x" },
    },
    now,
  );
  if (!planned.ok || !saved.ok) return { status: "VIOLATED", detail: "fixture signals failed to normalize" };

  const refused = evaluateEligibility([planned.evidence, saved.evidence], { mode: "AUTOMATIC" });
  if (refused.eligible || refused.reason !== "PLANNED_OR_SAVED_ONLY") {
    return { status: "VIOLATED", detail: `plan+save was ruled ${JSON.stringify(refused.reason)}, expected PLANNED_OR_SAVED_ONLY` };
  }

  // Positive control: the SAME world plus one occurrence-bearing record must be
  // eligible, or a gate that refuses everything would pass the assertion above.
  const occurred = normalizeEvidence(
    {
      owner_id: "cert-owner", source_type: "TRIP_OUTCOME", source_id: "plan-x-completed",
      assertion_type: "OCCURRED", observed_at: "2026-05-06T19:30:00.000Z",
      assertion_json: { place_id: "place-x", plan_id: "plan-x" },
    },
    now,
  );
  if (!occurred.ok) return { status: "VIOLATED", detail: "positive-control signal failed to normalize" };
  const allowed = evaluateEligibility([planned.evidence, saved.evidence, occurred.evidence], { mode: "AUTOMATIC" });
  if (!allowed.eligible) {
    return { status: "VIOLATED", detail: `positive control was refused (${allowed.reason}); the gate rejects everything` };
  }
  return {
    status: "HELD",
    detail:
      "PLANNED+SAVED alone is refused with PLANNED_OR_SAVED_ONLY and the same set plus one OCCURRED record is eligible, so the refusal is the intent rule and not a blanket deny. " +
      "CEILING: this is services/memoryProjections/evidence.ts, which no route imports; the live stamp path (routes/geofence.ts) enforces the same rule by requiring a check-in and is not exercised here",
  };
}

// ── 5. Blocked person cannot be newly resurfaced ─────────────────────────────

async function blockedPersonNotResurfaced(): Promise<{ status: InvariantStatus; detail: string }> {
  const blockedId = "cert-blocked-participant";
  const otherId = "cert-other-participant";
  const set = suppressions([{ control: "HIDE_PERSON_FROM_RESURFACING", subjectId: blockedId }]);

  if (!isSuppressed(set, "HIDE_PERSON_FROM_RESURFACING", blockedId)) {
    return { status: "VIOLATED", detail: "a person under HIDE_PERSON_FROM_RESURFACING was not suppressed" };
  }
  if (isSuppressed(set, "HIDE_PERSON_FROM_RESURFACING", otherId)) {
    return { status: "VIOLATED", detail: "suppression leaked to a person who is not under the control" };
  }
  // The control must reach the proactive surfaces, or suppressing it is a no-op.
  const surfaces = CONTROL_EFFECTS.HIDE_PERSON_FROM_RESURFACING.suppresses;
  if (!surfaces.includes("proactive_resurfacing") || !surfaces.includes("recap")) {
    return { status: "VIOLATED", detail: `HIDE_PERSON_FROM_RESURFACING suppresses ${surfaces.join(", ")}` };
  }
  // Fail-closed: an unreadable preference set must suppress, not serve.
  if (!isSuppressed({ state: "unreadable", reason: "certification" }, "HIDE_PERSON_FROM_RESURFACING", otherId)) {
    return { status: "VIOLATED", detail: "an unreadable suppression set served an unsuppressed feed" };
  }
  return {
    status: "HELD",
    detail:
      "HIDE_PERSON_FROM_RESURFACING suppresses exactly its subject across proactive_resurfacing and recap, does not leak to another participant, and an UNREADABLE preference set suppresses rather than serving. " +
      "CEILING: highlight_resurfacing_preferences is migration 2720, unapplied, so in production the set is `absent` and suppresses nothing — routes/highlights.ts logs exactly that on every request. The block half of this invariant is separately certified on the live route by src/test/memoriesBlockFailClosed.test.ts",
  };
}

// ── 6. Public location precision cannot exceed owner policy ──────────────────

async function publicPrecisionWithinPolicy(): Promise<{ status: InvariantStatus; detail: string }> {
  const world = HIGHLIGHT_PRECISION_WORLD;
  const row = world.highlights.find((h) => h.id === HIGHLIGHT_IDS.precise);
  if (!row) return { status: "VIOLATED", detail: "fixture highlight missing" };

  // Property over the whole ladder: what a rung discloses must be a subset of
  // what every finer rung discloses, and HIDDEN must disclose nothing.
  const disclosedFields = (rung: LocationPrecisionRung): string[] => {
    const d = resolveLocationDisclosure(row, rung, { state: "ready" });
    return (["location_name", "location_city", "location_country"] as const).filter((k) => d[k] !== null);
  };
  for (let i = 1; i < LOCATION_PRECISION_LADDER.length; i++) {
    const coarser = LOCATION_PRECISION_LADDER[i]!;
    const finer = LOCATION_PRECISION_LADDER[i - 1]!;
    const c = new Set(disclosedFields(coarser));
    const f = new Set(disclosedFields(finer));
    for (const field of c) {
      if (!f.has(field)) {
        return { status: "VIOLATED", detail: `${coarser} discloses ${field} but the finer rung ${finer} does not` };
      }
    }
  }
  if (disclosedFields("HIDDEN").length !== 0) {
    return { status: "VIOLATED", detail: "HIDDEN disclosed a location field" };
  }
  // Combining constraints may only tighten.
  for (const a of LOCATION_PRECISION_LADDER) {
    for (const b of LOCATION_PRECISION_LADDER) {
      const s = strictestPrecision(a, b);
      if (locationPrecisionRank(s) < Math.max(locationPrecisionRank(a), locationPrecisionRank(b))) {
        return { status: "VIOLATED", detail: `strictestPrecision(${a}, ${b}) = ${s} is looser than one of its inputs` };
      }
    }
  }
  // An unreadable policy must clamp to HIDDEN, not disclose.
  const unreadable = resolveLocationDisclosure(row, "EXACT", { state: "unreadable", reason: "certification" });
  if (unreadable.precision !== "HIDDEN" || unreadable.location_city !== null) {
    return { status: "VIOLATED", detail: `an unreadable policy disclosed ${JSON.stringify(unreadable)}` };
  }
  // A stored value that is not a rung is not permission.
  const garbage = resolveLocationDisclosure(row, "SOMEWHERE_NICE", { state: "ready" });
  if (garbage.precision !== "HIDDEN") {
    return { status: "VIOLATED", detail: `an unparseable stored precision disclosed ${JSON.stringify(garbage)}` };
  }
  return {
    status: "HELD",
    detail:
      "over all six rungs the disclosed field set is monotone toward HIDDEN, HIDDEN discloses nothing, strictestPrecision can only tighten, and both an unreadable policy row and an unparseable one clamp to HIDDEN. " +
      "This surface IS live: routes/highlights.ts applies resolveLocationDisclosure to the feeds. CEILING: highlight_projection_policies is migration 2721, unapplied, so the stored rung is always absent in production and the clamp is a no-op there — reported by resolveLocationDisclosure as applied:false with that reason",
  };
}

// ── 7. User correction cannot be overwritten by weaker inference ─────────────

async function correctionNotOverwritten(): Promise<{ status: InvariantStatus; detail: string }> {
  const fixture = getFixture("INCORRECT_GPS_PLACE_CORRECTION");
  const evidence = normalizedFrom(fixture.world);
  if (evidence.length !== 3) {
    return { status: "VIOLATED", detail: `fixture produced ${evidence.length} normalized records, expected 3` };
  }
  const gps = evidence.find((e) => e.source_type === "GPS_PROXIMITY");
  const correction = evidence.find((e) => e.is_correction);
  const laterCapture = evidence.find((e) => e.source_type === "CAMERA_CAPTURE");
  if (!gps || !correction || !laterCapture) {
    return { status: "VIOLATED", detail: "fixture is missing one of the three records the invariant needs" };
  }

  // Step 1: the correction lands on top of the wrong GPS inference and wins.
  const applied = mergeByPrecedence(
    { place_id: gps.assertion_json.place_id },
    { place_id: correction.assertion_json.place_id },
    { base: gps, incoming: correction },
  );
  if (applied.merged.place_id !== "place-correct-cafe") {
    return { status: "VIOLATED", detail: `the correction did not overwrite the inference: ${JSON.stringify(applied.merged)}` };
  }

  // Step 2, the invariant proper: a LATER inference with HIGHER source
  // confidence must not take the field back. If it did, the correction would be
  // a suggestion.
  if (laterCapture.confidence <= correction.confidence) {
    return {
      status: "VIOLATED",
      detail:
        `fixture is vacuous: the challenger's confidence (${laterCapture.confidence}) does not exceed the correction's (${correction.confidence}), ` +
        "so precedence would not be the thing being tested",
    };
  }
  if (Date.parse(laterCapture.observed_at) <= Date.parse(correction.observed_at)) {
    return { status: "VIOLATED", detail: "fixture is vacuous: the challenger does not arrive after the correction" };
  }
  const challenged = mergeByPrecedence(
    { place_id: applied.merged.place_id },
    { place_id: laterCapture.assertion_json.place_id },
    { base: correction, incoming: laterCapture },
  );
  if (challenged.merged.place_id !== "place-correct-cafe") {
    return { status: "VIOLATED", detail: `a weaker later inference overwrote the correction: ${JSON.stringify(challenged.merged)}` };
  }
  if (!challenged.refused.includes("place_id")) {
    return { status: "VIOLATED", detail: "the overwrite was refused silently — nothing recorded that a field was withheld" };
  }
  return {
    status: "HELD",
    detail:
      "a USER_CORRECTION observed at 18:00 overwrote a GPS inference, and a CAMERA_CAPTURE observed the NEXT DAY at HIGHER confidence (0.7 vs the correction's deliberately low 0.5) was refused the same field and reported in `refused`. " +
      "So the ordering is precedence, not recency and not score. " +
      "CEILING: services/memoryProjections/evidence.ts is imported by no route; memory_corrections (§3.6) does not exist, so no correction is durable in any database",
  };
}

// ── 8. Historical memory cannot assert current venue availability ────────────

async function historicalNotCurrent(): Promise<{ status: InvariantStatus; detail: string }> {
  const fixture = getFixture("SOLO_TRIP_EXPLICIT_REMEMBER");
  const client = await seededClient(fixture.world);
  const scope = { owner_id: fixture.world.owner_id, viewer_id: fixture.world.owner_id };
  const built = await rebuildProjection(client, "CompassMemoryProjection", scope, new Date(fixture.world.now));
  if (!built.ok) return { status: "VIOLATED", detail: `CompassMemoryProjection would not build: ${built.detail}` };
  if (built.value.rows.length === 0) return { status: "VIOLATED", detail: "fixture is inert: no rows projected" };

  for (const row of built.value.rows) {
    const note = row.confidence_note;
    if (typeof note !== "string" || !/historical record/i.test(note)) {
      return { status: "VIOLATED", detail: `a Compass fact travelled without a historical qualifier: ${JSON.stringify(row)}` };
    }
  }
  // Structural half: the whitelist must contain no field that could be read as
  // a statement about the venue NOW. A note is easy to add and easy to ignore;
  // an absent field cannot be misread.
  const def = getProjectionDefinition("CompassMemoryProjection");
  if (!def) return { status: "VIOLATED", detail: "CompassMemoryProjection has no definition" };
  const currentish = def.field_whitelist.filter((f) =>
    /^(is_open|open_now|status|availability|currently|hours|is_operational)/.test(f),
  );
  if (currentish.length > 0) {
    return { status: "VIOLATED", detail: `Compass whitelist carries present-tense fields: ${currentish.join(", ")}` };
  }
  return {
    status: "HELD",
    detail:
      "every CompassMemoryProjection row carries confidence_note naming it a historical record, and the field whitelist contains no availability/status/hours field that could be read as current truth. " +
      "CEILING: no Compass tool reads this projection — compass/CompassTools.ts declares eleven tools and none is memory-facing",
  };
}

// ── 9. Projection consumers must tolerate duplicate / out-of-order events ────

async function consumersTolerateDuplicates(): Promise<{ status: InvariantStatus; detail: string }> {
  const fixture = getFixture("DELETE_WITH_DERIVATIVES");
  const tables = tablesFor(fixture.world);
  const client = certificationClient(tables);
  const now = new Date(fixture.world.now);
  const scope = { owner_id: fixture.world.owner_id, viewer_id: null };

  const first = await rebuildProjection(client, "PublicMemoryProjection", scope, now);
  if (!first.ok) return { status: "VIOLATED", detail: `first build failed: ${first.detail}` };
  const second = await rebuildProjection(client, "PublicMemoryProjection", scope, now);
  if (!second.ok) return { status: "VIOLATED", detail: `replay failed: ${second.detail}` };

  if (JSON.stringify(first.value.rows) !== JSON.stringify(second.value.rows)) {
    return { status: "VIOLATED", detail: "replaying the same event produced different rows" };
  }
  if (first.value.registration.source_version !== second.value.registration.source_version) {
    return { status: "VIOLATED", detail: "replaying the same event produced a different source version" };
  }
  const registrations = tables[DERIVATIVE_REGISTRY_TABLE]!.filter(
    (r) => r.projection_id === "PublicMemoryProjection",
  );
  if (registrations.length !== 1) {
    return { status: "VIOLATED", detail: `a duplicate event produced ${registrations.length} registrations` };
  }

  // Out of order: a revocation followed by a routine rebuild must NOT resurrect
  // the derivative. That is the out-of-order case that actually loses data.
  const revoked = await revokeDerivativesForMemory(client, MEMORY_IDS.deleted, "privacy decision", now);
  if (!revoked.ok) return { status: "VIOLATED", detail: `revocation failed: ${revoked.detail}` };
  const late = await rebuildProjection(client, "PublicMemoryProjection", scope, now);
  if (!late.ok) return { status: "VIOLATED", detail: `post-revocation rebuild errored: ${late.detail}` };
  if (!late.value.was_revoked) {
    return { status: "VIOLATED", detail: "a rebuild arriving after a revocation resurrected the derivative" };
  }
  return {
    status: "HELD",
    detail:
      "a replayed rebuild produced byte-identical rows, the same source version and exactly one registration; a rebuild arriving AFTER a revocation reported was_revoked and did not resurrect the payload. " +
      "CEILING: nothing consumes the outbox — memory_event_outbox is migration 2710, unapplied, and lib/memoryOutbox.ts records that no code acks published_at, so there is no live consumer for this property to protect",
  };
}

const DEFINITIONS: readonly InvariantDefinition[] = Object.freeze([
  {
    id: "PRIVATE_NOT_IN_PUBLIC_SEARCH", census_id: "H236", spec_line: 657,
    spec_text: "PRIVATE memory cannot appear in public search.",
    surface: "services/memoryProjections/projectionRegistry.ts PublicMemoryProjection + services/memoryRetrieval/searchMemories.ts",
    reachable_from_a_route: false,
    run: privateNotInPublicSearch,
  },
  {
    id: "DELETED_NOT_IN_COMPASS_RETRIEVAL", census_id: "H237", spec_line: 658,
    spec_text: "Deleted memory cannot remain in Compass retrieval.",
    surface: "services/memoryProjections/projectionRegistry.ts CompassMemoryProjection + derivativeRegistry.revokeDerivativesForMemory",
    reachable_from_a_route: false,
    run: deletedNotInCompassRetrieval,
  },
  {
    id: "REJECTED_CANDIDATE_NOT_A_HIGHLIGHT", census_id: "H238", spec_line: 659,
    spec_text: "Rejected candidate cannot become a Highlight.",
    surface: "services/memoryProjections/evidence.ts evaluateEligibility (rejection half only)",
    reachable_from_a_route: false,
    run: rejectedCandidateNotAHighlight,
  },
  {
    id: "PLANNED_WITHOUT_OCCURRENCE_NOT_A_VISIT", census_id: "H239", spec_line: 660,
    spec_text: "Planned activity without occurrence evidence cannot earn a visit Memory/Stamp.",
    surface: "services/memoryProjections/evidence.ts evaluateEligibility",
    reachable_from_a_route: false,
    run: plannedWithoutOccurrence,
  },
  {
    id: "BLOCKED_PERSON_NOT_RESURFACED", census_id: "H240", spec_line: 661,
    spec_text: "Blocked person cannot be newly resurfaced through shared-memory recommendations.",
    surface: "services/highlights/highlightResurfacing.ts isSuppressed / CONTROL_EFFECTS",
    reachable_from_a_route: true,
    run: blockedPersonNotResurfaced,
  },
  {
    id: "PUBLIC_PRECISION_WITHIN_OWNER_POLICY", census_id: "H241", spec_line: 662,
    spec_text: "Public location precision cannot exceed owner policy.",
    surface: "services/highlights/highlightProjectionPolicy.ts resolveLocationDisclosure",
    reachable_from_a_route: true,
    run: publicPrecisionWithinPolicy,
  },
  {
    id: "CORRECTION_NOT_OVERWRITTEN_BY_INFERENCE", census_id: "H242", spec_line: 663,
    spec_text: "User correction cannot be overwritten by weaker inference.",
    surface: "services/memoryProjections/evidence.ts mergeByPrecedence / precedenceRank",
    reachable_from_a_route: false,
    run: correctionNotOverwritten,
  },
  {
    id: "HISTORICAL_NOT_CURRENT_AVAILABILITY", census_id: "H243", spec_line: 664,
    spec_text: "Historical memory cannot assert current venue availability.",
    surface: "services/memoryProjections/projectionRegistry.ts CompassMemoryProjection",
    reachable_from_a_route: false,
    run: historicalNotCurrent,
  },
  {
    id: "CONSUMERS_TOLERATE_DUPLICATE_AND_OUT_OF_ORDER", census_id: "H244", spec_line: 665,
    spec_text: "Projection consumers must tolerate duplicate/out-of-order events.",
    surface: "services/memoryProjections/derivativeRegistry.ts rebuildProjection / revokeDerivativesForMemory",
    reachable_from_a_route: false,
    run: consumersTolerateDuplicates,
  },
]);

/** Present so a caller can enumerate without running. */
export function listInvariants(): ReadonlyArray<Omit<InvariantDefinition, "run">> {
  return DEFINITIONS.map(({ run: _run, ...rest }) => rest);
}

export async function runInvariant(id: InvariantId): Promise<InvariantOutcome> {
  const def = DEFINITIONS.find((d) => d.id === id);
  if (!def) throw new Error(`unknown invariant: ${id}`);
  let result: { status: InvariantStatus; detail: string };
  try {
    result = await def.run();
  } catch (err) {
    // A thrown checker is a VIOLATION, never a skip: an invariant that crashed
    // proved nothing and must not be reported as "no surface".
    result = { status: "VIOLATED", detail: `invariant threw: ${String((err as Error)?.message ?? err)}` };
  }
  return {
    id: def.id,
    census_id: def.census_id,
    spec_line: def.spec_line,
    spec_text: def.spec_text,
    surface: def.surface,
    reachable_from_a_route: def.reachable_from_a_route,
    ...result,
  };
}

export async function runAllInvariants(): Promise<InvariantOutcome[]> {
  const out: InvariantOutcome[] = [];
  for (const id of INVARIANT_IDS) out.push(await runInvariant(id));
  return out;
}

/**
 * The §17 commands the merge/split invariants would need, with the reason the
 * bus gives for not declaring them. Re-exported so the certification report can
 * cite the code rather than restate it.
 */
export const UNDECLARED_COMMANDS = MEMORY_COMMAND_TYPES_NOT_DECLARED;
