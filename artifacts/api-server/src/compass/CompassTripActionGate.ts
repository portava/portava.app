import type { SupabaseClient } from '@supabase/supabase-js';
import { canEditPlan, isAcceptedTripMember } from '../lib/http.js';

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
