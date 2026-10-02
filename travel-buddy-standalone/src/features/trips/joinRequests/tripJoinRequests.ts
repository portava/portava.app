/**
 * TRIP-F06 — join requests on the client (WP-10).
 *
 * The owner reviews the pending requests on their trips (GET
 * /trips/join-requests) and approves or declines each. Approval is the write
 * the kernel owns: the route issues ADD_PARTICIPANT (or SET_PARTICIPANT_ROLE)
 * through `trip_kernel_execute` when `trip_kernel_enabled` is on and its
 * flag-off twin otherwise (routes/trips-expansion.ts, approve). This client
 * never writes `trip_members`; it sends the intent with its own
 * Idempotency-Key so a retry after a lost response cannot add the member twice.
 *
 * The requester sends a request and may withdraw it. The route answers a
 * second request while one is pending with `already_requested` and that
 * request's id WITHOUT filing another (the same route, idempotent by design),
 * which is how a returning requester recovers the id to cancel — no new read
 * route was needed (decision WP10-D3 in census-trips §77).
 */
import { readTripJson, sendTripWrite, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';

export interface JoinRequestUser { id: string; handle: string | null; name: string | null; avatarUrl: string | null }
export interface JoinRequest {
  id: string;
  tripId: string;
  status: string;
  message: string | null;
  createdAt: string;
  /** null when the requester's profile could not be read — the request still stands. */
  user: JoinRequestUser | null;
}

export async function fetchJoinRequests(): Promise<ApiRead<JoinRequest[]>> {
  const r = await readTripJson<{ requests: JoinRequest[] }>(
    '/api/trips/join-requests',
    (b) => Array.isArray(b?.requests) && b.requests.every((x: any) => x && typeof x.id === 'string' && typeof x.tripId === 'string'),
  );
  return r.state === 'ok' ? { state: 'ok', data: r.data.requests } : r;
}

/** The requests for one trip, newest first. */
export function requestsForTrip(all: readonly JoinRequest[], tripId: string): JoinRequest[] {
  return all.filter((r) => r.tripId === tripId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function requesterLabel(r: JoinRequest): string {
  if (!r.user) return 'Someone (profile unavailable)';
  const name = r.user.name?.trim();
  const handle = r.user.handle ? `@${r.user.handle}` : null;
  if (name && handle) return `${name} (${handle})`;
  return name || handle || 'Someone';
}

export function approveJoinRequest(tripId: string, requestId: string, idempotencyKey: string): Promise<ApiWrite<unknown>> {
  return sendTripWrite('POST', `/api/trips/${tripId}/join-requests/${requestId}/approve`, undefined, { idempotencyKey });
}

export function declineJoinRequest(tripId: string, requestId: string): Promise<ApiWrite<unknown>> {
  return sendTripWrite('POST', `/api/trips/${tripId}/join-requests/${requestId}/decline`);
}

export type SendJoinRequestResult =
  | { state: 'pending'; requestId: string }
  | { state: 'member' }
  | Exclude<ApiWrite<unknown>, { state: 'done' }>;

export async function sendJoinRequest(tripId: string, message?: string | null): Promise<SendJoinRequestResult> {
  const w = await sendTripWrite<{ status?: string; requestId?: string }>(
    'POST', `/api/trips/${tripId}/join-request`, message ? { message } : {},
  );
  if (w.state !== 'done') return w;
  if (w.data?.status === 'already_member') return { state: 'member' };
  if (typeof w.data?.requestId === 'string') return { state: 'pending', requestId: w.data.requestId };
  return { state: 'unavailable', detail: 'unreadable response' };
}

export function cancelJoinRequest(tripId: string, requestId: string): Promise<ApiWrite<unknown>> {
  return sendTripWrite('POST', `/api/trips/${tripId}/join-requests/${requestId}/cancel`);
}
