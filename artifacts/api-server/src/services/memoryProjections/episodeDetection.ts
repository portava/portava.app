/**
 * Episode detection and boundary engine.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 7 "Episode Detection and Boundary Engine"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:266)
 *       Section 3.2 MemoryEpisode contract (:84)
 *       Section 25 replay: the same inputs must produce the same episodes.
 *
 * CENSUS: H58 (deterministic replayable grouping), H59 (boundary features),
 *         H60 (midnight must not force a split), H61 (versioned candidate
 *         reason-code registry), H62 (dedup relationships) - all five NOT-BUILT
 *         (docs/architecture/census-highlights-memories.md, section 7).
 *
 * DESIGN. "Episode grouping must be deterministic enough to replay. AI may
 * assist candidate description, but core grouping should operate on structured
 * features and versioned reason codes." So there is no model in this file, no
 * clock, no I/O, and no Map iteration order dependence: every list this function
 * returns is explicitly sorted, and episode ids are a digest of their contents,
 * so two runs over the same evidence - in any input order - are byte-identical.
 *
 * THE MIDNIGHT RULE IS A REAL RULE. "Midnight must not force an episode split by
 * itself. A late-night experience may legitimately span calendar dates." The
 * detector therefore never reads a calendar date. Day bucketing exists in
 * memoryGraph.ts (section 13) and is a PROJECTION over episodes, not a boundary.
 */

import type { ConfidenceBand, EvidenceSourceType, NormalizedEvidence } from "./evidence.js";
import { confidenceBandOf, evidenceDigest } from "./evidence.js";

/** Section 3.2 `detector_version`, stored on every episode. Bump on any rule change. */
export const EPISODE_DETECTOR_VERSION = "memory-episode-detector@1";

/** Section 7 "Boundary features" - the closed registry of reasons to SPLIT. */
export type BoundaryFeature =
  | "TIME_GAP"
  | "GEO_TRANSITION"
  | "TRIP_TRANSITION"
  | "PARTICIPANT_CHANGE"
  | "ACTIVITY_CHANGE"
  | "TRANSPORT_TRANSITION"
  | "HOME_OR_HOTEL_RETURN"
  | "EVENT_COMMITMENT_BOUNDARY"
  | "USER_SPLIT";

export const BOUNDARY_FEATURES: readonly BoundaryFeature[] = Object.freeze([
  "TIME_GAP",
  "GEO_TRANSITION",
  "TRIP_TRANSITION",
  "PARTICIPANT_CHANGE",
  "ACTIVITY_CHANGE",
  "TRANSPORT_TRANSITION",
  "HOME_OR_HOTEL_RETURN",
  "EVENT_COMMITMENT_BOUNDARY",
  "USER_SPLIT",
] as const);

/** Section 7 "Candidate reason codes" - the closed registry, versioned with the detector. */
export type EpisodeReasonCode =
  | "SAME_TRIP"
  | "SAME_CREW"
  | "SAME_PLACE_CLUSTER"
  | "TIME_PROXIMITY"
  | "TRANSPORT_CONTINUITY"
  | "EVENT_CONTEXT"
  | "EXPLICIT_REMEMBER"
  | "FIRST_VISIT"
  | "REPEATED_PLACE"
  | "USER_MERGED";

export const EPISODE_REASON_CODES: readonly EpisodeReasonCode[] = Object.freeze([
  "SAME_TRIP",
  "SAME_CREW",
  "SAME_PLACE_CLUSTER",
  "TIME_PROXIMITY",
  "TRANSPORT_CONTINUITY",
  "EVENT_CONTEXT",
  "EXPLICIT_REMEMBER",
  "FIRST_VISIT",
  "REPEATED_PLACE",
  "USER_MERGED",
] as const);

/** Section 7 "Deduplication relationships". */
export type EpisodeRelation = "SAME_EPISODE" | "POSSIBLE_DUPLICATE" | "RELATED" | "CONTAINS";

/**
 * Structured features read off one normalized evidence record. Everything the
 * detector is allowed to look at is here; if it is not in this shape, the
 * detector cannot see it, which is what makes replay auditable.
 */
export interface EpisodeFeature {
  evidence_id: string;
  owner_id: string;
  /** Carried through so the episode's confidence band uses the real source strength. */
  source_type: EvidenceSourceType;
  at_ms: number;
  place_id: string | null;
  lat: number | null;
  lng: number | null;
  trip_id: string | null;
  event_id: string | null;
  /** Sorted, deduplicated participant ids. */
  participants: string[];
  activity_type: string | null;
  transport_mode: string | null;
  is_home_or_hotel_return: boolean;
  explicit_remember: boolean;
  confidence: number;
}

export interface EpisodeDetectorThresholds {
  /** A pause longer than this splits, unless transport continuity explains it. */
  time_gap_minutes: number;
  /** A jump larger than this splits, whatever the clock says. */
  geo_transition_km: number;
  /** Participant overlap below this ratio counts as a changed crew. */
  participant_overlap_min: number;
  /** An activity change only splits if the pause is at least this long. */
  activity_change_min_gap_minutes: number;
}

export const DEFAULT_THRESHOLDS: Readonly<EpisodeDetectorThresholds> = Object.freeze({
  time_gap_minutes: 180,
  geo_transition_km: 25,
  participant_overlap_min: 0.5,
  activity_change_min_gap_minutes: 30,
});

export interface DetectEpisodesContext {
  /** Places the owner has already been - drives FIRST_VISIT vs REPEATED_PLACE. */
  visited_place_ids?: ReadonlySet<string>;
  /**
   * Owner corrections (section 7 "User-authored split/merge corrections").
   * A split forces a boundary before `before_evidence_id`; a merge forbids one.
   * Corrections outrank every computed feature - section 4 truth precedence.
   */
  user_splits?: ReadonlySet<string>;
  user_merges?: ReadonlySet<string>;
  thresholds?: Partial<EpisodeDetectorThresholds>;
}

export interface DetectedEpisode {
  /** Deterministic: a digest of owner + detector version + member evidence ids. */
  id: string;
  owner_id: string;
  started_at: string;
  ended_at: string;
  primary_place_id: string | null;
  trip_id: string | null;
  event_id: string | null;
  detector_version: string;
  confidence_band: ConfidenceBand;
  /** Sorted. Section 7 candidate reason codes explaining why these belong together. */
  reason_codes: EpisodeReasonCode[];
  /** Why the episode STARTED here (empty for the first episode of the run). */
  opened_by: BoundaryFeature[];
  evidence_ids: string[];
  participants: string[];
}

export interface DetectEpisodesResult {
  episodes: DetectedEpisode[];
  /** Every boundary decision, in order, with the features that produced it. */
  boundaries: Array<{
    before_evidence_id: string;
    after_evidence_id: string;
    split: boolean;
    features: BoundaryFeature[];
    suppressed_by: Array<"TRANSPORT_CONTINUITY" | "USER_MERGED">;
    gap_minutes: number;
    distance_km: number | null;
    /** True when the pair straddles UTC midnight - recorded, never acted on (section 7). */
    crosses_midnight: boolean;
  }>;
  detector_version: string;
}

/** Great-circle distance. Null when either endpoint has no coordinate. */
export function haversineKm(
  a: { lat: number | null; lng: number | null },
  b: { lat: number | null; lng: number | null },
): number | null {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Section 6 output to section 7 input. The only adapter; nothing else reads assertion_json here. */
export function featureFromEvidence(e: NormalizedEvidence): EpisodeFeature {
  const a = e.assertion_json;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const participants = Array.isArray(a.participants)
    ? [...new Set(a.participants.filter((p): p is string => typeof p === "string"))].sort()
    : [];
  return {
    evidence_id: `${e.source_type}:${e.source_id}`,
    owner_id: e.owner_id,
    source_type: e.source_type,
    at_ms: new Date(e.observed_at).getTime(),
    place_id: str(a.place_id),
    lat: num(a.lat),
    lng: num(a.lng),
    trip_id: str(a.trip_id),
    event_id: str(a.event_id),
    participants,
    activity_type: str(a.activity_type),
    transport_mode: str(a.transport_mode),
    is_home_or_hotel_return: a.home_or_hotel_return === true,
    explicit_remember: e.source_type === "EXPLICIT_REMEMBER",
    confidence: e.confidence,
  };
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** UTC calendar dates differ. Recorded for the audit trail; NEVER a split reason (section 7). */
function crossesMidnightUtc(aMs: number, bMs: number): boolean {
  return new Date(aMs).toISOString().slice(0, 10) !== new Date(bMs).toISOString().slice(0, 10);
}

/**
 * Section 7. Group features into episodes.
 *
 * Deterministic by construction: the input is sorted by (time, evidence id)
 * before anything is decided, so caller order cannot change the outcome; every
 * emitted array is sorted; and no wall clock, random source or model is read.
 */
export function detectEpisodes(
  features: readonly EpisodeFeature[],
  ctx: DetectEpisodesContext = {},
): DetectEpisodesResult {
  const th: EpisodeDetectorThresholds = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds ?? {}) };
  const visited = ctx.visited_place_ids ?? new Set<string>();
  const splits = ctx.user_splits ?? new Set<string>();
  const merges = ctx.user_merges ?? new Set<string>();

  const ordered = [...features].sort((a, b) => a.at_ms - b.at_ms || a.evidence_id.localeCompare(b.evidence_id));
  const boundaries: DetectEpisodesResult["boundaries"] = [];
  const groups: EpisodeFeature[][] = [];
  let current: EpisodeFeature[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    if (current.length === 0) { current.push(f); continue; }
    const prev = ordered[i - 1];

    const gapMinutes = (f.at_ms - prev.at_ms) / 60000;
    const distanceKm = haversineKm(prev, f);
    const featuresHit: BoundaryFeature[] = [];
    const suppressed: Array<"TRANSPORT_CONTINUITY" | "USER_MERGED"> = [];

    // Transport continuity: a journey is one movement, so the long quiet stretch
    // inside it is not a pause between experiences.
    const transportContinuity =
      prev.transport_mode !== null && f.transport_mode !== null && prev.transport_mode === f.transport_mode;

    if (gapMinutes > th.time_gap_minutes) {
      if (transportContinuity) suppressed.push("TRANSPORT_CONTINUITY");
      else featuresHit.push("TIME_GAP");
    }
    if (distanceKm !== null && distanceKm > th.geo_transition_km) featuresHit.push("GEO_TRANSITION");
    if ((prev.trip_id ?? null) !== (f.trip_id ?? null)) featuresHit.push("TRIP_TRANSITION");
    if (jaccard(prev.participants, f.participants) < th.participant_overlap_min) featuresHit.push("PARTICIPANT_CHANGE");
    if (
      prev.activity_type !== null && f.activity_type !== null && prev.activity_type !== f.activity_type &&
      gapMinutes >= th.activity_change_min_gap_minutes
    ) {
      featuresHit.push("ACTIVITY_CHANGE");
    }
    if (prev.transport_mode !== f.transport_mode && !(prev.transport_mode === null && f.transport_mode === null)) {
      if (!transportContinuity) featuresHit.push("TRANSPORT_TRANSITION");
    }
    if (f.is_home_or_hotel_return) featuresHit.push("HOME_OR_HOTEL_RETURN");
    if ((prev.event_id ?? null) !== (f.event_id ?? null)) featuresHit.push("EVENT_COMMITMENT_BOUNDARY");

    // Owner corrections outrank every computed feature (section 4 precedence).
    const userSplit = splits.has(f.evidence_id);
    const userMerge = merges.has(f.evidence_id);
    if (userSplit) featuresHit.push("USER_SPLIT");

    let split = featuresHit.length > 0;
    if (userMerge && !userSplit) { split = false; suppressed.push("USER_MERGED"); }
    if (userSplit) split = true;

    boundaries.push({
      before_evidence_id: prev.evidence_id,
      after_evidence_id: f.evidence_id,
      split,
      features: [...featuresHit].sort(),
      suppressed_by: suppressed,
      gap_minutes: Number(gapMinutes.toFixed(4)),
      distance_km: distanceKm === null ? null : Number(distanceKm.toFixed(4)),
      // Recorded so an auditor can see the detector saw it and did nothing with it.
      crosses_midnight: crossesMidnightUtc(prev.at_ms, f.at_ms),
    });

    if (split) { groups.push(current); current = [f]; } else { current.push(f); }
  }
  if (current.length > 0) groups.push(current);

  const episodes = groups.map((members, idx) => {
    const openedBy = idx === 0 ? [] : boundaries.filter((b) => b.after_evidence_id === members[0].evidence_id && b.split).flatMap((b) => b.features);
    const placeCounts = new Map<string, number>();
    for (const m of members) if (m.place_id) placeCounts.set(m.place_id, (placeCounts.get(m.place_id) ?? 0) + 1);
    // Deterministic tie-break: most frequent place, then lexicographic id.
    const primaryPlace = [...placeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

    const trips = new Set(members.map((m) => m.trip_id).filter((t): t is string => t !== null));
    const events = new Set(members.map((m) => m.event_id).filter((t): t is string => t !== null));
    const participants = [...new Set(members.flatMap((m) => m.participants))].sort();
    const evidenceIds = members.map((m) => m.evidence_id).sort();

    const reasons = new Set<EpisodeReasonCode>();
    if (trips.size === 1 && members.every((m) => m.trip_id !== null)) reasons.add("SAME_TRIP");
    if (participants.length > 0 && members.every((m) => jaccard(m.participants, participants) >= 0.5)) reasons.add("SAME_CREW");
    if (primaryPlace !== null && members.every((m) => m.place_id === null || m.place_id === primaryPlace)) reasons.add("SAME_PLACE_CLUSTER");
    if (members.length > 1) {
      const spanMinutes = (members[members.length - 1].at_ms - members[0].at_ms) / 60000;
      if (spanMinutes <= th.time_gap_minutes) reasons.add("TIME_PROXIMITY");
    }
    if (members.some((m) => m.transport_mode !== null) && new Set(members.map((m) => m.transport_mode).filter((t) => t !== null)).size === 1) {
      reasons.add("TRANSPORT_CONTINUITY");
    }
    if (events.size === 1 && members.every((m) => m.event_id !== null)) reasons.add("EVENT_CONTEXT");
    if (members.some((m) => m.explicit_remember)) reasons.add("EXPLICIT_REMEMBER");
    if (primaryPlace !== null) reasons.add(visited.has(primaryPlace) ? "REPEATED_PLACE" : "FIRST_VISIT");
    if (members.some((m) => merges.has(m.evidence_id))) reasons.add("USER_MERGED");

    // The band is computed from the real source strengths (section 6), not from
    // a count of records: five weak proximity pings are still weak.
    const bandInput = members.map((m) => ({ confidence: m.confidence, source_type: m.source_type }));

    return {
      id: `ep_${evidenceDigest([members[0].owner_id, EPISODE_DETECTOR_VERSION, ...evidenceIds])}`,
      owner_id: members[0].owner_id,
      started_at: new Date(members[0].at_ms).toISOString(),
      ended_at: new Date(members[members.length - 1].at_ms).toISOString(),
      primary_place_id: primaryPlace,
      trip_id: trips.size === 1 ? [...trips][0] : null,
      event_id: events.size === 1 ? [...events][0] : null,
      detector_version: EPISODE_DETECTOR_VERSION,
      confidence_band: confidenceBandOf(bandInput),
      reason_codes: [...reasons].sort(),
      opened_by: [...new Set(openedBy)].sort(),
      evidence_ids: evidenceIds,
      participants,
    } satisfies DetectedEpisode;
  });

  return { episodes, boundaries, detector_version: EPISODE_DETECTOR_VERSION };
}

/**
 * Section 7 "Deduplication relationships". Returns the relationship between two
 * episodes, or null when they are unrelated. Symmetric except for CONTAINS,
 * which is reported from the point of view of `a`.
 */
export function relateEpisodes(a: DetectedEpisode, b: DetectedEpisode): EpisodeRelation | null {
  const sa = new Set(a.evidence_ids);
  const sb = new Set(b.evidence_ids);
  let shared = 0;
  for (const id of sa) if (sb.has(id)) shared++;

  if (shared === sa.size && shared === sb.size && sa.size > 0) return "SAME_EPISODE";
  if (shared > 0 && shared === sb.size && sa.size > sb.size) return "CONTAINS";
  if (shared > 0) return "POSSIBLE_DUPLICATE";

  const aStart = Date.parse(a.started_at), aEnd = Date.parse(a.ended_at);
  const bStart = Date.parse(b.started_at), bEnd = Date.parse(b.ended_at);
  const overlaps = aStart <= bEnd && bStart <= aEnd;
  const samePlace = a.primary_place_id !== null && a.primary_place_id === b.primary_place_id;
  if (overlaps && samePlace) return "POSSIBLE_DUPLICATE";
  if (samePlace || (a.trip_id !== null && a.trip_id === b.trip_id)) return "RELATED";
  return null;
}
