/**
 * Intelligence Gathering — §19 read models (internal decision-support APIs).
 *
 *   GET /v1/experiences/:id/live-state
 *     The spec-literal §19 name for "what is true at this experience right now?".
 *     A THIN ALIAS over lib/liveClaimRead.resolvePlaceIntelState — the SAME
 *     reader routes/placeLiving.ts serves the place card from, entered the same
 *     way: a merged place id is resolved to its surviving canonical id first,
 *     as loadPlaceGroup does, because the projection writes for the canonical
 *     subject. It adds no second gate and no second truth: every flag (the
 *     intel_live_label_crowd dependency chain, the disable_intel_live_labels
 *     kill switch, the IG-09 intel_limited_live master switch), the per-scope
 *     promotion allowlist, the
 *     privacy_eligible k-anonymity verdict and the TTL check all live in that one
 *     reader and are inherited here. The response is the §19 envelope
 *     (schema_version / source_label / generated_at / valid_until / state_version
 *     + ETag) around exactly the LiveClaimEnvelope[] the place card already
 *     carries — derived intelligence only, never a contributor id, a coordinate
 *     or the exact k-anonymity cohort size.
 *
 *   GET /v1/experiences/:id/typical-patterns
 *     The §12 historical patterns for an experience, projected to DERIVED fields
 *     only (no contributor ids, no exact cohort — a coarse bucket). A pattern is
 *     always source_label 'historical_pattern' — a Typical answer, never Live.
 *
 *   GET /v1/neighborhoods/:id/pulse
 *     A k-ANONYMOUS coarse aggregate of the neighborhood's privacy-eligible live
 *     crowd snapshots (lib/intelPulse). Thresholded (Table 28): withheld below the
 *     subject-count floor; never a per-subject or small-cohort row. The LIVE
 *     portion is additionally gated by liveLabelsServable + the pilot promotion
 *     (mayExposeLive semantics) — off ⇒ no live pulse.
 *
 * CONTRACT (§19): every response carries schema_version, source_label,
 * generated_at, and an ETag/state_version so a caller can revalidate; a matching
 * If-None-Match yields 304. Read APIs never return protected raw location proof.
 *
 * (Trail live-intel — GET /v1/trails/:id/live-intel — is unit I5's; not here.)
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { liveLabelsServable, resolvePlaceIntelState } from "../lib/liveClaimRead.js";
import { confidenceBand, mayCountAsConsensus } from "../lib/intelContracts.js";
import { sourceCountBucket } from "../lib/liveClaimRead.js";
import { computeNeighborhoodPulse, type PulseSnapshotInput } from "../lib/intelPulse.js";
import { shouldPrompt, PROMPT_THROTTLE_WINDOW_MS, type RecentObservation } from "../lib/intelThrottle.js";
import { logger } from "../lib/logger.js";

const router = Router();

const SCHEMA_VERSION = 1;
const MAX_PATTERNS = 5000;
const MAX_NEIGHBORHOOD_PLACES = 2000;
const MAX_SNAPSHOTS = 5000;

/** Weak ETag from a state-version token. */
function etagOf(stateVersion: string): string {
  return `W/"${stateVersion}"`;
}

/** If the client already has this version, answer 304 and return true. */
function notModified(req: any, res: any, etag: string): boolean {
  const inm = req.headers["if-none-match"];
  if (typeof inm === "string" && inm === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

/**
 * The §19 envelope's top-level `source_label` for a resolved state. It describes
 * WHAT KIND of answer the body is, and it is derived from the state the reader
 * returned — never asserted independently of it, so the label can never claim a
 * standing the claims do not have:
 *   live / emerging → 'consensus'          (independent first-hand observations)
 *   typical         → 'historical_pattern' (a §12 pattern — a Typical answer)
 *   unknown         → 'none'               (silence; the claims array is empty)
 * §37: 'portava_prediction' can never appear here — readLiveClaims drops any
 * class that mayRenderAsLive() rejects before it reaches an envelope, and a
 * pattern is labelled historical_pattern by readTypicalPatterns itself.
 */
function stateSourceLabel(state: "live" | "emerging" | "typical" | "unknown"): string {
  if (state === "typical") return "historical_pattern";
  if (state === "unknown") return "none";
  return "consensus";
}

/**
 * Resolve a merged place id to its surviving canonical id, exactly as
 * routes/placeLiving.ts (loadPlaceGroup) does before the SAME reader.
 *
 * The projection writes intel snapshots and §12 patterns for the CANONICAL
 * subject, so a request naming a merged-away place id resolves to no rows: the
 * alias would answer 'unknown' while the place card — which resolves first —
 * shows Live for the very same experience. That is precisely the disagreement
 * this route's header promises can never happen, so the resolution belongs
 * here, ahead of the reader, not inside it.
 *
 * One hop, like loadPlaceGroup: `merged_into_place_id` names the survivor, and
 * a survivor is not itself merged away. Fail-SAFE in every other case — a
 * missing row or a failed read falls back to the requested id, which can only
 * under-serve (state 'unknown'); it can never invent a subject or widen what is
 * exposed, and every privacy/flag gate still lives wholly in the reader.
 */
async function resolveSurvivorSubjectId(sc: any, placeId: string): Promise<string> {
  try {
    const { data, error } = await sc
      .from("places")
      .select("merged_into_place_id")
      .eq("id", placeId)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error, placeId }, "live-state: merge resolution read failed; using the requested id");
      return placeId;
    }
    const survivor = (data as any)?.merged_into_place_id;
    return typeof survivor === "string" && survivor.length > 0 ? survivor : placeId;
  } catch (err) {
    logger.warn({ err, placeId }, "live-state: merge resolution threw; using the requested id");
    return placeId;
  }
}

// ── GET /v1/experiences/:id/live-state ────────────────────────────────────────
// The spec-literal §19 read model. Delegates wholly to resolvePlaceIntelState —
// see the file header for why this is an alias and not a second reader.
router.get("/v1/experiences/:id/live-state", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "experience id (uuid) required");
  const sc = auth.client ?? getServiceClient();
  if (!sc) return sendError(res, "server_not_configured", "no client");

  const now = new Date();
  // Resolve a merged place id to its survivor FIRST — the place card does the
  // same before this very reader, and skipping it is the one way an alias that
  // adds no gates can still disagree with the card (see resolveSurvivorSubjectId).
  const subjectId = await resolveSurvivorSubjectId(sc, id.data);
  // ONE call. Every gate (flags, kill switch, pilot promotion, privacy_eligible,
  // TTL) and the degradation order Live → Emerging → Typical → Unknown are the
  // reader's; this route adds none of its own and can therefore never disagree
  // with the place card about whether something is live.
  const resolved = await resolvePlaceIntelState(sc, subjectId, { now });

  // state_version must change whenever the served SET changes — its size, its
  // standing, or the freshness of any member. validUntil is included because an
  // expiring claim changes the answer even when nothing was re-observed.
  let maxObservedMs = 0;
  let earliestValidUntil: string | null = null;
  for (const c of resolved.claims) {
    const o = Date.parse(c.observedAt);
    if (!Number.isNaN(o) && o > maxObservedMs) maxObservedMs = o;
    if (c.validUntil && (earliestValidUntil === null || c.validUntil < earliestValidUntil)) {
      earliestValidUntil = c.validUntil;
    }
  }
  // The resolved subject is part of the version: if this id is merged away after
  // a client cached the answer, the survivor's state may coincidentally have the
  // same shape, and a stale 304 would keep serving the wrong subject_id.
  const stateVersion = `${subjectId}:${resolved.state}:${resolved.claims.length}:${maxObservedMs || "-"}:${earliestValidUntil ?? "-"}`;
  const etag = etagOf(stateVersion);
  if (notModified(req, res, etag)) return;
  res.set("ETag", etag);

  res.json({
    schema_version: SCHEMA_VERSION,
    source_label: stateSourceLabel(resolved.state),
    // The CANONICAL subject the claims describe. For an unmerged place this is
    // the requested id; for a merged-away one it is the survivor, so the caller
    // can see which experience answered rather than being told the merged id
    // carries claims of its own.
    subject_id: subjectId,
    state: resolved.state,
    state_version: stateVersion,
    generated_at: now.toISOString(),
    // §19 "valid_until where operational" — the earliest horizon in the set, i.e.
    // when this answer first stops being wholly current. Null when there is none.
    valid_until: earliestValidUntil,
    claims: resolved.claims,
  });
}));

// ── GET /v1/experiences/:id/typical-patterns ──────────────────────────────────
router.get("/v1/experiences/:id/typical-patterns", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "experience id (uuid) required");
  const sc = auth.client ?? getServiceClient();
  if (!sc) return sendError(res, "server_not_configured", "no client");

  const { data, error } = await sc
    .from("intel_historical_patterns")
    .select("id, zone_id, claim_family, pattern_kind, time_band, dow, value_json, confidence, cohort_size, window_days, is_invalidation, computed_at, source_label")
    .eq("subject_id", id.data)
    .order("computed_at", { ascending: false })
    .limit(MAX_PATTERNS);
  if (error) { logger.warn({ err: error }, "typical-patterns read failed"); return sendError(res, "db_error", "pattern read failed"); }

  // Latest row per scope (append-only supersession); a tombstone that is latest
  // means "no typical pattern" for that scope.
  const seen = new Set<string>();
  const patterns: any[] = [];
  let maxComputedMs = 0;
  for (const row of (data as any[]) ?? []) {
    const scope = `${row.zone_id ?? ""}|${row.claim_family}|${row.pattern_kind}|${row.time_band}|${row.dow}`;
    if (seen.has(scope)) continue;
    seen.add(scope);
    const cms = Date.parse(String(row.computed_at));
    if (!Number.isNaN(cms) && cms > maxComputedMs) maxComputedMs = cms;
    if (row.is_invalidation === true) continue; // suppressed by superseding tombstone
    const confidence = typeof row.confidence === "number" ? row.confidence : null;
    patterns.push({
      claim_family: row.claim_family,
      pattern_kind: row.pattern_kind,
      time_band: row.time_band,
      dow: row.dow,
      value: row.value_json,
      confidence,
      band: confidenceBand(confidence),
      // A pattern is a many-contributor aggregate (consensus-eligible), so a coarse
      // cohort bucket is honest; the exact count stays withheld.
      cohort_bucket: mayCountAsConsensus("historical_pattern")
        ? sourceCountBucket(typeof row.cohort_size === "number" ? row.cohort_size : 0)
        : null,
      source_label: "historical_pattern",
    });
  }

  const stateVersion = `${patterns.length}:${maxComputedMs || "-"}`;
  const etag = etagOf(stateVersion);
  if (notModified(req, res, etag)) return;
  res.set("ETag", etag);
  res.json({
    schema_version: SCHEMA_VERSION,
    source_label: "historical_pattern",
    subject_id: id.data,
    state_version: stateVersion,
    generated_at: new Date().toISOString(),
    patterns,
  });
}));

// ── GET /v1/neighborhoods/:id/pulse ───────────────────────────────────────────
// :id is the neighborhood key matched against places.neighborhood.
router.get("/v1/neighborhoods/:id/pulse", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const neighborhood = z.string().min(1).max(200).safeParse(req.params.id);
  if (!neighborhood.success) return sendError(res, "invalid_payload", "neighborhood id required");
  const sc = auth.client ?? getServiceClient();
  if (!sc) return sendError(res, "server_not_configured", "no client");

  const generatedAt = new Date().toISOString();

  // The LIVE portion needs the global Live gates (flag chain + kill + pilot) — the
  // same mayExposeLive promotion gate the place read uses. Off ⇒ no live pulse.
  if (!(await liveLabelsServable(sc))) {
    const stateVersion = "0:-";
    const etag = etagOf(stateVersion);
    if (notModified(req, res, etag)) return;
    res.set("ETag", etag);
    return res.json({
      schema_version: SCHEMA_VERSION, source_label: "consensus", neighborhood: neighborhood.data,
      state_version: stateVersion, generated_at: generatedAt,
      pulse: { exposable: false, reason: "no_data", subjectCount: 0, levels: {} },
    });
  }

  // Resolve subjects (places) in the neighborhood.
  const { data: placeRows, error: placeErr } = await sc
    .from("places")
    .select("id")
    .eq("neighborhood", neighborhood.data)
    .limit(MAX_NEIGHBORHOOD_PLACES);
  if (placeErr) { logger.warn({ err: placeErr }, "pulse: place read failed"); return sendError(res, "db_error", "place read failed"); }
  const subjectIds = ((placeRows as any[]) ?? []).map((r) => String(r.id));

  let snapshots: PulseSnapshotInput[] = [];
  if (subjectIds.length > 0) {
    const now = new Date();
    const { data: snapData, error: snapErr } = await sc
      .from("intel_state_snapshots")
      .select("subject_id, claim_type, value, observed_at, privacy_eligible, expires_at")
      .in("subject_id", subjectIds)
      .eq("claim_type", "crowd.level")
      .eq("privacy_eligible", true)
      .gt("expires_at", now.toISOString())
      .limit(MAX_SNAPSHOTS);
    if (snapErr) { logger.warn({ err: snapErr }, "pulse: snapshot read failed"); return sendError(res, "db_error", "snapshot read failed"); }
    snapshots = ((snapData as any[]) ?? []).map((r) => ({
      subjectId: String(r.subject_id),
      claimType: String(r.claim_type),
      value: r.value,
      observedAt: String(r.observed_at),
    }));
  }

  const pulse = computeNeighborhoodPulse(snapshots);
  const etag = etagOf(pulse.stateVersion);
  if (notModified(req, res, etag)) return;
  res.set("ETag", etag);
  res.json({
    schema_version: SCHEMA_VERSION,
    source_label: "consensus",
    neighborhood: neighborhood.data,
    state_version: pulse.stateVersion,
    generated_at: generatedAt,
    pulse: {
      exposable: pulse.exposable,
      reason: pulse.reason,
      subjectCount: pulse.subjectCount,
      // Distribution only when exposable — never a per-subject or below-threshold row.
      levels: pulse.exposable ? pulse.levels : {},
    },
  });
}));

// ── GET /v1/intel/prompt-eligibility ──────────────────────────────────────────
// The PRODUCTION caller of lib/intelThrottle.shouldPrompt for the server-known
// signals (spec §6): the ≤1-unsolicited-prompt-per-45-min throttle (derived from
// this actor's recent intel_observations for the subject) and the fresh-qualifying-
// evidence gate (a live/emerging claim ⇒ no need to prompt). The CLIENT folds this
// with its own local gates — pause (session/category/permanent), Safe Return /
// emergency, and its own 45-minute throttle. Read-only; never writes an observation.
router.get("/v1/intel/prompt-eligibility", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const subjectId = z.string().uuid().safeParse(req.query.subjectId);
  if (!subjectId.success) return sendError(res, "invalid_payload", "subjectId (uuid) required");
  const followupRequired = req.query.followupRequired === "true" || req.query.followupRequired === "1";
  const sc = auth.client ?? getServiceClient();
  if (!sc) return sendError(res, "server_not_configured", "no client");

  const now = new Date();
  const windowIso = new Date(now.getTime() - PROMPT_THROTTLE_WINDOW_MS).toISOString();

  // This actor's recent observations for this subject — the "recent prompt" signal.
  const { data: obsData, error: obsErr } = await sc
    .from("intel_observations")
    .select("subject_id, observed_at")
    .eq("subject_id", subjectId.data)
    .eq("actor_id", auth.user.id)
    .gte("observed_at", windowIso);
  if (obsErr) { logger.warn({ err: obsErr }, "prompt-eligibility: observation read failed"); return sendError(res, "db_error", "observation read failed"); }
  const recentObservations: RecentObservation[] = ((obsData as any[]) ?? []).map((r) => ({
    subjectId: String(r.subject_id),
    observedAt: String(r.observed_at),
  }));

  // Fresh qualifying evidence = a live/emerging claim exists (typical/unknown do NOT
  // count — a prompt is exactly how a stale/absent live family gets refreshed).
  const resolved = await resolvePlaceIntelState(sc, subjectId.data, { now });
  const hasFreshQualifyingEvidence = resolved.state === "live" || resolved.state === "emerging";

  const decision = shouldPrompt({
    subjectId: subjectId.data,
    recentObservations,
    hasFreshQualifyingEvidence,
    now,
    state: { followupRequired },
  });

  res.json({
    schema_version: SCHEMA_VERSION,
    subject_id: subjectId.data,
    prompt: decision.prompt,
    reason: decision.reason,
    throttle_window_ms: PROMPT_THROTTLE_WINDOW_MS,
    generated_at: now.toISOString(),
  });
}));

export default router;
