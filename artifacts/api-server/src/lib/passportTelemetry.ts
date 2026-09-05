/**
 * passportTelemetry — the write side of the Passport §32 telemetry sink
 * (migration 2287, table public.passport_telemetry_events).
 *
 * WHAT IT DOES
 * ============
 * recordPassportEvent() inserts a §32 Passport telemetry event through the
 * service client. Fire-and-forget: call WITHOUT `await`, only after the work it
 * describes has committed. It NEVER throws — an instrumentation failure must not
 * break a request or an award. Insert failures are logged, not swallowed.
 *
 * THREE SAFETY MECHANISMS ON EVERY EVENT
 * ======================================
 *   1. FLAG GATE (fail-closed). Nothing is written unless
 *      `passport_telemetry_enabled` reads true; isFlagEnabled returns false on any
 *      error, so a partially-configured rollout collects nothing.
 *   2. EVENT PROJECTION. Only the §32 event names are accepted — an unknown name
 *      is dropped before insert (and the table's CHECK would reject it anyway).
 *   3. PAYLOAD SANITIZER. The payload is (a) stripped of coordinate- and
 *      contact/identity-shaped keys at every depth and (b) projected to an
 *      allow-list of known-safe context keys. A key that is neither is dropped —
 *      the same posture as canonicalEvents/mediaAnalytics, and it mirrors the
 *      passport_telemetry_payload_is_clean CHECK the DB enforces as a backstop.
 *
 * There is NO top-level user column (the table is modelled on media_events): the
 * pseudonymous actor/subject ride inside the allow-listed payload.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { logger } from "./logger.js";

/** Capability flag (seeded OFF by migration 2287). */
export const PASSPORT_TELEMETRY_FLAG = "passport_telemetry_enabled";

/** The §32 Passport telemetry event names. Mirrors the CHECK in migration 2287. */
export const PASSPORT_TELEMETRY_EVENTS = [
  "passport_viewed",
  "passport_shared",
  "passport_qr_scanned",
  "availability_set",
  "availability_expired",
  "open_to_plans_enabled",
  "stamp_issued",
  "stamp_verified",
  "stamp_viewed",
  "trust_summary_viewed",
  "shared_context_viewed",
  "make_plan_started",
  "journey_viewed",
  "memory_viewed",
  "my_world_opened",
  "follow_from_passport",
  "message_from_passport",
  "trip_invite_from_passport",
] as const;

export type PassportTelemetryEvent = (typeof PASSPORT_TELEMETRY_EVENTS)[number];

const EVENT_SET = new Set<string>(PASSPORT_TELEMETRY_EVENTS);

/**
 * Coordinate- and contact/identity-shaped key fragments, matched
 * case-insensitively as substrings at ANY depth. Deliberately mirrors the
 * database CHECK (passport_telemetry_payload_is_clean); the duplication is the
 * point — this side must hold even if a caller bypasses the DB constraint.
 */
export const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  "lat", "lng", "lon", "coord", "geometry", "geohash", "bbox", "altitude",
  "accuracy", "heading", "bearing", "street", "postcode", "address",
  "email", "phone", "avatar", "display_name", "username", "device_id", "push_token",
];

function keyIsForbidden(key: string): boolean {
  const k = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

/**
 * Allow-list of payload context keys that may be persisted. Neutral,
 * pseudonymous descriptors — the same shape media_events keeps in its payload.
 * A key outside this set (or matching a forbidden fragment) is dropped.
 */
export const ALLOWED_PAYLOAD_KEYS = [
  "actor_id",             // pseudonymous user id — the stamp owner / event subject
  "subject_id",           // opaque record id (e.g. a user_stamp id)
  "source",               // stamp source_type provenance
  "verification",         // decorative | reported | verified (TABLE 16)
  "stamp_type",           // country | city | event | milestone | …
  "city",                 // broad city context (§5) — never a coordinate
  "country",
  "viewer_relationship",  // self | public | follower | following | crew
  "surface",              // originating surface descriptor
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED_PAYLOAD_KEYS);

/** Strip forbidden keys at every depth. Arrays walked; non-plain values pass through. */
function deepStripForbidden(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined; // fail-closed on pathological nesting
  if (Array.isArray(value)) return value.map((v) => deepStripForbidden(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keyIsForbidden(k)) continue;
      const cleaned = deepStripForbidden(v, depth + 1);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/**
 * Strip forbidden keys, then project to the allow-list. Returns a new object
 * with only allow-listed, non-forbidden keys. Exported for tests.
 */
export function sanitizePassportPayload(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (keyIsForbidden(key)) continue;   // (a) forbidden-fragment strip
    if (!ALLOWED_SET.has(key)) continue; // (b) allow-list projection
    if (value === undefined || value === null) continue;
    out[key] = value && typeof value === "object" ? deepStripForbidden(value) : value;
  }
  return out;
}

export interface PassportTelemetryInput {
  event: PassportTelemetryEvent;
  /** Pseudonymous actor (folded into payload.actor_id). */
  actorId?: string | null;
  /** Opaque subject record id (folded into payload.subject_id). */
  subjectId?: string | null;
  /** Extra allow-listed context. Anything else is dropped by the sanitizer. */
  payload?: Record<string, unknown> | null;
  occurredAt?: string;
}

interface PassportTelemetryRow {
  event_name: string;
  payload: Record<string, unknown>;
  occurred_at?: string;
}

/**
 * Project an input to an insertable row, or null if the event is not a canonical
 * §32 name. Exported for tests. actor/subject are folded into the payload and
 * then sanitized alongside any extra context.
 */
export function projectPassportEvent(input: PassportTelemetryInput): PassportTelemetryRow | null {
  if (!input || !EVENT_SET.has(input.event)) return null;
  const merged: Record<string, unknown> = { ...(input.payload ?? {}) };
  if (input.actorId != null) merged.actor_id = input.actorId;
  if (input.subjectId != null) merged.subject_id = input.subjectId;
  const row: PassportTelemetryRow = {
    event_name: input.event,
    payload: sanitizePassportPayload(merged),
  };
  if (input.occurredAt) row.occurred_at = input.occurredAt;
  return row;
}

/**
 * Record a single §32 Passport telemetry event. Fire-and-forget: never throws,
 * never blocks. Fail-closed on the flag; drops non-canonical events; logs (does
 * not swallow) insert failures.
 */
export async function recordPassportEvent(sc: any, input: PassportTelemetryInput): Promise<void> {
  try {
    if (!sc) return;
    const row = projectPassportEvent(input);
    if (!row) return;
    if (!(await isFlagEnabled(sc, PASSPORT_TELEMETRY_FLAG))) return;
    const { error } = await sc.from("passport_telemetry_events").insert(row);
    if (error) {
      logger.warn({ err: error, event: row.event_name }, "passportTelemetry: insert rejected");
    }
  } catch (err) {
    logger.warn({ err }, "passportTelemetry: insert threw");
  }
}
