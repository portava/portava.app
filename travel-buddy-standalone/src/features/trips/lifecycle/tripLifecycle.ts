/**
 * TRIP-F23 — cancel, complete, archive and delete a trip, and the §3.1
 * lifecycle read (WP-10).
 *
 * Every one of these writes is the kernel's: the routes issue CANCEL_TRIP,
 * COMPLETE_TRIP and ARCHIVE_TRIP (DELETE is ARCHIVE_TRIP with
 * `soft_delete: true`) through `trip_kernel_execute` when
 * `trip_kernel_enabled` is on, with a flag-off twin otherwise
 * (routes/trips-expansion.ts, "Lifecycle routes"). This client sends the
 * intent and its Idempotency-Key; it never writes `trips.status` itself, and
 * it no longer reaches COMPLETE through a PATCH of the status field — POST
 * /complete is the route that also runs the §20.2 closeout.
 *
 * WHICH ACTIONS ARE OFFERED is the status registry's arrows
 * (lib/stateMachines/registry.ts TRIPS_STATUS), narrowed by product sense:
 * a completed trip is archived, not cancelled, although the registry would
 * allow it. The kernel re-checks every arrow; a refusal is shown by name.
 */
import { readTripJson, sendTripWrite, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';

export type LifecycleAction = 'cancel' | 'complete' | 'archive' | 'delete';

const OPEN_STATUSES = new Set(['draft', 'planning', 'upcoming', 'active']);

/** The actions the owner may take from `storedStatus`, in display order. */
export function lifecycleActions(storedStatus: string | null | undefined, isOwner: boolean): LifecycleAction[] {
  if (!isOwner) return [];
  const s = storedStatus ?? 'planning';
  if (s === 'archived') return [];
  if (OPEN_STATUSES.has(s)) return ['cancel', 'complete', 'archive', 'delete'];
  return ['archive', 'delete'];
}

export const ACTION_COPY: Record<LifecycleAction, { label: string; confirmTitle: string; confirmBody: string; done: string }> = {
  cancel: {
    label: 'Cancel trip',
    confirmTitle: 'Cancel this trip?',
    confirmBody: 'The crew is told the trip is cancelled. You can still archive it later.',
    done: 'Trip cancelled',
  },
  complete: {
    label: 'Mark trip as complete',
    confirmTitle: 'Mark trip as complete?',
    confirmBody: 'Completing the trip runs its closeout: plans are reconciled and memory candidates are prepared.',
    done: 'Trip completed',
  },
  archive: {
    label: 'Archive trip',
    confirmTitle: 'Archive this trip?',
    confirmBody: 'Archived trips leave your active lists. Archiving cannot be undone from the app.',
    done: 'Trip archived',
  },
  delete: {
    label: 'Delete trip',
    confirmTitle: 'Delete this trip?',
    confirmBody: 'The trip is removed from your lists (it is archived, so its history is kept). This cannot be undone from the app.',
    done: 'Trip deleted',
  },
};

export function runLifecycleAction(tripId: string, action: LifecycleAction, idempotencyKey: string): Promise<ApiWrite<unknown>> {
  if (action === 'delete') return sendTripWrite('DELETE', `/api/trips/${tripId}`, undefined, { idempotencyKey });
  return sendTripWrite('POST', `/api/trips/${tripId}/${action}`, undefined, { idempotencyKey });
}

export interface TripLifecycleRead {
  tripId: string;
  lifecycle: string;
  reason: string | null;
  unread: string[];
  storedStatus: string | null;
}

export function fetchTripLifecycle(tripId: string): Promise<ApiRead<TripLifecycleRead>> {
  return readTripJson<TripLifecycleRead>(
    `/api/trips/${tripId}/lifecycle`,
    (b) => typeof b?.lifecycle === 'string' && Array.isArray(b?.unread),
  );
}

/** "Planning", with the unread facts counted when there are any. */
export function lifecycleLabel(l: TripLifecycleRead): string {
  const words = l.lifecycle.toLowerCase().replace(/_/g, ' ');
  const head = words.charAt(0).toUpperCase() + words.slice(1);
  if (l.unread.length === 0) return head;
  return `${head} — ${l.unread.length} fact${l.unread.length === 1 ? '' : 's'} could not be read`;
}
