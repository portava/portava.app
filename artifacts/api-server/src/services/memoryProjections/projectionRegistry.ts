/**
 * Projections and the derived-artifact registry: the definitions.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 18 "Projections and Derived Artifact Registry"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:512)
 *       Section 10 "Privacy, Consent, and Projection Policy" (:320)
 *       Section 28.12 "Always make derived projections rebuildable."
 *       Section 28.6 "Never expose private canonical Memory records to public
 *       search and rely on post-filtering."
 *       Section 28.11 "Never swallow projection/schema failures into
 *       plausible-looking empty history without structured error state."
 *
 * CENSUS: section 18's twelve rows - MemoryTimelineProjection,
 *         PassportMemoryProjection, ProfileHighlightProjection,
 *         TripMemoryProjection, PlaceMemoryProjection, PeopleMemoryProjection,
 *         CompassMemoryProjection, PublicMemoryProjection, SearchEmbedding,
 *         NarrativeDerivative, MapTrailDerivative, and derivative registration -
 *         eight BUILT-BUT-WRONG, four NOT-BUILT
 *         (docs/architecture/census-highlights-memories.md, section 18).
 *
 * WHAT A PROJECTION IS HERE. Three things, or it is not one:
 *   1. it DECLARES what it derives from (`source_tables`, `builder_version`),
 *   2. it is REBUILDABLE from those sources by a pure function of the rows, and
 *   3. it can say whether it is STALE, by comparing the source version it was
 *      built from against the sources as they are now.
 * Definitions live in this file and are pure. The database half - registration,
 * staleness and revocation - is derivativeRegistry.ts, so a builder cannot
 * quietly acquire an I/O dependency and stop being replayable.
 *
 * FIELD WHITELISTS ARE THE PRIVACY MECHANISM, AND ARE LOAD-BEARING. Each builder
 * hands `project()` the WHOLE canonical row plus whatever it computed, and
 * `project()` copies only the whitelisted keys. This is deliberate: an earlier
 * draft assembled a literal containing exactly the whitelisted fields, which
 * made the whitelist decorative - deleting it changed no output and broke no
 * test. Written this way, deleting the narrowing step leaks coordinates and
 * hidden-user lists into the public projection, and the suite says so.
 */

import type { SignificanceExplanation } from "./significance.js";

export type ProjectionId =
  | "MemoryTimelineProjection"
  | "PassportMemoryProjection"
  | "ProfileHighlightProjection"
  | "TripMemoryProjection"
  | "PlaceMemoryProjection"
  | "PeopleMemoryProjection"
  | "CompassMemoryProjection"
  | "PublicMemoryProjection"
  | "SearchEmbedding"
  | "NarrativeDerivative"
  | "MapTrailDerivative";

/** Section 18's "Audience" column. */
export type ProjectionAudience =
  | "OWNER_PRIVATE"
  | "OWNER_OR_PUBLIC_PER_PASSPORT_POLICY"
  | "AUDIENCE_SPECIFIC_PROFILE"
  | "TRIP_RECAP"
  | "SHARED_HISTORY"
  | "COMPASS_AUTHORIZED_FACTS"
  | "PUBLIC"
  | "NAMESPACE_SCOPED_RETRIEVAL"
  | "OPTIONAL_AI_SUMMARY"
  | "SPATIAL_PRESENTATION";

/**
 * A projection this repository cannot honestly build yet says so, loudly.
 * NOT_CONFIGURED is not "empty": callers must surface a refusal, never a page
 * that reads as "you have no memories" (28.11).
 */
export type ProjectionAvailability = "BUILDABLE" | "NOT_CONFIGURED";

/** The canonical row shape read from `memories` (0067 + 0148). */
export interface MemorySourceRow {
  id: string;
  owner_id: string;
  title: string | null;
  caption: string | null;
  visibility: string;
  state: string;
  trip_id: string | null;
  event_id: string | null;
  place_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
  location_city: string | null;
  location_country: string | null;
  location_lat: number | null;
  location_lng: number | null;
  canonical_location_id: string | null;
  allowed_user_ids: string[] | null;
  hidden_user_ids: string[] | null;
}

export interface MemoryTagRow {
  memory_id: string;
  tagged_user_id: string;
  status: string;
}

export interface MemoryItemRow {
  memory_id: string;
  media_url: string;
  media_type: string;
  position: number;
}

/** What a projection is being built FOR. Every builder must respect it. */
export interface ProjectionScope {
  owner_id: string;
  /** Who will read the result. Equal to owner_id for owner-private projections. */
  viewer_id?: string | null;
  trip_id?: string | null;
  place_id?: string | null;
  person_id?: string | null;
}

export interface ProjectionInput {
  scope: ProjectionScope;
  memories: readonly MemorySourceRow[];
  tags: readonly MemoryTagRow[];
  items: readonly MemoryItemRow[];
  /** Section 8 output, owner-facing only. Absent is normal, not an error. */
  significance?: ReadonlyMap<string, SignificanceExplanation>;
}

export type ProjectedRow = Record<string, unknown>;

export interface ProjectionDefinition {
  id: ProjectionId;
  audience: ProjectionAudience;
  availability: ProjectionAvailability;
  /** Why, when NOT_CONFIGURED. Empty otherwise. */
  unavailable_reason: string;
  builder_version: string;
  /** Section 18 registration field: what this derives from. */
  source_tables: readonly string[];
  /** Section 18 registration field: where the derivative is delivered. */
  destination: string;
  /** The complete set of keys a row may carry. Nothing else is copied. */
  field_whitelist: readonly string[];
  /** May a significance figure appear? Only ever for the owner (section 8, H64). */
  emits_significance: boolean;
  build: (input: ProjectionInput) => ProjectedRow[];
}

/** Copy exactly the whitelisted keys. Absent keys become null, never "missing". */
function project(row: Record<string, unknown>, whitelist: readonly string[]): ProjectedRow {
  const out: ProjectedRow = {};
  for (const key of whitelist) out[key] = key in row ? row[key] : null;
  return out;
}

/** Rows the owner may see at all: everything they own that is not deleted. */
function ownerVisible(input: ProjectionInput): MemorySourceRow[] {
  return input.memories
    .filter((m) => m.owner_id === input.scope.owner_id && m.state !== "deleted" && m.state !== "removed")
    .sort((a, b) => occurredAt(b).localeCompare(occurredAt(a)) || a.id.localeCompare(b.id));
}

/** Section 3.1 `occurred_at`. `memories` has starts_at; created_at is the fallback. */
export function occurredAt(m: MemorySourceRow): string {
  return m.starts_at ?? m.created_at;
}

function approvedTagsFor(input: ProjectionInput, memoryId: string): string[] {
  return input.tags
    .filter((t) => t.memory_id === memoryId && t.status === "approved")
    .map((t) => t.tagged_user_id)
    .sort();
}

function mediaCount(input: ProjectionInput, memoryId: string): number {
  return input.items.filter((i) => i.memory_id === memoryId).length;
}

const TIMELINE_FIELDS = [
  "memory_id", "occurred_at", "ended_at", "title", "caption", "place_id",
  "location_city", "location_country", "trip_id", "event_id", "media_count",
  "people", "visibility", "state", "significance_score", "significance_tier",
] as const;

const PUBLIC_FIELDS = [
  "memory_id", "owner_id", "occurred_at", "title", "caption",
  "location_city", "location_country", "media_count",
] as const;

const COMPASS_FIELDS = [
  "memory_id", "occurred_at", "place_id", "canonical_location_id",
  "location_city", "location_country", "trip_id", "event_id", "confidence_note",
] as const;

const TRIP_FIELDS = [
  "memory_id", "occurred_at", "title", "place_id", "location_city",
  "location_country", "media_count", "people",
] as const;

const PLACE_FIELDS = [
  "memory_id", "occurred_at", "title", "place_id", "canonical_location_id",
  "location_city", "location_country", "visit_index",
] as const;

const PEOPLE_FIELDS = ["memory_id", "occurred_at", "title", "location_city", "location_country", "person_id"] as const;

const MAP_TRAIL_FIELDS = ["memory_id", "occurred_at", "lat", "lng", "place_id", "precision"] as const;

const PROFILE_HIGHLIGHT_FIELDS = [
  "memory_id", "occurred_at", "title", "location_city", "location_country", "media_count", "audience",
] as const;

/**
 * The eleven section 18 rows. Order matches the spec table so the two can be
 * diffed by eye.
 */
const DEFINITIONS: ProjectionDefinition[] = [
  {
    id: "MemoryTimelineProjection",
    audience: "OWNER_PRIVATE",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "timeline@1",
    source_tables: ["memories", "memory_items", "memory_tags"],
    destination: "owner.private.timeline",
    field_whitelist: TIMELINE_FIELDS,
    // The owner's own timeline is the one surface where significance may show.
    emits_significance: true,
    build(input) {
      return ownerVisible(input).map((m) => {
        const sig = input.significance?.get(m.id);
        return project({
          ...m,
          memory_id: m.id,
          occurred_at: occurredAt(m),
          ended_at: m.ends_at,
          title: m.title,
          caption: m.caption,
          place_id: m.place_id,
          location_city: m.location_city,
          location_country: m.location_country,
          trip_id: m.trip_id,
          event_id: m.event_id,
          media_count: mediaCount(input, m.id),
          people: approvedTagsFor(input, m.id),
          visibility: m.visibility,
          state: m.state,
          significance_score: sig ? sig.score : null,
          significance_tier: sig ? sig.tier : null,
        }, TIMELINE_FIELDS);
      });
    },
  },
  {
    id: "PassportMemoryProjection",
    audience: "OWNER_OR_PUBLIC_PER_PASSPORT_POLICY",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "passport@1",
    source_tables: ["memories", "memory_items"],
    destination: "passport.memories",
    field_whitelist: PROFILE_HIGHLIGHT_FIELDS,
    emits_significance: false,
    build(input) {
      // Passport shows places reached, so a Memory with no place at all is not
      // a passport artefact. It is NOT given a fabricated location.
      return ownerVisible(input)
        .filter((m) => m.location_country !== null || m.place_id !== null)
        .map((m) => project({
          ...m,
          memory_id: m.id,
          occurred_at: occurredAt(m),
          media_count: mediaCount(input, m.id),
          audience: "OWNER_OR_PUBLIC_PER_PASSPORT_POLICY",
        }, PROFILE_HIGHLIGHT_FIELDS));
    },
  },
  {
    id: "ProfileHighlightProjection",
    audience: "AUDIENCE_SPECIFIC_PROFILE",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "profile-highlight@1",
    source_tables: ["memories", "memory_items"],
    destination: "profile.highlights",
    field_whitelist: PROFILE_HIGHLIGHT_FIELDS,
    emits_significance: false,
    build(input) {
      const viewer = input.scope.viewer_id ?? null;
      const isOwner = viewer !== null && viewer === input.scope.owner_id;
      return ownerVisible(input)
        .filter((m) => {
          if (m.state !== "published") return false;
          if (isOwner) return true;
          // A viewer the owner hid never reaches the result set, and a
          // restricted-audience Memory is admitted only by explicit allow-list.
          if (viewer !== null && (m.hidden_user_ids ?? []).includes(viewer)) return false;
          if (m.visibility === "public") return true;
          if (m.visibility === "custom") return viewer !== null && (m.allowed_user_ids ?? []).includes(viewer);
          return false;
        })
        .map((m) => project({
          ...m,
          memory_id: m.id,
          occurred_at: occurredAt(m),
          media_count: mediaCount(input, m.id),
          audience: isOwner ? "OWNER" : "VIEWER",
        }, PROFILE_HIGHLIGHT_FIELDS));
    },
  },
  {
    id: "TripMemoryProjection",
    audience: "TRIP_RECAP",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "trip@1",
    source_tables: ["memories", "memory_items", "memory_tags"],
    destination: "trip.recap",
    field_whitelist: TRIP_FIELDS,
    emits_significance: false,
    build(input) {
      const tripId = input.scope.trip_id ?? null;
      if (tripId === null) return [];
      return ownerVisible(input)
        .filter((m) => m.trip_id === tripId)
        .sort((a, b) => occurredAt(a).localeCompare(occurredAt(b)) || a.id.localeCompare(b.id))
        .map((m) => project({
          ...m,
          memory_id: m.id,
          occurred_at: occurredAt(m),
          media_count: mediaCount(input, m.id),
          people: approvedTagsFor(input, m.id),
        }, TRIP_FIELDS));
    },
  },
  {
    id: "PlaceMemoryProjection",
    audience: "OWNER_PRIVATE",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "place@1",
    source_tables: ["memories"],
    destination: "owner.place.history",
    field_whitelist: PLACE_FIELDS,
    emits_significance: false,
    build(input) {
      const placeId = input.scope.place_id ?? null;
      if (placeId === null) return [];
      const rows = ownerVisible(input)
        .filter((m) => m.place_id === placeId || m.canonical_location_id === placeId)
        .sort((a, b) => occurredAt(a).localeCompare(occurredAt(b)) || a.id.localeCompare(b.id));
      // visit_index is the owner's own history at this place: 1 is the first visit.
      return rows.map((m, i) => project({
        ...m,
        memory_id: m.id,
        occurred_at: occurredAt(m),
        visit_index: i + 1,
      }, PLACE_FIELDS));
    },
  },
  {
    id: "PeopleMemoryProjection",
    audience: "SHARED_HISTORY",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "people@1",
    source_tables: ["memories", "memory_tags"],
    destination: "people.shared_history",
    field_whitelist: PEOPLE_FIELDS,
    emits_significance: false,
    build(input) {
      const personId = input.scope.person_id ?? null;
      if (personId === null) return [];
      // Shared history requires an APPROVED tag. A pending or removed tag is not
      // a shared experience, and being tagged confers no ownership (H83).
      const approved = new Set(
        input.tags.filter((t) => t.tagged_user_id === personId && t.status === "approved").map((t) => t.memory_id),
      );
      return ownerVisible(input)
        .filter((m) => approved.has(m.id))
        .map((m) => project({
          ...m,
          memory_id: m.id,
          occurred_at: occurredAt(m),
          person_id: personId,
        }, PEOPLE_FIELDS));
    },
  },
  {
    id: "CompassMemoryProjection",
    audience: "COMPASS_AUTHORIZED_FACTS",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "compass@1",
    source_tables: ["memories"],
    destination: "compass.authorized_facts",
    field_whitelist: COMPASS_FIELDS,
    emits_significance: false,
    build(input) {
      // "Minimal authorized retrieval facts": structure and identity, no prose.
      // Section 16 forbids Compass writing canonical facts through prose, and
      // section 14 forbids historical state being read as current truth - hence
      // the explicit note travelling with every row.
      return ownerVisible(input).map((m) => project({
        ...m,
        memory_id: m.id,
        occurred_at: occurredAt(m),
        confidence_note: "historical record; not evidence of current operational state (section 14)",
      }, COMPASS_FIELDS));
    },
  },
  {
    id: "PublicMemoryProjection",
    audience: "PUBLIC",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "public@1",
    source_tables: ["memories", "memory_items"],
    destination: "public.social_search",
    field_whitelist: PUBLIC_FIELDS,
    // H64: a public surface never carries significance, not even as a tier.
    emits_significance: false,
    build(input) {
      return input.memories
        .filter((m) => m.owner_id === input.scope.owner_id && m.state === "published" && m.visibility === "public")
        .sort((a, b) => occurredAt(b).localeCompare(occurredAt(a)) || a.id.localeCompare(b.id))
        .map((m) => project({
          ...m,
          memory_id: m.id,
          occurred_at: occurredAt(m),
          // Section 10 / 28.7: a public derivative carries city and country, never
          // a coordinate. The whitelist is what enforces that: the builder hands
          // project() the WHOLE canonical row, including the coordinate columns,
          // and only PUBLIC_FIELDS survives. A column added to `memories`
          // tomorrow is therefore absent from this projection by default.
          media_count: mediaCount(input, m.id),
        }, PUBLIC_FIELDS));
    },
  },
  {
    id: "SearchEmbedding",
    audience: "NAMESPACE_SCOPED_RETRIEVAL",
    availability: "NOT_CONFIGURED",
    unavailable_reason:
      "No embedding backend exists in this repository. Reporting NOT_CONFIGURED is the honest answer; " +
      "emitting an empty index would make an absent capability look like a person with no memories (28.11).",
    builder_version: "search-embedding@0",
    source_tables: ["memories"],
    destination: "search.embeddings",
    field_whitelist: ["memory_id", "namespace"],
    emits_significance: false,
    build() { return []; },
  },
  {
    id: "NarrativeDerivative",
    audience: "OPTIONAL_AI_SUMMARY",
    availability: "NOT_CONFIGURED",
    unavailable_reason:
      "No narrator is wired. Section 1 forbids AI manufacturing historical facts, so this projection emits " +
      "nothing rather than a generated summary; the supporting facts are listed for a narrator to summarize.",
    builder_version: "narrative@0",
    source_tables: ["memories"],
    destination: "narrative.summaries",
    field_whitelist: ["memory_id", "summary", "supporting_fact_ids"],
    emits_significance: false,
    build() { return []; },
  },
  {
    id: "MapTrailDerivative",
    audience: "SPATIAL_PRESENTATION",
    availability: "BUILDABLE",
    unavailable_reason: "",
    builder_version: "map-trail@1",
    source_tables: ["memories"],
    destination: "map.trail",
    field_whitelist: MAP_TRAIL_FIELDS,
    emits_significance: false,
    build(input) {
      const isOwner = (input.scope.viewer_id ?? input.scope.owner_id) === input.scope.owner_id;
      return ownerVisible(input)
        .filter((m) => m.location_lat !== null && m.location_lng !== null)
        .sort((a, b) => occurredAt(a).localeCompare(occurredAt(b)) || a.id.localeCompare(b.id))
        .map((m) => project({
          ...m,
          memory_id: m.id,
          occurred_at: occurredAt(m),
          // Section 10 precision ladder: an exact coordinate is owner-only. Any
          // other reader gets the coordinate rounded to roughly city scale, and
          // `precision` says so rather than implying a fix nobody measured.
          lat: isOwner ? m.location_lat : coarsen(m.location_lat),
          lng: isOwner ? m.location_lng : coarsen(m.location_lng),
          place_id: m.place_id,
          precision: isOwner ? "EXACT" : "CITY",
        }, MAP_TRAIL_FIELDS));
    },
  },
];

export const PROJECTION_DEFINITIONS: readonly ProjectionDefinition[] = Object.freeze(DEFINITIONS);

/** ~11 km grid. Coarse enough that the point is a city, not a doorway. */
function coarsen(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

const BY_ID = new Map<ProjectionId, ProjectionDefinition>(PROJECTION_DEFINITIONS.map((d) => [d.id, d]));

export function getProjectionDefinition(id: ProjectionId): ProjectionDefinition | null {
  return BY_ID.get(id) ?? null;
}

export function listProjectionIds(): ProjectionId[] {
  return PROJECTION_DEFINITIONS.map((d) => d.id);
}

/**
 * Section 18 "Every derivative is registered with source Memory version".
 *
 * The version of a projection's inputs is a digest over (memory id, updated_at)
 * for exactly the rows that fed it. Any insert, edit, visibility change or
 * soft-delete moves `updated_at`, so it moves the digest, so the projection can
 * be told it is stale without anybody remembering to invalidate it.
 */
export function sourceVersionOf(memories: readonly MemorySourceRow[]): {
  digest: string;
  per_memory: Record<string, string>;
} {
  const per: Record<string, string> = {};
  for (const m of [...memories].sort((a, b) => a.id.localeCompare(b.id))) per[m.id] = m.updated_at;
  const text = Object.entries(per).map(([id, v]) => `${id}@${v}`).join("|");
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c * (i + 1), 0x85ebca6b) >>> 0;
  }
  return {
    digest: `v1:${memories.length}:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`,
    per_memory: per,
  };
}

/** The registry key for one built artifact: one projection, one scope. */
export function scopeKeyOf(id: ProjectionId, scope: ProjectionScope): string {
  const parts = [
    `owner:${scope.owner_id}`,
    scope.viewer_id ? `viewer:${scope.viewer_id}` : null,
    scope.trip_id ? `trip:${scope.trip_id}` : null,
    scope.place_id ? `place:${scope.place_id}` : null,
    scope.person_id ? `person:${scope.person_id}` : null,
  ].filter((p): p is string => p !== null);
  return `${id}|${parts.join("|")}`;
}
