/**
 * PresenceVerifier — Intelligence Gathering unit I3 (presence P2/P3/P4).
 *
 * Spec §7 Table 13 (the presence ladder) and Table 12 (the evidence matrix):
 *
 *   P1 coarse       device within neighbourhood / time window   (client-asserted,
 *                   the "unverified ceiling" IntelCaptureService clamps to)
 *   P2 experience   device within the EXPERIENCE GEOFENCE + a DWELL or
 *                   INTERACTION check
 *   P3 transaction  P2 + receipt / booking / entry evidence
 *   P4 assigned     P2/P3 + mission NONCE and contract
 *
 * This module answers ONE question for the capture path: "what level does the
 * SERVER-HELD evidence support for this capture?" It is consulted only when the
 * `intel_presence_verification_enabled` flag is on (the caller gates it; §30
 * Table 38 "presence off by default"). It never raises a level above what the
 * ladder allows — every rung REQUIRES the rung below it (P3 needs P2, P4 needs
 * P2/P3) — and the caller further caps the result at the level the client
 * claimed, so verification can only ever LOWER a claim, never inflate one.
 *
 * FAIL-CLOSED, EVERYWHERE: a thrown error, a DB error, a missing subject
 * coordinate, no device position, a stale or imprecise snapshot, a malformed
 * reference — each yields P1 with the refusal named in the evidence summary.
 * Nothing here can produce P2+ without a positive, server-verified check.
 *
 * WHERE THE DEVICE POSITION COMES FROM (documented per the unit brief): the
 * capture envelope (routes/intel.ts observationSchema → CaptureInput) carries NO
 * device coordinates — only presenceLevel / capturedAt / observedAt — and the
 * client attestation payload, when present, is provenance we RECORD but never
 * TRUST as a position (a client can type any coordinate). So the ONLY position
 * source is the server-held `location_snapshots` row the location-safety path
 * records (services/location/LocationSafetyService.checkAndRecordSnapshot):
 * the latest snapshot for the actor within ±POSITION_SLACK_MS of the capture
 * instant (captured_at, else observed_at). No snapshot in that window ⇒ no
 * position ⇒ P1.
 *
 * WHAT THE CLIENT ATTESTATION MAY CARRY (references, not trust):
 *   { receipt: { mediaAssetId } }          → P3 candidate (verified against media_assets)
 *   { mission: { missionId, nonce } }      → P4 candidate (verified against the HMAC digest)
 * Both are looked up server-side and every property that matters (ownership,
 * eligibility, window, contract, single-use) is checked here.
 *
 * PRIVACY: the evidence summary returned (and stored in
 * intel_presence_verifications) contains NO raw coordinate — only a distance
 * bucket, a dwell bucket, which methods held, refusal reasons and evidence
 * references (media asset id / mission id). Coordinates are consumed inside
 * this module and dropped.
 */
import { haversineKm } from "../../lib/mapSearch.js";
import { isEvidenceEligible } from "../../lib/media/mediaEvidenceEligibility.js";
import { verifyMissionNonce, isWellFormedMissionNonceToken } from "../../lib/intelMissionNonce.js";
import { CLAIM_TYPES, PRESENCE_LEVELS, type PresenceLevel } from "../../lib/intelContracts.js";

// ── Tunables (Phase-1 pilot values; §8 says thresholds are calibrated later) ──

/** Geofence radius per subject kind, metres. Fail-closed default for unknown kinds. */
export const GEOFENCE_RADIUS_M: Readonly<Record<string, number>> = {
  experience: 150,
  service: 150,
  event: 250,
  route: 300,
  zone: 400,
  neighborhood: 800,
};
export const DEFAULT_GEOFENCE_RADIUS_M = 150;

/** A snapshot less precise than this cannot place the device inside any pilot geofence. */
export const MAX_SNAPSHOT_ACCURACY_M = 250;

/** How far from the capture instant the position snapshot may be (±2 minutes). */
export const POSITION_SLACK_MS = 2 * 60_000;

/** Dwell: an earlier in-geofence fix at least this long before capture … */
export const DWELL_MIN_MS = 10 * 60_000;
/** … and no earlier than this before capture (a fix from last week is not dwell). */
export const DWELL_WINDOW_MS = 3 * 60 * 60_000;

/** Interaction: a save / wishlist within this long BEFORE capture … */
export const INTERACTION_WINDOW_MS = 24 * 60 * 60_000;
/** … or up to this long after it (clock skew between save and capture). */
export const INTERACTION_FUTURE_SLACK_MS = 60_000;
/** A plan stop whose scheduled time is within ± this of capture counts. */
export const PLAN_STOP_WINDOW_MS = 12 * 60 * 60_000;

/** Receipt media may be captured up to this long AFTER the observation instant. */
export const RECEIPT_FUTURE_SLACK_MS = 60_000;

/** Upper bound on rows scanned per dwell/interaction query. */
export const SCAN_LIMIT = 50;

export type PresenceMethod = "geofence" | "dwell" | "interaction" | "receipt" | "mission_nonce";
export const PRESENCE_METHODS: readonly PresenceMethod[] = ["geofence", "dwell", "interaction", "receipt", "mission_nonce"];

export type DistanceBucket = "within_50m" | "within_150m" | "within_400m" | "within_1km" | "beyond_1km";
export type DwellBucket = "10_to_30m" | "30_to_90m" | "over_90m";
export type GeofenceVerdict =
  | "inside"
  | "outside"
  | "no_position"
  | "imprecise"
  | "no_subject_coordinates"
  | "invalid_capture_time"
  | "error";

export interface PresenceEvidenceSummary {
  /** Where the device position came from. */
  positionSource: "location_snapshot" | "none";
  geofence: GeofenceVerdict;
  distanceBucket?: DistanceBucket;
  radiusMeters?: number;
  dwell?: { held: boolean; bucket?: DwellBucket; source?: "location_snapshots" | "prior_observation" };
  interaction?: { held: boolean; kind?: "save" | "wishlist" | "plan_stop" };
  receipt?: { held: boolean; mediaAssetId?: string; reason?: string };
  mission?: { held: boolean; missionId?: string; reason?: string };
  /** Every method that held, in ladder order. */
  methods: PresenceMethod[];
  /** Why a rung was refused, in the order the checks ran. */
  refusals: string[];
  /** Present only when the verifier itself failed (→ P1). Message only, never data. */
  error?: string;
}

export interface PresenceVerificationOutcome {
  /** The level the server-held evidence supports. P1 when nothing holds. */
  level: PresenceLevel;
  /** The decisive method — the strongest one that established `level`. null ⇒ clamped. */
  method: PresenceMethod | null;
  evidence: PresenceEvidenceSummary;
}

export interface PresenceVerificationRequest {
  actorId: string;
  subjectId: string;
  subjectKind: string;
  claimType: string;
  /** Server-clamped ISO observed_at. */
  observedAt: string;
  /** Client capture time (ISO) or null → observedAt is the capture instant. */
  capturedAt: string | null;
  /** The level the client asked for; rungs above it are not even attempted. */
  claimedLevel: PresenceLevel;
  /** The client attestation payload — references only (see module banner). */
  attestation: Record<string, unknown> | null | undefined;
  /** Injectable clock. */
  now?: Date;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const rank = (l: PresenceLevel) => PRESENCE_LEVELS.indexOf(l);
const UNVERIFIED: PresenceLevel = "P1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function toMs(v: unknown): number | null {
  if (v == null) return null;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? t : null;
}
const iso = (ms: number) => new Date(ms).toISOString();

export function distanceBucket(metres: number): DistanceBucket {
  if (metres <= 50) return "within_50m";
  if (metres <= 150) return "within_150m";
  if (metres <= 400) return "within_400m";
  if (metres <= 1000) return "within_1km";
  return "beyond_1km";
}

export function dwellBucket(ms: number): DwellBucket {
  if (ms < 30 * 60_000) return "10_to_30m";
  if (ms < 90 * 60_000) return "30_to_90m";
  return "over_90m";
}

export function geofenceRadiusFor(subjectKind: string): number {
  return GEOFENCE_RADIUS_M[subjectKind] ?? DEFAULT_GEOFENCE_RADIUS_M;
}

function finiteCoord(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = typeof lat === "number" ? lat : Number(lat);
  const ln = typeof lng === "number" ? lng : Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln };
}

function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
}

/** Does `claimType` fall under the mission's `claim_family` (exact or family prefix)? */
export function claimMatchesFamily(claimType: string, family: unknown): boolean {
  if (typeof family !== "string" || family.length === 0) return false;
  return claimType === family || claimType.startsWith(`${family}.`);
}

function ttlSecondsFor(claimType: string): number | null {
  const spec = CLAIM_TYPES.find((c) => c.claimType === claimType);
  return spec ? spec.ttlSeconds : null;
}

/** Pull `{ receipt, mission }` references out of a client attestation; anything malformed → undefined. */
function references(att: Record<string, unknown> | null | undefined): {
  receipt?: { mediaAssetId: string };
  mission?: { missionId: string; nonce: string };
} {
  if (!att || typeof att !== "object") return {};
  const out: { receipt?: { mediaAssetId: string }; mission?: { missionId: string; nonce: string } } = {};
  const r = (att as any).receipt;
  if (r && typeof r === "object" && isUuid(r.mediaAssetId)) out.receipt = { mediaAssetId: r.mediaAssetId };
  const m = (att as any).mission;
  if (m && typeof m === "object" && isUuid(m.missionId) && isWellFormedMissionNonceToken(m.nonce)) {
    out.mission = { missionId: m.missionId, nonce: m.nonce };
  }
  return out;
}

// ── Evidence checks (each fail-closed; each throws only on a DB error) ────────

async function loadSubjectCoordinates(sc: any, subjectId: string): Promise<{ lat: number; lng: number } | null> {
  const { data, error } = await sc.from("places").select("latitude, longitude").eq("id", subjectId).maybeSingle();
  if (error) throw new Error(`places read failed: ${String((error as any).message ?? "")}`);
  if (!data) return null;
  return finiteCoord((data as any).latitude, (data as any).longitude);
}

interface Fix { lat: number; lng: number; accuracy: number | null; atMs: number }

function fixFromSnapshot(row: any): Fix | null {
  const c = finiteCoord(row?.lat, row?.lng);
  const at = toMs(row?.captured_at);
  if (!c || at == null) return null;
  const acc = row?.accuracy_meters == null ? null : Number(row.accuracy_meters);
  return { ...c, accuracy: acc != null && Number.isFinite(acc) ? acc : null, atMs: at };
}

const preciseEnough = (f: Fix) => f.accuracy == null || f.accuracy <= MAX_SNAPSHOT_ACCURACY_M;

/** The latest server-held device fix within ±POSITION_SLACK_MS of the capture instant. */
async function loadDevicePosition(sc: any, actorId: string, captureMs: number): Promise<Fix | null> {
  const { data, error } = await sc
    .from("location_snapshots")
    .select("lat, lng, accuracy_meters, captured_at")
    .eq("user_id", actorId)
    .gte("captured_at", iso(captureMs - POSITION_SLACK_MS))
    .lte("captured_at", iso(captureMs + POSITION_SLACK_MS))
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`location_snapshots read failed: ${String((error as any).message ?? "")}`);
  return data ? fixFromSnapshot(data) : null;
}

/**
 * Dwell: evidence the device was ALREADY inside the geofence at least
 * DWELL_MIN_MS before capture (and within DWELL_WINDOW_MS). Two sources:
 *   (a) an earlier location_snapshot inside the geofence;
 *   (b) an earlier observation by the same actor at the same subject whose OWN
 *       verification put the device inside the geofence (presence_attestation
 *       .verifier.geofence === "inside" — server-written, never client-set).
 */
async function checkDwell(
  sc: any, req: PresenceVerificationRequest, subject: { lat: number; lng: number }, radiusM: number, captureMs: number,
): Promise<NonNullable<PresenceEvidenceSummary["dwell"]>> {
  const fromIso = iso(captureMs - DWELL_WINDOW_MS);
  const untilIso = iso(captureMs - DWELL_MIN_MS);

  const { data: snaps, error: snapErr } = await sc
    .from("location_snapshots")
    .select("lat, lng, accuracy_meters, captured_at")
    .eq("user_id", req.actorId)
    .gte("captured_at", fromIso)
    .lte("captured_at", untilIso)
    .order("captured_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (snapErr) throw new Error(`location_snapshots dwell read failed: ${String((snapErr as any).message ?? "")}`);
  for (const row of (snaps as any[]) ?? []) {
    const fix = fixFromSnapshot(row);
    if (!fix || !preciseEnough(fix)) continue;
    if (distanceM(fix, subject) <= radiusM) {
      return { held: true, bucket: dwellBucket(captureMs - fix.atMs), source: "location_snapshots" };
    }
  }

  const { data: priors, error: priorErr } = await sc
    .from("intel_observations")
    .select("observed_at, presence_attestation")
    .eq("actor_id", req.actorId)
    .eq("subject_id", req.subjectId)
    .gte("observed_at", fromIso)
    .lte("observed_at", untilIso)
    .order("observed_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (priorErr) throw new Error(`intel_observations dwell read failed: ${String((priorErr as any).message ?? "")}`);
  for (const row of (priors as any[]) ?? []) {
    const verifier = row?.presence_attestation?.verifier;
    const at = toMs(row?.observed_at);
    if (verifier && verifier.geofence === "inside" && at != null) {
      return { held: true, bucket: dwellBucket(captureMs - at), source: "prior_observation" };
    }
  }
  return { held: false };
}

/**
 * Interaction: a recent save / wishlist / plan stop AT THIS SUBJECT by this
 * actor. (Event RSVPs are not linkable — `events` carries no place_id — and
 * there is no place-level check-in table; plan_checkins are geofence-keyed.)
 */
async function checkInteraction(
  sc: any, req: PresenceVerificationRequest, captureMs: number,
): Promise<NonNullable<PresenceEvidenceSummary["interaction"]>> {
  const fromIso = iso(captureMs - INTERACTION_WINDOW_MS);
  const untilIso = iso(captureMs + INTERACTION_FUTURE_SLACK_MS);

  const { data: saves, error: saveErr } = await sc
    .from("saved_places")
    .select("saved_at")
    .eq("user_id", req.actorId)
    .eq("place_id", req.subjectId)
    .gte("saved_at", fromIso)
    .lte("saved_at", untilIso)
    .limit(1);
  if (saveErr) throw new Error(`saved_places read failed: ${String((saveErr as any).message ?? "")}`);
  if (Array.isArray(saves) && saves.length > 0) return { held: true, kind: "save" };

  const { data: wishes, error: wishErr } = await sc
    .from("wishlist_places")
    .select("saved_at")
    .eq("user_id", req.actorId)
    .eq("place_id", req.subjectId)
    .gte("saved_at", fromIso)
    .lte("saved_at", untilIso)
    .limit(1);
  if (wishErr) throw new Error(`wishlist_places read failed: ${String((wishErr as any).message ?? "")}`);
  if (Array.isArray(wishes) && wishes.length > 0) return { held: true, kind: "wishlist" };

  const { data: stops, error: stopErr } = await sc
    .from("trip_plan_items")
    .select("starts_at, created_at, creator_id, added_by")
    .eq("source_type", "place")
    .eq("source_id", req.subjectId)
    .is("removed_at", null)
    .or(`creator_id.eq.${req.actorId},added_by.eq.${req.actorId}`)
    .limit(SCAN_LIMIT);
  if (stopErr) throw new Error(`trip_plan_items read failed: ${String((stopErr as any).message ?? "")}`);
  for (const s of (stops as any[]) ?? []) {
    // Defence in depth: re-check actor ownership in code, not only in the filter.
    if (s?.creator_id !== req.actorId && s?.added_by !== req.actorId) continue;
    const starts = toMs(s?.starts_at);
    if (starts != null) {
      if (Math.abs(starts - captureMs) <= PLAN_STOP_WINDOW_MS) return { held: true, kind: "plan_stop" };
      continue;
    }
    const created = toMs(s?.created_at);
    if (created != null && created >= captureMs - INTERACTION_WINDOW_MS && created <= captureMs + INTERACTION_FUTURE_SLACK_MS) {
      return { held: true, kind: "plan_stop" };
    }
  }
  return { held: false };
}

/**
 * Receipt (P3): a media asset the ACTOR OWNS, ready, not moderation-blocked,
 * not private (Appendix B: private/blocked/processing/failed/removed media fail
 * closed), captured inside the observation window [observed_at − claim TTL,
 * observed_at + slack], and §35 evidence-eligible (lib/media/mediaEvidenceEligibility).
 */
async function checkReceipt(
  sc: any, req: PresenceVerificationRequest, mediaAssetId: string, observedMs: number, nowMs: number,
): Promise<NonNullable<PresenceEvidenceSummary["receipt"]>> {
  const refuse = (reason: string) => ({ held: false, mediaAssetId, reason });
  const { data: asset, error } = await sc
    .from("media_assets")
    .select("id, owner_user_id, source_type, provenance, captured_at, moderation_status, processing_status, visibility")
    .eq("id", mediaAssetId)
    .maybeSingle();
  if (error) throw new Error(`media_assets read failed: ${String((error as any).message ?? "")}`);
  if (!asset) return refuse("not_found");
  if ((asset as any).owner_user_id !== req.actorId) return refuse("not_owner");
  if ((asset as any).processing_status !== "ready") return refuse("not_ready");
  if (!["pending", "approved"].includes(String((asset as any).moderation_status))) return refuse("moderation_blocked");
  if ((asset as any).visibility === "private") return refuse("media_private");

  const prov = (asset as any).provenance;
  const capturedAt = (prov && typeof prov === "object" && typeof prov.capturedAt === "string" ? prov.capturedAt : null)
    ?? (asset as any).captured_at ?? null;
  const capMs = toMs(capturedAt);
  if (capMs == null) return refuse("no_capture_time");
  const ttl = ttlSecondsFor(req.claimType);
  if (ttl == null) return refuse("unknown_claim_ttl");
  if (capMs < observedMs - ttl * 1000 || capMs > observedMs + RECEIPT_FUTURE_SLACK_MS) return refuse("outside_window");

  if (!isEvidenceEligible({ ...(asset as any), now: nowMs })) return refuse("ineligible");
  return { held: true, mediaAssetId };
}

/**
 * Mission nonce (P4): the mission must be ACCEPTED BY THIS ACTOR, name THIS
 * SUBJECT, contract THIS CLAIM FAMILY, be within its deadline, hold a nonce
 * digest that the presented token reproduces, and be UNCONSUMED — then it is
 * consumed with a compare-and-set so a replay fails closed.
 */
async function checkMission(
  sc: any, req: PresenceVerificationRequest, missionId: string, token: string, captureMs: number, nowMs: number,
): Promise<NonNullable<PresenceEvidenceSummary["mission"]>> {
  const refuse = (reason: string) => ({ held: false, missionId, reason });
  const { data: mission, error } = await sc
    .from("intel_mission_candidates")
    .select("id, status, accepted_by, subject_id, claim_family, deadline, nonce, nonce_consumed_at")
    .eq("id", missionId)
    .maybeSingle();
  if (error) throw new Error(`intel_mission_candidates read failed: ${String((error as any).message ?? "")}`);
  if (!mission) return refuse("not_found");
  const m = mission as any;
  if (m.status !== "accepted") return refuse("not_accepted");
  if (m.accepted_by !== req.actorId) return refuse("not_assignee");
  if (!m.subject_id || m.subject_id !== req.subjectId) return refuse("subject_mismatch");
  if (!claimMatchesFamily(req.claimType, m.claim_family)) return refuse("contract_mismatch");
  const deadline = toMs(m.deadline);
  if (deadline != null && captureMs > deadline) return refuse("expired");
  if (!m.nonce) return refuse("no_nonce");
  if (m.nonce_consumed_at) return refuse("replayed");
  if (!verifyMissionNonce(missionId, req.actorId, token, m.nonce)) return refuse("forged");

  // Single-use: claim the nonce atomically. Zero rows ⇒ someone else consumed
  // it between our read and this write ⇒ treat as a replay.
  const { data: claimed, error: casErr } = await sc
    .from("intel_mission_candidates")
    .update({ nonce_consumed_at: iso(nowMs), updated_at: iso(nowMs) })
    .eq("id", missionId)
    .is("nonce_consumed_at", null)
    .select("id");
  if (casErr) throw new Error(`nonce consume failed: ${String((casErr as any).message ?? "")}`);
  if (!Array.isArray(claimed) || claimed.length !== 1) return refuse("replayed");
  return { held: true, missionId };
}

// ── The verifier ─────────────────────────────────────────────────────────────

/**
 * verifyPresence — what level does the server-held evidence support?
 * NEVER throws: any failure is P1 with `evidence.error` set (fail-closed).
 */
export async function verifyPresence(sc: any, req: PresenceVerificationRequest): Promise<PresenceVerificationOutcome> {
  const evidence: PresenceEvidenceSummary = { positionSource: "none", geofence: "error", methods: [], refusals: [] };
  const clamp = (method: PresenceMethod | null = null): PresenceVerificationOutcome => ({ level: UNVERIFIED, method, evidence });

  try {
    const nowMs = (req.now ?? new Date()).getTime();
    const observedMs = toMs(req.observedAt);
    const captureMs = toMs(req.capturedAt) ?? observedMs;
    if (observedMs == null || captureMs == null) {
      evidence.geofence = "invalid_capture_time";
      evidence.refusals.push("invalid_capture_time");
      return clamp();
    }

    // ── Rung P2, part 1: geofence ──────────────────────────────────────────
    const subject = await loadSubjectCoordinates(sc, req.subjectId);
    if (!subject) {
      evidence.geofence = "no_subject_coordinates";
      evidence.refusals.push("no_subject_coordinates");
      return clamp();
    }
    const radiusM = geofenceRadiusFor(req.subjectKind);
    evidence.radiusMeters = radiusM;

    const fix = await loadDevicePosition(sc, req.actorId, captureMs);
    if (!fix) {
      evidence.geofence = "no_position";
      evidence.refusals.push("no_position_within_window");
      return clamp();
    }
    evidence.positionSource = "location_snapshot";
    if (!preciseEnough(fix)) {
      evidence.geofence = "imprecise";
      evidence.refusals.push("snapshot_imprecise");
      return clamp();
    }
    const dist = distanceM(fix, subject);
    evidence.distanceBucket = distanceBucket(dist);
    if (dist > radiusM) {
      evidence.geofence = "outside";
      evidence.refusals.push("outside_geofence");
      return clamp();
    }
    evidence.geofence = "inside";
    evidence.methods.push("geofence");

    // ── Rung P2, part 2: dwell OR interaction ──────────────────────────────
    evidence.dwell = await checkDwell(sc, req, subject, radiusM, captureMs);
    if (evidence.dwell.held) {
      evidence.methods.push("dwell");
    } else {
      evidence.interaction = await checkInteraction(sc, req, captureMs);
      if (evidence.interaction.held) evidence.methods.push("interaction");
    }
    if (!evidence.dwell.held && !evidence.interaction?.held) {
      evidence.refusals.push("no_dwell_or_interaction");
      return clamp(); // geofence alone is not P2 (Table 13)
    }
    let level: PresenceLevel = "P2";
    let method: PresenceMethod = evidence.dwell.held ? "dwell" : "interaction";

    // Rungs above the CLAIMED level are not attempted: a P2 claim must not spend
    // a mission nonce or examine a receipt it did not offer.
    const refs = references(req.attestation);

    // ── Rung P3: receipt ───────────────────────────────────────────────────
    if (rank(req.claimedLevel) >= rank("P3")) {
      if (refs.receipt) {
        evidence.receipt = await checkReceipt(sc, req, refs.receipt.mediaAssetId, observedMs, nowMs);
        if (evidence.receipt.held) {
          evidence.methods.push("receipt");
          level = "P3";
          method = "receipt";
        } else {
          evidence.refusals.push(`receipt:${evidence.receipt.reason ?? "refused"}`);
        }
      } else {
        evidence.refusals.push("receipt:no_reference");
      }
    }

    // ── Rung P4: mission nonce (needs P2 or P3, which we have) ─────────────
    if (rank(req.claimedLevel) >= rank("P4")) {
      if (refs.mission) {
        evidence.mission = await checkMission(sc, req, refs.mission.missionId, refs.mission.nonce, captureMs, nowMs);
        if (evidence.mission.held) {
          evidence.methods.push("mission_nonce");
          level = "P4";
          method = "mission_nonce";
        } else {
          evidence.refusals.push(`mission:${evidence.mission.reason ?? "refused"}`);
        }
      } else {
        evidence.refusals.push("mission:no_reference");
      }
    }

    return { level, method, evidence };
  } catch (err) {
    evidence.geofence = evidence.geofence === "inside" ? "inside" : "error";
    evidence.error = err instanceof Error ? err.message : String(err);
    evidence.refusals.push("verifier_error");
    // A thrown error anywhere on the ladder is a full clamp — even if a lower
    // rung had already held. Fail closed, never partial.
    evidence.methods = [];
    return { level: UNVERIFIED, method: null, evidence };
  }
}
