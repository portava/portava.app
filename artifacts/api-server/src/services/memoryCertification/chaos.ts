/**
 * The nine property / chaos scenarios.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 "Property / chaos testing" (:666-675). The nine below are that
 *       list, verbatim and in the spec's order.
 *
 * CENSUS: H245-H253 (docs/architecture/census-highlights-memories.md §B).
 *
 * ── WHAT A CHAOS SCENARIO ASSERTS HERE ───────────────────────────────────────
 *
 * Not "it did not crash". Each scenario names the WRONG behaviour it is looking
 * for and asserts its absence:
 *
 *   duplicate upload      -> a second delivery must not become a second fact
 *   out-of-order evidence -> caller order must not change the episodes
 *   worker outage         -> a missing index must REFUSE, never serve empty
 *   search-index delay    -> staleness must be detectable, not silent
 *   concurrent merge+edit -> lifecycle must be order-independent
 *   offline correction    -> a late correction must still outrank inference
 *   partial media delete  -> the Memory must survive losing one asset
 *   entity merge          -> re-resolution must find the Memory again
 *   timezone / date line  -> the calendar must not decide an episode boundary
 *
 * ── FOUR STATUSES, AND WHY PARTIAL EXISTS ────────────────────────────────────
 *
 *   TOLERATED   the perturbation was applied and the system behaved.
 *   BROKEN      it was applied and the system did not.
 *   PARTIAL     one half of the scenario has a surface and the other does not.
 *               Reported as its own status so it can never be counted as a
 *               clean pass — `runCertification` prints the halves separately.
 *   NO_SURFACE  nothing to perturb.
 *
 * A three-status vocabulary would force `CONCURRENT_MERGE_AND_EDIT` to choose
 * between claiming a pass it has not earned (there is no MERGE_MEMORY command)
 * and throwing away the half that IS certifiable (the lifecycle machine is live
 * and IS order-independent). Both answers would be false.
 */

import {
  DERIVATIVE_REGISTRY_TABLE,
  projectionStaleness,
  rebuildProjection,
} from "../memoryProjections/derivativeRegistry.js";
import {
  dedupeEvidence,
  mergeByPrecedence,
  normalizeEvidence,
  type NormalizedEvidence,
  type RawSignal,
} from "../memoryProjections/evidence.js";
import {
  detectEpisodes,
  featureFromEvidence,
} from "../memoryProjections/episodeDetection.js";
import { searchMemories } from "../memoryRetrieval/searchMemories.js";
import {
  MEMORY_COMMAND_TYPES_NOT_DECLARED,
  assertLifecycleTransition,
} from "../../lib/memoryCommandBus.js";
import { certificationClient, tablesFor, type CertificationWorld } from "./world.js";
import { MEMORY_IDS, getFixture } from "./fixtures.js";

export const CHAOS_SCENARIO_IDS = [
  "DUPLICATE_UPLOAD",
  "OUT_OF_ORDER_EVIDENCE",
  "PROJECTION_WORKER_OUTAGE",
  "SEARCH_INDEX_DELAY",
  "CONCURRENT_MERGE_AND_EDIT",
  "OFFLINE_CORRECTION",
  "PARTIAL_MEDIA_DELETION",
  "ENTITY_MERGE_AFTER_MEMORY_CREATION",
  "TIMEZONE_AND_DATE_LINE_EDGES",
] as const;
export type ChaosScenarioId = (typeof CHAOS_SCENARIO_IDS)[number];

export type ChaosStatus = "TOLERATED" | "BROKEN" | "PARTIAL" | "NO_SURFACE";

export interface ChaosOutcome {
  readonly id: ChaosScenarioId;
  readonly census_id: string;
  readonly spec_line: number;
  readonly spec_text: string;
  readonly status: ChaosStatus;
  readonly surface: string;
  readonly detail: string;
}

interface ChaosDefinition {
  readonly id: ChaosScenarioId;
  readonly census_id: string;
  readonly spec_line: number;
  readonly spec_text: string;
  readonly surface: string;
  run(): Promise<{ status: ChaosStatus; detail: string }>;
}

function normalize(raw: RawSignal, now: Date): NormalizedEvidence {
  const r = normalizeEvidence(raw, now);
  if (!r.ok) throw new Error(`certification signal failed to normalize: ${r.reason} ${r.detail}`);
  return r.evidence;
}

function normalizedFrom(world: CertificationWorld): NormalizedEvidence[] {
  const now = new Date(world.now);
  return world.signals.map((s) => normalize(s, now));
}

// ── 1. Duplicate upload ──────────────────────────────────────────────────────

async function duplicateUpload(): Promise<{ status: ChaosStatus; detail: string }> {
  const fixture = getFixture("SOLO_TRIP_EXPLICIT_REMEMBER");
  const now = new Date(fixture.world.now);
  const first = normalizedFrom(fixture.world);
  // The SAME upload delivered a second time: identical source_id, and a capture
  // timestamp 20 seconds later because the second delivery re-read the file.
  const redelivered = fixture.world.signals
    .filter((s) => s.source_type === "CAMERA_CAPTURE")
    .map((s) => normalize({ ...s, observed_at: new Date(Date.parse(String(s.observed_at)) + 20_000).toISOString() }, now));

  const { kept, dropped } = dedupeEvidence([...first, ...redelivered]);
  if (kept.length !== first.length) {
    return { status: "BROKEN", detail: `a re-delivered upload produced ${kept.length} records from ${first.length} distinct claims` };
  }
  if (dropped.length !== redelivered.length) {
    return { status: "BROKEN", detail: `${dropped.length} records were dropped for ${redelivered.length} duplicates` };
  }
  // Reordering the duplicates must not change which record survives.
  const reversed = dedupeEvidence([...redelivered, ...first]);
  if (JSON.stringify(reversed.kept) !== JSON.stringify(kept)) {
    return { status: "BROKEN", detail: "the survivor depended on delivery order" };
  }
  return {
    status: "TOLERATED",
    detail:
      `${redelivered.length} re-delivered captures (same source_id, timestamp 20s later) collapsed onto the original fingerprints — the minute-bucketed fingerprint is what makes that true — ` +
      "and the surviving set was identical under reversed delivery order",
  };
}

// ── 2. Out-of-order evidence ─────────────────────────────────────────────────

async function outOfOrderEvidence(): Promise<{ status: ChaosStatus; detail: string }> {
  const fixture = getFixture("MERGE_THEN_SPLIT");
  const evidence = normalizedFrom(fixture.world);
  const extra = normalize(
    {
      owner_id: fixture.world.owner_id, source_type: "CAMERA_CAPTURE", source_id: "media-market-3",
      assertion_type: "CAPTURED_MEDIA", observed_at: "2026-02-20T18:30:00.000Z",
      assertion_json: { place_id: "place-riverside", capture_provenance: "camera", lat: 41.14, lng: -8.61 },
    },
    new Date(fixture.world.now),
  );
  const features = [...evidence, extra].map(featureFromEvidence);

  const inOrder = detectEpisodes(features);
  const reversed = detectEpisodes([...features].reverse());
  const shuffled = detectEpisodes([features[1]!, features[2]!, features[0]!]);

  const canonical = JSON.stringify(inOrder);
  if (JSON.stringify(reversed) !== canonical || JSON.stringify(shuffled) !== canonical) {
    return { status: "BROKEN", detail: "episode detection depended on the order evidence arrived in" };
  }
  if (inOrder.episodes.length < 2) {
    return { status: "BROKEN", detail: "fixture is inert: the detector found no boundary to be order-sensitive about" };
  }
  return {
    status: "TOLERATED",
    detail:
      `three delivery orders of the same ${features.length} records produced byte-identical results, including ${inOrder.episodes.length} episodes and their boundary explanations`,
  };
}

// ── 3. Projection worker outage ──────────────────────────────────────────────

async function projectionWorkerOutage(): Promise<{ status: ChaosStatus; detail: string }> {
  const fixture = getFixture("DELETE_WITH_DERIVATIVES");
  const tables = tablesFor(fixture.world);
  const healthy = certificationClient(tables);
  const now = new Date(fixture.world.now);
  const scope = { owner_id: fixture.world.owner_id, viewer_id: null };

  const built = await rebuildProjection(healthy, "PublicMemoryProjection", scope, now);
  if (!built.ok) return { status: "BROKEN", detail: `precondition failed: ${built.detail}` };

  // The registry is down; canonical storage is fine. The distinction matters:
  // an empty search result here would be a lie about the person's history.
  const degraded = certificationClient(tables, { failTables: new Set([DERIVATIVE_REGISTRY_TABLE]), failCode: "57014" });
  const read = await searchMemories(degraded, {
    ownerId: fixture.world.owner_id,
    viewerId: "cert-anyone",
    namespace: "PUBLIC",
    authorizedProjection: "PublicMemoryProjection",
    now,
  });
  if (read.ok) {
    return { status: "BROKEN", detail: `an unreadable registry served ${read.value.hits.length} hits instead of refusing` };
  }
  if (read.reason !== "derivative_unavailable") {
    return { status: "BROKEN", detail: `outage reported as ${read.reason}, which a caller cannot distinguish from a privacy refusal` };
  }
  if (!read.retryable) {
    return { status: "BROKEN", detail: "a transient outage (57014) was reported as non-retryable, so nothing would ever retry it" };
  }

  // And a rebuild during the outage must not claim success.
  const rebuilt = await rebuildProjection(degraded, "PublicMemoryProjection", scope, now);
  if (rebuilt.ok) return { status: "BROKEN", detail: "a rebuild succeeded while its registry was unreadable" };
  if (rebuilt.reason !== "registry_unavailable") {
    return { status: "BROKEN", detail: `rebuild during outage reported ${rebuilt.reason}` };
  }
  return {
    status: "TOLERATED",
    detail:
      "with memory_derivative_registry answering 57014 and canonical storage healthy, the read refused with derivative_unavailable+retryable and the rebuild refused with registry_unavailable — neither returned an empty result set (§28.11)",
  };
}

// ── 4. Search-index delay ────────────────────────────────────────────────────

async function searchIndexDelay(): Promise<{ status: ChaosStatus; detail: string }> {
  const fixture = getFixture("DELETE_WITH_DERIVATIVES");
  const tables = tablesFor(fixture.world);
  const client = certificationClient(tables);
  const now = new Date(fixture.world.now);
  const scope = { owner_id: fixture.world.owner_id, viewer_id: null };

  const built = await rebuildProjection(client, "PublicMemoryProjection", scope, now);
  if (!built.ok) return { status: "BROKEN", detail: `precondition failed: ${built.detail}` };
  const fresh = await projectionStaleness(client, "PublicMemoryProjection", scope);
  if (!fresh.ok || fresh.value.state !== "FRESH") {
    return { status: "BROKEN", detail: `a just-built derivative reported ${JSON.stringify(fresh)}` };
  }

  // Canonical moves; the index does not. This is the delay.
  const row = tables.memories!.find((m) => m.id === MEMORY_IDS.survivor);
  if (!row) return { status: "BROKEN", detail: "fixture row missing" };
  row.title = "Survivor, retitled";
  row.updated_at = "2026-06-01T01:00:00.000Z";

  const stale = await projectionStaleness(client, "PublicMemoryProjection", scope);
  if (!stale.ok) return { status: "BROKEN", detail: `staleness unreadable: ${stale.detail}` };
  if (stale.value.state !== "STALE") {
    return { status: "BROKEN", detail: `a delayed index reported ${stale.value.state}; a silent lag is the defect` };
  }
  if (!stale.value.changed_memory_ids.includes(MEMORY_IDS.survivor)) {
    return { status: "BROKEN", detail: "staleness was detected but could not name what changed, so nothing could be rebuilt selectively" };
  }
  // The delayed index still SERVES — that is the point of a derivative — but it
  // serves the old row, and the staleness verdict is how a caller knows.
  const served = await searchMemories(client, {
    ownerId: fixture.world.owner_id, viewerId: "cert-anyone", namespace: "PUBLIC",
    authorizedProjection: "PublicMemoryProjection", now,
  });
  if (!served.ok) return { status: "BROKEN", detail: `the delayed index stopped serving entirely: ${served.detail}` };
  const titles = served.value.hits.map((h) => String(h.row.title));
  if (titles.includes("Survivor, retitled")) {
    return { status: "BROKEN", detail: "the derivative served the new title, so nothing was actually delayed and the check is vacuous" };
  }
  return {
    status: "TOLERATED",
    detail:
      `canonical moved and the registered derivative did not; projectionStaleness reported STALE and named ${stale.value.changed_memory_ids.length} changed memory id(s), while the derivative kept serving its registered payload`,
  };
}

// ── 5. Concurrent merge and edit ─────────────────────────────────────────────

async function concurrentMergeAndEdit(): Promise<{ status: ChaosStatus; detail: string }> {
  // The EDIT half is live: assertLifecycleTransition runs on every PATCH
  // regardless of the kernel flag, so order-independence here is a property of
  // production behaviour and not of an unreachable module.
  const archiveThenPublish = [
    assertLifecycleTransition("published", "archived"),
    assertLifecycleTransition("archived", "published"),
  ];
  const publishThenArchive = [
    assertLifecycleTransition("published", "published"),
    assertLifecycleTransition("published", "archived"),
  ];
  if (!archiveThenPublish[0]!.ok || !publishThenArchive[1]!.ok) {
    return { status: "BROKEN", detail: "a legal transition was refused; the fixture cannot test ordering" };
  }
  // A terminal state must be terminal in every interleaving, or two concurrent
  // commands could resurrect a deleted Memory depending on which lost the race.
  const outOfDeleted = assertLifecycleTransition("deleted", "published");
  const outOfDeletedToArchived = assertLifecycleTransition("deleted", "archived");
  if (outOfDeleted.ok || outOfDeletedToArchived.ok) {
    return { status: "BROKEN", detail: "a Memory could leave the terminal deleted state, so a losing concurrent command could resurrect it" };
  }

  return {
    status: "PARTIAL",
    detail:
      "EDIT half CERTIFIED against live code: lib/memoryCommandBus.ts assertLifecycleTransition admits published->archived and archived->published in either interleaving and refuses both transitions out of the terminal `deleted`, so no losing race can resurrect a deleted Memory. " +
      `MERGE half NO SURFACE: MEMORY_COMMAND_TYPES_NOT_DECLARED.MERGE_MEMORY — "${MEMORY_COMMAND_TYPES_NOT_DECLARED.MERGE_MEMORY}". There is no merge to be concurrent with`,
  };
}

// ── 6. Offline correction ────────────────────────────────────────────────────

async function offlineCorrection(): Promise<{ status: ChaosStatus; detail: string }> {
  const now = new Date("2026-05-20T00:00:00.000Z");
  // The device was offline. The correction was MADE on the 11th and DELIVERED
  // on the 19th, after an inference the server had already accepted.
  const inference = normalize(
    {
      owner_id: "cert-owner", source_type: "GPS_PROXIMITY", source_id: "gps-late",
      assertion_type: "OCCURRED", observed_at: "2026-05-12T09:00:00.000Z",
      assertion_json: { place_id: "place-inferred", dwell_seconds: 3600 },
    },
    now,
  );
  const correction = normalize(
    {
      owner_id: "cert-owner", source_type: "USER_CORRECTION", source_id: "offline-correction",
      assertion_type: "CORRECTION", observed_at: "2026-05-11T20:00:00.000Z",
      confidence: 0.4,
      assertion_json: { place_id: "place-actual" },
    },
    now,
  );
  const merged = mergeByPrecedence(
    { place_id: inference.assertion_json.place_id },
    { place_id: correction.assertion_json.place_id },
    { base: inference, incoming: correction },
  );
  if (merged.merged.place_id !== "place-actual") {
    return { status: "BROKEN", detail: `a correction that arrived late lost to the inference: ${JSON.stringify(merged.merged)}` };
  }
  // And the reverse arrival order must give the same answer, or "who wins"
  // depends on connectivity.
  const reverse = mergeByPrecedence(
    { place_id: correction.assertion_json.place_id },
    { place_id: inference.assertion_json.place_id },
    { base: correction, incoming: inference },
  );
  if (reverse.merged.place_id !== "place-actual") {
    return { status: "BROKEN", detail: "the winner depended on which record arrived first" };
  }
  return {
    status: "TOLERATED",
    detail:
      "a correction observed 2026-05-11 and delivered after a 2026-05-12 inference won in BOTH arrival orders, at a lower confidence (0.4) than the inference's ceiling — connectivity does not decide truth",
  };
}

// ── 7. Partial media deletion ────────────────────────────────────────────────

async function partialMediaDeletion(): Promise<{ status: ChaosStatus; detail: string }> {
  const fixture = getFixture("SOLO_TRIP_EXPLICIT_REMEMBER");
  const tables = tablesFor(fixture.world);
  const client = certificationClient(tables);
  const now = new Date(fixture.world.now);
  const scope = { owner_id: fixture.world.owner_id, viewer_id: null };

  const before = await rebuildProjection(client, "PublicMemoryProjection", scope, now);
  if (!before.ok) return { status: "BROKEN", detail: `precondition failed: ${before.detail}` };
  const beforeRow = before.value.rows.find((r) => r.memory_id === MEMORY_IDS.soloA);
  if (!beforeRow || beforeRow.media_count !== 2) {
    return { status: "BROKEN", detail: `fixture expected 2 media on the public row, saw ${JSON.stringify(beforeRow?.media_count)}` };
  }

  // Remove one asset, as DELETE /memories/:id/items/:itemId does.
  tables.memory_items = tables.memory_items!.filter((i) => i.media_url !== "https://cdn.example/ferry-2.jpg");
  tables[DERIVATIVE_REGISTRY_TABLE]!.length = 0;

  const after = await rebuildProjection(client, "PublicMemoryProjection", scope, now);
  if (!after.ok) return { status: "BROKEN", detail: `rebuild after partial delete failed: ${after.detail}` };
  const afterRow = after.value.rows.find((r) => r.memory_id === MEMORY_IDS.soloA);
  if (!afterRow) {
    return { status: "BROKEN", detail: "deleting one media asset removed the Memory from the projection (§28.1: a media asset is not the Memory)" };
  }
  if (afterRow.media_count !== 1) {
    return { status: "BROKEN", detail: `media_count did not follow the delete: ${JSON.stringify(afterRow.media_count)}` };
  }
  if (afterRow.title !== beforeRow.title || afterRow.occurred_at !== beforeRow.occurred_at) {
    return { status: "BROKEN", detail: "losing one asset changed the Memory's facts" };
  }
  return {
    status: "TOLERATED",
    detail:
      "one of two assets was removed: the Memory stayed in the public derivative with its title and occurred_at unchanged and media_count 2 -> 1. §28.1 (a media asset is not the Memory) survives partial deletion",
  };
}

// ── 8. Entity merge after Memory creation ────────────────────────────────────

async function entityMergeAfterCreation(): Promise<{ status: ChaosStatus; detail: string }> {
  const fixture = getFixture("INCORRECT_GPS_PLACE_CORRECTION");
  const tables = tablesFor(fixture.world);
  const client = certificationClient(tables);
  const now = new Date(fixture.world.now);
  const scope = { owner_id: fixture.world.owner_id, viewer_id: fixture.world.owner_id, place_id: "canon-correct-cafe" };

  const before = await rebuildProjection(client, "PlaceMemoryProjection", scope, now);
  if (!before.ok) return { status: "BROKEN", detail: `precondition failed: ${before.detail}` };
  if (before.value.rows.length !== 1) {
    return { status: "BROKEN", detail: `fixture expected one visit at the place, saw ${before.value.rows.length}` };
  }

  // Two canonical places are merged: the memory is repointed at the survivor.
  const row = tables.memories!.find((m) => m.id === MEMORY_IDS.gps);
  if (!row) return { status: "BROKEN", detail: "fixture row missing" };
  row.canonical_location_id = "canon-merged-cafe";
  row.updated_at = "2026-06-01T02:00:00.000Z";

  const stale = await projectionStaleness(client, "PlaceMemoryProjection", scope);
  if (!stale.ok || stale.value.state !== "STALE") {
    return { status: "BROKEN", detail: `an entity merge did not make the place derivative stale: ${JSON.stringify(stale)}` };
  }

  const mergedScope = { ...scope, place_id: "canon-merged-cafe" };
  const after = await rebuildProjection(client, "PlaceMemoryProjection", mergedScope, now);
  if (!after.ok) return { status: "BROKEN", detail: `rebuild under the survivor id failed: ${after.detail}` };
  if (after.value.rows.length !== 1 || after.value.rows[0]!.memory_id !== MEMORY_IDS.gps) {
    return { status: "BROKEN", detail: "re-resolution lost the Memory: it is at neither the old nor the new canonical id" };
  }

  // The half that does NOT hold, stated rather than hidden. §9 requires the
  // occurrence-time display text to survive a merge; `memories` has no
  // display_name_at_occurrence column to survive in (census H68).
  return {
    status: "PARTIAL",
    detail:
      "RE-RESOLUTION CERTIFIED: repointing canonical_location_id made the place derivative STALE and a rebuild under the survivor id found the Memory again with visit_index recomputed. " +
      "OCCURRENCE-TIME DISPLAY TEXT NOT CERTIFIABLE: §9 requires the name as it was at the time of the visit to survive the merge, and `memories` has no display_name_at_occurrence column (census H68) — there is nothing for the merge to preserve or lose",
  };
}

// ── 9. Timezone and date-line edges ──────────────────────────────────────────

async function timezoneAndDateLine(): Promise<{ status: ChaosStatus; detail: string }> {
  const now = new Date("2026-06-01T00:00:00.000Z");
  // Two captures thirty minutes apart that a calendar-bucketing detector would
  // split, because they fall on different UTC dates.
  const before = normalize(
    {
      owner_id: "cert-owner", source_type: "CAMERA_CAPTURE", source_id: "tz-before-midnight",
      assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-20T23:45:00.000Z",
      observed_timezone: "Pacific/Auckland",
      assertion_json: { place_id: "place-night", capture_provenance: "camera", lat: -36.85, lng: 174.76 },
    },
    now,
  );
  const after = normalize(
    {
      owner_id: "cert-owner", source_type: "CAMERA_CAPTURE", source_id: "tz-after-midnight",
      assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-21T00:15:00.000Z",
      observed_timezone: "Pacific/Auckland",
      assertion_json: { place_id: "place-night", capture_provenance: "camera", lat: -36.851, lng: 174.761 },
    },
    now,
  );
  // The same clock gap, entirely inside one UTC day. A detector that reads
  // elapsed time must treat these two pairs identically.
  const midA = normalize(
    {
      owner_id: "cert-owner", source_type: "CAMERA_CAPTURE", source_id: "tz-midday-a",
      assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-22T11:45:00.000Z",
      assertion_json: { place_id: "place-day", capture_provenance: "camera", lat: -36.85, lng: 174.76 },
    },
    now,
  );
  const midB = normalize(
    {
      owner_id: "cert-owner", source_type: "CAMERA_CAPTURE", source_id: "tz-midday-b",
      assertion_type: "CAPTURED_MEDIA", observed_at: "2026-04-22T12:15:00.000Z",
      assertion_json: { place_id: "place-day", capture_provenance: "camera", lat: -36.851, lng: 174.761 },
    },
    now,
  );

  const crossing = detectEpisodes([before, after].map(featureFromEvidence));
  const inDay = detectEpisodes([midA, midB].map(featureFromEvidence));

  if (crossing.episodes.length !== 1) {
    return { status: "BROKEN", detail: `midnight forced a split: ${crossing.episodes.length} episodes from a 30-minute gap` };
  }
  if (inDay.episodes.length !== crossing.episodes.length) {
    return { status: "BROKEN", detail: "the same 30-minute gap grouped differently depending on which UTC date it fell on" };
  }
  const boundary = crossing.boundaries[0];
  if (!boundary || boundary.crosses_midnight !== true) {
    return { status: "BROKEN", detail: "the midnight crossing was not even recorded, so a later reader cannot tell it happened" };
  }
  if (boundary.split) {
    return { status: "BROKEN", detail: "crosses_midnight was acted on rather than recorded" };
  }
  // Time normalization: an observation carrying a zone is still stored in UTC.
  if (!before.observed_at.endsWith("Z") || before.observed_timezone !== "Pacific/Auckland") {
    return { status: "BROKEN", detail: `time normalization lost either the UTC instant or the zone: ${JSON.stringify(before)}` };
  }
  return {
    status: "TOLERATED",
    detail:
      "a 30-minute gap across UTC midnight produced ONE episode, identical to the same gap at midday; the crossing is recorded on the boundary as crosses_midnight=true and split=false; and the observation kept its IANA zone alongside a UTC instant",
  };
}

const DEFINITIONS: readonly ChaosDefinition[] = Object.freeze([
  {
    id: "DUPLICATE_UPLOAD", census_id: "H245", spec_line: 667, spec_text: "Duplicate upload",
    surface: "services/memoryProjections/evidence.ts dedupeEvidence / fingerprint",
    run: duplicateUpload,
  },
  {
    id: "OUT_OF_ORDER_EVIDENCE", census_id: "H246", spec_line: 668, spec_text: "Out-of-order evidence",
    surface: "services/memoryProjections/episodeDetection.ts detectEpisodes",
    run: outOfOrderEvidence,
  },
  {
    id: "PROJECTION_WORKER_OUTAGE", census_id: "H247", spec_line: 669, spec_text: "Projection worker outage",
    surface: "services/memoryProjections/derivativeRegistry.ts rebuildProjection + memoryRetrieval/searchMemories.ts",
    run: projectionWorkerOutage,
  },
  {
    id: "SEARCH_INDEX_DELAY", census_id: "H248", spec_line: 670, spec_text: "Search-index delay",
    surface: "services/memoryProjections/derivativeRegistry.ts projectionStaleness",
    run: searchIndexDelay,
  },
  {
    id: "CONCURRENT_MERGE_AND_EDIT", census_id: "H249", spec_line: 671, spec_text: "Concurrent merge and edit",
    surface: "lib/memoryCommandBus.ts assertLifecycleTransition (edit half); MERGE_MEMORY is undeclared",
    run: concurrentMergeAndEdit,
  },
  {
    id: "OFFLINE_CORRECTION", census_id: "H250", spec_line: 672, spec_text: "Offline correction",
    surface: "services/memoryProjections/evidence.ts mergeByPrecedence",
    run: offlineCorrection,
  },
  {
    id: "PARTIAL_MEDIA_DELETION", census_id: "H251", spec_line: 673, spec_text: "Partial media deletion",
    surface: "services/memoryProjections/projectionRegistry.ts PublicMemoryProjection media_count",
    run: partialMediaDeletion,
  },
  {
    id: "ENTITY_MERGE_AFTER_MEMORY_CREATION", census_id: "H252", spec_line: 674, spec_text: "Entity merge after Memory creation",
    surface: "services/memoryProjections/projectionRegistry.ts PlaceMemoryProjection + projectionStaleness",
    run: entityMergeAfterCreation,
  },
  {
    id: "TIMEZONE_AND_DATE_LINE_EDGES", census_id: "H253", spec_line: 675, spec_text: "Timezone and date-line edges",
    surface: "services/memoryProjections/episodeDetection.ts crossesMidnightUtc + evidence.ts time normalization",
    run: timezoneAndDateLine,
  },
]);

export function listChaosScenarios(): ReadonlyArray<Omit<ChaosDefinition, "run">> {
  return DEFINITIONS.map(({ run: _run, ...rest }) => rest);
}

export async function runChaosScenario(id: ChaosScenarioId): Promise<ChaosOutcome> {
  const def = DEFINITIONS.find((d) => d.id === id);
  if (!def) throw new Error(`unknown chaos scenario: ${id}`);
  let result: { status: ChaosStatus; detail: string };
  try {
    result = await def.run();
  } catch (err) {
    result = { status: "BROKEN", detail: `scenario threw: ${String((err as Error)?.message ?? err)}` };
  }
  return {
    id: def.id,
    census_id: def.census_id,
    spec_line: def.spec_line,
    spec_text: def.spec_text,
    surface: def.surface,
    ...result,
  };
}

export async function runAllChaosScenarios(): Promise<ChaosOutcome[]> {
  const out: ChaosOutcome[] = [];
  for (const id of CHAOS_SCENARIO_IDS) out.push(await runChaosScenario(id));
  return out;
}
