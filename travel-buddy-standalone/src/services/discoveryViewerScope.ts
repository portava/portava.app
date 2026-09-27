/**
 * discoveryViewerScope — WHOSE Discovery answers this device is holding.
 * census-discovery §50 (the client-correctness lane).
 *
 * WHY THIS EXISTS
 * ===============
 * `GET /api/discovery` and `GET /api/discovery/community` used to be called with
 * no Authorization header, so every production serve was anonymous and one
 * device cache could safely hold one answer per (city, category, page). Once
 * the viewer's token is sent, the answer is PER VIEWER IN CONTENT, not only in
 * order: the server removes places whose submitter the viewer blocked or muted
 * (both directions of a block), the viewer's "Not interested" dismissals, rows
 * outside the viewer's age bounds and Layover-gated rows, and it stamps each
 * item with a `recommendationId` minted for THIS viewer's exposure. A device
 * cache keyed without the viewer would then paint user X's page for user Y on
 * the same phone — X's recommendation ids included — and would go on
 * re-showing a place for up to four minutes after the viewer dismissed it or
 * blocked its author, even though the server stops serving it on the very next
 * request.
 *
 * THE MODEL — one scope, two ways it moves
 * ========================================
 * A SCOPE is (viewer, epoch).
 *
 *   viewer  who the cached answers belong to: `anon`, or `u:<user id>`. Learned
 *           from two places, both authoritative for the moment they speak:
 *             • the auth layer (SessionContext) on every auth event, before any
 *               screen re-renders — this is what protects a SYNCHRONOUS cache
 *               read at mount, which runs before any request could say who is
 *               asking;
 *             • every Discovery request, from the token it is about to send —
 *               the token IS the identity the server will personalise for.
 *   epoch   bumps on every viewer change and on every action that changes what
 *           the server will serve this viewer (block, unblock, mute, unmute,
 *           dismiss).
 *
 * A cache entry records the scope it was written under and is readable only in
 * that exact scope. Every scope change also CLEARS the registered caches, so a
 * previous viewer's answers do not even sit in memory after a switch.
 *
 * A request records the scope it was sent in (its LEASE). When it resolves:
 *   • viewer moved  → the answer belongs to somebody else and is DISCARDED;
 *                     the caller gets `ok: false`, never another person's page;
 *   • epoch moved   → the answer is the current viewer's, but may predate a
 *                     block or dismissal, so it is returned and NOT cached.
 *
 * WHAT THIS DOES NOT CLAIM
 * ========================
 * `freshToken()` returns null both when signed out and when a refresh FAILED
 * (docs/architecture/blocker-ledger.md, API_TOKEN_SIGNED_OUT_VS_UNREADABLE), so
 * a signed-in viewer whose refresh failed is served anonymously. That is the
 * server's anonymous answer, not a leak between viewers, and it is scoped
 * `anon` here, so it is not replayed once the token recovers.
 *
 * Pure module state, no imports: the services that must invalidate (blocks,
 * mutes, the dismiss path) can call it without pulling in the Discovery service.
 */

/** The anonymous viewer. Not a UUID, so it can never equal a user id. */
export const ANONYMOUS_VIEWER = 'anon';

export type DiscoveryViewerKey = string;

/** The scope an answer was fetched or cached under. `viewer` is undefined until anything has said who is looking. */
export interface DiscoveryScope {
  viewer: DiscoveryViewerKey | undefined;
  epoch: number;
}

/** What a request carries: the scope it was sent in, and its request init. */
export interface DiscoveryLease {
  scope: DiscoveryScope;
  /** `Authorization: Bearer …` when signed in; undefined — NO header — when anonymous. */
  init: RequestInit | undefined;
}

/** Why a Discovery answer was withheld from the screen: it was fetched for another viewer. */
export const VIEWER_CHANGED_ERROR = 'The signed-in account changed while this loaded.';

let _viewer: DiscoveryViewerKey | undefined;
let _epoch = 0;
const _listeners = new Set<() => void>();

/** The `sub` claim of a JWT, or null when the token is not a decodable JWT. */
function jwtSubject(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part || typeof globalThis.atob !== 'function') return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(globalThis.atob(padded)) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * The viewer a request made with `token` is made AS.
 *
 * A Supabase access token is a JWT whose `sub` is the user id — the same id the
 * server resolves with `auth.getUser(token)` and the same one SessionContext
 * reports — so a signed-in request and an auth event name the same viewer. A
 * token that is not a decodable JWT is keyed by itself: never shared between
 * two people, at the cost of a cache miss after a refresh.
 */
export function viewerKeyForToken(token: string | null | undefined): DiscoveryViewerKey {
  if (!token) return ANONYMOUS_VIEWER;
  const sub = jwtSubject(token);
  return sub ? `u:${sub}` : `t:${token}`;
}

/** The viewer SessionContext reports: a user id, or null when signed out. */
export function viewerKeyForUser(userId: string | null | undefined): DiscoveryViewerKey {
  return userId ? `u:${userId}` : ANONYMOUS_VIEWER;
}

function moveScope(): void {
  _epoch += 1;
  for (const clear of [..._listeners]) {
    try { clear(); } catch { /* one cache failing to clear must not stop the others */ }
  }
}

/** Record who is looking. A different viewer than before clears every registered cache. */
export function noteDiscoveryViewer(viewer: DiscoveryViewerKey): void {
  if (_viewer === viewer) return;
  _viewer = viewer;
  moveScope();
}

/** The auth layer's entry point: call on every auth event and on sign-out. */
export function setDiscoveryViewerFromSession(userId: string | null | undefined): void {
  noteDiscoveryViewer(viewerKeyForUser(userId));
}

/**
 * The viewer did something the server reflects on its very next answer — a
 * block, an unblock, a mute, an unmute, a "Not interested". Every device-cached
 * Discovery answer predates it, so none may be painted again.
 */
export function invalidateDiscoveryCaches(): void {
  moveScope();
}

export function currentDiscoveryScope(): DiscoveryScope {
  return { viewer: _viewer, epoch: _epoch };
}

/** Is `scope` still the scope the device is in? Both halves, exactly. */
export function isCurrentDiscoveryScope(scope: DiscoveryScope | null | undefined): boolean {
  return !!scope && scope.viewer === _viewer && scope.epoch === _epoch;
}

/** Is the lease's viewer still the viewer? (Epoch aside — see the file header.) */
export function isLeaseViewerCurrent(lease: DiscoveryLease): boolean {
  return lease.scope.viewer === _viewer;
}

/**
 * Open a request as the viewer `token` names.
 *
 * The header is built exactly as every authenticated call in
 * services/discovery.ts builds it — `Authorization: Bearer <freshToken()>` —
 * and is OMITTED, not blanked, when there is no token, so a signed-out request
 * stays anonymous (the routes support it).
 */
export function openDiscoveryLease(token: string | null | undefined): DiscoveryLease {
  noteDiscoveryViewer(viewerKeyForToken(token));
  return {
    scope: currentDiscoveryScope(),
    init: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  };
}

/** Register a cache to be cleared whenever the scope moves. Returns an unsubscribe. */
export function onDiscoveryScopeChange(clear: () => void): () => void {
  _listeners.add(clear);
  return () => { _listeners.delete(clear); };
}

/** Test seam: forget the viewer and restart the epoch. Registered caches are cleared. */
export function _resetDiscoveryViewerScopeForTests(): void {
  _viewer = undefined;
  moveScope();
  _epoch = 0;
}
