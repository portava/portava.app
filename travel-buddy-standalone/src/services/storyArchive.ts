/**
 * The owner's Story archive — listing, deletion, recovery and re-posting.
 *
 * A file of its own rather than more of `stories.ts`, mirroring the server's
 * `routes/storyArchive.ts`. The audience-facing story calls and the owner's
 * archive share a URL prefix and nothing else, and `stories.ts` is being edited
 * on two other branches; keeping these apart means this work lands without
 * touching either.
 *
 * ── EVERY RESULT SAYS WHICH IT IS ────────────────────────────────────────────
 * Each call returns a discriminated result rather than a list-or-empty. An
 * archive screen that cannot tell a failed read from an empty archive shows the
 * owner "nothing here" for an outage, which is the app telling them their
 * stories are gone. The server is written to return an error rather than `[]`
 * for exactly this reason; throwing that distinction away on the client would
 * waste it.
 */
function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * The token reader and fetch, injectable.
 *
 * `apiToken` is reached through a dynamic import — the way pushTokenService.ts
 * and useActiveLocation.ts already do it — because a static import pulls
 * supabase.ts -> SecureStoreAdapter -> react-native into this module's graph,
 * and node:test cannot load that chain (scripts/run-node-tests.mjs keeps a
 * KNOWN_BROKEN list of tests that hit exactly that wall). The rules this file
 * enforces — a failed read is not an empty archive, a closed window is not a
 * retryable error — are only rules if something executes them.
 */
export interface StoryArchiveDeps {
  token: () => Promise<string | null>;
  fetchImpl: typeof fetch;
}

let deps: StoryArchiveDeps | null = null;

/** Tests only. Pass null to restore the real dependencies. */
export function _setStoryArchiveDeps(d: StoryArchiveDeps | null): void {
  deps = d;
}

async function realToken(): Promise<string | null> {
  const { freshToken } = await import('./apiToken.ts');
  return freshToken();
}

function http(): typeof fetch {
  return deps?.fetchImpl ?? fetch;
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await (deps?.token ?? realToken)();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The dates the server computes for one story. Never computed here. */
export interface StoryRetentionDates {
  /** When the audience stopped being able to see it. */
  audienceEndedAt: string | null;
  /** When viewers, reactions and replies are purged. */
  engagementPurgeAt: string | null;
  /** When the story and its media are permanently purged, or null when it has no clock. */
  purgeAt: string | null;
  /** For a deleted story: the last moment the owner can recover it. */
  recoverableUntil: string | null;
  /** True when it is inside its owner-only recovery window right now. */
  recoverable: boolean;
  /** True when its archive deadline has already passed, so recovery restores it into the next purge. */
  purgeImminent: boolean;
}

export interface ArchivedStory {
  id: string;
  owner_id: string;
  media_url: string;
  media_type: string;
  caption: string | null;
  state: string;
  expires_at: string | null;
  deleted_at: string | null;
  saved_to_highlight_id: string | null;
  created_at: string;
  retention: StoryRetentionDates;
}

export type ArchiveResult =
  | { ok: true; stories: ArchivedStory[] }
  | { ok: false; message: string };

async function list(path: string, limit: number): Promise<ArchiveResult> {
  try {
    const headers = await authHeader();
    if (!headers.Authorization) return { ok: false, message: 'You are signed out.' };
    const res = await http()(`${apiBase()}${path}?limit=${limit}`, { headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, message: body?.message ?? `Could not open your archive (${res.status}).` };
    }
    // A 200 whose body is not the shape we asked for is not an empty archive
    // either — it is a response we cannot read, and saying "nothing here" for it
    // is the same lie as saying it for a 500.
    if (!Array.isArray(body?.stories)) {
      return { ok: false, message: 'Could not read your archive.' };
    }
    return { ok: true, stories: body.stories as ArchivedStory[] };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

/** The owner's expired and saved stories. */
export function getStoryArchive(limit = 50): Promise<ArchiveResult> {
  return list('/api/stories/archive', limit);
}

/**
 * Deletions the owner can still undo.
 *
 * The server filters to what the recovery route would actually accept, so this
 * list and the Recover button cannot disagree.
 */
export function getRecoverableStories(limit = 50): Promise<ArchiveResult> {
  return list('/api/stories/archive/deleted', limit);
}

export type RecoverResult =
  | { ok: true; id: string; state: string; retention: StoryRetentionDates; purgeImminent: boolean }
  | { ok: false; windowClosed: boolean; message: string };

/**
 * Put a deleted story back in the archive.
 *
 * `windowClosed` is kept separate from every other failure because it is the
 * one the owner can do nothing about, and the screen has to say so rather than
 * offer "try again".
 */
export async function recoverStory(id: string): Promise<RecoverResult> {
  try {
    const headers = await authHeader();
    const res = await http()(`${apiBase()}/api/stories/${id}/recover`, { method: 'POST', headers });
    const body = await res.json().catch(() => null);
    if (res.status === 410) {
      return {
        ok: false,
        windowClosed: true,
        message: body?.message ?? 'This story can no longer be restored.',
      };
    }
    if (!res.ok) {
      return { ok: false, windowClosed: false, message: body?.message ?? 'Could not restore this story.' };
    }
    return {
      ok: true,
      id: body?.id ?? id,
      state: body?.state ?? 'expired',
      retention: body?.retention,
      purgeImminent: body?.purgeImminent === true,
    };
  } catch (e: any) {
    return { ok: false, windowClosed: false, message: e?.message ?? 'Network error' };
  }
}

export type RepostResult =
  | { ok: true; expiresAt: string }
  | { ok: false; message: string };

/** Publish an archived story again, for a fresh 24 hours. */
export async function repostStory(id: string): Promise<RepostResult> {
  try {
    const headers = await authHeader();
    const res = await http()(`${apiBase()}/api/stories/${id}/repost`, { method: 'POST', headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: body?.message ?? 'Could not re-post this story.' };
    return { ok: true, expiresAt: body?.expiresAt ?? '' };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── the dates, in words ──────────────────────────────────────────────────────

function dayDiff(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.ceil((at - nowMs) / 86_400_000);
}

/**
 * What the row says about how long this story is kept.
 *
 * Returns null when the server gave no purge date. That is a real answer — a
 * story whose media belongs to a Highlight is not this job's to purge — and
 * inventing a date for it would promise something the system does not do.
 */
export function archiveRowRetentionLabel(
  retention: StoryRetentionDates,
  nowMs: number = Date.now(),
): string | null {
  const days = dayDiff(retention.purgeAt, nowMs);
  if (days === null) return null;
  if (days <= 0) return 'Being deleted now';
  if (days === 1) return 'Deleted tomorrow';
  if (days < 30) return `Deleted in ${days} days`;
  const months = Math.round(days / 30);
  if (months < 12) return `Deleted in about ${months} ${months === 1 ? 'month' : 'months'}`;
  const years = Math.round(days / 365);
  return `Deleted in about ${years === 1 ? 'a year' : `${years} years`}`;
}

/** What the row says about how long it can still be restored. */
export function recoveryRowLabel(
  retention: StoryRetentionDates,
  nowMs: number = Date.now(),
): string {
  const days = dayDiff(retention.recoverableUntil, nowMs);
  if (days === null) return 'Deleted';
  if (days <= 0) return 'Being deleted now';
  if (days === 1) return 'Restore within a day';
  return `Restore within ${days} days`;
}
