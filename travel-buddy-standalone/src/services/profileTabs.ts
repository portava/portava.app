/**
 * Profile content tabs — GET /api/users/:username/{posts,trips,events,circles}
 * (artifacts/api-server/src/routes/profileTabs.ts). TM-social, PLAT-F14.
 *
 * The server owns every visibility decision: a blocked pair gets
 * `{ blocked: true }`, a deactivated account `{ unavailable: true }`, a private
 * profile the viewer does not follow an empty page, a `show_*` opt-out an empty
 * page, and a post is only served at a tier the viewer may read. This module
 * only carries those answers to the screen without flattening them — in
 * particular a failed read is `status: 'error'`, never an empty page (DV-83).
 *
 * The stamps tab is NOT served from here: the profile already renders stamps
 * from the v2 profile route (StampsTab → /stamps/profile/:username), and a
 * second tab over the legacy passport_stamps table would show a second,
 * different stamp inventory for the same person.
 */
import { freshToken } from './apiToken.ts';

export type ProfileTabKind = 'posts' | 'trips' | 'events' | 'circles';

export interface ProfilePostItem {
  id: string;
  content: string | null;
  mediaUrls: string[];
  locationCity: string | null;
  locationCountry: string | null;
  tripId: string | null;
  createdAt: string;
}

export interface ProfileTripItem {
  id: string;
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  coverUrl: string | null;
}

export interface ProfileEventItem {
  eventId: string;
  title: string | null;
  startTime: string | null;
  endTime: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  coverImageUrl: string | null;
  isHosted: boolean;
}

export interface ProfileCircleItem {
  circleOwnerId: string;
  ownerHandle: string | null;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
  joinedAt: string;
}

export interface ProfileTabItemMap {
  posts: ProfilePostItem;
  trips: ProfileTripItem;
  events: ProfileEventItem;
  circles: ProfileCircleItem;
}

export type ProfileTabPage<K extends ProfileTabKind> =
  | { status: 'ok'; items: ProfileTabItemMap[K][]; nextCursor: string | null }
  | { status: 'blocked' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * Map one route response to a page. Exported so the decision is testable
 * without a network: `{ blocked }` and `{ unavailable }` win over `items`,
 * and a body without an `items` array is an error, not an empty tab.
 */
export function toProfileTabPage<K extends ProfileTabKind>(
  httpOk: boolean,
  status: number,
  body: unknown,
): ProfileTabPage<K> {
  const b = (body ?? {}) as { blocked?: unknown; unavailable?: unknown; items?: unknown; nextCursor?: unknown; message?: unknown };
  if (!httpOk) {
    return { status: 'error', message: typeof b.message === 'string' ? b.message : `API ${status}` };
  }
  if (b.blocked === true) return { status: 'blocked' };
  if (b.unavailable === true) return { status: 'unavailable' };
  if (!Array.isArray(b.items)) return { status: 'error', message: 'Unexpected response' };
  return {
    status: 'ok',
    items: b.items as ProfileTabItemMap[K][],
    nextCursor: typeof b.nextCursor === 'string' && b.nextCursor ? b.nextCursor : null,
  };
}

export async function getProfileTabPage<K extends ProfileTabKind>(
  kind: K,
  username: string,
  cursor?: string | null,
): Promise<ProfileTabPage<K>> {
  const base = apiBase();
  if (!base) return { status: 'error', message: 'Not configured' };
  const handle = username.replace(/^@+/, '');
  const qs = new URLSearchParams({ limit: '20' });
  if (cursor) qs.set('cursor', cursor);
  let token: string | null = null;
  try { token = await freshToken(); } catch { token = null; }
  try {
    const res = await fetch(`${base}/api/users/${encodeURIComponent(handle)}/${kind}?${qs.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json().catch(() => null);
    return toProfileTabPage<K>(res.ok, res.status, body);
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Network error' };
  }
}
