/**
 * Highlights service — typed fetch wrappers for all highlight API endpoints.
 * Follows the freshToken / apiFetch pattern used by posts.ts and other services.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export type HighlightVisibility = 'public' | 'travelers_nearby' | 'circle_only' | 'trip_only' | 'private';

export interface HighlightAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
}

export interface Highlight {
  id: string;
  ownerId: string;
  mediaUrl: string;
  mediaType: string;
  videoDurationSeconds: number | null;
  caption: string | null;
  locationName: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  visibility: HighlightVisibility;
  expiresAt: string;
  createdAt: string;
  deletedAt: string | null;
  author: HighlightAuthor | null;
  viewCount: number;
  likeCount: number;
  viewedByMe: boolean;
  likedByMe: boolean;
  filterId: string;
  filterIntensity: number;
  mediaThumbnailUrl?: string | null;
  mediaDurationSeconds?: number | null;
  /**
   * §12 manual_pin. THREE-valued, and the three states are not interchangeable:
   *
   *   a timestamp — pinned, and this is when.
   *   `null`      — the server projected the column and it is empty: not pinned.
   *   `undefined` — the server did NOT project it. Migration 2723 is absent on
   *                 that deployment, so `highlightColumns` falls back to the
   *                 narrow select and no class field is sent at all.
   *
   * Collapsing the last two would put a pin affordance on a build that cannot
   * store a pin, where every tap answers `feature_disabled`. Collapsing the
   * first two makes UNPIN_HIGHLIGHT unreachable, which is the trap §17 names.
   */
  pinnedAt?: string | null;
  /**
   * §21 Archive — "retain canonical Memory; remove from normal browsing unless
   * explicitly requested". Non-null only on `GET /highlights/archived`: every
   * other read filters `archived_at IS NULL`, so a row from the profile or a
   * feed always carries `null` here.
   *
   * Archive is NOT delete, and §21 requires the two to stay separate "in both
   * data model and UX". `deletedAt` above is the terminal one.
   */
  archivedAt?: string | null;
  /**
   * §12 / §3.6 — the Memories this Highlight projects.
   *
   * THREE-VALUED, for the same reason `pinnedAt` is:
   *
   *   a non-empty array — this Highlight projects these Memories.
   *   `[]`              — the server answered and this Highlight is SOURCELESS.
   *   `undefined`       — the read did not carry provenance at all.
   *
   * Only `POST /highlights` projects this field today; the list reads do not,
   * so a Highlight from a feed or the profile carries `undefined` here and a
   * caller that wants its sources asks `fetchHighlightSources`. Collapsing
   * `undefined` into `[]` would print "built from nothing" over every
   * Highlight in the app on the strength of a field nobody sent — which is
   * §28.11's failure ("never swallow … into plausible-looking empty history")
   * applied to provenance.
   */
  sourceMemoryIds?: string[];
}

export interface HighlightViewer {
  userId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  viewedAt: string;
  likedByMe: boolean;
}

export type HighlightErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_payload'
  | 'db_error'
  | 'feature_disabled'
  // §28.11. The SERVER's word for "the read could not be performed", 503 and
  // retryable. It is deliberately NOT `db_error`: the API server refuses with
  // this rather than serving an empty feed, because "nobody you follow has an
  // active Highlight" is a claim about other people and it must be true.
  // Folding it into `db_error` here gave the client a second vocabulary for a
  // word the server owns, and lost the only signal that a retry is worth
  // offering.
  | 'degraded_unavailable'
  | 'network_unreachable'
  | 'config_error';

export interface HighlightResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: HighlightErrorKind;
  message?: string;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

function mapApiError<T>(status: number, body: any): HighlightResult<T> {
  const code = (body?.error as HighlightErrorKind) ?? 'db_error';
  const known: HighlightErrorKind[] = [
    'unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error',
    // ADDED: the create path refuses a §4 class this deployment cannot store
    // with `feature_disabled`. Flattening it to `db_error` would put "something
    // went wrong, try again" on a choice that will never work on this build.
    'feature_disabled',
    // ADDED: the feeds and the profile read refuse with this when a scoping
    // read failed. See the comment on the union member.
    'degraded_unavailable',
  ];
  const errorKind = known.includes(code) ? code : 'db_error';
  return { ok: false, data: null, errorKind, message: body?.message ?? `API ${status}` };
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

function mapHighlight(r: any): Highlight {
  return {
    id: r.id,
    ownerId: r.owner_id,
    mediaUrl: r.media_url,
    mediaType: r.media_type,
    videoDurationSeconds: r.video_duration_seconds ?? null,
    caption: r.caption ?? null,
    locationName: r.location_name ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    visibility: r.visibility,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    deletedAt: r.deleted_at ?? null,
    author: r.author
      ? { id: r.author.id, handle: r.author.handle, name: r.author.name, avatarUrl: r.author.avatarUrl ?? null }
      : null,
    viewCount: r.viewCount ?? 0,
    likeCount: r.likeCount ?? 0,
    viewedByMe: r.viewedByMe ?? false,
    likedByMe: r.likedByMe ?? false,
    filterId: r.filter_id ?? 'original',
    filterIntensity: r.filter_intensity ?? 100,
    mediaThumbnailUrl: r.media_thumbnail_url ?? null,
    mediaDurationSeconds: r.media_duration_seconds ?? null,
    // NOT `r.pinnedAt ?? null`. That spelling erases the difference between a
    // server that said "not pinned" and a server that could not say anything
    // about pinning at all — see the field's comment on `Highlight`.
    pinnedAt: r.pinnedAt === undefined ? undefined : (r.pinnedAt ?? null),
    archivedAt: r.archived_at ?? null,
    // NOT `r.sourceMemoryIds ?? []`. See the field's comment: a read that did
    // not carry provenance must not read back as "no provenance".
    sourceMemoryIds: Array.isArray(r.sourceMemoryIds) ? r.sourceMemoryIds : undefined,
  };
}

/**
 * §4 HighlightLifetime. Optional, and absent means absent — the server writes no
 * class when none is named, because nothing in §12 assigns hour boundaries to
 * the classes and a default would be invented product policy wearing the spec's
 * vocabulary. PERMANENT additionally requires migration 2975; a create that
 * names it on a database without it is refused with `feature_disabled` rather
 * than quietly stored with an expiry.
 */
export type HighlightLifetimeClass = 'LIVE' | 'DAY' | 'TRIP' | 'SEASONAL' | 'PERMANENT';

export interface CreateHighlightInput {
  mediaUrl: string;
  mediaType: string;
  videoDurationSeconds?: number | null;
  caption?: string | null;
  locationName?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  visibility?: HighlightVisibility;
  expiresInHours?: number;
  filterId?: string;
  filterIntensity?: number;
  mediaThumbnailUrl?: string | null;
  mediaDurationSeconds?: number | null;
  lifetimeClass?: HighlightLifetimeClass | null;
  /**
   * §12 / §3.6 — the Memories this Highlight projects. Census H93.
   *
   * OPTIONAL here because it is optional on the wire
   * (`routes/highlights.ts:736`), and absent means absent: a Highlight created
   * without sources is stored with no link rows and reads back
   * `sourceMemoryIds: []`. It is deliberately NOT defaulted to some nearby
   * Memory — §12 says a Highlight IS a projection over Memories, and a client
   * that guessed which ones would be inventing provenance, which is the exact
   * failure `services/highlights/highlightSources.ts` exists to prevent.
   *
   * At most 25 (`MAX_HIGHLIGHT_SOURCES`), and every id must be a live Memory
   * the caller owns or the whole create is refused with `forbidden`.
   */
  sourceMemoryIds?: string[];
}

export async function createHighlight(input: CreateHighlightInput): Promise<HighlightResult<Highlight>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mediaUrl: input.mediaUrl,
        mediaType: input.mediaType,
        videoDurationSeconds: input.videoDurationSeconds ?? null,
        caption: input.caption ?? null,
        locationName: input.locationName ?? null,
        locationCity: input.locationCity ?? null,
        locationCountry: input.locationCountry ?? null,
        visibility: input.visibility ?? 'public',
        expiresInHours: input.expiresInHours ?? 24,
        filterId: input.filterId ?? 'original',
        filterIntensity: input.filterIntensity ?? 100,
        mediaThumbnailUrl: input.mediaThumbnailUrl ?? null,
        mediaDurationSeconds: input.mediaDurationSeconds ?? null,
        // Omitted, not nulled: the server distinguishes "no class was chosen"
        // from a class, and sending null would be a value.
        ...(input.lifetimeClass ? { lifetimeClass: input.lifetimeClass } : {}),
        // Same rule for §12's sources. An empty array is a CLAIM — "this
        // Highlight projects nothing" — and the schema treats absent and empty
        // identically only because absent is what a Stories-style create means.
        // Sending `[]` on every create would make the two indistinguishable
        // from the server's side.
        ...(input.sourceMemoryIds && input.sourceMemoryIds.length > 0
          ? { sourceMemoryIds: input.sourceMemoryIds }
          : {}),
      }),
    });
    if (!res.ok) return mapApiError<Highlight>(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: mapHighlight(await res.json()) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Fetch active highlights for a specific user, filtered by viewer permissions. */
export async function fetchUserHighlights(userId: string): Promise<HighlightResult<Highlight[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${userId}/highlights`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<Highlight[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return { ok: true, data: (body.highlights ?? []).map(mapHighlight) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/**
 * Fetch active highlights visible to the current user.
 * Supports ?userId=, ?city=, ?tripId= filters.
 */
export async function fetchActiveHighlights(opts?: {
  userId?: string;
  city?: string;
  tripId?: string;
  limit?: number;
}): Promise<HighlightResult<Highlight[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  const params = new URLSearchParams();
  if (opts?.userId) params.set('userId', opts.userId);
  if (opts?.city) params.set('city', opts.city);
  if (opts?.tripId) params.set('tripId', opts.tripId);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const res = await fetch(`${apiBase()}/api/highlights/active${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<Highlight[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return { ok: true, data: (body.highlights ?? []).map(mapHighlight) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/** Idempotent mark-as-viewed. Best-effort — never blocks the UI. */
export async function markHighlightViewed(highlightId: string): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  const token = await freshToken();
  if (!token) return;
  fetch(`${apiBase()}/api/highlights/${highlightId}/view`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export async function toggleHighlightLike(
  highlightId: string,
  liked: boolean,
): Promise<HighlightResult<{ likedByMe: boolean; likeCount: number }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/like`, {
      method: liked ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

export async function fetchHighlightViewers(highlightId: string): Promise<HighlightResult<HighlightViewer[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/viewers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<HighlightViewer[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return {
      ok: true,
      data: (body.viewers ?? []).map((v: any) => ({
        userId: v.user_id,
        handle: v.handle,
        name: v.name,
        avatarUrl: v.avatar_url ?? null,
        viewedAt: v.viewed_at,
        likedByMe: v.liked ?? false,
      })),
    };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

/** Reply to a highlight — creates or returns a Telegraph DM thread. Returns threadId. */
export async function replyToHighlight(
  highlightId: string,
  message: string,
): Promise<HighlightResult<{ threadId: string }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

export async function deleteHighlight(highlightId: string): Promise<HighlightResult<null>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204) return { ok: true, data: null };
    return mapApiError<null>(res.status, await res.json().catch(() => ({})));
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

/* ============================================================================
 * §21 ARCHIVE — the reversible removal, which is NOT the soft delete.
 *
 * Highlights/Memories Development Architecture Spec v1 §21: "Delete, archive,
 * do-not-resurface, and 'keep but do not personalize' are different operations
 * and must remain separate in both data model and UX."
 *
 * The three routes have existed and been tested on the server; nothing in this
 * client called any of them, so the only removal an owner could perform was
 * DELETE — which is terminal. A product that offers one verb where the spec
 * requires four separate ones has collapsed them in the UX half of that
 * sentence whatever its data model does.
 * ========================================================================== */

/** §21 Archive. Reversible, retains the row, does not consume the delete. */
export async function archiveHighlight(
  highlightId: string,
): Promise<HighlightResult<{ id: string; archivedAt: string }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

/** §21 Archive is reversible. This is the half that makes it so. */
export async function unarchiveHighlight(
  highlightId: string,
): Promise<HighlightResult<{ id: string; archivedAt: null }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/archive`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

/**
 * §21's "unless explicitly requested" — the owner's archive, on demand.
 *
 * A FAILED READ IS NOT AN EMPTY ARCHIVE. The route refuses with
 * `degraded_unavailable` rather than serving `{highlights: []}` precisely so
 * this function can tell an outage from an owner who has archived nothing, and
 * the unconfigured branch below returns `config_error` for the same reason —
 * NOT `{ok: true, data: []}` the way the older reads in this file do. "Your
 * archive is empty" is a claim about somebody's retained record, and a screen
 * that prints it for a failed request tells them their archive was lost.
 */
export async function fetchArchivedHighlights(): Promise<HighlightResult<Highlight[]>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/archived`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<Highlight[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return { ok: true, data: (body.highlights ?? []).map(mapHighlight) };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/* ============================================================================
 * §12 / §3.6 PROVENANCE — what a Highlight is built from.
 *
 * Highlights/Memories Development Architecture Spec v1 §12: a Highlight is a
 * disposable, audience-specific PROJECTION over Memories. Census H93 records
 * the gap plainly: "`POST /highlights` accepts a client-supplied `mediaUrl`
 * with no source, and every Highlight on production is sourceless."
 *
 * Migration 2722 (`highlight_sources`) IS applied on production — checked in
 * `artifacts/api-server/src/lib/capability/production-applied-migrations.json`
 * — and `GET /highlights/:id/sources` has been served since, with no client of
 * any kind. This is that client. It does not make H93 correct: a sourceless
 * create still succeeds, which is the row's stated reason and a product
 * migration rather than a wiring gap. What it does is stop the answer being
 * unaskable.
 *
 * OWNER-ONLY. The route refuses with `not_found` for a Highlight the caller
 * does not own, deliberately collapsing "not yours" and "not there" so the
 * endpoint is not an oracle for whether an arbitrary UUID is a Highlight.
 * ========================================================================== */

/** 2722's `source_type` CHECK. `EPISODE` is storable and not yet verifiable. */
export type HighlightSourceType = 'MEMORY' | 'EPISODE';

/** 2722's `provenance` CHECK, which is §4's TruthLevel verbatim. */
export type HighlightSourceProvenance =
  | 'USER_ASSERTED'
  | 'SYSTEM_OBSERVED'
  | 'MUTUALLY_CONFIRMED'
  | 'INFERRED'
  | 'UNKNOWN';

export interface HighlightSource {
  sourceType: HighlightSourceType;
  sourceId: string;
  /**
   * §4's truth precedence. A link a person asserted is not the same claim as
   * one an engine proposed, and a surface that renders the two identically has
   * thrown away the distinction the column exists to keep.
   */
  provenance: HighlightSourceProvenance;
  createdAt: string | null;
}

/**
 * `GET /highlights/:id/sources`.
 *
 * `feature_disabled` here means migration 2722 is absent on THAT deployment —
 * not on the one whose committed snapshot this lane read. It is a permanent
 * answer for that build and must never be offered a retry, which is why it
 * survives `mapApiError`'s union rather than being flattened to `db_error`.
 */
export async function fetchHighlightSources(
  highlightId: string,
): Promise<HighlightResult<HighlightSource[]>> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/sources`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<HighlightSource[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    // `?? []` IS correct here and nowhere else in this file: the route answers
    // 200 only when the link table was read successfully, and refuses with
    // `degraded_unavailable` when it could not be. An empty list from a 200 is
    // therefore the server saying "sourceless", not "I could not tell".
    return {
      ok: true,
      data: ((body.sources ?? []) as any[]).map((s): HighlightSource => ({
        sourceType: s.sourceType,
        sourceId: s.sourceId,
        provenance: s.provenance ?? 'UNKNOWN',
        createdAt: s.createdAt ?? null,
      })),
    };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export async function reportHighlight(highlightId: string, reason: string): Promise<HighlightResult<null>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/${highlightId}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason }),
    });
    if (res.status === 204 || res.ok) return { ok: true, data: null };
    return mapApiError<null>(res.status, await res.json().catch(() => ({})));
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error' };
  }
}

export interface HighlightFeedUser {
  userId: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  highlights: Highlight[];
}

/**
 * Fetch highlights from users the current user follows, grouped by user.
 * Used by the Explore tab Highlights strip.
 */
export async function fetchFollowingHighlightsFeed(): Promise<HighlightResult<HighlightFeedUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: [] };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/highlights/following-feed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<HighlightFeedUser[]>(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return {
      ok: true,
      data: (body.users ?? []).map((u: any): HighlightFeedUser => ({
        userId: u.userId,
        handle: u.handle ?? null,
        name: u.name ?? null,
        avatarUrl: u.avatarUrl ?? null,
        highlights: (u.highlights ?? []).map(mapHighlight),
      })),
    };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/**
 * Batch-fetch active-highlight metadata for multiple users.
 * Returns a map: userId → { hasActive: boolean, allViewed: boolean, highlights: Highlight[] }
 * Used by HighlightRing to determine ring state.
 */
export async function fetchHighlightRingStates(
  userIds: string[],
  viewedIds: Set<string>,
): Promise<Map<string, { hasActive: boolean; allViewed: boolean; highlights: Highlight[] }>> {
  const result = new Map<string, { hasActive: boolean; allViewed: boolean; highlights: Highlight[] }>();
  if (userIds.length === 0) return result;

  // Fetch per-user highlights in parallel (batch of unique userIds)
  const uniqueIds = [...new Set(userIds)];
  const fetches = uniqueIds.map(async (uid) => {
    const r = await fetchUserHighlights(uid);
    const highlights = r.ok && r.data ? r.data : [];
    const hasActive = highlights.length > 0;
    const allViewed = hasActive && highlights.every((h) => viewedIds.has(h.id));
    return [uid, { hasActive, allViewed, highlights }] as const;
  });
  const entries = await Promise.all(fetches);
  for (const [uid, state] of entries) result.set(uid, state);
  return result;
}
