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

/**
 * The canonical row shape read from `public.highlights`, for the §18 row whose
 * subject is a HIGHLIGHT rather than a Memory (§12).
 *
 * MEASURED against `src/lib/capability/snapshots/20260922-production-schema.json`
 * (watermark 20260922155706): every column below is on the deployed table.
 * `lifetime_class`, `lifecycle_state` and `pinned_at` arrived with migration
 * 2723, applied to production at 20260915080401.
 *
 * WHAT IS DELIBERATELY NOT HERE. `caption`, `media_url`, `media_type`,
 * `location_name` and `filter_*` are columns this projection must never carry
 * and therefore never reads. That is the same discipline the field whitelist
 * enforces on the way out, applied one step earlier on the way in: a column
 * that is never selected cannot leak through a whitelist someone widens later.
 * `lifecycle_state` is absent because nothing in this server writes it and
 * services/highlights/highlightLifecycle.ts DERIVES the lifecycle instead — a
 * projection reading a column no writer maintains would publish a stale
 * constant.
 */
export interface HighlightSourceRow {
  id: string;
  owner_id: string;
  visibility: string;
  created_at: string;
  /** Present since 2723's predecessor; the staleness digest's input. */
  updated_at: string | null;
  expires_at: string | null;
  /** §21's terminal soft delete. */
  deleted_at: string | null;
  /** §21's REVERSIBLE hide — §17's HIDE_HIGHLIGHT. Not the delete. */
  archived_at: string | null;
  pinned_at: string | null;
  lifetime_class: string | null;
  location_city: string | null;
  location_country: string | null;
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
  /**
   * §12's Highlights, for the projections that declare `highlights` among their
   * source tables.
   *
   * OPTIONAL, AND ABSENT MEANS "NO HIGHLIGHT ROWS" RATHER THAN "UNKNOWN". The
   * read that populates it is `readProjectionSources`, which only performs it
   * for a projection whose definition asks for it — so a builder never has to
   * tell a missing read from an empty table, because the only caller that can
   * produce the first is the one that refuses instead. A DIRECT caller that
   * builds from rows it loaded itself (routes/memories.ts does exactly that)
   * simply omits it and gets the Memory half alone, unchanged.
   */
  highlights?: readonly HighlightSourceRow[];
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

/**
 * PassportMemoryProjection's whitelist. SPLIT OUT of ProfileHighlightProjection's
 * in this lane and deliberately left identical field-for-field: the two are
 * different §18 rows with different audiences, and sharing one constant meant a
 * field the profile needed could not be added without also widening what
 * Passport publishes. Two names, so the two can diverge on purpose rather than
 * by accident.
 */
const PASSPORT_FIELDS = [
  "memory_id", "occurred_at", "title", "location_city", "location_country", "media_count", "audience",
] as const;

/**
 * ProfileHighlightProjection's whitelist. The last five fields are the
 * HIGHLIGHT half.
 *
 * §12 (:357): "Highlights are disposable, audience-specific projections over
 * one or more Memories or Episodes." §18's ProfileHighlightProjection is the
 * row whose audience is, verbatim, "Audience-specific profile". Until this lane
 * this builder read only `memories`, so §17's five `highlight.*` events had NO
 * §18 projection keyed on their subject and drained as
 * `unsubscribed_event_type`.
 *
 * `source` is what keeps the two halves distinguishable rather than blended: a
 * reader can always tell a projected Memory from a projected Highlight, and
 * `memory_id` and `highlight_id` are never both non-null on one row.
 *
 * `caption` IS STILL ABSENT, from both halves. `public.highlights.caption` is
 * free text the owner wrote and is exactly what §10 keeps off an
 * audience-specific surface, so the highlight half carries NO text at all
 * rather than smuggling a caption through `title`.
 *
 * `expires_at` and `pinned` are CARRIED rather than APPLIED. §12's expiry is a
 * read-time predicate ("Expires after recent context unless pinned"); a builder
 * that filtered on a clock would stop being a pure function of its rows and
 * could not be replayed, which is 28.12's requirement and the reason
 * `deriveProjection` is pure once the read has happened.
 */
const PROFILE_HIGHLIGHT_FIELDS = [
  "memory_id", "occurred_at", "title", "location_city", "location_country", "media_count", "audience",
  "highlight_id", "source", "pinned", "lifetime_class", "expires_at",
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
    field_whitelist: PASSPORT_FIELDS,
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
        }, PASSPORT_FIELDS));
    },
  },
  {
    id: "ProfileHighlightProjection",
    audience: "AUDIENCE_SPECIFIC_PROFILE",
    availability: "BUILDABLE",
    unavailable_reason: "",
    // @2 because the builder gained a second source. The output for an input
    // with no `highlights` is byte-identical to @1's, which is what keeps the
    // route at routes/memories.ts serving the same rows; the version moves
    // anyway, because a registration written by a builder that CAN read
    // Highlights is not the same artifact as one written by a builder that
    // cannot, and §18 registers `builder_version` precisely so that difference
    // is legible.
    builder_version: "profile-highlight@2",
    source_tables: ["memories", "memory_items", "highlights"],
    destination: "profile.highlights",
    field_whitelist: PROFILE_HIGHLIGHT_FIELDS,
    emits_significance: false,
    build(input) {
      const viewer = input.scope.viewer_id ?? null;
      const isOwner = viewer !== null && viewer === input.scope.owner_id;

      const fromMemories = ownerVisible(input)
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
          highlight_id: null,
          source: "memory",
          occurred_at: occurredAt(m),
          media_count: mediaCount(input, m.id),
          audience: isOwner ? "OWNER" : "VIEWER",
          // A Memory is not pinnable and has no lifetime class; both are
          // Highlight concepts (§12). Written explicitly so the row shape is
          // uniform rather than depending on project()'s null padding.
          pinned: false,
          lifetime_class: null,
          expires_at: null,
        }, PROFILE_HIGHLIGHT_FIELDS));

      // ── §12's Highlights. See PROFILE_HIGHLIGHT_FIELDS for why this half
      // exists and what it deliberately does not carry. ────────────────────
      const fromHighlights = (input.highlights ?? [])
        .filter((h) => h.owner_id === input.scope.owner_id)
        // §21 keeps the three removals separate, and a profile is BROWSING:
        // `deleted_at` is the terminal soft delete, `archived_at` is the
        // reversible hide whose whole definition is "remove from normal
        // browsing unless explicitly requested". Neither belongs on a profile,
        // INCLUDING the owner's own — the owner reaches archived Highlights
        // through the explicit request, which is a different surface.
        .filter((h) => h.deleted_at === null && h.archived_at === null)
        // §23 for a Highlight is `highlights.owner_id`, and `public.highlights`
        // carries no allow-list and no hidden-user list: the only audience
        // distinction the row can support is public / not public. A builder
        // that guessed a friendship here would be inventing an authorization
        // the table cannot express, so anything not `public` is owner-only.
        .filter((h) => isOwner || h.visibility === "public")
        .map((h) => project({
          ...h,
          memory_id: null,
          highlight_id: h.id,
          source: "highlight",
          // §3.1 occurred_at. `highlights` has no start time; `created_at` is
          // when the Highlight was made and is the only instant the row has.
          occurred_at: h.created_at,
          // Never the caption. See PROFILE_HIGHLIGHT_FIELDS.
          title: null,
          // `public.highlights` is one media_url per row — it is the 24-hour
          // Stories shape — so the count is 1 and is not a guess.
          media_count: 1,
          audience: isOwner ? "OWNER" : "VIEWER",
          pinned: h.pinned_at !== null,
          lifetime_class: h.lifetime_class,
          expires_at: h.expires_at,
        }, PROFILE_HIGHLIGHT_FIELDS));

      // §12: "Pinned/manual order always outranks automatic ordering." Applied
      // across BOTH halves, not within each, so a pinned Highlight outranks a
      // newer Memory rather than merely a newer Highlight. The id tiebreak
      // keeps the order total, which is what makes a rebuild byte-identical.
      return [...fromMemories, ...fromHighlights].sort((a, b) => {
        const ap = a.pinned === true ? 0 : 1;
        const bp = b.pinned === true ? 0 : 1;
        if (ap !== bp) return ap - bp;
        const at = String(a.occurred_at ?? "");
        const bt = String(b.occurred_at ?? "");
        if (at !== bt) return bt.localeCompare(at);
        return String(a.memory_id ?? a.highlight_id ?? "").localeCompare(
          String(b.memory_id ?? b.highlight_id ?? ""),
        );
      });
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
export function sourceVersionOf(
  memories: readonly MemorySourceRow[],
  /**
   * The Highlight half of the same question, for ProfileHighlightProjection.
   *
   * BACKWARD-COMPATIBLE BY CONSTRUCTION: with no highlights the output is
   * byte-identical to what this function returned before the parameter existed,
   * `v1` tag and all. That matters because a registration written by the old
   * code carries a `v1` digest, and a comparison that changed shape would
   * report every existing registration STALE on the first pass after deploy —
   * a correct-looking stampede over projections nothing had changed.
   *
   * Highlight entries are keyed `highlight:<id>` so a caller reading
   * `changed_memory_ids` can still tell which aggregate moved; they cannot
   * collide with a Memory id, which is a bare uuid.
   */
  highlights: readonly HighlightSourceRow[] = [],
): {
  digest: string;
  per_memory: Record<string, string>;
} {
  const per: Record<string, string> = {};
  for (const m of [...memories].sort((a, b) => a.id.localeCompare(b.id))) per[m.id] = m.updated_at;
  for (const h of [...highlights].sort((a, b) => a.id.localeCompare(b.id))) {
    // `updated_at` is nullable on `highlights` (rows written before the column
    // existed). `created_at` is NOT NULL and never moves, so falling back to it
    // makes such a row a CONSTANT in the digest rather than an absent one —
    // which is honest: nothing about that row can be observed to have changed.
    per[`highlight:${h.id}`] = h.updated_at ?? h.created_at;
  }
  const text = Object.entries(per).map(([id, v]) => `${id}@${v}`).join("|");
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c * (i + 1), 0x85ebca6b) >>> 0;
  }
  const tag = highlights.length === 0 ? `v1:${memories.length}` : `v2:${memories.length}+${highlights.length}`;
  return {
    digest: `${tag}:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`,
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
