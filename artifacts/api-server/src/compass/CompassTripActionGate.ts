import type { SupabaseClient } from '@supabase/supabase-js';
import { canEditPlan, isAcceptedTripMember } from '../lib/http.js';

/** Never silently discard an explicit scheduling request or normalize an
 * impossible calendar date into a different day. */
export function tripProposalDate(value: unknown, start?: string | null, end?: string | null):
  { ok: true; dayDate: string | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, dayDate: null };
  const realDate = (day: unknown): day is string => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (!realDate(value)) return { ok: false, error: 'Choose a real calendar date in YYYY-MM-DD format before proposing this item. Nothing was added.' };
  if ((realDate(start) && value < start) || (realDate(end) && value > end)) {
    return { ok: false, error: 'That date is outside this trip’s dates. Ask which day within the trip to use; do not change the trip dates or drop the requested day. Nothing was added.' };
  }
  return { ok: true, dayDate: value };
}

// Resolve only a single explicit command. References to places and trip IDs in
// questions, quoted examples, multi-step requests or unrelated clauses stay in
// the normal tool loop.
const tripAdd = /^(?:please\s+)?(?:add|save|put)\s+[^.!?\n]{1,220}?\s+(?:to|in|on|into)\s+(?:(?:my|the)\s+)?trip\s+(?:id\s+)?([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})(?:\s*[.!]?\s*)(?:(?:please\s+)?(?:do not|don't|don’t)\s+(?:say|mark|claim)\s+(?:it(?:'s| is| was)?\s+)?(?:was\s+)?(?:saved|added)\s+until\s+I\s+confirm[.!]?)?$/i;

export async function refuseExplicitTripAdd(client: SupabaseClient, viewerId: string, prompt: string) {
  const tripId = tripAdd.exec(prompt.trim())?.[1];
  if (!tripId) return null;
  try {
    if (await isAcceptedTripMember(client, tripId, viewerId) && await canEditPlan(client, tripId, viewerId)) return null;
    return { reason: 'trip_edit_access_required', message: 'You need edit access to that trip before Compass can propose a change.', retryable: false };
  } catch {
    return { reason: 'trip_access_unavailable', message: 'Compass couldn’t check your access to that trip. Please try again.', retryable: true };
  }
}
