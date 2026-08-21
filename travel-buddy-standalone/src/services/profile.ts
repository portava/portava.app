/**
 * Profile service — wraps the API server's profile endpoints.
 * All mutations route through the API server (service-role pattern, matching
 * createTrip / createPost). Reads also go through the API server so we can
 * do server-side joins/filtering cleanly.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import type { OwnProfile, PublicProfile, PassportPostcard, PassportStamp, PostcardMediaItem } from '../types/models.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void { _testAuthToken = t; }

async function freshToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('err_address_unreachable') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

export interface ProfileResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: string;
  message?: string;
  /** Fields the server could not persist (schema drift partial save). */
  unsavedFields?: string[];
}

/* ---------- Own profile ---------- */

export async function getMyProfile(): Promise<ProfileResult<OwnProfile>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' };

  try {
    const res = await fetch(`${apiBase()}/api/me/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export interface UpdateProfileInput {
  displayName?: string;
  username?: string;
  bio?: string;
  homeCity?: string | null;
  homeCountry?: string | null;
  currentCity?: string | null;
  interests?: string[];
  passportVisibility?: 'public' | 'followers_only' | 'private';
  avatarUrl?: string;
  /** Pixel width of the uploaded avatar (from upload response). */
  avatarImageWidth?: number | null;
  /** Pixel height of the uploaded avatar (from upload response). */
  avatarImageHeight?: number | null;
  coverUrl?: string;
  /** Pixel width of the uploaded cover photo (from upload response). */
  coverImageWidth?: number | null;
  /** Pixel height of the uploaded cover photo (from upload response). */
  coverImageHeight?: number | null;
  travelStyle?: string | null;
  openToMeet?: boolean;
  spokenLanguages?: string[];
  defaultLanguage?: string | null;
  travelStyles?: string[];
  travelPace?: 'slow' | 'balanced' | 'packed' | null;
  budgetStyle?: 'budget' | 'mid-range' | 'luxury' | 'flexible' | null;
  travelGroupStyle?: string[];
  lookingFor?: string[];
  comfortLevel?: string | null;
  availabilityTags?: string[];
  planningStyle?: string | null;
  publicSocialLinks?: Record<string, string>;
  preferredLanguage?: string | null;
  dateOfBirth?: string | null;
  /** Permutation of the five passport section keys; null resets to canonical order. */
  passportSectionOrder?: string[] | null;
  /** Permutation of the five passport tab keys; null resets to canonical order. */
  passportTabOrder?: string[] | null;
  /** Hidden section keys for the owner's passport; null clears all hidden sections. */
  passportHiddenSections?: string[] | null;
  /**
   * Set to true by the onboarding flow after the user completes all steps.
   * Triggers a server-side silent auto-follow of @Portava so the new user's
   * feed is non-empty from day one.
   */
  onboardingComplete?: boolean;
}

export async function updateMyProfile(patch: UpdateProfileInput): Promise<ProfileResult<OwnProfile>> {
  if (!_testAuthToken && (!isSupabaseConfigured || !apiBase())) {
    return { ok: false, data: null, errorKind: 'config_error' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message ?? `API ${res.status}` };
    }
    const data = (await res.json()) as OwnProfile & { unsavedFields?: string[]; warning?: string };
    if (Array.isArray(data.unsavedFields) && data.unsavedFields.length > 0) {
      // Partial success: the server saved what it could but dropped some fields
      // (database schema drift). Surface as a failure so every save screen shows
      // the message instead of pretending everything saved.
      return {
        ok: false,
        data,
        errorKind: 'partial_save',
        message: data.warning ?? `Some fields could not be saved: ${data.unsavedFields.join(', ')}`,
        unsavedFields: data.unsavedFields,
      };
    }
    return { ok: true, data };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Username check ---------- */

export async function checkUsername(username: string): Promise<{ available: boolean; reason?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { available: false, reason: 'Backend not configured' };
  const token = await freshToken();
  if (!token) return { available: false, reason: 'Not signed in' };

  try {
    const res = await fetch(
      `${apiBase()}/api/users/check-username?username=${encodeURIComponent(username.toLowerCase().trim())}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return { available: false, reason: 'Could not check username' };
    return await res.json();
  } catch {
    return { available: false, reason: 'Network error' };
  }
}

/* ---------- Avatar upload ---------- */

export async function uploadAvatar(uri: string, mimeType = 'image/jpeg'): Promise<ProfileResult<{ url: string; path: string | null; width?: number | null; height?: number | null }>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' };

  let blob: Blob;
  try {
    const resp = await fetch(uri);
    blob = await resp.blob();
  } catch (e) {
    return { ok: false, data: null, errorKind: 'read_failed', message: 'Failed to read image file' };
  }

  if (blob.size > 5 * 1024 * 1024) {
    return { ok: false, data: null, errorKind: 'too_large', message: 'Avatar must be under 5 MB' };
  }

  try {
    const res = await fetch(`${apiBase()}/api/me/avatar/upload`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, Authorization: `Bearer ${token}` },
      body: blob,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: 'upload_failed', message: (body as any)?.message ?? `Upload failed (${res.status})` };
    }
    const body = await res.json();
    return { ok: true, data: { url: body.url, path: body.path ?? null, width: body.width ?? null, height: body.height ?? null } };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'upload_failed', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Cover photo upload ---------- */

export async function uploadCover(uri: string, mimeType = 'image/jpeg'): Promise<ProfileResult<{ url: string; path: string | null; width?: number | null; height?: number | null }>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' };

  let blob: Blob;
  try {
    const resp = await fetch(uri);
    blob = await resp.blob();
  } catch (e) {
    return { ok: false, data: null, errorKind: 'read_failed', message: 'Failed to read image file' };
  }

  if (blob.size > 10 * 1024 * 1024) {
    return { ok: false, data: null, errorKind: 'too_large', message: 'Cover photo must be under 10 MB' };
  }

  try {
    const res = await fetch(`${apiBase()}/api/me/cover/upload`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, Authorization: `Bearer ${token}` },
      body: blob,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: 'upload_failed', message: (body as any)?.message ?? `Upload failed (${res.status})` };
    }
    const body = await res.json();
    return { ok: true, data: { url: body.url, path: body.path ?? null, width: body.width ?? null, height: body.height ?? null } };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'upload_failed', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Orphan cleanup — called when PATCH /me/profile fails after upload ---------- */

export async function deleteOrphanedAvatar(path: string): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  const token = await freshToken();
  if (!token) return;
  try {
    await fetch(`${apiBase()}/api/me/avatar/file`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path }),
    });
  } catch { /* best-effort */ }
}

export async function deleteOrphanedCover(path: string): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  const token = await freshToken();
  if (!token) return;
  try {
    await fetch(`${apiBase()}/api/me/cover/file`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path }),
    });
  } catch { /* best-effort */ }
}

/* ---------- Public profile (share card) ---------- */

export interface PublicProfileCard {
  id?: string;
  username: string | null;
  displayName: string | null;
  bio?: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  tripCount: number;
  stampCount: number;
  visibility: string;
  private?: boolean;
  homeCity?: string | null;
  homeCountry?: string | null;
  travelStyle?: string | null;
  interests?: string[];
  verified?: boolean;
  verificationStatus?: string;
  verifiedAt?: string | null;
  passportVisibility?: string;
  createdAt?: string | null;
  /** True when this profile is an @Portava Official account. */
  isOfficial?: boolean;
}

export async function getPublicProfile(username: string): Promise<ProfileResult<PublicProfileCard>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error' };
  }

  try {
    const res = await fetch(
      `${apiBase()}/api/users/${encodeURIComponent(username)}/profile`,
    );
    if (res.status === 404) return { ok: false, data: null, errorKind: 'not_found', message: 'User not found' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Public passport ---------- */

export async function getPublicPassport(username: string): Promise<ProfileResult<PublicProfile | { private: true }>> {
  if (!apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error' };
  }

  // Auth is optional server-side (unauthenticated callers get a fully-anonymous
  // viewer), but WHEN a session exists we must attach it — otherwise the server
  // can never resolve viewerId and every relationship flag (is_friend,
  // friend_request_pending) silently comes back false even when a real pending
  // request exists. Unlike getMyProfile(), a missing token here is not fatal.
  const token = await freshToken();

  try {
    const res = await fetch(
      `${apiBase()}/api/users/${encodeURIComponent(username)}/passport`,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    );
    if (res.status === 404) return { ok: false, data: null, errorKind: 'not_found', message: 'User not found' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: 'db_error', message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/**
 * Enrich raw API postcard objects with derived fields.
 * The API returns `media` (snake_case PostcardMediaItem[]); we derive `hasVideo`
 * and `primaryMediaType` from it so UI components can use them without re-computing.
 */
function enrichPostcard(raw: Record<string, unknown>): PassportPostcard {
  const media = (raw['media'] ?? []) as PostcardMediaItem[];
  const readyMedia = media.filter((m) => m.processing_status === 'ready');
  const primary = readyMedia[0] ?? media[0];
  return {
    ...(raw as unknown as PassportPostcard),
    media,
    hasVideo: media.some((m) => m.media_type === 'video'),
    primaryMediaType: primary?.media_type ?? (raw['mediaUrl'] ? 'image' : 'none'),
  };
}

export type PostcardsSentinel = 'private' | 'blocked' | 'unavailable';

export type PublicPostcardsResult =
  | { ok: true; data: PassportPostcard[]; sentinel?: undefined }
  | { ok: true; data: PassportPostcard[]; sentinel: PostcardsSentinel }
  | { ok: false; data: null; errorKind?: string; message?: string };

export async function getPublicPostcards(username: string): Promise<PublicPostcardsResult> {
  if (!apiBase()) return { ok: true, data: [] };

  try {
    const res = await fetch(
      `${apiBase()}/api/users/${encodeURIComponent(username)}/passport/postcards`,
    );
    if (!res.ok) return { ok: true, data: [] };
    const body = await res.json();
    // Detect sentinel shapes returned by the API.
    if (body.blocked === true)     return { ok: true, data: [], sentinel: 'blocked' };
    if (body.unavailable === true) return { ok: true, data: [], sentinel: 'unavailable' };
    if (body.private === true)     return { ok: true, data: [], sentinel: 'private' };
    const raw: Record<string, unknown>[] = body.postcards ?? [];
    return { ok: true, data: raw.map(enrichPostcard) };
  } catch {
    return { ok: true, data: [] };
  }
}

/* ---------- Own stamps ----------
 * getMyStamps (GET /api/me/passport/stamps) was removed: the passport screen
 * now has a single stamps pipeline — usePassport pages GET /api/stamps/me via
 * services/passportStamps.getMyPassportStamps and derives legacy shapes from
 * it, so the same stamps are no longer downloaded twice from two endpoints.
 */

/* ---------- Own passport postcards ---------- */

export async function getMyPassportPostcards(): Promise<ProfileResult<PassportPostcard[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/passport/postcards`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: true, data: [] };
    const body = await res.json();
    const raw: Record<string, unknown>[] = body.postcards ?? [];
    return { ok: true, data: raw.map(enrichPostcard) };
  } catch {
    return { ok: true, data: [] };
  }
}

/* ---------- Postcard actions ---------- */

export interface PostcardPatch {
  note?: string | null;
  visibility?: 'public' | 'private' | 'trip_only';
  pin?: boolean;
}

export async function updatePostcard(id: string, patch: PostcardPatch): Promise<ProfileResult<PassportPostcard>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/passport/postcards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export async function removePostcard(id: string): Promise<ProfileResult<null>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/passport/postcards/${id}/remove`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204) return { ok: true, data: null };
    const body = await res.json().catch(() => ({}));
    return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

// ── Privacy settings ──────────────────────────────────────────────────────────

export interface PrivacySettings {
  profile_visibility: 'public' | 'followers_only' | 'private';
  show_profile_picture_publicly: boolean;
  show_current_city: boolean;
  show_home_country: boolean;
  show_visited_places: boolean;
  show_upcoming_trips: boolean;
  show_past_trips: boolean;
  show_posts: boolean;
  show_stamps: boolean;
  show_friends: boolean;
  show_followers: boolean;
  show_real_name: boolean;
  allow_messages_from: 'everyone' | 'friends' | 'followers' | 'nobody';
  allow_friend_requests: boolean;
  allow_follow: boolean;
  allow_tagging: boolean;
  allow_profile_discovery: boolean;
  delayed_posting_default: boolean;
  precise_location_visible: boolean;
}

export async function getPrivacySettings(): Promise<ProfileResult<PrivacySettings>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/privacy`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export async function updatePrivacySettings(
  fields: Partial<PrivacySettings>,
): Promise<ProfileResult<PrivacySettings>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/privacy`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

// ── Account status ────────────────────────────────────────────────────────────

export type AccountStatus = 'active' | 'deactivated' | 'pending_deletion';

export interface AccountStatusResult {
  accountStatus: AccountStatus;
  deletionScheduledAt: string | null;
}

/**
 * errorKind returned when the CLIENT could not mint an access token for a
 * request — `freshToken()` returned null.
 *
 * It is deliberately NOT 'unauthenticated', and the distinction is the whole of
 * task 3658. 'unauthenticated' is the SERVER's verdict on a token it actually
 * received: `requireUser` (api-server `lib/http.ts`) answers 401
 * `{ error: 'unauthenticated' }` for a missing, malformed, invalid or expired
 * bearer token. Both used to arrive here under the same name, so no caller
 * could tell them apart.
 *
 * They are not the same fact and they do not license the same response:
 *
 *   - a 401 IS a statement about the caller's credentials;
 *   - `freshToken()` returning null is a statement about ONE token mint, and
 *     says nothing at all about whether the user is signed in. The session can
 *     be entirely live while a single mint loses a refresh race, is handed
 *     auth-js's cached refresh failure during its cooldown window, or has its
 *     rotation dropped by auth-js's commit guard.
 *
 * Reporting the second as 'unauthenticated' states something that is not true,
 * and `SessionContext.fetchAccountStatus` — which fails closed on anything it
 * cannot read as a transient — then put a full-page "Couldn't verify your
 * account" wall in front of a signed-in user whose other requests were
 * succeeding at the same moment.
 *
 * NOTE the 13 other `freshToken()` call sites in this file still return
 * 'unauthenticated' for the same non-fact. They are the same latent defect and
 * are deliberately NOT changed here: each one's caller decides something
 * different on it (`PulseCreate.machine.ts:224` force-signs-out, for instance),
 * and re-deciding those without a reproduction for each is how a fix becomes a
 * new bug. Named rather than silently half-fixed.
 */
export const TOKEN_UNAVAILABLE = 'token_unavailable';

export async function getAccountStatus(): Promise<ProfileResult<AccountStatusResult>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) {
    return {
      ok: false,
      data: null,
      errorKind: TOKEN_UNAVAILABLE,
      message: 'Could not obtain a session token',
    };
  }

  try {
    const res = await fetch(`${apiBase()}/api/me/account-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

// ── Account controls ──────────────────────────────────────────────────────────

export async function deactivateAccount(): Promise<ProfileResult<{ deactivated: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/deactivate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ---------- Profile analytics ---------- */

export interface ProfileAnalytics {
  profileViews: { sevenDay: number; thirtyDay: number };
  followerGrowth: { sevenDay: number; thirtyDay: number };
  postImpressions7d: number;
  stampsEarned: number;
  milestones: Array<{ level: number; celebratedAt: string }>;
}

export async function getProfileAnalytics(): Promise<ProfileResult<ProfileAnalytics>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' };

  try {
    const res = await fetch(`${apiBase()}/api/me/profile/analytics`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export async function reactivateAccount(): Promise<ProfileResult<{ reactivated: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/reactivate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export async function requestAccountDeletion(): Promise<ProfileResult<{ requested: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/delete-request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, errorKind: (body as any)?.error ?? 'db_error', message: (body as any)?.message };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}
