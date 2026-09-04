/**
 * passportTelemetry — the Passport product-telemetry seam (Passport spec §32).
 *
 * A single typed, privacy-scrubbed entry point for the §32 event catalogue.
 * Nothing on a Passport surface should call `fetch` for analytics directly;
 * everything goes through the `track*` helpers here, which fan out to a
 * pluggable sink (the real telemetry pipeline, or a test spy).
 *
 * PRIVACY IS THE POINT (§32 + §23/§24):
 *   Every event here carries ONLY ids, enums and counts — never PII and never
 *   raw typed text. A Passport event is about a real person, so a name, @handle,
 *   e-mail, free-text label, bio, message body or coordinate must never leave
 *   the device through this seam. The typed payloads below are constructed to
 *   contain none of those; `scrubPayload` then enforces it as a runtime
 *   invariant (a disallowed key at any depth is stripped), and `emit` drops an
 *   event outright if anything disallowed still survives. Subject *ids* (the
 *   passport being viewed, a stamp id) ARE allowed — they are opaque uuids, the
 *   same thing wallAnalytics records as `objectId`/`subjectId`.
 *
 * TRANSPORT:
 *   The sink is injected once at app start (or by a test). Until then the
 *   default sink only dev-logs, so telemetry fired before wiring is never a
 *   crash and never a silent network call. `emit` never throws — analytics must
 *   not be able to break a Passport screen.
 *
 * This mirrors features/wall/services/wallAnalytics.ts (pluggable sink, typed
 * events, a non-throwing `emit`) with the map-telemetry privacy scrubber folded
 * in, because a Passport is exactly the kind of identity surface §23/§24 guard.
 */
import type { StampVerification } from '../../types/models.ts';
import type { PassportViewerContext } from '../../services/passportProjection.ts';
import type { SharedContextSummaryLabel } from '../../services/passportSharedContext.ts';

// ── Enums the events carry (all closed sets, never free text) ─────────────────

/** How a passport was shared (§25 / §32 passport_shared). */
export type PassportShareMethod = 'link' | 'copy' | 'bump' | 'qr' | 'share_sheet';

/** Where a make_plan_started action originated (§18 / §32). */
export type MakePlanOrigin = 'shared_context' | 'plans_overlap';

// ── The §32 event catalogue, with per-event payloads ──────────────────────────

export interface PassportTelemetryEventMap {
  /** A passport was opened/viewed. `subjectId` is the viewed user's id. */
  passport_viewed: { subjectId: string; viewerContext?: PassportViewerContext };
  /** The owner shared their passport. Ids/enums only — never the link text. */
  passport_shared: { method: PassportShareMethod };
  /** A passport QR was scanned (scanner side). No profile fields. */
  passport_qr_scanned: Record<string, never>;

  /** The owner set an explicit availability window (§7). */
  availability_set: { openToPlans: boolean; intentCount: number; hasWindow: boolean };
  /** An availability window lapsed (§31). */
  availability_expired: Record<string, never>;
  /** Open to Plans was turned on (§8). */
  open_to_plans_enabled: { intentCount: number };

  /** A stamp detail was opened (§12/§13). Carries the verification treatment. */
  stamp_viewed: { stampId: string; kind: string; verification: StampVerification };
  /** The Trust & Credentials summary was viewed (§9/§10). */
  trust_summary_viewed: { subjectId?: string; hasScore: boolean };
  /** Shared Context (ME ↔ THEM) was viewed (§17). */
  shared_context_viewed: { subjectId: string; factCount: number; summary: SharedContextSummaryLabel };
  /** A make-a-plan / Compass handoff was started (§18). */
  make_plan_started: { subjectId: string; from: MakePlanOrigin };

  /** The Journeys surface was viewed (§14). */
  journey_viewed: { subjectId?: string; journeyCount: number; hasFeatured: boolean };
  /** A memory was viewed (§15). */
  memory_viewed: { memoryId: string };
  /** My World was opened (§26). Counts only — never a place name. */
  my_world_opened: { countryCount: number; cityCount: number; stampCount: number };

  /** A follow initiated from a passport (§32). */
  follow_from_passport: { subjectId: string };
  /** A message initiated from a passport (§32). */
  message_from_passport: { subjectId: string };
  /** A trip invite initiated from a passport (§32). */
  trip_invite_from_passport: { subjectId: string };
}

export type PassportTelemetryEventName = keyof PassportTelemetryEventMap;

/** A fully-formed telemetry event: name + its scrubbed payload. */
export type PassportTelemetryEvent = {
  [N in PassportTelemetryEventName]: {
    type: N;
    payload: PassportTelemetryEventMap[N];
  };
}[PassportTelemetryEventName];

/** Runtime mirror of the union — the server's allow-list / validation set. */
export const PASSPORT_TELEMETRY_EVENTS: readonly PassportTelemetryEventName[] = [
  'passport_viewed',
  'passport_shared',
  'passport_qr_scanned',
  'availability_set',
  'availability_expired',
  'open_to_plans_enabled',
  'stamp_viewed',
  'trust_summary_viewed',
  'shared_context_viewed',
  'make_plan_started',
  'journey_viewed',
  'memory_viewed',
  'my_world_opened',
  'follow_from_passport',
  'message_from_passport',
  'trip_invite_from_passport',
] as const;

// ── The privacy scrubber (§23/§24) ────────────────────────────────────────────

/**
 * Keys that must never appear in a passport telemetry payload at any depth.
 *
 * Matched as case-insensitive SUBSTRINGS: a denylist that only catches `name`
 * misses `displayName`/`full_name`. The cost is that an innocent key containing
 * a fragment is also stripped — which is why no payload type above uses one.
 * When in doubt the scrubber removes: losing an analytics field is recoverable,
 * leaking a name or a coordinate is not. Subject *ids* survive because they do
 * not match any fragment here.
 */
const DISALLOWED_KEY_RE =
  /(name|handle|username|e_?mail|phone|avatar|photo|bio|title|label|text|message|body|description|caption|note|address|street|postcode|postal|zip|lat|lng|lon|coord|geometry)/i;

/**
 * Keys that are explicitly SAFE despite containing a denylist fragment. Every
 * entry must carry a closed enum or a count — never free text — and is listed
 * here by exact name so the exception cannot widen by accident.
 *
 *   • `viewerContext` — the TABLE 5 enum ('self' | 'public' | 'follower' | …).
 *     It contains the fragment "text", which silently stripped it from every
 *     passport_viewed event until the transport was wired and a wire-level
 *     test noticed the payload arriving without it.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['viewerContext']);

/** True when a key must be removed from a payload wherever it appears. */
export function isDisallowedKey(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return false;
  return DISALLOWED_KEY_RE.test(key);
}

const MAX_DEPTH = 5;
const MAX_ARRAY_LENGTH = 50;
const MAX_STRING_LENGTH = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) : s;
  }
  if (t === 'number') return Number.isFinite(value as number) ? value : undefined;
  if (t === 'boolean') return value;
  if (t !== 'object') return undefined; // functions, symbols, bigint, undefined
  if (depth >= MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_ARRAY_LENGTH)) {
      const scrubbed = scrubValue(item, depth + 1);
      if (scrubbed !== undefined) out.push(scrubbed);
    }
    return out;
  }
  if (!isPlainObject(value)) return undefined;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isDisallowedKey(key)) continue;
    const scrubbed = scrubValue(value[key], depth + 1);
    if (scrubbed === undefined) continue;
    out[key] = scrubbed;
  }
  return out;
}

/** The privacy gate. Pure, total, and the only way a payload reaches the sink. */
export function scrubPayload(payload: unknown): Record<string, unknown> {
  const scrubbed = scrubValue(payload, 0);
  return isPlainObject(scrubbed) ? scrubbed : {};
}

/** Post-condition: true when a disallowed key survived (last line of defence). */
export function containsDisallowedKey(value: unknown, depth = 0): boolean {
  if (depth >= MAX_DEPTH + 2 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsDisallowedKey(v, depth + 1));
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isDisallowedKey(key)) return true;
    if (containsDisallowedKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

// ── Sink (pluggable, mirrors wallAnalytics) ───────────────────────────────────

export type PassportTelemetrySink = (event: PassportTelemetryEvent) => void;

const defaultSink: PassportTelemetrySink = (event) => {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[passportTelemetry]', event.type, event.payload);
  }
};

let sink: PassportTelemetrySink = defaultSink;

/** Inject the real telemetry pipeline or a test spy. */
export function setPassportTelemetrySink(next: PassportTelemetrySink): void {
  sink = next;
}

/** Reset to the default (dev-log) sink. Test cleanup + app teardown. */
export function resetPassportTelemetrySink(): void {
  sink = defaultSink;
}

/**
 * The single sanctioned emit path. Scrubs, drops on a surviving disallowed key,
 * and never throws. Typed so `emit('stamp_viewed', { … })` accepts only a
 * StampViewed payload — a wrong payload for a name is a compile error.
 */
export function emit<N extends PassportTelemetryEventName>(
  name: N,
  payload: PassportTelemetryEventMap[N],
): void {
  try {
    if (!PASSPORT_TELEMETRY_EVENTS.includes(name)) return;
    const scrubbed = scrubPayload(payload);
    // Belt and braces: if anything disallowed survived, drop rather than send.
    if (containsDisallowedKey(scrubbed)) return;
    sink({ type: name, payload: scrubbed } as PassportTelemetryEvent);
  } catch {
    // Telemetry must never surface an error to the user.
  }
}

// ── Named helpers (call sites use these, not `emit` directly) ─────────────────

export const trackPassportViewed = (
  subjectId: string,
  viewerContext?: PassportViewerContext,
): void => emit('passport_viewed', viewerContext ? { subjectId, viewerContext } : { subjectId });

export const trackPassportShared = (method: PassportShareMethod): void =>
  emit('passport_shared', { method });

export const trackPassportQrScanned = (): void => emit('passport_qr_scanned', {});

export const trackAvailabilitySet = (args: {
  openToPlans: boolean;
  intentCount: number;
  hasWindow: boolean;
}): void => emit('availability_set', args);

export const trackAvailabilityExpired = (): void => emit('availability_expired', {});

export const trackOpenToPlansEnabled = (intentCount: number): void =>
  emit('open_to_plans_enabled', { intentCount });

export const trackStampViewed = (args: {
  stampId: string;
  kind: string;
  verification: StampVerification;
}): void => emit('stamp_viewed', args);

export const trackTrustSummaryViewed = (args: { subjectId?: string; hasScore: boolean }): void =>
  emit('trust_summary_viewed', args);

export const trackSharedContextViewed = (args: {
  subjectId: string;
  factCount: number;
  summary: SharedContextSummaryLabel;
}): void => emit('shared_context_viewed', args);

export const trackMakePlanStarted = (subjectId: string, from: MakePlanOrigin): void =>
  emit('make_plan_started', { subjectId, from });

export const trackJourneyViewed = (args: {
  subjectId?: string;
  journeyCount: number;
  hasFeatured: boolean;
}): void => emit('journey_viewed', args);

export const trackMemoryViewed = (memoryId: string): void =>
  emit('memory_viewed', { memoryId });

export const trackMyWorldOpened = (args: {
  countryCount: number;
  cityCount: number;
  stampCount: number;
}): void => emit('my_world_opened', args);

export const trackFollowFromPassport = (subjectId: string): void =>
  emit('follow_from_passport', { subjectId });

export const trackMessageFromPassport = (subjectId: string): void =>
  emit('message_from_passport', { subjectId });

export const trackTripInviteFromPassport = (subjectId: string): void =>
  emit('trip_invite_from_passport', { subjectId });
