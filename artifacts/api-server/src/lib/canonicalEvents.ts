/**
 * canonicalEvents — the write side of the canonical_events ingestion spine
 * (migration 2100).
 *
 * WHAT IT DOES
 * ============
 * recordEvent()/recordEvents() insert observed interaction events through the
 * service client. Fire-and-forget: call WITHOUT `await`, only after the response
 * has been sent. Never throws — an instrumentation failure must not break a
 * request. Insert failures are logged, not swallowed silently.
 *
 * TWO SAFETY MECHANISMS ON EVERY EVENT
 * ====================================
 *   1. VERB PROJECTION. Only the nine canonical verbs are accepted. An event
 *      with any other verb is dropped by the projection before insert (and the
 *      table's CHECK would reject it anyway) — a bad verb never reaches the DB.
 *   2. PAYLOAD SANITIZER. The free-form payload is (a) stripped of forbidden
 *      raw-GPS keys (lat/lng/latitude/longitude/coords/accuracy, case-insensitive)
 *      and (b) projected to an allow-list of known-safe context keys. A key that
 *      is neither GPS nor allow-listed is dropped. Coordinates never land here.
 *
 * Follows the featureFlags.ts conventions: the service client is injected as the
 * first argument (`sc: any`), typing is loose at the boundary.
 */
import { logger } from "./logger.js";

/** The nine canonical verbs. Mirrors the CHECK on canonical_events.verb. */
export const CANONICAL_EVENT_VERBS = [
  "impression",
  "open",
  "save",
  "join",
  "direction",
  "arrival",
  "completion",
  "rejection",
  "satisfaction",
] as const;

export type CanonicalEventVerb = (typeof CANONICAL_EVENT_VERBS)[number];

const VERB_SET = new Set<string>(CANONICAL_EVENT_VERBS);

/**
 * Forbidden raw-GPS keys, stripped from payload absolutely (even if one were
 * mistakenly added to the allow-list). Matched case-insensitively.
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  "lat",
  "lng",
  "latitude",
  "longitude",
  "coords",
  "accuracy",
] as const;

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_PAYLOAD_KEYS.map((k) => k.toLowerCase()));

/**
 * Allow-list of payload context keys that may be persisted. Neutral,
 * observability-shaped descriptors already used by existing instrumentation
 * (discoveryServeLog / discovery_shadow_serves context). Owner-tunable: adding a
 * domain key is a deliberate decision, not a default.
 */
export const ALLOWED_PAYLOAD_KEYS = [
  "surface",
  "route",
  "servePoint",
  "engine_mode",
  "mode_reason",
  "destination",
  "category",
  "radius_km",
  "page",
  "sort_by",
  "cache_level",
  "cohort_reason",
  "reason",
  "position",
  "result_count",
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED_PAYLOAD_KEYS);

export interface CanonicalEventInput {
  verb: CanonicalEventVerb;
  actorId?: string | null;
  subjectKind?: string | null;
  subjectId?: string | null;
  occurredAt?: string;
  sourceCount?: number | null;
  freshnessSeconds?: number | null;
  confidence?: number | null;
  privacyEligible?: boolean | null;
  expiresAt?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Strip forbidden GPS keys, then project to the allow-list. Returns a new object
 * containing only allow-listed, non-GPS keys.
 */
export function sanitizePayload(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_SET.has(key.toLowerCase())) continue; // (a) GPS strip — absolute
    if (!ALLOWED_SET.has(key)) continue;                // (b) allow-list projection
    out[key] = value;
  }
  return out;
}

/** The row shape inserted into canonical_events. */
interface CanonicalEventRow {
  verb: string;
  actor_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  occurred_at?: string;
  source_count: number | null;
  freshness_seconds: number | null;
  confidence: number | null;
  privacy_eligible: boolean | null;
  expires_at: string | null;
  payload: Record<string, unknown>;
}

/**
 * Project an input to an insertable row, or null if the verb is not canonical.
 * A null result is dropped before insert — this is where a bad verb is rejected.
 * Exported for tests.
 */
export function projectEvent(input: CanonicalEventInput): CanonicalEventRow | null {
  if (!input || !VERB_SET.has(input.verb)) return null;
  const row: CanonicalEventRow = {
    verb: input.verb,
    actor_id: input.actorId ?? null,
    subject_kind: input.subjectKind ?? null,
    subject_id: input.subjectId ?? null,
    source_count: input.sourceCount ?? null,
    freshness_seconds: input.freshnessSeconds ?? null,
    confidence: input.confidence ?? null,
    privacy_eligible: input.privacyEligible ?? null,
    expires_at: input.expiresAt ?? null,
    payload: sanitizePayload(input.payload),
  };
  // Only set occurred_at when supplied; otherwise the column default (now())
  // applies at insert.
  if (input.occurredAt) row.occurred_at = input.occurredAt;
  return row;
}

/**
 * Bulk-insert events. Fire-and-forget: never throws, never blocks the request
 * path. Non-canonical verbs are dropped by the projection. Insert failures are
 * logged.
 */
export async function recordEvents(sc: any, inputs: readonly CanonicalEventInput[]): Promise<void> {
  try {
    if (!sc || !inputs || inputs.length === 0) return;
    const rows = inputs.map(projectEvent).filter((r): r is CanonicalEventRow => r !== null);
    if (rows.length === 0) return;
    const { error } = await sc.from("canonical_events").insert(rows);
    if (error) {
      logger.warn({ err: error, count: rows.length }, "canonicalEvents: insert rejected");
    }
  } catch (err) {
    logger.warn({ err }, "canonicalEvents: insert threw");
  }
}

/** Record a single event. Fire-and-forget; see recordEvents. */
export async function recordEvent(sc: any, input: CanonicalEventInput): Promise<void> {
  return recordEvents(sc, [input]);
}
