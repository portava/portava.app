/**
 * §21 / §54 — smart action candidates in a Telegraph message (census G133,
 * G362; flow GII-F10).
 *
 * Spec §54: User types "meet at" → Context = telegraph_message → No aggressive
 * text autocomplete → Action candidates: Share meeting point / Share Trip stop /
 * Share current Place → Eligibility checks → User taps action → Structured
 * entity share inserted into message composer.
 *
 * WHAT THE ROWS ARE. `type: 'action'` rows whose action is the existing
 * `set_structured_value` — the structured value IS the §6.2 LOCATION draft the
 * composer inserts (label, place id, precision). No new action type was added
 * to the wire: the composer declares `set_structured_value` in its §48
 * capability handshake, and a client that does not is served none of these.
 *
 * ELIGIBILITY, decided where the facts are:
 *   - meeting point: always offerable. When text follows "meet at", it is
 *     resolved through the PLACE PICKER's own gateway serve (same privacy gate,
 *     same protected-location handling, same ranking) — a second resolver is
 *     exactly what §6 forbids.
 *   - Trip stop: the viewer's OWN Trips only (membership that is not an
 *     invitation), read here. None → an INELIGIBLE row carrying the reason. An
 *     unreadable read → a coverage refusal and NO row: a failed read must never
 *     be rendered as "you have no Trip stops".
 *   - current Place: needs the DEVICE's location permission and position, which
 *     only the device has. The row says so (`requires: 'device_location'`) and
 *     carries no draft — the server never invents where the sender is.
 *
 * PRIVACY. `telegraph_message` is `private_message`: this module logs nothing
 * and stores nothing; the client sends only the "meet at …" fragment, not the
 * message.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GenerateParams } from './gateway';
import type { GatewayServe } from './searchPage';
import { GATEWAY_ROUTE } from './searchPage';
import { POLICY_VERSION, resolvePolicy } from './policyRegistry';
import { discoveryRefusal } from '../discoveryRefusal';
import type { InputFieldPolicy, InputSuggestion } from './types';
import { isFlagEnabled } from '../featureFlags';

export type TelegraphShareKind = 'meeting_point' | 'trip_stop' | 'current_place' | 'event';

/** The §6.2 LOCATION draft the composer opens pre-filled. The sender still confirms. */
export interface TelegraphLocationDraft {
  label: string;
  placeId: string | null;
  precision: 'area' | 'venue' | 'exact';
}

/** The structured value on every §54 candidate row. */
export interface TelegraphShareValue {
  telegraphShare: TelegraphShareKind;
  /** The §6.2 kind the tap composes. */
  kind: 'LOCATION';
  eligible: boolean;
  ineligibleReason: string | null;
  /** A precondition only the device can check. */
  requires: 'device_location' | null;
  draft: TelegraphLocationDraft | null;
}

const MEET_AT =
  /\b(?:let'?s\s+|we\s+(?:can|could|should)\s+|shall\s+we\s+)?meet(?:\s+(?:me|us|up|you|them))?\s+(?:at|@|outside|by|near|in\s+front\s+of)(?:\s+|$)([^\n.!?]*)$/i;
const TIME_ONLY = /^(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|h)?|noon|midnight|sunset|sunrise)$/i;
const TRAILING_TIME = /\s+(?:at|around|by|@)\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|h)?|noon|midnight)\s*$/i;

/**
 * The "meet at …" phrase at the END of a draft, and the place text after it (a
 * bare time is not a place: "meet at 7" has none). Null when the draft does not
 * end in that phrase — "the meeting at noon went well" is not an invitation.
 */
export function parseMeetAt(text: string): { placeText: string } | null {
  const m = (text ?? '').slice(-300).match(MEET_AT);
  if (!m) return null;
  let place = (m[1] ?? '').replace(TRAILING_TIME, '').replace(/\s+/g, ' ').trim();
  if (TIME_ONLY.test(place)) place = '';
  return { placeText: place.slice(0, 80) };
}

interface TripStop {
  label: string;
  country: string | null;
  placeId: string | null;
  tripTitle: string | null;
}

/**
 * The viewer's own upcoming Trip stops: Trips they are a (non-invited) member
 * of, each Trip's destination plus its multi-city stops. Throws when a read
 * fails — the caller turns that into a refusal, never into "none".
 */
async function readTripStops(sc: SupabaseClient, userId: string, max: number): Promise<TripStop[]> {
  const mem = await sc.from('trip_members').select('trip_id, role').eq('user_id', userId).neq('role', 'invited');
  if (mem.error) throw new Error('trip_members unreadable');
  const tripIds = ((mem.data ?? []) as Array<{ trip_id: string }>).map((r) => r.trip_id);
  if (tripIds.length === 0) return [];
  const trips = await sc
    .from('trips')
    .select('id, title, destination_city, destination_country, destination_place_id, status, start_date')
    .in('id', tripIds)
    .in('status', ['active', 'upcoming', 'planning'])
    .order('start_date', { ascending: true })
    .limit(10);
  if (trips.error) throw new Error('trips unreadable');
  const tripRows = (trips.data ?? []) as Array<{ id: string; title: string | null; destination_city: string | null; destination_country: string | null; destination_place_id?: string | null }>;
  if (tripRows.length === 0) return [];
  const dests = await sc
    .from('trip_destinations')
    .select('trip_id, city, country, place_id, position')
    .in('trip_id', tripRows.map((t) => t.id))
    .order('position', { ascending: true })
    .limit(30);
  if (dests.error) throw new Error('trip_destinations unreadable');
  const out: TripStop[] = [];
  const seen = new Set<string>();
  const push = (s: TripStop) => {
    const key = s.label.toLowerCase();
    if (!s.label || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(s);
  };
  for (const t of tripRows) {
    if (t.destination_city) push({ label: t.destination_city.trim(), country: t.destination_country, placeId: t.destination_place_id ?? null, tripTitle: t.title });
    for (const d of (dests.data ?? []) as Array<{ trip_id: string; city: string | null; country: string | null; place_id: string | null }>) {
      if (d.trip_id === t.id && d.city) push({ label: d.city.trim(), country: d.country, placeId: d.place_id, tripTitle: t.title });
    }
  }
  return out;
}

function row(
  id: string,
  label: string,
  value: TelegraphShareValue,
  extra: { subtitle?: string; confidence: number },
): InputSuggestion {
  return {
    id,
    type: 'action',
    context: 'telegraph_message',
    label,
    ...(extra.subtitle ? { subtitle: extra.subtitle } : {}),
    action: { type: 'set_structured_value', value },
    structuredValue: value,
    confidence: extra.confidence,
    source: 'canonical',
    policyVersion: POLICY_VERSION,
  };
}

const MAX_PLACES = 2;
const MAX_TRIP_STOPS = 3;
const MAX_EVENTS = 2;

export const INPUT_TELEGRAPH_SHARE_ENTITY_FLAG = 'input_telegraph_share_entity_enabled';

/** global_search's own policy, narrowed to events and entity rows: the same gate, nothing personal. */
function shareableEventPolicy(): InputFieldPolicy | null {
  const base = resolvePolicy('global_search');
  if (!base || !(base.entityTypes ?? []).includes('event')) return null;
  return { ...base, entityTypes: ['event'], allowedSuggestionTypes: ['entity'], allowPersonalization: false, allowLiveContext: false, allowMemoryContext: false, allowAI: false };
}

/**
 * The §54 takeover for `telegraph_message`. Returns null when the text is not
 * a "meet at" phrase, so every other message is served exactly as before.
 * `generate` is the gateway's own serve, passed in (no import cycle).
 */
export async function serveTelegraphMeetAt(
  sc: SupabaseClient,
  params: GenerateParams,
  generate: (sc: SupabaseClient, p: GenerateParams) => Promise<GatewayServe>,
): Promise<GatewayServe | null> {
  if (params.context !== 'telegraph_message') return null;
  if (!params.policy.allowedSuggestionTypes.includes('action')) return null;
  const meet = parseMeetAt(params.text);
  if (!meet) return null;

  const suggestions: InputSuggestion[] = [];
  const failed: string[] = [];

  // 1. Meeting point — the typed place, through the place picker's own serve.
  let places: InputSuggestion[] = [];
  const placePolicy = resolvePolicy('place_picker');
  if (meet.placeText.length >= 2 && placePolicy) {
    try {
      const served = await generate(sc, {
        context: 'place_picker',
        policy: placePolicy,
        text: meet.placeText,
        userId: params.userId,
        limit: MAX_PLACES + 2,
        sessionContext: params.sessionContext,
        lat: params.lat,
        lng: params.lng,
        city: params.city,
        tz: params.tz ?? null,
      });
      places = served.suggestions.filter((s) => s.entityType === 'place' && !!s.entityId && s.locationPrecision !== 'hidden').slice(0, MAX_PLACES);
      if (served.refusal) failed.push('places');
    } catch {
      failed.push('places');
    }
  }
  for (const [i, p] of places.entries()) {
    suggestions.push(row(`telegraph-action:meeting_point:${i}`, `Share meeting point: ${p.label}`, {
      telegraphShare: 'meeting_point', kind: 'LOCATION', eligible: true, ineligibleReason: null, requires: null,
      // Telegraph §4.3: a share opens at "Approximate area"; a finer precision is
      // the SENDER's second tap in the compose sheet, never a suggestion's default.
      draft: { label: p.label, placeId: p.entityId ?? null, precision: 'area' },
    }, { subtitle: p.subtitle, confidence: 0.9 - i * 0.05 }));
  }
  if (places.length === 0) {
    suggestions.push(row('telegraph-action:meeting_point', meet.placeText ? `Share meeting point: “${meet.placeText}”` : 'Share meeting point', {
      telegraphShare: 'meeting_point', kind: 'LOCATION', eligible: true, ineligibleReason: null, requires: null,
      draft: meet.placeText ? { label: meet.placeText, placeId: null, precision: 'area' } : null,
    }, { confidence: 0.8 }));
  }

  // 1b. §21 "Share Event" / §43 `share_entity` (census G303, G133): the typed
  // place text may name an EVENT. Resolved through the gateway's own privacy-
  // gated event search (blocks, age gate, visibility — the same rows global
  // search would show THIS sender), never a fresh read. The row's action is
  // `share_entity`; the composer sends it through POST /threads/:id/share, which
  // re-checks that the sender can open it and projects it per RECIPIENT at read
  // time (§5.3), so a recipient who may not see the event sees "unavailable",
  // never the event. Behind `input_telegraph_share_entity_enabled` (3691,
  // seeded FALSE); served only to a client that declares `share_entity`.
  if (meet.placeText.length >= 2 && (await isFlagEnabled(sc, INPUT_TELEGRAPH_SHARE_ENTITY_FLAG))) {
    const eventPolicy = shareableEventPolicy();
    if (eventPolicy) {
      try {
        const served = await generate(sc, {
          context: 'global_search', policy: eventPolicy, text: meet.placeText.replace(/^(?:the|a|an)\s+/i, ''), userId: params.userId, limit: MAX_EVENTS + 2,
          sessionContext: params.sessionContext, lat: params.lat, lng: params.lng, city: params.city, tz: params.tz ?? null,
        });
        const events = served.suggestions.filter((s) => s.type === 'entity' && s.entityType === 'event' && !!s.entityId).slice(0, MAX_EVENTS);
        if (served.refusal) failed.push('events');
        for (const [i, e] of events.entries()) {
          suggestions.push({
            id: `telegraph-action:share_event:${i}`, type: 'action', context: 'telegraph_message', label: `Share Event: ${e.label}`,
            ...(e.subtitle ? { subtitle: e.subtitle } : {}),
            action: { type: 'share_entity', entityType: 'event', entityId: e.entityId! },
            structuredValue: { telegraphShare: 'event', kind: 'PORTAVA_OBJECT', objectType: 'EVENT', eligible: true, ineligibleReason: null, requires: null, draft: null },
            confidence: 0.85 - i * 0.05, source: 'canonical', policyVersion: POLICY_VERSION,
          });
        }
      } catch {
        failed.push('events');
      }
    }
  }

  // 2. Trip stops — the viewer's own; a failed read is a refusal, not "none".
  try {
    const stops = await readTripStops(sc, params.userId, MAX_TRIP_STOPS);
    for (const [i, s] of stops.entries()) {
      suggestions.push(row(`telegraph-action:trip_stop:${i}`, `Share Trip stop: ${s.label}`, {
        telegraphShare: 'trip_stop', kind: 'LOCATION', eligible: true, ineligibleReason: null, requires: null,
        draft: { label: s.label, placeId: s.placeId, precision: 'area' },
      }, { subtitle: s.tripTitle ?? s.country ?? undefined, confidence: 0.7 - i * 0.05 }));
    }
    if (stops.length === 0) {
      suggestions.push(row('telegraph-action:trip_stop', 'Share Trip stop', {
        telegraphShare: 'trip_stop', kind: 'LOCATION', eligible: false,
        ineligibleReason: 'You have no upcoming Trip stops to share.', requires: null, draft: null,
      }, { confidence: 0.3 }));
    }
  } catch {
    failed.push('trip_stops');
  }

  // 3. Current Place — the device decides; the server never guesses a position.
  suggestions.push(row('telegraph-action:current_place', 'Share current Place', {
    telegraphShare: 'current_place', kind: 'LOCATION', eligible: true, ineligibleReason: null,
    requires: 'device_location', draft: null,
  }, { confidence: 0.6 }));

  const refusal = failed.length > 0
    ? discoveryRefusal('transient_db', 'suggest_sources_unreadable', GATEWAY_ROUTE, 'partial', failed.sort())
    : null;
  return { suggestions: suggestions.slice(0, Math.max(params.limit, 6)), refusal };
}
