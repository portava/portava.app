/**
 * §21 Trip smart actions (census-input-intelligence G135): add stop, reorder
 * plan, add destination, invite Crew — typed into the search field.
 *
 *   "add a stop in Hue"            → add_to_trip (the existing §43 type: a Trip's
 *   "add Hoi An as a stop"            stops ARE its destinations — the multi-city
 *                                     editor and Telegraph's "Trip stop" both mean
 *                                     a destination, so this is that action)
 *   "add Hoi An to my trip"        → add_to_trip (already produced by
 *                                     semanticIntent.ts; "add destination")
 *   "invite @maya to my trip"      → trip_action / invite_crew
 *   "reorder my trip"              → trip_action / reorder_plan
 *
 * PROPOSE-ONLY (§47). A row never names a Trip and never writes: the person
 * picks one of THEIR OWN Trips on the device, and the write goes through the
 * existing authorised endpoint — POST /trips/:tripId/invite (owner-only, block
 * guard, Trust restriction gate) for an invitation, POST
 * /trips/:tripId/destinations for a stop; "reorder" opens the Trip's own edit
 * screen, where the reorder endpoint's authorization applies. Nothing here can
 * do what the person could not do on the Trip screen.
 *
 * PRIVACY. The invitee is resolved by the @mention resolver — the people search
 * with its block / age-restriction gate, fail-closed — and only on an EXACT
 * handle match: a fuzzy "did you mean" person is never proposed for an
 * invitation.
 *
 * FLAG: `input_trip_actions_enabled` (migration 3692, seeded FALSE). OFF /
 * absent: none of these rows is produced (the pre-existing "add X to my trip"
 * row is unaffected).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../featureFlags';
import type { InputContext, InputFieldPolicy, InputSuggestion, SuggestSessionContext } from './types';
import { resolveMentionSuggestions } from './socialIdentity';
import { resolveGeoCandidates } from './geoResolver';
import { buildAddToTripRow } from './semanticIntent';

export const INPUT_TRIP_ACTIONS_FLAG = 'input_trip_actions_enabled';

export type TripActionKind = 'reorder_plan' | 'invite_crew';

export type ParsedTripAction =
  | { kind: 'add_stop'; destinationText: string }
  | { kind: 'invite_crew'; handle: string }
  | { kind: 'reorder_plan' };

const TRIP = String.raw`(?:my|our|the)\s+(?:trip|itinerary|plan)`;
const ADD_STOP_RES: RegExp[] = [
  new RegExp(String.raw`^add\s+(?:a\s+)?stop\s+(?:in|at|to)\s+(.+?)(?:\s+(?:to|on)\s+${TRIP})?$`, 'i'),
  new RegExp(String.raw`^add\s+(.+?)\s+as\s+(?:a\s+)?stop(?:\s+(?:to|on)\s+${TRIP})?$`, 'i'),
];
const INVITE_RE = new RegExp(String.raw`^invite\s+@?([a-z0-9_.]{2,30})\s+to\s+${TRIP}$`, 'i');
const REORDER_RE = new RegExp(String.raw`^(?:reorder|rearrange|re-order)\s+(?:${TRIP}|(?:my|our|the)\s+(?:stops|destinations))$`, 'i');

/** Recognise one Trip action phrase (the WHOLE text, so a search containing the words is not a command). */
export function parseTripAction(text: string): ParsedTripAction | null {
  const raw = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 120) return null;
  if (REORDER_RE.test(raw)) return { kind: 'reorder_plan' };
  const inv = raw.match(INVITE_RE);
  if (inv) return { kind: 'invite_crew', handle: inv[1]!.toLowerCase() };
  for (const re of ADD_STOP_RES) {
    const m = raw.match(re);
    const dest = m?.[1]?.replace(/["']/g, '').trim();
    if (dest && dest.length >= 2 && dest.length <= 80) return { kind: 'add_stop', destinationText: dest };
  }
  return null;
}

export interface TripActionParams {
  context: InputContext;
  policy: InputFieldPolicy;
  text: string;
  userId: string;
  policyVersion: string;
  sessionContext?: SuggestSessionContext;
  lat: number | null;
  lng: number | null;
  city: string | null;
}

/** The contexts whose screen dispatches these (app/search.tsx). */
export const TRIP_ACTION_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['global_search']);

/** The §21 Trip action rows for one serve. Empty unless every gate passes. Never throws. */
export async function buildTripActionRows(sc: SupabaseClient, p: TripActionParams): Promise<InputSuggestion[]> {
  if (!TRIP_ACTION_CONTEXTS.has(p.context) || !p.policy.allowedSuggestionTypes.includes('action') || !p.userId) return [];
  const parsed = parseTripAction(p.text);
  if (!parsed) return [];
  if (!(await isFlagEnabled(sc, INPUT_TRIP_ACTIONS_FLAG))) return [];

  if (parsed.kind === 'reorder_plan') {
    return [{
      id: `${p.context}:action:trip_action:reorder_plan`,
      type: 'action',
      context: p.context,
      label: 'Reorder the stops on one of your Trips',
      action: { type: 'trip_action', action: 'reorder_plan' },
      structuredValue: { kind: 'trip_action', action: 'reorder_plan' },
      confidence: 0.9,
      source: 'canonical',
      reason: 'Reorder plan',
      policyVersion: p.policyVersion,
    }];
  }

  if (parsed.kind === 'add_stop') {
    const res = await resolveGeoCandidates(sc, parsed.destinationText, 3).catch(() => null);
    const row = res?.rows?.[0];
    if (!row) return [];
    const add = buildAddToTripRow(p.context, p.policyVersion, { cityId: row.id, city: row.name || row.display_name, country: row.country ?? null }, p.sessionContext);
    return [{ ...add, id: `${add.id}:stop`, label: `Add ${row.name || row.display_name} as a stop on your trip`, reason: 'Add stop' }];
  }

  // invite_crew — the @mention resolver's people (block + age gate, fail-closed), EXACT handle only.
  const people = await resolveMentionSuggestions(sc, p.context, p.policyVersion, {
    userId: p.userId,
    q: parsed.handle,
    max: 5,
    ctx: { lat: p.lat, lng: p.lng, userCity: p.city, nearbyIntent: false },
  }).catch(() => [] as InputSuggestion[]);
  const exact = people.find((s) => {
    const h = (s.structuredValue as { handle?: unknown } | undefined)?.handle;
    return typeof h === 'string' && h.toLowerCase() === parsed.handle && s.entityId && s.entityId !== p.userId;
  });
  if (!exact) return [];
  return [{
    id: `${p.context}:action:trip_action:invite_crew:${exact.entityId}`,
    type: 'action',
    context: p.context,
    label: `Invite @${parsed.handle} to one of your Trips`,
    entityType: 'user',
    entityId: exact.entityId,
    action: { type: 'trip_action', action: 'invite_crew', entityType: 'user', entityId: exact.entityId! },
    structuredValue: { kind: 'trip_action', action: 'invite_crew', userId: exact.entityId, handle: parsed.handle },
    confidence: 0.9,
    source: 'canonical',
    reason: 'Invite Crew',
    policyVersion: p.policyVersion,
  }];
}
