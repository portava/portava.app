/**
 * mediaTelemetry — the Media v2 North-Star outcome emitter (spec §44/§45).
 *
 * WHAT THIS IS
 * ============
 * A thin, pure, privacy-scrubbed mapping from a *media-originated action* to the
 * ONE §45 north-star transition it represents. It is the single place that knows
 * "tapping this media action == this real-world outcome", and it reuses the
 * EXISTING media analytics helper (hooks/useMediaAnalytics.ts) as its transport —
 * it introduces NO new provider, queue, or endpoint of its own.
 *
 * WHY IT EXISTS IN THIS SHAPE (§44/§45/§2/§26)
 * ============================================
 * §45 defines success for Media as real-world outcomes, NOT engagement:
 *
 *     Media → Place Open · Compass · Route · Trip Add · Plan ·
 *             Real-World Arrival · Contribution · Useful Correction
 *     "Do not optimize primarily for minutes watched, infinite scroll depth,
 *      or forced autoplay completion."
 *
 * The merged media surfaces already route each action through the server action
 * resolver (services/mediaActions.ts) and existing endpoints; what was MISSING is
 * the OUTCOME LINKAGE — an event fired at the moment a media object causes a
 * real-world action, so usefulness is measurable. That is all this module adds:
 * one coarse event per transition, mapped from the action id.
 *
 * PRIVACY IS THE POINT (§44)
 * ==========================
 * §44 requires measuring usefulness WITHOUT capturing raw private text, and the
 * media action context is private-message-adjacent (captions, on-the-ground
 * notes, Compass prompts, coordinates). So the payload carries ONLY coarse
 * metadata — opaque ids and coarse enums (media id, entity kind, action id,
 * surface) — never a caption, note, message, prompt, title, or coordinate.
 *
 * `FORBIDDEN_KEY_RE` / `hasForbiddenKey` enforce that as a last line of defence:
 * an event whose payload still carries a raw-text or coordinate key is DROPPED
 * rather than sent. `buildNorthStarPayload` only ever produces allowed keys, so
 * in normal operation the guard never fires — it exists so a future careless
 * caller cannot leak.
 *
 * FAIL-SOFT (§44 hard constraint)
 * ===============================
 * Telemetry is fire-and-forget and must never break the action: every path is
 * wrapped so a throw from the recorder (or anywhere) is swallowed. The recorder
 * itself (useMediaAnalytics.record) is already best-effort/batched/deduped.
 *
 * PURE — NO REACT, NO FETCH
 * =========================
 * This file imports only TYPES from the analytics helper (erased at runtime), so
 * it is testable under `node --test` and cannot drag react-native into a unit
 * test. The real `record` function is passed in by the call site (the action
 * rail), which already owns the hook.
 */
import type { MediaEventType, MediaEventPayload } from '../../../hooks/useMediaAnalytics.ts';

// ── The eight §45 north-star transitions ──────────────────────────────────────

/**
 * The §45 north-star outcomes, as event names. These are a SUBSET of the media
 * analytics `MediaEventType` vocabulary (they are declared there too), so the
 * existing `record` helper accepts them with no adapter.
 *
 * `media_arrival` is the "Real-World Arrival where safely measurable" transition;
 * `media_route` and `media_contribution` have no action-rail trigger yet (there
 * is no directions / contribution-submit affordance in the rail) and are
 * reserved for the surfaces that will emit them. The vocabulary is complete so
 * those surfaces have a canonical name to reuse rather than inventing one.
 */
export type MediaNorthStarEvent =
  | 'media_place_open' // Media → Place Open
  | 'media_compass' //    Media → Compass
  | 'media_route' //      Media → Route (reserved: no rail trigger yet)
  | 'media_trip_add' //   Media → Trip Add
  | 'media_plan' //       Media → Plan
  | 'media_contribution' //Media → Contribution (reserved)
  | 'media_correction' // Media → Useful Correction
  | 'media_arrival'; //   Media → Real-World Arrival (reserved)

/** Runtime mirror of the union — for validation and for the server allow-list. */
export const MEDIA_NORTH_STAR_EVENTS: readonly MediaNorthStarEvent[] = [
  'media_place_open',
  'media_compass',
  'media_route',
  'media_trip_add',
  'media_plan',
  'media_contribution',
  'media_correction',
  'media_arrival',
];

// ── Action → north-star mapping ───────────────────────────────────────────────

/**
 * Map a resolved media action id (services/mediaActions.ts `MediaActionId`) to
 * the ONE §45 transition it constitutes, or `null` when the action is not a
 * real-world outcome.
 *
 * Mapped (a real-world transition):
 *   • show_on_map / view_experience → media_place_open  (open the entity behind
 *     the media — a place, or an experience/trip)
 *   • ask_compass                   → media_compass
 *   • create_plan / do_this_experience → media_plan     (build a plan/experience)
 *   • add_to_trip                   → media_trip_add
 *   • report                        → media_correction  (user-supplied correction)
 *
 * NOT mapped (returns null — deliberately NOT north-star):
 *   • see_nearby / find_similar — in-app discovery, not a real-world outcome.
 *   • save — an engagement-adjacent signal, already tracked as its own `save`
 *     event; §45's canon is the eight transitions, and "save" is not one.
 *   • meet_here — a social meetup, outside the §45 set.
 *   • i_want_this — a want SIGNAL (§15.1), not a completed real-world action.
 *   • share_telegraph — a share; §2/§26 explicitly keep shares from dominating
 *     the hierarchy, so it is not optimized for here.
 *
 * Pure and total: an unknown/future id returns null (a no-op, never a fabricated
 * outcome).
 */
export function mediaActionToNorthStar(actionId: string): MediaNorthStarEvent | null {
  switch (actionId) {
    case 'show_on_map':
    case 'view_experience':
      return 'media_place_open';
    case 'ask_compass':
      return 'media_compass';
    case 'create_plan':
    case 'do_this_experience':
      return 'media_plan';
    case 'add_to_trip':
      return 'media_trip_add';
    case 'report':
      return 'media_correction';
    default:
      return null;
  }
}

// ── Coarse-metadata payload ───────────────────────────────────────────────────

/**
 * The ONLY inputs a north-star payload is built from — every field is either an
 * opaque id or a coarse enum. There is deliberately no place for a caption,
 * note, message, prompt, title, or coordinate: the type simply does not accept
 * one, and `hasForbiddenKey` catches anything that slips past the type.
 */
export interface MediaNorthStarContext {
  /** Opaque media id. */
  mediaId?: string | null;
  /** The action id being dispatched (also the mapping key). */
  actionId?: string | null;
  /** Coarse entity kind: 'media' | 'place' | 'trip' | 'gem'. */
  entityKind?: string | null;
  /** Opaque place id (id only — never a name or coordinate). */
  placeId?: string | null;
  /** Opaque trip id. */
  tripId?: string | null;
  /** Where the action was dispatched from, e.g. 'action_rail'. */
  surface?: string | null;
}

function put(out: Record<string, unknown>, key: keyof MediaEventPayload, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) out[key as string] = value;
}

/**
 * Build the coarse-metadata payload for a north-star event. Only allowed keys
 * are ever emitted (opaque ids + coarse enums); empty/absent inputs are dropped
 * so the payload stays minimal. Pure — safe to unit-test directly.
 */
export function buildNorthStarPayload(ctx: MediaNorthStarContext): MediaEventPayload {
  const out: Record<string, unknown> = {};
  put(out, 'media_id', ctx.mediaId);
  put(out, 'action_id', ctx.actionId);
  put(out, 'entity_kind', ctx.entityKind);
  put(out, 'place_id', ctx.placeId);
  put(out, 'trip_id', ctx.tripId);
  put(out, 'surface', ctx.surface);
  return out as MediaEventPayload;
}

// ── Forbidden-key guard (§44 hygiene: metadata, never raw text/coords) ─────────

/**
 * Keys that may NEVER appear in a media north-star payload, at any depth.
 *
 * Matched as case-insensitive SUBSTRINGS (like the map telemetry scrubber): a
 * denylist that only catches `caption` misses `captionText`, `raw_caption`.
 * Two families:
 *   • Raw private text — captions, on-the-ground notes, messages, comments,
 *     Compass prompts, and any free-text title/name/description/body/query.
 *   • Precise location — coordinates and street addresses.
 *
 * `buildNorthStarPayload` never produces any of these; the guard is the last
 * line of defence so a careless future caller cannot leak one.
 */
export const FORBIDDEN_KEY_RE =
  /(caption|note|message|comment|\btext\b|body|prompt|title|\bname\b|display_?name|full_?name|description|query|transcript|content|lat|lng|lon|coord|geometry|geohash|address|street|postcode|postal|zipcode)/i;

/** True when a key must never appear in a north-star payload. */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_RE.test(key);
}

/** True when any key of the payload (shallow — the payload is flat) is forbidden. */
export function hasForbiddenKey(payload: object | null | undefined): boolean {
  if (!payload || typeof payload !== 'object') return false;
  return Object.keys(payload).some(isForbiddenKey);
}

// ── Emit ──────────────────────────────────────────────────────────────────────

/** The shape of the existing media analytics recorder (useMediaAnalytics.record). */
export type MediaEventRecorder = (type: MediaEventType, payload?: MediaEventPayload) => void;

/**
 * Fire the north-star event for a media action through the EXISTING analytics
 * helper. Returns the event that was emitted (for tests / callers that want to
 * know), or null when the action is not a north-star transition or telemetry was
 * suppressed.
 *
 * Fire-and-forget + fail-soft: any throw (including from `record`) is swallowed,
 * so telemetry can never break the media action. A payload that — against the
 * type — still carries a forbidden key is DROPPED, not sent.
 */
export function emitMediaNorthStar(
  record: MediaEventRecorder,
  actionId: string,
  ctx: MediaNorthStarContext = {},
): MediaNorthStarEvent | null {
  try {
    const event = mediaActionToNorthStar(actionId);
    if (!event) return null;
    const payload = buildNorthStarPayload({ ...ctx, actionId });
    // Last line of defence — never let raw text / a coordinate leave.
    if (hasForbiddenKey(payload)) return null;
    record(event, payload);
    return event;
  } catch {
    // Telemetry must never surface an error to the user.
    return null;
  }
}
