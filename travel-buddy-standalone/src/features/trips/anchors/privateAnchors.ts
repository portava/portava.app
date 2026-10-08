/**
 * Trips §14.1 private anchors on the client (census-trips TR256).
 *
 * The owner's decision of 2026-10-04: "Private anchors: Owner-only by default.
 * The owner can share an individual anchor with selected trip members; trip
 * membership or organizer status alone does not grant access."
 *
 * The SERVER decides who sees an anchor (domain/trips/policies/privateAnchorAccess.ts):
 * the map projection's `privateAnchors` layer now carries only the viewer's own
 * anchors and the ones granted to them, each with `meta.relation`. This module
 * reads that layer and talks to the grant routes; it never decides access.
 *
 * FAIL CLOSED ON AN OLDER SERVER. A point with no `meta.relation` came from a
 * server that served every member's anchors to every member. Such a point is
 * NOT drawn — the client must not become the leak the server stopped being.
 */
import { readTripJson, sendTripWrite, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';
import type { TripMapProjection } from '../map/tripMapProjection.ts';

export interface PrivatePlace {
  id: string;
  label: string | null;
  relation: 'own' | 'shared_with_me';
}

export type PrivatePlacesView =
  | { state: 'ok'; own: PrivatePlace[]; sharedWithMe: PrivatePlace[] }
  | { state: 'unread'; reason: string }
  | { state: 'no_source' };

export function privatePlacesOf(p: TripMapProjection): PrivatePlacesView {
  const layer = p.privateAnchors;
  if (layer.status === 'unread') return { state: 'unread', reason: layer.reason };
  if (layer.status === 'no_source') return { state: 'no_source' };
  const own: PrivatePlace[] = [];
  const sharedWithMe: PrivatePlace[] = [];
  for (const point of layer.items) {
    const relation = point.meta?.relation;
    if (relation === 'own') own.push({ id: point.id, label: point.label, relation });
    else if (relation === 'shared_with_me') sharedWithMe.push({ id: point.id, label: point.label, relation });
    // anything else: an older server's unscoped point — never drawn.
  }
  return { state: 'ok', own, sharedWithMe };
}

export interface AnchorShares {
  sharingEnabled: boolean;
  /** The server's three-valued read of the setting; absent from an older server. `unread` is not "off". */
  sharing?: 'on' | 'off' | 'unread';
  memberIds: string[];
}

function isShares(b: unknown): b is AnchorShares {
  const v = b as { sharingEnabled?: unknown; sharing?: unknown; memberIds?: unknown } | null;
  return !!v && typeof v.sharingEnabled === 'boolean' && Array.isArray(v.memberIds)
    && (v.sharing === undefined || v.sharing === 'on' || v.sharing === 'off' || v.sharing === 'unread')
    && v.memberIds.every((m) => typeof m === 'string');
}

const sharesPath = (tripId: string, itemId: string) =>
  `/api/trips/${encodeURIComponent(tripId)}/anchors/${encodeURIComponent(itemId)}/shares`;

export function fetchAnchorShares(tripId: string, itemId: string): Promise<ApiRead<AnchorShares>> {
  return readTripJson<AnchorShares>(sharesPath(tripId, itemId), isShares);
}

/**
 * The grant list AFTER a write, as the server read it back — or null when the
 * write did not land or its answer was unreadable. A caller never assumes its
 * own request succeeded.
 */
export function sharesAfter(w: ApiWrite<unknown>): AnchorShares | null {
  return w.state === 'done' && isShares(w.data) ? { sharingEnabled: w.data.sharingEnabled, ...(w.data.sharing ? { sharing: w.data.sharing } : {}), memberIds: [...w.data.memberIds] } : null;
}

export function grantAnchorShare(tripId: string, itemId: string, memberId: string): Promise<ApiWrite<unknown>> {
  return sendTripWrite('POST', sharesPath(tripId, itemId), { memberId });
}

export function revokeAnchorShare(tripId: string, itemId: string, memberId: string): Promise<ApiWrite<unknown>> {
  return sendTripWrite('DELETE', `${sharesPath(tripId, itemId)}/${encodeURIComponent(memberId)}`);
}

/**
 * What a member's toggle may do right now. Granting needs sharing ON; taking a
 * grant back is always allowed — a person must be able to undo what they gave.
 */
export function toggleAllowed(shares: AnchorShares, memberId: string): 'grant' | 'revoke' | 'unavailable' {
  if (shares.memberIds.includes(memberId)) return 'revoke';
  return shares.sharingEnabled ? 'grant' : 'unavailable';
}

export function placeLabel(p: PrivatePlace): string {
  return p.label?.trim() ? p.label.trim() : 'Private place';
}
