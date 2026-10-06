/**
 * Episode candidates — §7's candidate inbox, the writer migration 2320's spine
 * has never had.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §6   evidence normalization and the eligibility gate
 *   §7   "Episode detection … deterministic grouping … candidate inbox"
 *   §8   significance, and "a user-created Memory may never be demoted"
 *   §27  EpisodeDetectionService.buildCandidates(ownerId, window) / explain /
 *        replay, and MemoryDomainService.confirm
 *   Phase 2 "Episode Candidates: Eligibility, deterministic grouping, candidate
 *        inbox, merge/split."
 *   Appendix A, steps 1-7: photos taken during a trip become a PRIVATE candidate
 *        the owner opens, corrects and confirms — "not a public post".
 *
 * CENSUS: H18 MemoryEpisode, H19 MemoryEvidence, H23 memory_episodes, H24
 *         memory_evidence were NOT-BUILT on "nothing writes either table";
 *         H7/H8/H9/H54-H61 were BUILT-BUT-WRONG on "No route imports it". This
 *         module is the production caller of evidence.ts, episodeDetection.ts
 *         and significance.ts, and the first writer of the two 2320 tables.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 *   detect   The OWNER asks ("find memories from this trip"). The owner's own
 *            captured media inside the trip's dates become CAMERA_CAPTURE
 *            evidence → §6 normalization → §7 deterministic grouping → §6
 *            eligibility per group (mode USER_INITIATED) → a `candidate` row in
 *            memory_episodes (detection_reason media_cluster, replay key
 *            (user, reason, version, digest)) and one memory_evidence row per
 *            capture. A replay finds the same rows and writes nothing new.
 *   confirm  The owner keeps a candidate: §8's significance is scored with
 *            later_user_promotion, the episode moves candidate → confirmed with
 *            basis `user_affirmed` (the 2320 CHECK and the lifecycle machine
 *            both demand a score AND a basis), and a canonical Memory is created
 *            through the §17 boundary — private (`only_me`), the photos attached
 *            through ADD_MEDIA — and linked back as EXPLICIT evidence.
 *   reject   candidate → rejected. A rejected candidate cannot become a
 *            Highlight (highlightSources refuses it, census H238).
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────
 *   - It never runs on its own. There is no scheduler and no automatic path:
 *     §1 "Automatic Memories are private-first" and §29 "Private-first
 *     automatic Memory behavior is enabled only after shadow precision is
 *     acceptable" — so detection is OWNER-INITIATED only.
 *   - It never UPDATEs an episode it detected again (§9 / H179: late evidence
 *     may raise confidence but must not overwrite explicit edits). A replay
 *     appends evidence it had not seen and leaves the episode row alone.
 *   - It never treats upload time as capture time. A file with no capture time
 *     says nothing about WHEN anything happened and is left out (counted).
 *   - It never invents a place. Media carries none here; an episode without a
 *     place is honest, a guessed one is §28.3's semantic substitute.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 * 2320 is WRITTEN AND UNAPPLIED on production. Every entry point probes both
 * tables first: absent ⇒ `not_deployed` (the route answers feature_disabled),
 * unreadable ⇒ `unavailable` (503). Nothing is written to a half-deployed spine.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { probeHighlightObject } from "../highlights/highlightSchemaAvailability.js";
import {
  evaluateEligibility,
  normalizeEvidence,
  type NormalizedEvidence,
  type RawSignal,
} from "../memoryProjections/evidence.js";
import {
  detectEpisodes,
  featureFromEvidence,
  EPISODE_DETECTOR_VERSION,
  type DetectedEpisode,
} from "../memoryProjections/episodeDetection.js";
import { scoreSignificance, SIGNIFICANCE_POLICY_VERSION } from "../memoryProjections/significance.js";
import { decideTransition } from "../../memory/memoryEpisodeLifecycle.js";
import { EPISODES_TABLE, EVIDENCE_TABLE, parseEpisodeRow, type MemoryEpisode } from "../../memory/memoryEpisodeContract.js";
import { classifyMemoryMediaUrl } from "./memoryMediaOrigin.js";
import { countCandidateDecision, countCandidateEvaluation } from "./memoryKernelMetrics.js";
import { dispatchMemoryCommand } from "./MemoryDomainService.js";
import { lifecycleStateOf } from "../../lib/memoryCommandBus.js";

const log = rootLogger.child({ mod: "episodeCandidates" });

/** memory_episodes.detector_version is an INTEGER; this is EPISODE_DETECTOR_VERSION's number. */
export const CANDIDATE_DETECTOR_VERSION = 1;
export const CANDIDATE_DETECTION_REASON = "media_cluster" as const;
/** 2320's kind vocabulary has no "photos" kind; a cluster of captures is an activity until the owner says more. */
export const CANDIDATE_EPISODE_KIND = "activity" as const;

export const EPISODE_COLUMNS = [
  "id", "user_id", "episode_kind", "summary", "started_at", "ended_at", "place_id", "city", "country",
  "detection_reason", "detector_version", "detection_digest", "significance", "significance_basis",
  "state", "state_changed_at", "merged_into_id", "sensitivity", "visibility", "retention_class",
  "created_at", "updated_at",
] as const;
const EVIDENCE_COLUMNS = [
  "id", "episode_id", "user_id", "truth_level", "source_class", "source_table", "source_id",
  "source_ref", "observed_at", "recorded_at", "weight",
] as const;
// A string literal, not EPISODE_COLUMNS.join(", "): check:write-path-columns resolves a
// select list only when it is a literal or a same-file string const, and a .join is a
// blind spot to it. memoryEpisodeContract.test pins the two to the same column set.
export const EPISODE_SELECT = "id, user_id, episode_kind, summary, started_at, ended_at, place_id, city, country, detection_reason, detector_version, detection_digest, significance, significance_basis, state, state_changed_at, merged_into_id, sensitivity, visibility, retention_class, created_at, updated_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A trip's dates are calendar days in its own zone; ±14 h covers every zone on Earth. */
const TRIP_EDGE_MS = 14 * 3_600_000;
const MAX_CAPTURES = 500;
const MAX_CANDIDATES_LISTED = 50;
/** A producer-declared confidence for a capture; normalizeEvidence clamps it to CAMERA_CAPTURE's ceiling. */
const CAPTURE_CONFIDENCE = 0.7;

export type StoreState = { state: "ready" } | { state: "not_deployed"; detail: string } | { state: "unavailable"; detail: string };

/** Both 2320 tables, probed for the columns this module writes. Half a spine is not a spine. */
export async function candidateStoreState(sc: SupabaseClient): Promise<StoreState> {
  const [ep, ev] = await Promise.all([
    probeHighlightObject(sc, EPISODES_TABLE, EPISODE_COLUMNS),
    probeHighlightObject(sc, EVIDENCE_TABLE, EVIDENCE_COLUMNS),
  ]);
  for (const a of [ep, ev]) {
    if (a.state === "absent") return { state: "not_deployed", detail: a.reason };
    if (a.state === "unreadable") return { state: "unavailable", detail: a.reason };
  }
  return { state: "ready" };
}

/* ============================================================================
 * Signals: the owner's own captured media
 * ==========================================================================*/

interface MediaRow {
  id: string;
  owner_user_id: string;
  media_type: string;
  mime_type: string | null;
  public_url: string | null;
  captured_at: string | null;
  source_type: string | null;
  moderation_status: string | null;
  processing_status: string | null;
  deleted_at: string | null;
  provenance: Record<string, unknown> | null;
}

const MEDIA_COLUMNS = "id, owner_user_id, media_type, mime_type, public_url, captured_at, source_type, moderation_status, processing_status, deleted_at, provenance";

/**
 * Moderation states a capture may be in to stand as evidence, be previewed, or
 * be attached. An ALLOW-list: a state this code has not heard of is not
 * admitted. The legacy spellings (pending/approved) and their §36 meanings
 * (processing/active) are both here; flagged, limited, rejected, removed and
 * owner_deleted are not.
 */
export const ADMISSIBLE_CAPTURE_MODERATION: ReadonlySet<string> = new Set(["approved", "active", "pending", "processing"]);

/**
 * ONE rule for every read of the owner's media in this module — detection,
 * the inbox preview and the photos a Keep attaches. A capture the owner
 * deleted after detection (deleted_at set, processing_status 'removed',
 * moderation 'owner_deleted') or one a moderator flagged later is not
 * evidence, not a preview and not attached: the decision is re-made at every
 * read, never inherited from the detection that first saw the file.
 */
export function isAdmissibleCapture(m: Pick<MediaRow, "processing_status" | "deleted_at" | "moderation_status" | "source_type">): boolean {
  return m.processing_status === "ready"
    && m.deleted_at == null
    && ADMISSIBLE_CAPTURE_MODERATION.has(String(m.moderation_status ?? ""))
    && (m.source_type ?? "user") === "user";
}

/** What a capture says about how it was made, if anything. Never "camera" unless the file says so. */
function captureProvenanceOf(p: Record<string, unknown> | null): string {
  const v = p && (p["captureProvenance"] ?? p["capture_provenance"] ?? p["origin"]);
  return typeof v === "string" && v.length > 0 ? v : "unknown";
}

export function signalFromMedia(row: MediaRow, tripId: string): RawSignal {
  return {
    owner_id: row.owner_user_id,
    source_type: "CAMERA_CAPTURE",
    source_id: row.id,
    assertion_type: "CAPTURED_MEDIA",
    observed_at: row.captured_at,
    assertion_json: { trip_id: tripId, media_type: row.media_type, capture_provenance: captureProvenanceOf(row.provenance) },
    confidence: CAPTURE_CONFIDENCE,
    provenance_json: { table: "media_assets", id: row.id },
  };
}

/* ============================================================================
 * Detect
 * ==========================================================================*/

export interface DetectedCandidateSummary {
  episodeId: string;
  startedAt: string;
  endedAt: string | null;
  captureCount: number;
  /** True when this run wrote the episode; false when a replay found it. */
  created: boolean;
  /** Evidence rows this run added (a replay may add captures it had not seen). */
  evidenceAdded: number;
  /** Set when an overlapping episode the owner already DECIDED against made this run write nothing. */
  suppressedBy: string | null;
}

export interface DetectReport {
  tripId: string;
  window: { from: string; to: string };
  detectorVersion: string;
  capturesRead: number;
  /** Media in the window with no capture time — left out, never dated by upload. */
  capturesWithoutTime: number;
  /** Captures already in one of the owner's Memories — not proposed again. */
  capturesAlreadyInMemories: number;
  normalizationRejected: Array<{ sourceId: string; reason: string }>;
  ineligible: Array<{ startedAt: string; reason: string | null; detail: string }>;
  candidates: DetectedCandidateSummary[];
}

export type DetectOutcome =
  | { ok: true; report: DetectReport }
  | { ok: false; reason: "not_deployed" | "unavailable" | "trip_not_found" | "not_trip_member" | "trip_has_no_dates" | "write_failed"; detail: string };

function sha(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
}

/**
 * The replay identity of a detected episode: owner + detector + the sorted ids
 * of the captures it rests on. The detector's own `id` is the same kind of
 * digest; it is recomputed here so the stored key does not depend on a format
 * another module may change.
 */
export function detectionDigest(ownerId: string, episode: Pick<DetectedEpisode, "evidence_ids">): string {
  return sha([ownerId, EPISODE_DETECTOR_VERSION, CANDIDATE_DETECTION_REASON, ...[...episode.evidence_ids].sort()]);
}

async function readTripWindow(
  sc: SupabaseClient, tripId: string, ownerId: string,
): Promise<{ ok: true; from: string; to: string; city: string | null; country: string | null } | { ok: false; reason: "unavailable" | "trip_not_found" | "not_trip_member" | "trip_has_no_dates"; detail: string }> {
  const [tripRead, memberRead] = await Promise.all([
    sc.from("trips").select("id, owner_id, start_date, end_date, destination_city, destination_country").eq("id", tripId).maybeSingle(),
    sc.from("trip_members").select("role, status").eq("trip_id", tripId).eq("user_id", ownerId).maybeSingle(),
  ]);
  if (tripRead.error) return { ok: false, reason: "unavailable", detail: `trips: ${tripRead.error.message}` };
  if (memberRead.error) return { ok: false, reason: "unavailable", detail: `trip_members: ${memberRead.error.message}` };
  const trip = tripRead.data as { owner_id: string; start_date: string | null; end_date: string | null; destination_city: string | null; destination_country: string | null } | null;
  if (!trip) return { ok: false, reason: "trip_not_found", detail: "no such trip" };
  const m = memberRead.data as { role: string | null; status: string | null } | null;
  const accepted = trip.owner_id === ownerId
    || (m != null && ["owner", "co_host", "member", "viewer"].includes(String(m.role)) && (m.status == null || m.status === "accepted"));
  if (!accepted) return { ok: false, reason: "not_trip_member", detail: "not an accepted member of that trip" };
  if (!trip.start_date || !trip.end_date) return { ok: false, reason: "trip_has_no_dates", detail: "the trip has no start and end date to look between" };
  const from = new Date(Date.parse(`${trip.start_date}T00:00:00.000Z`) - TRIP_EDGE_MS).toISOString();
  const to = new Date(Date.parse(`${trip.end_date}T23:59:59.999Z`) + TRIP_EDGE_MS).toISOString();
  return { ok: true, from, to, city: trip.destination_city ?? null, country: trip.destination_country ?? null };
}

/** URLs of media already inside one of the owner's Memories. */
async function urlsAlreadyInMemories(sc: SupabaseClient, ownerId: string, urls: string[]): Promise<{ ok: true; urls: Set<string> } | { ok: false; detail: string }> {
  if (urls.length === 0) return { ok: true, urls: new Set() };
  const { data: mems, error: memErr } = await sc.from("memories").select("id").eq("owner_id", ownerId).neq("state", "deleted").limit(2000);
  if (memErr) return { ok: false, detail: `memories: ${memErr.message}` };
  const ids = ((mems as Array<{ id: string }> | null) ?? []).map((m) => m.id);
  if (ids.length === 0) return { ok: true, urls: new Set() };
  const { data: items, error: itemErr } = await sc.from("memory_items").select("media_url").in("memory_id", ids).in("media_url", urls);
  if (itemErr) return { ok: false, detail: `memory_items: ${itemErr.message}` };
  return { ok: true, urls: new Set(((items as Array<{ media_url: string }> | null) ?? []).map((i) => i.media_url)) };
}

/**
 * §27 `buildCandidates(ownerId, window)` — the window is a trip the owner is on.
 */
export async function detectTripCandidates(
  sc: SupabaseClient,
  input: { ownerId: string; tripId: string; now: Date },
): Promise<DetectOutcome> {
  const store = await candidateStoreState(sc);
  if (store.state !== "ready") return { ok: false, reason: store.state, detail: store.detail };

  const win = await readTripWindow(sc, input.tripId, input.ownerId);
  if (!win.ok) return { ok: false, reason: win.reason, detail: win.detail };

  const { data: mediaData, error: mediaErr } = await sc
    .from("media_assets")
    .select(MEDIA_COLUMNS)
    .eq("owner_user_id", input.ownerId)
    .eq("processing_status", "ready")
    .gte("captured_at", win.from)
    .lte("captured_at", win.to)
    .order("captured_at", { ascending: true })
    .limit(MAX_CAPTURES);
  if (mediaErr) return { ok: false, reason: "unavailable", detail: `media_assets: ${mediaErr.message}` };
  // A moderator's verdict outranks a memory; a non-user source is not the
  // owner's capture; a deleted file is gone. See isAdmissibleCapture.
  const media = ((mediaData as MediaRow[] | null) ?? []).filter(isAdmissibleCapture);
  // The window query reads CAPTURE time, so a file with none never reaches it.
  // Say how many there were (uploaded inside the trip, no capture time) rather
  // than letting them vanish: "we could not date 4 photos" is information.
  const { data: untimedData, error: untimedErr } = await sc
    .from("media_assets")
    .select("id")
    .eq("owner_user_id", input.ownerId)
    .is("captured_at", null)
    .gte("created_at", win.from)
    .lte("created_at", win.to)
    .limit(MAX_CAPTURES);
  if (untimedErr) return { ok: false, reason: "unavailable", detail: `media_assets: ${untimedErr.message}` };
  const withoutTime = ((untimedData as unknown[] | null) ?? []).length;
  const timed = media.filter((m) => Boolean(m.captured_at));

  const already = await urlsAlreadyInMemories(sc, input.ownerId, timed.map((m) => m.public_url).filter((u): u is string => Boolean(u)));
  if (!already.ok) return { ok: false, reason: "unavailable", detail: already.detail };
  const fresh = timed.filter((m) => !(m.public_url && already.urls.has(m.public_url)));

  const normalized: NormalizedEvidence[] = [];
  const normalizationRejected: DetectReport["normalizationRejected"] = [];
  for (const m of fresh) {
    const n = normalizeEvidence(signalFromMedia(m, input.tripId), input.now);
    if (n.ok) normalized.push(n.evidence);
    else normalizationRejected.push({ sourceId: m.id, reason: n.reason });
  }

  const detected = detectEpisodes(normalized.map(featureFromEvidence));
  const byFeatureId = new Map<string, NormalizedEvidence>(normalized.map((e) => [`${e.source_type}:${e.source_id}`, e]));

  const report: DetectReport = {
    tripId: input.tripId,
    window: { from: win.from, to: win.to },
    detectorVersion: EPISODE_DETECTOR_VERSION,
    capturesRead: media.length,
    capturesWithoutTime: withoutTime,
    capturesAlreadyInMemories: timed.length - fresh.length,
    normalizationRejected,
    ineligible: [],
    candidates: [],
  };

  for (const ep of detected.episodes) {
    const evidence = ep.evidence_ids.map((id) => byFeatureId.get(id)).filter((e): e is NormalizedEvidence => Boolean(e));
    const verdict = evaluateEligibility(evidence, { mode: "USER_INITIATED" });
    countCandidateEvaluation(verdict.eligible);
    if (!verdict.eligible) {
      report.ineligible.push({ startedAt: ep.started_at, reason: verdict.reason, detail: verdict.detail });
      continue;
    }
    const stored = await storeCandidate(sc, {
      ownerId: input.ownerId, episode: ep, evidence, city: win.city, country: win.country,
    });
    if (!stored.ok) return { ok: false, reason: stored.reason, detail: stored.detail };
    report.candidates.push(stored.summary);
  }
  return { ok: true, report };
}

/**
 * Store one detected episode as a candidate — or add to the one already there.
 *
 * LATE EVIDENCE NEVER OVERWRITES A DECISION (§9, H179). A detected episode
 * whose time range overlaps an episode this owner already has (same detector
 * reason) is NOT a new episode: new captures are appended to the existing one
 * as evidence and its row is left exactly as it is — candidate, confirmed or
 * otherwise. If the owner REJECTED that window, nothing is written at all: a
 * re-run must not resurrect what the owner discarded. Only a range nothing
 * overlaps becomes a new `candidate`, under the replay key.
 */
async function storeCandidate(
  sc: SupabaseClient,
  input: { ownerId: string; episode: DetectedEpisode; evidence: NormalizedEvidence[]; city: string | null; country: string | null },
): Promise<{ ok: true; summary: DetectedCandidateSummary } | { ok: false; reason: "unavailable" | "write_failed"; detail: string }> {
  const digest = detectionDigest(input.ownerId, input.episode);
  type Row = { id: string; started_at: string; ended_at: string | null; state: string };
  const { data: overlapping, error: overlapErr } = await sc
    .from("memory_episodes")
    .select("id, started_at, ended_at, state, created_at")
    .eq("user_id", input.ownerId)
    .eq("detection_reason", CANDIDATE_DETECTION_REASON)
    .lte("started_at", input.episode.ended_at)
    .gte("ended_at", input.episode.started_at)
    .order("created_at", { ascending: true })
    .limit(5);
  if (overlapErr) return { ok: false, reason: "unavailable", detail: `${EPISODES_TABLE}: ${overlapErr.message}` };

  let episodeRow = ((overlapping as Row[] | null) ?? [])[0] ?? null;
  let created = false;
  if (episodeRow && (episodeRow.state === "rejected" || episodeRow.state === "deleted")) {
    return {
      ok: true,
      summary: {
        episodeId: episodeRow.id, startedAt: episodeRow.started_at, endedAt: episodeRow.ended_at,
        captureCount: input.evidence.length, created: false, evidenceAdded: 0, suppressedBy: episodeRow.state,
      },
    };
  }
  if (!episodeRow) {
    const { data: inserted, error: insertErr } = await sc
      .from("memory_episodes")
      .insert({
        user_id: input.ownerId,
        episode_kind: CANDIDATE_EPISODE_KIND,
        summary: null,
        started_at: input.episode.started_at,
        ended_at: input.episode.ended_at,
        place_id: input.episode.primary_place_id,
        city: input.city,
        country: input.country,
        detection_reason: CANDIDATE_DETECTION_REASON,
        detector_version: CANDIDATE_DETECTOR_VERSION,
        detection_digest: digest,
        state: "candidate",
        visibility: "private",
      })
      .select("id, started_at, ended_at, state")
      .single();
    if (insertErr) {
      // A concurrent detect of the same inputs is the same episode: the replay
      // key refused the second insert. Read the winner rather than fail.
      if (String((insertErr as { code?: string }).code ?? "") !== "23505") {
        return { ok: false, reason: "write_failed", detail: `${EPISODES_TABLE} insert: ${insertErr.message}` };
      }
      const again = await sc
        .from("memory_episodes")
        .select("id, started_at, ended_at, state")
        .eq("user_id", input.ownerId)
        .eq("detection_reason", CANDIDATE_DETECTION_REASON)
        .eq("detector_version", CANDIDATE_DETECTOR_VERSION)
        .eq("detection_digest", digest)
        .maybeSingle();
      if (again.error || !again.data) return { ok: false, reason: "write_failed", detail: "replay-key race and the winner could not be read" };
      episodeRow = again.data as Row;
    } else {
      episodeRow = inserted as Row;
      created = true;
    }
  }

  // Evidence is append-only and keyed (episode, source_table, source_id,
  // truth_level): a capture already recorded is ignored, a new one is added —
  // and the episode row is never touched here.
  const rows = input.evidence.map((e) => ({
    episode_id: episodeRow!.id,
    user_id: input.ownerId,
    truth_level: "observed",
    source_class: "system",
    source_table: "media_assets",
    source_id: e.source_id,
    source_ref: { normalizer: e.normalizer_version, fingerprint: e.fingerprint },
    observed_at: e.observed_at,
    weight: Math.max(0, Math.min(1, e.confidence)),
  }));
  const { data: written, error: evErr } = await sc
    .from("memory_evidence")
    .upsert(rows, { onConflict: "episode_id,source_table,source_id,truth_level", ignoreDuplicates: true })
    .select("id");
  if (evErr) return { ok: false, reason: "write_failed", detail: `${EVIDENCE_TABLE} write: ${evErr.message}` };

  return {
    ok: true,
    summary: {
      episodeId: episodeRow!.id,
      startedAt: episodeRow!.started_at,
      endedAt: episodeRow!.ended_at,
      captureCount: input.evidence.length,
      created,
      evidenceAdded: Array.isArray(written) ? written.length : 0,
      suppressedBy: null,
    },
  };
}

/* ============================================================================
 * Inbox
 * ==========================================================================*/

export interface CandidateView {
  id: string;
  startedAt: string;
  endedAt: string | null;
  city: string | null;
  country: string | null;
  detectionReason: string;
  detectorVersion: number;
  captureCount: number;
  /** Up to four capture URLs to show, owner's own, still admissible now. */
  previewUrls: string[];
  /** `interrupted`: the owner pressed Keep and it did not finish — Keep again completes it. */
  state: "candidate" | "interrupted";
}

export type ListOutcome =
  | { ok: true; candidates: CandidateView[] }
  | { ok: false; reason: "not_deployed" | "unavailable"; detail: string };

export async function listCandidates(sc: SupabaseClient, ownerId: string): Promise<ListOutcome> {
  const store = await candidateStoreState(sc);
  if (store.state !== "ready") return { ok: false, reason: store.state, detail: store.detail };

  // `confirmed` is read too: a Keep that claimed its episode and was cut off
  // before its Memory was linked must stay in front of the owner, or the retry
  // that finishes it would be unreachable. Those are the ones with no link.
  const { data, error } = await sc
    .from("memory_episodes")
    .select(EPISODE_SELECT)
    .eq("user_id", ownerId)
    .in("state", ["candidate", "confirmed"])
    .order("started_at", { ascending: false })
    .limit(MAX_CANDIDATES_LISTED * 4);
  if (error) return { ok: false, reason: "unavailable", detail: `${EPISODES_TABLE}: ${error.message}` };
  const read = ((data as unknown[] | null) ?? []).map(parseEpisodeRow).filter((e): e is MemoryEpisode => e !== null);
  if (read.length === 0) return { ok: true, candidates: [] };

  const { data: ev, error: evErr } = await sc
    .from("memory_evidence")
    .select("episode_id, source_table, source_id")
    .eq("user_id", ownerId)
    .in("episode_id", read.map((e) => e.id));
  if (evErr) return { ok: false, reason: "unavailable", detail: `${EVIDENCE_TABLE}: ${evErr.message}` };
  const evRows = ((ev as Array<{ episode_id: string; source_table: string; source_id: string }> | null) ?? []);
  const linked = new Set(evRows.filter((r) => r.source_table === "memories").map((r) => r.episode_id));
  const episodes = read.filter((e) => e.state === "candidate" || !linked.has(e.id)).slice(0, MAX_CANDIDATES_LISTED);
  if (episodes.length === 0) return { ok: true, candidates: [] };
  const mediaIds = [...new Set(evRows.filter((r) => r.source_table === "media_assets").map((r) => r.source_id))];

  const urlById = new Map<string, string>();
  if (mediaIds.length > 0) {
    const { data: media, error: mediaErr } = await sc
      .from("media_assets")
      .select("id, owner_user_id, public_url, processing_status, deleted_at, moderation_status, source_type")
      .eq("owner_user_id", ownerId)
      .in("id", mediaIds);
    if (mediaErr) return { ok: false, reason: "unavailable", detail: `media_assets: ${mediaErr.message}` };
    for (const m of ((media as Array<MediaRow> | null) ?? [])) if (m.public_url && isAdmissibleCapture(m)) urlById.set(m.id, m.public_url);
  }

  return {
    ok: true,
    candidates: episodes.map((e) => {
      const mine = evRows.filter((r) => r.episode_id === e.id && r.source_table === "media_assets");
      return {
        id: e.id,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        city: e.city,
        country: e.country,
        detectionReason: e.detection.reason,
        detectorVersion: e.detection.version,
        captureCount: mine.length,
        previewUrls: mine.map((r) => urlById.get(r.source_id)).filter((u): u is string => Boolean(u)).slice(0, 4),
        // A claimed-but-unlinked Keep: the owner already chose to keep it, and
        // Keep again finishes the same Memory (it cannot make a second one).
        state: e.state === "confirmed" ? ("interrupted" as const) : ("candidate" as const),
      };
    }),
  };
}

/* ============================================================================
 * Decide: confirm or reject
 * ==========================================================================*/

export type DecideOutcome =
  | { ok: true; episodeId: string; state: "confirmed"; memoryId: string; mediaAttached: number; replayed: boolean }
  | { ok: true; episodeId: string; state: "rejected"; replayed: boolean }
  | { ok: false; reason: "not_deployed" | "unavailable" | "not_found" | "not_a_candidate" | "write_failed" | "kernel_refused"; detail: string };

async function loadOwnEpisode(sc: SupabaseClient, ownerId: string, episodeId: string): Promise<{ ok: true; episode: MemoryEpisode } | { ok: false; reason: "unavailable" | "not_found"; detail: string }> {
  if (!UUID_RE.test(episodeId)) return { ok: false, reason: "not_found", detail: "not an id" };
  const { data, error } = await sc.from("memory_episodes").select(EPISODE_SELECT).eq("id", episodeId).eq("user_id", ownerId).maybeSingle();
  if (error) return { ok: false, reason: "unavailable", detail: `${EPISODES_TABLE}: ${error.message}` };
  const episode = data ? parseEpisodeRow(data) : null;
  if (!episode) return { ok: false, reason: "not_found", detail: "no such candidate for this owner" };
  return { ok: true, episode };
}

/** The Memory a confirmation already created, if any — the link is EXPLICIT evidence on the episode. */
async function linkedMemoryId(sc: SupabaseClient, ownerId: string, episodeId: string): Promise<{ ok: true; memoryId: string | null } | { ok: false; detail: string }> {
  const { data, error } = await sc
    .from("memory_evidence")
    .select("source_id")
    .eq("user_id", ownerId)
    .eq("episode_id", episodeId)
    .eq("source_table", "memories")
    .eq("truth_level", "asserted")
    .maybeSingle();
  if (error) return { ok: false, detail: `${EVIDENCE_TABLE}: ${error.message}` };
  return { ok: true, memoryId: (data as { source_id: string } | null)?.source_id ?? null };
}

export async function rejectCandidate(sc: SupabaseClient, input: { ownerId: string; episodeId: string; now: Date }): Promise<DecideOutcome> {
  const store = await candidateStoreState(sc);
  if (store.state !== "ready") return { ok: false, reason: store.state, detail: store.detail };
  const loaded = await loadOwnEpisode(sc, input.ownerId, input.episodeId);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail };
  if (loaded.episode.state === "rejected") return { ok: true, episodeId: input.episodeId, state: "rejected", replayed: true };
  // ONLY A CANDIDATE MAY BE REJECTED HERE. The lifecycle machine admits
  // confirmed → rejected, but in this inbox `confirmed` means the owner pressed
  // Keep: confirmCandidate claims the episode BEFORE its Memory exists, so a
  // `confirmed` episode is one whose Memory exists or is being made. Rejecting
  // it would leave that Memory — and any Highlight made from it — behind a
  // rejected candidate (H238). Deleting the Memory is how a kept one is undone.
  if (loaded.episode.state !== "candidate") {
    return { ok: false, reason: "not_a_candidate", detail: `a ${loaded.episode.state} suggestion cannot be dismissed — it was kept` };
  }
  const link = await linkedMemoryId(sc, input.ownerId, input.episodeId);
  if (!link.ok) return { ok: false, reason: "unavailable", detail: link.detail };
  if (link.memoryId) return { ok: false, reason: "not_a_candidate", detail: "this suggestion was already kept as a Memory" };
  const { data, error } = await sc
    .from("memory_episodes")
    .update({ state: "rejected", state_changed_at: input.now.toISOString() })
    .eq("id", input.episodeId)
    .eq("user_id", input.ownerId)
    .eq("state", "candidate")
    .select("id");
  if (error) return { ok: false, reason: "write_failed", detail: `${EPISODES_TABLE} update: ${error.message}` };
  // A Keep that claimed the episode between the read above and this write wins:
  // the conditional update changes nothing, and the dismissal is refused.
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "not_a_candidate", detail: "the suggestion was kept while it was being dismissed" };
  countCandidateDecision("rejected");
  return { ok: true, episodeId: input.episodeId, state: "rejected", replayed: false };
}

/**
 * A uuid derived from a name — the same name, the same id, on every call.
 * The Memory a candidate becomes, and each photo attached to it, are keyed this
 * way so a second INSERT of the same thing is impossible (primary key), not
 * merely unlikely: two taps, two devices, a retry after a lost response, a
 * retry after a failed link write — all reach one row.
 */
export function derivedUuid(namespace: string, name: string): string {
  const h = createHash("sha256").update(`${namespace}\u0000${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
export const candidateMemoryId = (episodeId: string) => derivedUuid("portava:memory-candidate:memory", episodeId);
export const candidateItemId = (memoryId: string, assetId: string) => derivedUuid("portava:memory-candidate:item", `${memoryId}:${assetId}`);
/** The §19 key the Memory create carries: one per candidate, whatever key the client sent. */
export const candidateCreateKey = (episodeId: string) => `memory-candidate:${episodeId}`;

/**
 * §27 MemoryDomainService.confirm — the owner keeps a candidate.
 *
 * ONLY ONE CALLER CAN WIN, AND NOTHING IT LEAVES BEHIND IS A SECOND MEMORY.
 *
 *   (1) CLAIM. A conditional `candidate → confirmed` update (with §8's score
 *       and the `user_affirmed` basis the 2320 CHECK requires) that must change
 *       exactly one row. A reject racing it can no longer win; a reject that
 *       already won makes this claim change nothing and the answer is 409 —
 *       before any Memory exists. A second confirm finds `confirmed` and goes
 *       on to (2) as a completion, not as a competitor.
 *   (2) MEMORY. Created through the §17 boundary with an id DERIVED from the
 *       episode (and the §19 key derived the same way), so every completer —
 *       concurrent, retried, or after a crash — reaches the same row: with the
 *       kernel off a duplicate INSERT is a primary-key refusal answered by
 *       reading that row; with it on the receipt answers the original result.
 *   (3) LINK, as explicit evidence — idempotent on its own key.
 *   (4) PHOTOS, each with a derived id, admissible captures only.
 *
 * A failure after (1) leaves `confirmed` without a link; the inbox keeps
 * showing it as interrupted and Keep again completes it. A rejected candidate
 * never has a Memory, because (2) never runs for one.
 */
export async function confirmCandidate(
  sc: SupabaseClient,
  input: { ownerId: string; episodeId: string; title: string | null; idempotencyKey: string; now: Date },
): Promise<DecideOutcome> {
  const store = await candidateStoreState(sc);
  if (store.state !== "ready") return { ok: false, reason: store.state, detail: store.detail };
  const loaded = await loadOwnEpisode(sc, input.ownerId, input.episodeId);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, detail: loaded.detail };
  let ep = loaded.episode;
  const title = input.title && input.title.trim() ? input.title.trim().slice(0, 200) : null;

  // (1)
  let claimedHere = false;
  if (ep.state === "candidate") {
    const significance = scoreSignificance({ later_user_promotion: true, user_caption: Boolean(title) });
    const decision = decideTransition("candidate", "confirmed", { significance: significance.score, significanceBasis: "user_affirmed" });
    if (!decision.ok) return { ok: false, reason: "not_a_candidate", detail: decision.detail };
    const { data, error } = await sc
      .from("memory_episodes")
      .update({
        state: "confirmed",
        state_changed_at: input.now.toISOString(),
        significance: significance.score,
        significance_basis: "user_affirmed",
        summary: title ?? ep.summary,
      })
      .eq("id", ep.id)
      .eq("user_id", input.ownerId)
      .eq("state", "candidate")
      .select("id");
    if (error) return { ok: false, reason: "write_failed", detail: `${EPISODES_TABLE} claim: ${error.message}` };
    if (Array.isArray(data) && data.length === 1) {
      claimedHere = true;
      countCandidateDecision("confirmed");
    } else {
      const again = await loadOwnEpisode(sc, input.ownerId, input.episodeId);
      if (!again.ok) return { ok: false, reason: again.reason, detail: again.detail };
      ep = again.episode;
    }
  }
  if (ep.state !== "confirmed" && !claimedHere) {
    return { ok: false, reason: "not_a_candidate", detail: `a ${ep.state} episode cannot be kept` };
  }

  const { data: evData, error: evErr } = await sc
    .from("memory_evidence")
    .select("source_table, source_id")
    .eq("user_id", input.ownerId)
    .eq("episode_id", ep.id);
  if (evErr) return { ok: false, reason: "unavailable", detail: `${EVIDENCE_TABLE}: ${evErr.message}` };
  const evRows = ((evData as Array<{ source_table: string; source_id: string }> | null) ?? []);
  const captureIds = evRows.filter((r) => r.source_table === "media_assets").map((r) => r.source_id);
  const existingLink = evRows.find((r) => r.source_table === "memories")?.source_id ?? null;
  const replayed = !claimedHere;

  // (2)
  let memoryId = existingLink;
  if (!memoryId) {
    const derivedId = candidateMemoryId(ep.id);
    const write = {
      id: derivedId,
      owner_id: input.ownerId,
      title: title ?? ep.summary,
      caption: null,
      visibility: "only_me",
      state: "published",
      starts_at: ep.startedAt,
      ends_at: ep.endedAt,
      location_city: ep.city,
      location_country: ep.country,
    };
    const created = await dispatchMemoryCommand<{ id: string }>({
      sc,
      commandType: "CREATE_MEMORY",
      memoryId: null,
      actorUserId: input.ownerId,
      idempotencyKey: candidateCreateKey(ep.id),
      fromCandidate: true,
      payload: { to_state: lifecycleStateOf("published"), visibility: "only_me", write, select: "id" },
      fromKernelResult: (r: unknown) => { const k = (r ?? {}) as { memory_id?: unknown; id?: unknown }; return { id: String(k.memory_id ?? k.id ?? "") }; },
      legacy: async () => {
        const { data, error } = await sc.from("memories").insert(write).select("id").single();
        if (!error) return { ok: true, body: { id: String((data as { id: string }).id) } };
        if (String((error as { code?: string }).code ?? "") !== "23505") return { ok: false, http: { code: "db_error", message: error.message } };
        // The derived id is taken: this candidate's Memory already exists.
        const { data: had, error: hadErr } = await sc.from("memories").select("id, owner_id").eq("id", derivedId).maybeSingle();
        if (hadErr || !had || (had as { owner_id: string }).owner_id !== input.ownerId) {
          return { ok: false, http: { code: "db_error", message: "the candidate's Memory id is taken and could not be confirmed as this owner's" } };
        }
        return { ok: true, body: { id: derivedId } };
      },
    });
    if (!created.ok) {
      const detail = "rejection" in created ? created.rejection.reason : created.http.message;
      return { ok: false, reason: "kernel_refused", detail: String(detail) };
    }
    memoryId = created.body.id;

    // (3)
    const { error: linkErr } = await sc
      .from("memory_evidence")
      .upsert({
        episode_id: ep.id,
        user_id: input.ownerId,
        truth_level: "asserted",
        source_class: "explicit",
        source_table: "memories",
        source_id: memoryId,
        source_ref: { confirmed_by: "owner", significance_policy: SIGNIFICANCE_POLICY_VERSION },
        observed_at: input.now.toISOString(),
        weight: 1,
      }, { onConflict: "episode_id,source_table,source_id,truth_level", ignoreDuplicates: true });
    if (linkErr) return { ok: false, reason: "write_failed", detail: `${EVIDENCE_TABLE} link: ${linkErr.message}` };
  }

  // (4)
  let attached = 0;
  if (captureIds.length > 0) {
    const [mediaRead, itemsRead] = await Promise.all([
      sc.from("media_assets").select(MEDIA_COLUMNS).eq("owner_user_id", input.ownerId).in("id", captureIds),
      sc.from("memory_items").select("id, media_url").eq("memory_id", memoryId),
    ]);
    if (mediaRead.error) return { ok: false, reason: "unavailable", detail: `media_assets: ${mediaRead.error.message}` };
    if (itemsRead.error) return { ok: false, reason: "unavailable", detail: `memory_items: ${itemsRead.error.message}` };
    const items = ((itemsRead.data as Array<{ id: string; media_url: string }> | null) ?? []);
    const haveIds = new Set(items.map((i) => i.id));
    const haveUrls = new Set(items.map((i) => i.media_url));
    const media = ((mediaRead.data as MediaRow[] | null) ?? [])
      .filter((m) => m.public_url && isAdmissibleCapture(m))
      .sort((a, b) => String(a.captured_at ?? "").localeCompare(String(b.captured_at ?? "")) || a.id.localeCompare(b.id));
    let position = items.length;
    for (const m of media) {
      const url = m.public_url!;
      const itemId = candidateItemId(memoryId!, m.id);
      if (haveIds.has(itemId) || haveUrls.has(url)) continue;
      if (classifyMemoryMediaUrl(url, input.ownerId).verdict === "foreign_storage") continue;
      const item = { id: itemId, memory_id: memoryId, media_url: url, media_type: m.mime_type ?? "image/jpeg", caption: null, position };
      const added = await dispatchMemoryCommand<{ id: string }>({
        sc,
        commandType: "ADD_MEDIA",
        memoryId,
        actorUserId: input.ownerId,
        idempotencyKey: `memory-candidate-item:${itemId}`,
        payload: { media_type: item.media_type, position, write: item },
        legacy: async () => {
          const { data, error } = await sc.from("memory_items").insert(item).select("id").single();
          if (!error) return { ok: true, body: { id: String((data as { id: string }).id) } };
          // A concurrent completer attached this exact photo already.
          if (String((error as { code?: string }).code ?? "") === "23505") return { ok: true, body: { id: itemId } };
          return { ok: false, http: { code: "db_error", message: error.message } };
        },
      });
      if (!added.ok) {
        const detail = "rejection" in added ? added.rejection.reason : added.http.message;
        return { ok: false, reason: "kernel_refused", detail: `attaching a capture: ${String(detail)}` };
      }
      attached += 1;
      position += 1;
    }
  }

  return { ok: true, episodeId: ep.id, state: "confirmed", memoryId: memoryId!, mediaAttached: attached, replayed };
}
