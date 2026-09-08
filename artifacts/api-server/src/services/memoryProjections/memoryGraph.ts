/**
 * Memory graph and compression hierarchy.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 13 "Memory Graph and Compression Hierarchy"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:395)
 *       Section 4 MemoryRelationType (:178)
 *       Section 3.4 MemoryRelation contract (:108)
 *
 * CENSUS: H104 (compression hierarchy SIGNAL -> MOMENT -> EPISODE -> DAY -> TRIP
 *         -> SEASON -> LIFE CHAPTER), H105 (Life Chapters as projections, not
 *         duplicated Memories), H106 (relationship edge types) - all NOT-BUILT
 *         (docs/architecture/census-highlights-memories.md, section 13).
 *
 * THE RULE THAT SHAPES THIS FILE. "Life Chapters and cross-trip themes should be
 * projections over the graph rather than duplicated Memories." So every node
 * above MOMENT holds nothing but ids, counts and a derived label: no caption is
 * copied upward, no title, no media url. A chapter that copied its memories'
 * content would be a second source of truth, and deleting a Memory would leave
 * its words behind inside the chapter - which is exactly what 28.8 forbids.
 *
 * DAY IS A PROJECTION, NOT A BOUNDARY. Section 7 forbids midnight forcing an
 * episode split. Bucketing episodes into days happens HERE, after detection, and
 * an episode that spans midnight belongs to the day it STARTED - one day, not
 * two - so the late-night experience stays whole.
 */

/** Bump when a rollup rule changes; stored on every projected node. */
export const COMPRESSION_ENGINE_VERSION = "memory-compression@1";

/** Section 13's hierarchy, in order. Index in this array is the level's rank. */
export type CompressionLevel =
  | "SIGNAL"
  | "MOMENT"
  | "EPISODE"
  | "DAY"
  | "TRIP"
  | "SEASON"
  | "LIFE_CHAPTER";

export const COMPRESSION_LEVELS: readonly CompressionLevel[] = Object.freeze([
  "SIGNAL", "MOMENT", "EPISODE", "DAY", "TRIP", "SEASON", "LIFE_CHAPTER",
] as const);

/** Section 13 "Relationship edges" - the target types a Memory may point at. */
export type MemoryEdgeTarget =
  | "PERSON" | "PLACE" | "TRIP" | "EVENT" | "STAMP" | "MEMORY" | "WORLD_CONTEXT_SNAPSHOT";

export const MEMORY_EDGE_TARGETS: readonly MemoryEdgeTarget[] = Object.freeze([
  "PERSON", "PLACE", "TRIP", "EVENT", "STAMP", "MEMORY", "WORLD_CONTEXT_SNAPSHOT",
] as const);

/** Section 4 MemoryRelationType. */
export type MemoryRelationType =
  | "SAME_EPISODE" | "RELATED" | "CONTAINS" | "LED_TO" | "DISCOVERED_THROUGH"
  | "INTRODUCED_BY" | "RESULTED_IN" | "DERIVED_FROM" | "INSPIRED";

export const MEMORY_RELATION_TYPES: readonly MemoryRelationType[] = Object.freeze([
  "SAME_EPISODE", "RELATED", "CONTAINS", "LED_TO", "DISCOVERED_THROUGH",
  "INTRODUCED_BY", "RESULTED_IN", "DERIVED_FROM", "INSPIRED",
] as const);

/** Section 3.4 MemoryRelation, as an in-memory edge. */
export interface MemoryEdge {
  source_memory_id: string;
  target_type: MemoryEdgeTarget;
  target_id: string;
  relation_type: MemoryRelationType;
  confidence: number | null;
  visibility_override: string | null;
}

export function isValidEdge(edge: MemoryEdge): boolean {
  return (
    MEMORY_EDGE_TARGETS.includes(edge.target_type) &&
    MEMORY_RELATION_TYPES.includes(edge.relation_type) &&
    edge.source_memory_id.length > 0 &&
    edge.target_id.length > 0
  );
}

/** The atom the hierarchy is built from. Ids and structure only. */
export interface GraphMoment {
  memory_id: string;
  owner_id: string;
  /** UTC instant the experience started. */
  occurred_at: string;
  /** Minutes east of UTC at the place of occurrence; used only for day bucketing. */
  utc_offset_minutes: number;
  episode_id: string | null;
  trip_id: string | null;
  place_id: string | null;
  people: string[];
  /** Section 8 score, owner-facing only. Never projected above MOMENT. */
  significance_score: number | null;
}

/**
 * A node above MOMENT. It references; it does not contain. `member_memory_ids`
 * is the whole payload, which is what makes a chapter a projection (H105).
 */
export interface CompressedNode {
  level: CompressionLevel;
  /** Deterministic within its level: level + key. */
  id: string;
  owner_id: string;
  /** Derived label - a date, a trip id, a season, a theme name. Never user prose. */
  key: string;
  started_at: string;
  ended_at: string;
  member_memory_ids: string[];
  child_node_ids: string[];
  memory_count: number;
  engine_version: string;
}

function localDayKey(occurredAtIso: string, offsetMinutes: number): string {
  const shifted = new Date(Date.parse(occurredAtIso) + offsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** Meteorological quarters, labelled by the start month so the label is stable worldwide. */
function seasonKey(occurredAtIso: string, offsetMinutes: number): string {
  const shifted = new Date(Date.parse(occurredAtIso) + offsetMinutes * 60000);
  const y = shifted.getUTCFullYear();
  const q = Math.floor(shifted.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

function nodeFrom(
  level: CompressionLevel,
  ownerId: string,
  key: string,
  moments: readonly GraphMoment[],
  childIds: readonly string[],
): CompressedNode {
  const sorted = [...moments].sort(
    (a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.memory_id.localeCompare(b.memory_id),
  );
  return {
    level,
    id: `${level.toLowerCase()}:${key}`,
    owner_id: ownerId,
    key,
    started_at: sorted[0]?.occurred_at ?? "",
    ended_at: sorted[sorted.length - 1]?.occurred_at ?? "",
    member_memory_ids: sorted.map((m) => m.memory_id),
    child_node_ids: [...childIds].sort(),
    memory_count: sorted.length,
    engine_version: COMPRESSION_ENGINE_VERSION,
  };
}

/**
 * Section 13. Build one level of the hierarchy from the moments beneath it.
 *
 * Deterministic: grouping keys are derived, groups are emitted in sorted key
 * order, and members are sorted inside each group. A rebuild over the same
 * moments is byte-identical to the first build.
 */
export function rollUp(
  moments: readonly GraphMoment[],
  level: Exclude<CompressionLevel, "SIGNAL" | "MOMENT">,
): CompressedNode[] {
  if (moments.length === 0) return [];
  const ownerId = moments[0].owner_id;
  const keyOf = (m: GraphMoment): string | null => {
    switch (level) {
      case "EPISODE": return m.episode_id;
      // An episode that crosses midnight belongs to the day it STARTED (section 7).
      case "DAY": return localDayKey(m.occurred_at, m.utc_offset_minutes);
      case "TRIP": return m.trip_id;
      case "SEASON": return seasonKey(m.occurred_at, m.utc_offset_minutes);
      case "LIFE_CHAPTER": return null; // chapters are themed - see buildLifeChapters
      default: return null;
    }
  };

  const groups = new Map<string, GraphMoment[]>();
  for (const m of moments) {
    const k = keyOf(m);
    // A moment with no trip is not forced into a fabricated one. It simply does
    // not appear at the TRIP level; it is still present at DAY and SEASON.
    if (k === null) continue;
    const list = groups.get(k);
    if (list) list.push(m);
    else groups.set(k, [m]);
  }

  return [...groups.keys()].sort().map((k) => nodeFrom(level, ownerId, k, groups.get(k) ?? [], []));
}

/** Which moments a rollup could not place, and why - never silently dropped. */
export function unplacedAt(
  moments: readonly GraphMoment[],
  level: Exclude<CompressionLevel, "SIGNAL" | "MOMENT">,
): Array<{ memory_id: string; reason: string }> {
  const placed = new Set(rollUp(moments, level).flatMap((n) => n.member_memory_ids));
  return moments
    .filter((m) => !placed.has(m.memory_id))
    .map((m) => ({
      memory_id: m.memory_id,
      reason: level === "EPISODE" ? "no episode_id" : level === "TRIP" ? "no trip_id" : "no grouping key",
    }))
    .sort((a, b) => a.memory_id.localeCompare(b.memory_id));
}

/**
 * A theme definition. Predicates run over MOMENT structure only, so a chapter
 * never depends on prose and can be recomputed from ids alone.
 */
export interface ChapterTheme {
  key: string;
  /** Human-facing label for the chapter. Fixed by the theme, not generated per run. */
  label: string;
  matches: (m: GraphMoment) => boolean;
  /** A chapter with fewer members than this is not worth showing. */
  min_members?: number;
}

/**
 * Section 13 H105. Life Chapters are PROJECTIONS: the returned nodes carry
 * member ids and counts, never copied content, so nothing here is a second
 * source of truth and a deleted Memory disappears from every chapter on the
 * next rebuild rather than surviving inside one.
 */
export function buildLifeChapters(
  moments: readonly GraphMoment[],
  themes: readonly ChapterTheme[],
): CompressedNode[] {
  if (moments.length === 0) return [];
  const ownerId = moments[0].owner_id;
  const out: CompressedNode[] = [];
  for (const theme of [...themes].sort((a, b) => a.key.localeCompare(b.key))) {
    const members = moments.filter((m) => theme.matches(m));
    if (members.length < (theme.min_members ?? 1)) continue;
    out.push(nodeFrom("LIFE_CHAPTER", ownerId, theme.key, members, []));
  }
  return out;
}

/**
 * Section 13's ladder, assembled. Each level's nodes link DOWN to the level
 * below by node id, giving the cleanup graph something to walk.
 */
export function buildCompressionHierarchy(
  moments: readonly GraphMoment[],
  themes: readonly ChapterTheme[] = [],
): { levels: Record<Exclude<CompressionLevel, "SIGNAL" | "MOMENT">, CompressedNode[]>; engine_version: string } {
  const episodes = rollUp(moments, "EPISODE");
  const days = rollUp(moments, "DAY").map((day) => ({
    ...day,
    child_node_ids: episodes
      .filter((ep) => ep.member_memory_ids.some((id) => day.member_memory_ids.includes(id)))
      .map((ep) => ep.id)
      .sort(),
  }));
  const trips = rollUp(moments, "TRIP").map((trip) => ({
    ...trip,
    child_node_ids: days
      .filter((day) => day.member_memory_ids.some((id) => trip.member_memory_ids.includes(id)))
      .map((day) => day.id)
      .sort(),
  }));
  const seasons = rollUp(moments, "SEASON").map((season) => ({
    ...season,
    child_node_ids: trips
      .filter((trip) => trip.member_memory_ids.some((id) => season.member_memory_ids.includes(id)))
      .map((trip) => trip.id)
      .sort(),
  }));
  const chapters = buildLifeChapters(moments, themes).map((chapter) => ({
    ...chapter,
    child_node_ids: seasons
      .filter((season) => season.member_memory_ids.some((id) => chapter.member_memory_ids.includes(id)))
      .map((season) => season.id)
      .sort(),
  }));

  return {
    levels: { EPISODE: episodes, DAY: days, TRIP: trips, SEASON: seasons, LIFE_CHAPTER: chapters },
    engine_version: COMPRESSION_ENGINE_VERSION,
  };
}
