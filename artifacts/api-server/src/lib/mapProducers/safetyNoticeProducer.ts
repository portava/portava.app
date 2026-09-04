/**
 * safetyNoticeProducer — the `safety_notice` kind (Map spec §5 "Safety and
 * active navigation always take visual precedence", §6 "Shield = Safety
 * context", §20 "Safety owns safety state", §24 "Safety and access warnings
 * take precedence over activity ranking").
 *
 * THE CANONICAL SAFETY SOURCE — AND THE ONE THAT IS NOT
 * =====================================================
 * A search of the schema for a safety notice / alert / advisory table finds
 * none. What the repository DOES hold is one server-owned safety CLAIM:
 * lib/intelContracts SPECIALIST_ONLY_CROWD_LEVELS — `crowd.level =
 * unsafe_density`, "a safety claim, not a vibe: specialist review only". It is
 * unreachable from every contributor surface (lib/quickSignal refuses to emit
 * it, routes/mapObservations collapses it out of the contributor vocabulary),
 * so a snapshot carrying it can only have come through specialist review and
 * lib/intelProjection — the sole writer of intel_state_snapshots — with the
 * privacy gate passed. lib/mapProjection deliberately maps it to NO activity
 * level ("rendering a dangerous crush as 'Peak' would advertise it as the
 * place to go") and records that "a real safety surface for it is owed". This
 * is that surface.
 *
 * `protected_zones` (migration 2217) IS NOT A SAFETY SOURCE AND IS NOT READ
 * HERE. Its categories are private_residence / medical_facility / shelter /
 * sensitive_government / policy_defined — the places §24 says to HIDE, whose
 * row list "is itself a map of exactly what it protects" and which "must never
 * appear in an API response". Projecting those rows as safety notices would
 * publish, at RENDERING_PRIORITY.safety and exempt from the protection gate,
 * the very locations the table exists to withhold. So the fallback the sweep
 * brief allowed ("project protected_locations safety-category rows") is
 * refused on purpose, and this producer reads the specialist-reviewed claim
 * instead.
 *
 * WHAT A NOTICE CARRIES, AND WHAT IT MUST NOT
 * ==========================================
 * The place, the claim, its band, its observation time and its expiry. NO
 * presence payload: no cohort size, no `count`, no actor-derived field — the
 * `safety_notice` exemption in lib/protectedLocations rests on exactly that
 * ("they carry no presence payload"), and dataRights marks `distinct_actors`
 * restricted, so it is never selected. `source_count` is never selected either:
 * a safety notice is not a consensus badge.
 *
 * GATES. lib/liveClaimRead.liveLabelsServable — the flag chain (capture →
 * projection → live label), the `disable_intel_live_labels` emergency stop and
 * the IG-09 master switch — is the ONE global answer to "may live intelligence
 * be served at all", and this read consults it first. What it does NOT apply
 * is the per-scope pilot allowlist (intel_live_promoted_scopes): that gate
 * decides which venues may show a crowd LABEL in the pilot, and a specialist-
 * reviewed safety claim held back because its venue is not in a marketing pilot
 * is the "silently removed safety notice" §5 forbids. Then, per snapshot:
 * `privacy_eligible = true` (the projection's own gate) and unexpired.
 *
 * `place_level` rung: the subject is a public venue, not a person.
 */
import { liveLabelsServable } from "../liveClaimRead.js";
import { SPECIALIST_ONLY_CROWD_LEVELS, confidenceBand } from "../intelContracts.js";
import {
  KIND_DEFAULT_PRIORITY,
  deriveFreshness,
  point,
  type MapObject,
  type PrivacyClass,
} from "../mapObjects.js";
import type { BBox } from "../mapAggregation.js";

export const SAFETY_NOTICE_PRIVACY_CLASS: PrivacyClass = "place_level";

/** The claim type and value that constitute a safety notice today. */
export const SAFETY_CLAIM_TYPE = "crowd.level";
export const SAFETY_CLAIM_LEVEL = "unsafe_density";

/** Bounded: specialist-reviewed safety claims are rare by construction. */
const MAX_SAFETY_SNAPSHOT_ROWS = 200;

/** The intel_state_snapshots columns this producer reads. Never distinct_actors. */
export interface SafetySnapshotLike {
  id: string;
  subject_id: string;
  zone_id?: string | null;
  claim_type: string;
  value: unknown;
  confidence?: number | null;
  observed_at: string;
  expires_at: string;
  privacy_eligible?: boolean | null;
}

/** The places columns this producer reads. */
export interface SafetyPlaceLike {
  id: string;
  name?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  status?: string | null;
  merged_into_place_id?: string | null;
}

/** Is this snapshot the safety claim? Checked in code even though the query filters — defence in depth. */
export function isSafetyClaim(row: SafetySnapshotLike | null | undefined): boolean {
  if (!row || row.claim_type !== SAFETY_CLAIM_TYPE) return false;
  const v = row.value;
  const level = typeof v === "string" ? v : v && typeof v === "object" ? (v as any).level : null;
  return typeof level === "string" && level === SAFETY_CLAIM_LEVEL &&
    (SPECIALIST_ONLY_CROWD_LEVELS as readonly string[]).includes(level);
}

/**
 * Project one safety snapshot onto its place. Pure. Returns null when the row
 * is not a publishable safety claim, is expired, or the place cannot be drawn.
 */
export function projectSafetyNotice(
  row: SafetySnapshotLike,
  place: SafetyPlaceLike,
  opts: { now: number },
): MapObject | null {
  if (!isSafetyClaim(row)) return null;
  if (row.privacy_eligible !== true) return null;
  const expiresMs = new Date(String(row.expires_at)).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= opts.now) return null;
  if (!place || place.status === undefined ? false : place.status !== "active") return null;
  if (place.merged_into_place_id != null) return null;
  const lat = place.latitude;
  const lng = place.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const band = confidenceBand(typeof row.confidence === "number" ? row.confidence : null);
  const observedAt = new Date(String(row.observed_at));
  const observedIso = Number.isFinite(observedAt.getTime()) ? observedAt.toISOString() : undefined;
  const expiresIso = new Date(expiresMs).toISOString();
  const placeName = place.name && String(place.name).trim() !== "" ? String(place.name) : "This place";

  return {
    id: `safety:${row.id}`,
    kind: "safety_notice",
    geometry: point(lat, lng),
    title: "Unsafe crowd density reported",
    subtitle: [placeName, place.city].filter((s) => s && String(s).trim() !== "").join(" · ") || undefined,
    observedAt: observedIso,
    expiresAt: expiresIso,
    freshness: deriveFreshness(observedIso, expiresIso, opts.now),
    confidence: band,
    // No sourceClass: the snapshot records no speaker, and this producer will
    // not invent one. The §9 line says what the claim is and who reviewed it.
    sourceRefs: [row.id],
    provenance: {
      lines: [{ text: `Specialist-reviewed safety claim · ${SAFETY_CLAIM_TYPE}`, ref: row.id }],
      confidence: band,
      updatedAt: observedIso,
    },
    privacyClass: SAFETY_NOTICE_PRIVACY_CLASS,
    // §5 / §24 / §31: the top of the ladder.
    renderingPriority: KIND_DEFAULT_PRIORITY.safety_notice,
    interaction: {
      actions: ["view", "ask_compass"],
      opensSheet: true,
    },
    // NO count, NO cohort, NO actor-derived field — see the header.
    payload: {
      placeId: place.id,
      claimType: SAFETY_CLAIM_TYPE,
      level: SAFETY_CLAIM_LEVEL,
      zoneId: row.zone_id && row.zone_id !== "" ? row.zone_id : null,
      band,
    },
  };
}

export interface SafetyNoticeReport {
  /** Current, privacy-eligible safety snapshots read. */
  snapshots: number;
  /** Snapshots whose place is outside the viewport, inactive, merged or unplaceable. */
  unplaced: number;
}

export type SafetyNoticeReadResult =
  | { ok: true; notices: MapObject[]; report: SafetyNoticeReport }
  | { ok: false; reason: "live_gates_closed" | "snapshot_read_failed" | "places_read_failed" };

/**
 * Read the current safety notices inside a viewport. The ONE privacy-complete
 * safety read for the map; routes/mapProjection.ts is its only approved caller
 * (src/test/gatewayBypassGuard.test.ts).
 */
export async function readSafetyNotices(
  sc: any,
  opts: { bbox: BBox; now: number },
): Promise<SafetyNoticeReadResult> {
  if (!(await liveLabelsServable(sc))) return { ok: false, reason: "live_gates_closed" };

  const nowIso = new Date(opts.now).toISOString();
  const { data, error } = await sc
    .from("intel_state_snapshots")
    .select("id, subject_id, zone_id, claim_type, value, confidence, observed_at, expires_at, privacy_eligible")
    .eq("claim_type", SAFETY_CLAIM_TYPE)
    .eq("privacy_eligible", true)
    .gt("expires_at", nowIso)
    .contains("value", { level: SAFETY_CLAIM_LEVEL })
    .limit(MAX_SAFETY_SNAPSHOT_ROWS);
  if (error || !Array.isArray(data)) return { ok: false, reason: "snapshot_read_failed" };

  const rows = (data as SafetySnapshotLike[]).filter((r) => isSafetyClaim(r) && r.privacy_eligible === true);
  const report: SafetyNoticeReport = { snapshots: rows.length, unplaced: 0 };
  if (rows.length === 0) return { ok: true, notices: [], report };

  const subjectIds = [...new Set(rows.map((r) => String(r.subject_id)))];
  const { bbox } = opts;
  const { data: placeRows, error: placeErr } = await sc
    .from("places")
    .select("id, name, city, latitude, longitude, status, merged_into_place_id")
    .in("id", subjectIds)
    .eq("status", "active")
    .is("merged_into_place_id", null)
    .gte("latitude", bbox.south)
    .lte("latitude", bbox.north)
    .gte("longitude", bbox.west)
    .lte("longitude", bbox.east);
  if (placeErr || !Array.isArray(placeRows)) return { ok: false, reason: "places_read_failed" };

  const byId = new Map<string, SafetyPlaceLike>();
  for (const p of placeRows as SafetyPlaceLike[]) if (p && typeof p.id === "string") byId.set(p.id, p);

  const notices: MapObject[] = [];
  for (const row of rows) {
    const place = byId.get(String(row.subject_id));
    const obj = place ? projectSafetyNotice(row, place, { now: opts.now }) : null;
    if (!obj) { report.unplaced += 1; continue; }
    notices.push(obj);
  }
  return { ok: true, notices, report };
}
