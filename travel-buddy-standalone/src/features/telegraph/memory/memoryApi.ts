/**
 * Telegraph §10 API client — save-to-Memory and the end-of-night recap.
 *
 *   POST /api/me/memory-drafts          §10.2, ONE message at a time.
 *   GET  /api/threads/:id/recap         §10.3, a READ that writes nothing.
 *
 * §10.2's prohibition is visible in this module's SHAPE as well as on the
 * server: `saveMessageAsMemoryDraft` takes a single `messageId: string`. There
 * is no array form, no thread form and no "save this conversation" helper for a
 * screen to reach for, so a caller cannot accidentally build the bulk path the
 * spec forbids. The server refuses `threadId` / `messageIds` / `conversationId`
 * / `all` by name as well, because a client-only guarantee is not one.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export const RECAP_CURATE_ACTIONS = [
  'CREATE_MEMORY',
  'SHARE_PHOTOS',
  'FOLLOW_PEOPLE_YOU_MET',
  'DONE',
] as const;
export type RecapCurateAction = (typeof RECAP_CURATE_ACTIONS)[number];

export interface RecapCounts {
  places: number;
  people: number;
  photos: number;
  videos: number;
}

export interface SessionRecap {
  threadId: string;
  planId: string | null;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  counts: RecapCounts;
  sourceMessageIds: string[];
  curateActions: RecapCurateAction[];
  invitation: true;
  empty: boolean;
}

export interface RecapResponse {
  recap: SessionRecap | null;
  headline: string;
  /** Present only when there is nothing to recap. */
  reason?: string;
  /**
   * §10.3 said out loud by the server: the read created nothing. The sheet
   * shows it so a user is not left guessing whether opening a recap already
   * made a Memory.
   */
  wrote?: 'nothing';
}

export interface MemoryDraft {
  id: string;
  ownerId: string;
  state: string;
  visibility: string;
  title: string | null;
  occurredAt: string | null;
  fromMessageId: string;
  source: string;
}

export type MemoryResult<T> = { ok: true; data: T } | { ok: false; error: string; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call<T>(path: string, init?: RequestInit): Promise<MemoryResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(body?.error ?? res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}

/**
 * §10.2 — promote ONE message into a PRIVATE Memory draft.
 *
 * Singular by construction. A screen that wants to save five things calls this
 * five times, each an explicit user action, which is the difference between
 * "a user may explicitly save" and "Telegraph automatically converts".
 */
export async function saveMessageAsMemoryDraft(
  messageId: string,
  extra?: { title?: string | null; caption?: string | null },
): Promise<MemoryResult<{ draft: MemoryDraft }>> {
  return call<{ draft: MemoryDraft }>(`/api/me/memory-drafts`, {
    method: 'POST',
    body: JSON.stringify({ messageId, ...(extra ?? {}) }),
  });
}

/** §10.3 — the recap for a thread's most recent COMPLETED plan. A read. */
export async function fetchRecap(
  threadId: string,
  planId?: string | null,
): Promise<MemoryResult<RecapResponse>> {
  const qs = planId ? `?planId=${encodeURIComponent(planId)}` : '';
  return call<RecapResponse>(`/api/threads/${threadId}/recap${qs}`);
}

/**
 * §10.3's headline, rendered client-side from the counts.
 *
 * "4 places · 6 people · 18 photos · 2 videos" — a zero count is omitted rather
 * than printed as "0 videos", because a recap that reports absences reads as an
 * accusation instead of an invitation.
 */
export function recapHeadline(counts: RecapCounts): string {
  const parts: string[] = [];
  const push = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  push(counts.places, 'place', 'places');
  push(counts.people, 'person', 'people');
  push(counts.photos, 'photo', 'photos');
  push(counts.videos, 'video', 'videos');
  return parts.join(' · ');
}

/**
 * What to tell a user after a save, read back from what the SERVER returned.
 *
 * §10.2 promises a PRIVATE draft. This function does not assert that promise —
 * it reports the `state` and `visibility` the server actually wrote, so a
 * deployment that ever returned a published or visible Memory would be
 * described as such rather than as "saved privately". Asserting the promise
 * would make the confirmation a wish; reading it back makes it evidence.
 */
export function draftSavedMessage(draft: MemoryDraft): string {
  if (draft.state === 'draft' && draft.visibility === 'only_me') {
    return 'Saved to your private Memory drafts. Only you can see it.';
  }
  return `Saved as a ${draft.state} Memory, visible to ${draft.visibility}.`;
}

/** §10.3's four buttons, in the spec's order, with the spec's labels. */
export function curateActionLabel(action: RecapCurateAction): string {
  switch (action) {
    case 'CREATE_MEMORY':
      return 'Create Memory';
    case 'SHARE_PHOTOS':
      return 'Share Photos';
    case 'FOLLOW_PEOPLE_YOU_MET':
      return 'Follow People You Met';
    case 'DONE':
      return 'Done';
    default:
      return action;
  }
}
