/**
 * Global Input Intelligence — §24: the ONLY place a reviewed paste becomes
 * data (flow GII-F08, census G162).
 *
 * Called by the review screen's confirm button with exactly the destinations
 * the person ticked — never with the extraction itself. In a Trip being edited
 * each one is written through the Trip's own endpoint
 * (`services/tripDestinations.ts#addDestination`, which carries the route's own
 * membership and permission checks); in a Trip being created nothing exists to
 * write to yet, so they join the draft the create screen persists.
 *
 * A write that fails is RETURNED, not dropped: the review screen keeps those
 * rows and offers Retry, so "added 3 of 4" can never read as "added 4".
 */
import { addDestination as defaultAdd, type TripDestination } from '../../../services/tripDestinations.ts';
import type { PasteDestination } from './pasteReview.ts';
import { reportInputTaskOutcome, type OutcomeEntity, type TaskOutcomeField } from '../services/outcomeLearning.ts';

/** The field the paste-to-Trip flow serves (DestinationListEditor's PasteReviewSheet). */
export const PASTE_TRIP_FIELD: TaskOutcomeField = { fieldId: 'trip.destination', context: 'trip_destination' };

export interface PersistedPaste {
  saved: Array<{ destination: PasteDestination; serverId: string | null }>;
  failed: PasteDestination[];
}

export async function persistPastedDestinations(
  tripId: string | undefined,
  destinations: readonly PasteDestination[],
  firstPosition: number,
  add: typeof defaultAdd = defaultAdd,
  report: typeof reportInputTaskOutcome = reportInputTaskOutcome,
): Promise<PersistedPaste> {
  const out: PersistedPaste = { saved: [], failed: [] };
  if (!tripId) {
    for (const d of destinations) out.saved.push({ destination: d, serverId: null });
    return out;
  }
  let position = firstPosition;
  for (const d of destinations) {
    let row: TripDestination | null = null;
    try {
      row = await add(tripId, {
        city: d.city,
        country: d.country,
        lat: d.lat,
        lng: d.lng,
        placeId: d.placeId,
        position,
      });
    } catch {
      row = null;
    }
    if (row && typeof row.id === 'string') {
      out.saved.push({ destination: d, serverId: row.id });
      position += 1;
    } else {
      out.failed.push(d);
    }
  }
  // §45 / OD-INPUT-1 — the downstream task this field served has now actually
  // happened (or failed) on the server. Reported ONLY in a Trip being edited:
  // in a Trip being created nothing was written above, and "added to a draft" is
  // not a completed task. The reporter does nothing at all unless this account
  // opted in to outcome learning. Credited: the canonical CITIES that were
  // written — `trip_destination` keeps per-user memory of cities, not places.
  const credited: OutcomeEntity[] = out.saved
    .filter((s) => s.destination.entityType === 'city' && !!s.destination.placeId)
    .map((s) => ({ entityType: 'city', entityId: s.destination.placeId as string }));
  if (destinations.length > 0) {
    report(PASTE_TRIP_FIELD, 'trip_destinations_saved', out.failed.length === 0, credited);
  }
  return out;
}
